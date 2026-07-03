// Broker-email sender-domain anti-spoof regression test (temp DB).
// Run: npx tsx server/lib/adapters/broker-email.test.ts
//
// Locks in the fix in senderMatches() (broker-email.ts): the From domain must
// match a configured senderDomains entry by EXACT domain or true subdomain —
// never by an unanchored substring/suffix of the raw header. The pre-fix code
// used a raw `header.includes(domain)`, which let a look-alike or unrelated
// sender ("evil-dispatchos.co", "notrxo.com", a display name containing the
// domain, or "rxo.com.attacker.example") impersonate a trusted broker and
// inject trusted-looking loads. senderMatches() is module-private, so we drive
// it through the REAL exported adapters' fetchLoads(), which scopes ingested
// emails to the source by sender domain.
//
// Each assertion below passes on the current (fixed) code and would FAIL on the
// pre-fix unanchored-includes() behavior — that is stated per block.

import { tmpdir } from "node:os";
import { join } from "node:path";

// Unique temp DB BEFORE importing storage (better-sqlite3 binds the file at
// import time) — mirrors stripe-charge.test.ts. No shared/native rebuild.
process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-broker-email-${Date.now()}-${process.pid}.db`);
// No AI in this adapter test: the no-limit poller path calls parseBrokerEmailWithAi,
// which stays offline without a key. Delete it so the suite is deterministic and
// never makes a real model call regardless of the ambient environment.
delete process.env.ANTHROPIC_API_KEY;

const { storage } = await import("../../storage");
const { rxoEmailAdapter, echoEmailAdapter, genericEmailAdapter } = await import("./broker-email");
import type { LoadSourceRow } from "./types";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}
const rnd = () => Math.random().toString(36).slice(2, 10);

// Minimal LoadSourceRow the adapter needs. configJson left empty so matching
// uses ONLY the adapter's built-in senderDomains (the anti-spoof code path).
function srcRow(adapterKey: LoadSourceRow["adapterKey"], cfg: Record<string, unknown> = {}): LoadSourceRow {
  return {
    id: `src_${rnd()}`,
    clientId: `cli_${rnd()}`,
    adapterKey,
    label: "test",
    status: "active",
    configJson: cfg,
    pollIntervalMin: 60,
  };
}

// Seed one email into email_ingest and return its from header. A unique
// messageId avoids the idempotency short-circuit in saveEmailIngest. createdAt
// is stamped "now", so it sits well inside the 24h lookback window — no Date
// flakiness, no waiting.
function seedEmail(from: string): string {
  storage.saveEmailIngest({
    from,
    to: "loads@dispatchos.co",
    subject: "Load offer",
    // Body must parse to a COMPLETE load: fetchLoads now gates on parsed.matched
    // (drops unparseable mail so it never becomes an empty $0 load), and the
    // no-limit poller path AI-assists incomplete parses — a criticalComplete body
    // keeps this sender-scoping test deterministic (zero model calls) and lets the
    // accepted emails survive the gate.
    body: "Origin: Dallas, TX\nDestination: Atlanta, GA\nRate: $1,200\nMiles: 800\nPickup: 2026-07-10",
    messageId: `<${rnd()}@test.local>`,
  });
  return from;
}

// Seed an email with an explicit subject/body (for the parse-gate test below).
function seedEmailWith(from: string, subject: string, body: string): string {
  storage.saveEmailIngest({ from, to: "loads@dispatchos.co", subject, body, messageId: `<${rnd()}@test.local>` });
  return from;
}

// True iff fetchLoads accepted (scoped in) an email with this exact From header.
async function accepted(adapter: { fetchLoads: (r: LoadSourceRow, n?: number) => Promise<any[]> }, row: LoadSourceRow, from: string): Promise<boolean> {
  const out = await adapter.fetchLoads(row, 500);
  return out.some((r) => String(r.from) === from);
}

// ---------------------------------------------------------------------------
// 1) RXO adapter (senderDomains: ["rxo.com"]).
//    Exact + true subdomain accepted; look-alikes rejected.
// ---------------------------------------------------------------------------
{
  const exact = seedEmail("loadoffers@rxo.com");
  const exactDisplay = seedEmail('"RXO Loads" <dispatch@rxo.com>');
  const subdomain = seedEmail("offers@mail.rxo.com");

  // Look-alikes that the PRE-FIX includes(domain) would have wrongly accepted:
  const prefix = seedEmail("x@notrxo.com"); // ends-with check on raw addr would still need the dot; substring of header would match
  const suffixLookalike = seedEmail("x@evil-rxo.com"); // raw includes("rxo.com") is TRUE -> pre-fix false positive
  const trailingHost = seedEmail("x@rxo.com.attacker.example"); // pre-fix includes("rxo.com") TRUE
  const displayNameSpoof = seedEmail('"loadoffers@rxo.com" <x@phisher.example>'); // header CONTAINS rxo.com but real domain is phisher.example
  const unrelated = seedEmail("x@coyote.com");

  const row = srcRow("rxo_email");

  // PASS on fixed code; the matching is real (positives must still match).
  assert("rxo: exact domain accepted", await accepted(rxoEmailAdapter, row, exact));
  assert("rxo: display-name w/ real rxo.com addr accepted", await accepted(rxoEmailAdapter, row, exactDisplay));
  assert("rxo: true subdomain mail.rxo.com accepted", await accepted(rxoEmailAdapter, row, subdomain));

  // REGRESSION GUARDS: each of these would FAIL (be wrongly accepted) under the
  // pre-fix unanchored header.includes("rxo.com").
  assert("rxo: 'evil-rxo.com' NOT matched (suffix false-positive guard)", !(await accepted(rxoEmailAdapter, row, suffixLookalike)));
  assert("rxo: 'rxo.com.attacker.example' NOT matched (trailing-host guard)", !(await accepted(rxoEmailAdapter, row, trailingHost)));
  assert("rxo: display-name containing rxo.com but real domain phisher NOT matched", !(await accepted(rxoEmailAdapter, row, displayNameSpoof)));
  assert("rxo: 'notrxo.com' NOT matched", !(await accepted(rxoEmailAdapter, row, prefix)));
  assert("rxo: unrelated coyote.com NOT matched by rxo source", !(await accepted(rxoEmailAdapter, row, unrelated)));
}

// ---------------------------------------------------------------------------
// 2) Echo adapter (senderDomains: ["echo.com"]) — the classic substring trap:
//    "notecho.com" CONTAINS "echo.com". Must NOT match.
// ---------------------------------------------------------------------------
{
  const real = seedEmail("offers@echo.com");
  const substringTrap = seedEmail("x@notecho.com"); // includes("echo.com") TRUE -> pre-fix false positive
  const lookalike = seedEmail("x@echo.com.evil.io"); // includes("echo.com") TRUE -> pre-fix false positive

  const row = srcRow("echo_email");
  assert("echo: real echo.com accepted", await accepted(echoEmailAdapter, row, real));
  // REGRESSION GUARD: pre-fix would wrongly accept these.
  assert("echo: 'notecho.com' NOT matched (substring guard)", !(await accepted(echoEmailAdapter, row, substringTrap)));
  assert("echo: 'echo.com.evil.io' NOT matched", !(await accepted(echoEmailAdapter, row, lookalike)));
}

// ---------------------------------------------------------------------------
// 3) Generic adapter (built-in senderDomains: []) scoped ONLY by config
//    senderDomains. Exact/subdomain accepted, look-alike rejected. Confirms the
//    same anti-spoof logic applies to operator-supplied domains, and that an
//    empty built-in list does not accept everything when a config list is set.
// ---------------------------------------------------------------------------
{
  const real = seedEmail("ops@acmebroker.com");
  const sub = seedEmail("ops@us.acmebroker.com");
  const spoof = seedEmail("x@evil-acmebroker.com"); // pre-fix includes() false positive
  const other = seedEmail("x@someoneelse.com");

  const row = srcRow("email_generic", { senderDomains: ["acmebroker.com"] });
  assert("generic(cfg): exact config domain accepted", await accepted(genericEmailAdapter, row, real));
  assert("generic(cfg): true subdomain accepted", await accepted(genericEmailAdapter, row, sub));
  // REGRESSION GUARD: pre-fix substring match would accept the look-alike.
  assert("generic(cfg): 'evil-acmebroker.com' NOT matched", !(await accepted(genericEmailAdapter, row, spoof)));
  assert("generic(cfg): unrelated domain NOT matched", !(await accepted(genericEmailAdapter, row, other)));
}

// ---------------------------------------------------------------------------
// 4) A From header with no '@' at all must never match a real domain
//    (fromDomain returns "" -> senderMatches returns false).
// ---------------------------------------------------------------------------
{
  const noAt = seedEmail("rxo.com"); // bare token, no address; pre-fix includes("rxo.com") TRUE
  const row = srcRow("rxo_email");
  // REGRESSION GUARD: pre-fix raw includes would accept this bare token.
  assert("rxo: From with no '@' (bare 'rxo.com') NOT matched", !(await accepted(rxoEmailAdapter, row, noAt)));
}

// ---------------------------------------------------------------------------
// 5) Window-completeness (silent-drop regression): an in-window offer buried
//    under >200 NEWER unrelated emails must still be found. The pre-fix fetch
//    fed a GLOBAL newest-200 listEmailIngest() page (cron passes no limit →
//    cap 200) into the per-source filters, so 200+ unrelated emails arriving
//    in a poll interval evicted another source's still-in-window offers — and
//    rows only get older, so they were never seen again (purged at 180d).
//    The buried-offer assertion FAILS on the old newest-200-global code.
// ---------------------------------------------------------------------------
{
  const buriedFrom = `buried-${rnd()}@rxo.com`;
  seedEmail(buriedFrom);
  // Guarantee the noise below is strictly NEWER (created_at has ms precision;
  // a 15ms gap removes any same-millisecond ordering ambiguity).
  await new Promise((r) => setTimeout(r, 15));
  const noiseFrom = `noise-${rnd()}@unrelated.example`;
  for (let i = 0; i < 220; i++) seedEmail(noiseFrom);

  const row = srcRow("rxo_email");
  const out = await rxoEmailAdapter.fetchLoads(row); // no limit, like the cron poller
  assert(
    "window: in-window RXO offer buried under 220 newer noise emails is still found",
    out.some((r) => String(r.from) === buriedFrom),
  );
  assert(
    "window: unrelated noise still filtered out",
    !out.some((r) => String(r.from) === noiseFrom),
  );
}

// ---------------------------------------------------------------------------
// 6) Parse-gate (fix a): a valid-sender email whose body has NO usable load
//    (no origin/dest) must be DROPPED by fetchLoads so the poller never mints an
//    empty $0 load the scorer silently discards. No API key (deleted above) → no
//    AI rescue, so the junk stays unmatched. A parseable offer is kept.
// ---------------------------------------------------------------------------
{
  const parseable = seedEmailWith(
    `ok-${rnd()}@rxo.com`,
    "Load",
    "Origin: Reno, NV\nDestination: Boise, ID\nRate: $1,500\nMiles: 420",
  );
  const junk = seedEmailWith(`junk-${rnd()}@rxo.com`, "Newsletter", "Thanks for reading — no loads here today.");
  const row = srcRow("rxo_email");
  const out = await rxoEmailAdapter.fetchLoads(row); // no limit → poller path, gate active
  assert("gate: parseable RXO offer kept", out.some((r) => String(r.from) === parseable));
  assert(
    "gate: unparseable RXO email dropped (no empty $0 load)",
    !out.some((r) => String(r.from) === junk),
  );
}

// ---------------------------------------------------------------------------
// 7) Задача-1 врезка: normalizeToLoad REUSES the parse fetchLoads attached
//    (raw.__parsed) instead of re-parsing the raw body — so AI-recovered fields
//    survive. The body here is deliberately unparseable: a re-parse would yield
//    empty endpoints, so reading Reno→Boise proves __parsed was used.
// ---------------------------------------------------------------------------
{
  const raw = {
    ingestId: `ig_${rnd()}`,
    from: "loadoffers@rxo.com",
    subject: "no lane in subject",
    body: "unparseable body — no field lines at all",
    messageId: `<${rnd()}@test.local>`,
    __parsed: {
      matched: true,
      origin: { city: "Reno", state: "NV" },
      destination: { city: "Boise", state: "ID" },
      rate: 1500,
      miles: 420,
      rawFields: {},
    },
  };
  const norm = rxoEmailAdapter.normalizeToLoad(raw, srcRow("rxo_email"));
  assert(
    "врезка: normalizeToLoad reuses __parsed endpoints (no re-parse)",
    norm.originCity === "Reno" && norm.destinationCity === "Boise",
    `origin=${norm.originCity} dest=${norm.destinationCity}`,
  );
  assert("врезка: normalizeToLoad reuses __parsed rate", norm.rate === 1500, `rate=${norm.rate}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
