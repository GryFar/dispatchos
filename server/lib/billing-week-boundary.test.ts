// Billing week-boundary integration test (temp DB).
// Run: npx tsx server/lib/billing-week-boundary.test.ts
//
// Regression for a real money bug: the billing trigger timestamp
// (payload.deliveredAt, post-2026-07 restructure) is a full ISO timestamp but
// the invoice week bounds are date-only strings. A naive `deliveredAt <=
// weekEnd` drops every load delivered ON the last day of the week (because
// "2026-06-14T15:30Z" > "2026-06-14" lexically), silently undercharging.
// The week is inclusive on both ends; this pins that against the new
// listDeliveredSourcedLoadsForClientWeek selector. All loads are platform-
// sourced (sourceId set) so provenance doesn't confound the boundary check.

import { tmpdir } from "node:os";
import { join } from "node:path";

// Unique per-run DB path: this test now writes platform-sourced loads, which
// carry a UNIQUE(source_id, source_external_id) index. A fixed path let a prior
// run's rows collide on re-insert (SQLITE_CONSTRAINT_UNIQUE); the timestamp
// isolates each run, matching the sibling billing tests.
process.env.DISPATCHOS_DB_PATH = join(
  tmpdir(),
  `dispatchos-billing-week-test-${Date.now()}-${process.pid}.db`,
);
const { storage } = await import("../storage");
const { computeInvoiceForWeek } = await import("./billing");

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

const clientId = `bill-client-${rnd()}`;
const WEEK_START = "2026-06-08";
const WEEK_END = "2026-06-14";

// A paying client whose 2× cap ($258 for fleet_scale) comfortably exceeds the
// $90 fee under test, so the monthly cap never confounds the boundary assertions.
storage.upsertClient({
  id: clientId, name: "Boundary Co", planTier: "fleet_scale", billingStatus: "active",
} as Parameters<typeof storage.upsertClient>[0]);

let seq = 0;
function mkLoad(deliveredAt: string, rate: number) {
  storage.upsertLoad({
    id: `load-bw-${rnd()}`,
    clientId,
    bookedAt: "2026-06-01T12:00:00.000Z", // booked earlier; billing keys on delivery
    deliveredAt,
    status: "completed",
    sourceId: "src-test",
    sourceExternalId: `ext-bw-${seq++}`,
    rate,
    brokerMc: "MC-1",
    brokerName: "B",
  } as Parameters<typeof storage.upsertLoad>[0]);
}

// First day, 00:30 UTC — must be included (lower bound inclusive).
mkLoad("2026-06-08T00:30:00.000Z", 1000);
// LAST day, 23:30 UTC — the bug dropped this. Must be included.
mkLoad("2026-06-14T23:30:00.000Z", 2000);
// Next week, 00:00 UTC — must be excluded.
mkLoad("2026-06-15T00:00:00.000Z", 5000);
// Day before the week — must be excluded.
mkLoad("2026-06-07T23:59:00.000Z", 7000);

const inv = computeInvoiceForWeek(clientId, WEEK_START, WEEK_END);

assert("exactly the 2 in-week loads counted", inv.breakdown.loadCount === 2, String(inv.breakdown.loadCount));
assert(
  "last-day load (23:30 on weekEnd) IS included",
  inv.breakdown.loads.some((l) => l.rateCents === 200000),
  JSON.stringify(inv.breakdown.loads.map((l) => l.rateCents)),
);
assert("gross = 1000 + 2000 = $3000", inv.grossBookedCents === 300000, String(inv.grossBookedCents));
assert("next-week load ($5000) excluded", !inv.breakdown.loads.some((l) => l.rateCents === 500000));
assert("prior-day load ($7000) excluded", !inv.breakdown.loads.some((l) => l.rateCents === 700000));
// 3% of $3000 = $90.
assert("percent fee = 3% of gross = $90", inv.percentFeeCents === 9000, String(inv.percentFeeCents));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
