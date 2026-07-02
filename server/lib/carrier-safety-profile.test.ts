// Carrier safety-profile verdict integration test (temp DB, no network).
// Run: npx tsx server/lib/carrier-safety-profile.test.ts
//
// buildCarrierSafetyProfile drives the broker-defense / negligent-hiring badge
// (green/yellow/red/unknown) shown for each carrier. With no FMCSA_WEB_KEY the
// live fetch is skipped (fmcsa=null, no network), so the verdict is a pure
// function of insurance + operational history — which we exercise here:
//   - EXPIRED insurance -> red
//   - no FMCSA + zero loads -> unknown
//   - active insurance + some loads -> yellow
// plus insurance classification and the markdown renderer.

import { tmpdir } from "node:os";
import { join } from "node:path";

// Unique temp DB per run (like stripe-charge.test.ts) so a parallel agent /
// re-run can't collide on the same better-sqlite3 file. Set BEFORE importing storage.
process.env.DISPATCHOS_DB_PATH = join(
  tmpdir(),
  `dispatchos-carrier-safety-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
);
// Ensure the FMCSA live fetch is skipped (no network in tests).
delete process.env.FMCSA_WEB_KEY;
delete process.env.FMCSA_API_URL;

const { storage } = await import("../storage");
const { buildCarrierSafetyProfile, renderCarrierSafetyProfileMarkdown, fmcsaCacheKey } =
  await import("./carrier-safety-profile");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const rnd = () => Math.random().toString(36).slice(2, 10);

function mkClient(overrides: Record<string, unknown>): string {
  const id = `safety-${rnd()}`;
  storage.upsertClient({
    id,
    name: `Carrier ${id}`,
    mc: "MC-123456",
    equipment: "hotshot_flatbed",
    targetPpm: 2.2,
    minimumPpm: 1.9,
    mpg: 10,
    fuelPrice: 3.6,
    fixedCostPerMile: 0.35,
    preferredLanes: [],
    avoidStates: [],
    ...overrides,
  } as Parameters<typeof storage.upsertClient>[0]);
  return id;
}

// --- unknown: no insurance, no loads, no FMCSA ----------------------------
{
  const id = mkClient({});
  const p = await buildCarrierSafetyProfile(id);
  assert("profile returned", !!p);
  assert("fmcsa not fetched (no key)", p!.fmcsa.fetched === false);
  assert("fmcsa error mentions FMCSA_WEB_KEY", /FMCSA_WEB_KEY/.test(p!.fmcsa.error ?? ""), p!.fmcsa.error);
  assert("verdict unknown (no fmcsa + 0 loads)", p!.verdict.level === "unknown", p!.verdict.level);
  assert("operational loadsTotal 0", p!.operational.loadsTotal === 0);
}

// --- red: expired insurance is a fatal signal ------------------------------
{
  const id = mkClient({ cargoInsuranceExpiresAt: "2020-01-01" });
  const p = await buildCarrierSafetyProfile(id);
  assert("verdict red on expired insurance", p!.verdict.level === "red", p!.verdict.level);
  assert(
    "risk lists EXPIRED insurance",
    p!.verdict.risks.some((r) => /EXPIRED/.test(r)),
    JSON.stringify(p!.verdict.risks),
  );
  const cargo = p!.insurance.find((i) => i.kind === "cargo");
  assert("cargo line classified expired", cargo?.status === "expired", JSON.stringify(cargo));
}

// --- yellow: active insurance + operational history, but no FMCSA ----------
{
  const id = mkClient({
    cargoInsuranceExpiresAt: "2027-12-31",
    autoLiabilityExpiresAt: "2027-12-31",
    generalLiabilityExpiresAt: "2027-12-31",
  });
  storage.upsertLoad({
    id: `load-safety-${rnd()}`,
    clientId: id,
    bookedAt: "2026-06-01T00:00:00.000Z",
    brokerMc: "MC-9",
    brokerName: "B",
    rate: 1500,
  } as Parameters<typeof storage.upsertLoad>[0]);

  const p = await buildCarrierSafetyProfile(id);
  assert("verdict yellow (active insurance + a load, no FMCSA)", p!.verdict.level === "yellow", p!.verdict.level);
  assert(
    "strength notes all insurance current",
    p!.verdict.strengths.some((s) => /insurance lines on file and current/i.test(s)),
    JSON.stringify(p!.verdict.strengths),
  );
  assert("operational counted the load", p!.operational.loadsTotal === 1);

  // Markdown renderer reflects the verdict.
  const md = renderCarrierSafetyProfileMarkdown(p!);
  assert("markdown has yellow badge", md.includes("🟡 YELLOW"), md.slice(0, 200));
  assert("markdown includes the MC", md.includes("MC-123456"));
  assert("markdown includes the summary", md.includes(p!.verdict.summary));
}

// --- null for an unknown client -------------------------------------------
{
  const p = await buildCarrierSafetyProfile(`nope-${rnd()}`);
  assert("unknown client -> null", p === null);
}

// --- FMCSA cache key isolates by web key (Audit: no cross-credential bleed) -
{
  const sameMcKeyA = fmcsaCacheKey("123456", "web-key-A");
  const sameMcKeyB = fmcsaCacheKey("123456", "web-key-B");
  assert("same MC + different web key -> different cache key", sameMcKeyA !== sameMcKeyB);
  assert(
    "cache key is deterministic for identical inputs",
    fmcsaCacheKey("123456", "web-key-A") === sameMcKeyA,
  );
  assert(
    "different MC + same web key -> different cache key",
    fmcsaCacheKey("654321", "web-key-A") !== sameMcKeyA,
  );
  // The raw web key must never appear in the cache key (it is hashed).
  assert("cache key does not leak the raw web key", !sameMcKeyA.includes("web-key-A"));
}

// ===========================================================================
// REGRESSION: escapeMarkdown sanitization inside renderCarrierSafetyProfileMarkdown
// ---------------------------------------------------------------------------
// escapeMarkdown is the only thing standing between untrusted external text
// (client name, MC, FMCSA legalName/address/phone) and the rendered Markdown a
// broker pastes into their carrier file or converts to PDF. The fix it locks in:
//
//   (a) INLINE markdown metachars  \ ` * _ [ ] ( ) ! | < > ~  are backslash-
//       escaped so a malicious clientName/legalName like "[x](http://evil)" or
//       "`code`" or "**b**" renders LITERALLY — it cannot inject a link/image,
//       open a code span, or apply emphasis.
//   (b) control characters / newlines collapse to a single space so a value
//       cannot break out of its list item / heading / table cell.
//   (c) line-start-only structural chars  - . + # { }  are intentionally NOT
//       escaped, because these values are embedded MID-line: escaping them would
//       mangle legitimate content like "MC-123456" -> "MC\-123456" or "5.5" ->
//       "5\.5".
//
// Each assertion below PASSES on the current (fixed) regex and would have FAILED
// on a pre-fix version that either (i) didn't escape inline metachars at all, or
// (ii) over-escaped "-"/"." (the two failure modes the comment in the source
// explicitly guards against). We drive the PUBLIC renderer (escapeMarkdown is
// module-private) by constructing a CarrierSafetyProfile directly — fully
// deterministic, no FMCSA fetch, no network, no clock dependency.
{
  // Build a minimal but complete CarrierSafetyProfile by hand. The malicious
  // payloads live in clientName + FMCSA legalName (both run through escapeMarkdown).
  const profile = {
    clientId: "c-regress",
    // Inline-injection attempts: link, code span, bold, image, pipe, angle/tilde.
    clientName: "Evil [x](http://evil) `code` **bold** ![i](http://img) a|b <s> ~t~ Co",
    // A normal MC must survive UNMANGLED (the "-" is NOT escaped).
    mc: "MC-123456",
    generatedAt: "2026-06-29T12:00:00.000Z", // fixed -> formatDate is deterministic
    fmcsa: {
      fetched: true,
      raw: {
        legalName: "Bad [link](http://x) Trucking",
        // A decimal authority age must render UNMANGLED ("5.5", not "5\.5").
        authorityAgeYears: 5.5,
        // Control chars / newline in a value must collapse to a single space.
        phone: "555\n123\t4567",
      },
    },
    insurance: [],
    operational: {
      loadsTotal: 0,
      loadsLast90d: 0,
      loadsDelivered: 0,
      loadsActive: 0,
      firstActivityAt: null,
      lastActivityAt: null,
    },
    verdict: { level: "unknown", summary: "S.", risks: [], strengths: [] },
    disclaimer: "D.",
  } as unknown as Parameters<typeof renderCarrierSafetyProfileMarkdown>[0];

  const md = renderCarrierSafetyProfileMarkdown(profile);

  // (a) Inline metachars in clientName are backslash-escaped → no live markup.
  // Pre-fix (no inline escaping) these literal sequences would NOT be present.
  assert(
    "clientName link is escaped (no clickable link injected)",
    md.includes("\\[x\\]\\(http://evil\\)"),
    md.split("\n")[0],
  );
  assert(
    "clientName code span is neutralized (backtick escaped)",
    md.includes("\\`code\\`"),
    md.split("\n")[0],
  );
  assert(
    "clientName bold is neutralized (asterisks escaped)",
    md.includes("\\*\\*bold\\*\\*"),
    md.split("\n")[0],
  );
  assert(
    "clientName image is neutralized (bang + brackets + parens escaped)",
    md.includes("\\!\\[i\\]\\(http://img\\)"),
    md.split("\n")[0],
  );
  assert(
    "clientName pipe / angle / tilde are escaped",
    md.includes("a\\|b") && md.includes("\\<s\\>") && md.includes("\\~t\\~"),
    md.split("\n")[0],
  );
  // Sanity: the dangerous RAW link must NOT appear unescaped anywhere.
  assert(
    "no raw unescaped '[x](http://evil)' leaks into the document",
    !md.includes("[x](http://evil)"),
  );

  // FMCSA legalName (separate code path) is escaped the same way.
  assert(
    "FMCSA legalName link is escaped",
    md.includes("Bad \\[link\\]\\(http://x\\) Trucking"),
    md,
  );

  // (b) Control chars / newlines in phone collapse to single spaces (no breakout).
  assert(
    "control chars / newlines collapse to a single space",
    md.includes("**Phone:** 555 123 4567"),
    md,
  );

  // (c) The MC "-" passes through UNMANGLED. Pre-fix over-escaping would have
  // produced "MC\-123456" and this would FAIL.
  assert(
    "MC-123456 renders unmangled (no backslash before '-')",
    md.includes("**MC:** MC-123456") && !md.includes("MC\\-123456"),
    md,
  );
  // (c) The decimal "5.5" passes through UNMANGLED ("." is not escaped).
  assert(
    "authority age '5.5' renders unmangled (no backslash before '.')",
    md.includes("5.5 years") && !md.includes("5\\.5"),
    md,
  );
}

// ===========================================================================
// REGRESSION: escapeMarkdown via clientName even when the live FMCSA fetch is
// skipped (the default test path) — proves the heading itself is sanitized.
// ===========================================================================
{
  // Build a real client whose NAME carries a markdown-injection payload, then
  // render through the full buildCarrierSafetyProfile path (no FMCSA key set).
  const id = mkClient({ name: "Acme [evil](http://x) `r` Ltd" });
  const p = await buildCarrierSafetyProfile(id);
  const md = renderCarrierSafetyProfileMarkdown(p!);
  // The H1 heading embeds clientName mid-line; pre-fix it would contain a live
  // link. Now it must be backslash-escaped.
  assert(
    "H1 heading escapes an injected link in clientName",
    md.includes("# Carrier Safety Profile — Acme \\[evil\\]\\(http://x\\) \\`r\\` Ltd"),
    md.split("\n")[0],
  );
  assert(
    "H1 heading does not leak a raw clickable link",
    !md.includes("[evil](http://x)"),
    md.split("\n")[0],
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
