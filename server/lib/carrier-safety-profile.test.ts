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

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), "dispatchos-carrier-safety-test.db");
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
