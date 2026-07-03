// Generic email adapter test (temp DB).
// Run: npx tsx server/lib/adapters/generic-email.test.ts
//
// The five named broker-email adapters only ingest mail from hardcoded sender
// domains (rxo.com, tql.com, ...). A carrier whose broker isn't one of those
// couldn't ingest at all. The generic adapter ('email_generic') ships with NO
// sender domains, so the carrier scopes it via config (inboundAddress and/or
// senderDomains) — enforced by authenticate — and it reuses the same parser.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-generic-email-${Date.now()}.db`);
// fetchLoads now gates on parsed.matched and AI-assists incomplete parses on the
// no-limit path; drop any key so this scoping test stays offline + deterministic.
delete process.env.ANTHROPIC_API_KEY;
const { storage } = await import("../../storage");
const { getAdapter, listAdapters } = await import("./index");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// --- registration -----------------------------------------------------------
const adapter = getAdapter("email_generic");
assert("getAdapter('email_generic') resolves", !!adapter);
assert("registered as implemented", listAdapters().some((a) => a.key === "email_generic" && a.implemented));
assert("requires no credentials", adapter!.requiresCredentials === false);

// --- authenticate guard -----------------------------------------------------
function row(configJson: Record<string, unknown>): any {
  return { id: "src-gen", clientId: "c1", adapterKey: "email_generic", configJson };
}
let threw = false;
try { await adapter!.authenticate(row({})); } catch { threw = true; }
assert("authenticate throws with no scoping config", threw);

let ok = true;
try { await adapter!.authenticate(row({ inboundAddress: "loads+ivan@dispatchos.co" })); } catch { ok = false; }
assert("authenticate passes with inboundAddress", ok);

ok = true;
try { await adapter!.authenticate(row({ senderDomains: ["mybroker.com"] })); } catch { ok = false; }
assert("authenticate passes with senderDomains", ok);

// --- fetchLoads scoping -----------------------------------------------------
// Seed three emails; only the one TO our sub-address AND FROM our domain matches.
storage.saveEmailIngest({
  from: "dispatch@mybroker.com",
  to: "loads+ivan@dispatchos.co",
  subject: "Load offer",
  // Parseable, complete load — fetchLoads now drops emails that don't parse to a
  // matched load (fix a), so the one email this test expects back must parse.
  body: "Origin: Dallas, TX\nDestination: Atlanta, GA\nRate: $2,400\nMiles: 780\nPickup: 2026-07-10",
});
storage.saveEmailIngest({
  from: "dispatch@mybroker.com",
  to: "loads+someoneelse@dispatchos.co", // different carrier's sub-address
  subject: "Load offer",
  body: "Miami, FL to Newark, NJ — 1280 mi — $3200",
});
storage.saveEmailIngest({
  from: "spam@randomdomain.com", // not our broker domain
  to: "loads+ivan@dispatchos.co",
  subject: "Load offer",
  body: "Chicago, IL to Denver, CO — 1000 mi — $1800",
});

const srcRow = row({ inboundAddress: "loads+ivan@dispatchos.co", senderDomains: ["mybroker.com"] });
const raws = await adapter!.fetchLoads(srcRow);
assert("fetchLoads returns only the matching email", raws.length === 1, `got ${raws.length}`);
assert("matched email is the right one (to+from)", String((raws[0] as any)?.to ?? "").includes("ivan") && String((raws[0] as any)?.from ?? "").includes("mybroker"));
// (the matched row carries the email fields for normalizeToLoad to parse)
assert("matched row carries the body for parsing", typeof (raws[0] as any)?.body === "string");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
