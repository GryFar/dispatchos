// Regression for the negative-rate billing bug (security audit finding #1).
// A negative load rate -- bad feed data, a manual adjustment row, or an attempt
// to deflate the platform 3% fee -- used to flow straight into grossBookedCents
// (dollarsToCents preserves sign), zeroing/negating the invoice (one -$5000 load
// made percentFee = -$150, cancelling the $150 flat fee -> $0 due). Two layers:
//   1. billing floors each rate at 0 (Math.max(0, dollarsToCents(rate))) for ALL
//      write paths, incl. the Zod-bypassing feed ingest and legacy rows.
//   2. insertLoadSchema.rate is .nonnegative() so API/CSV input paths reject a
//      negative rate. The READ schema (loadSchema) is untouched, so stored rows
//      are never 400'd on read (the 470c0e9 trap).
// Run: npx tsx server/lib/billing-negative-rate.test.ts

import { tmpdir } from "node:os";
import { join } from "node:path";

import { insertLoadFullSchema } from "../../shared/schema";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

const baseLoad = {
  source: "test",
  originCity: "Dallas", originState: "TX", originLat: 32.7, originLng: -96.8,
  destinationCity: "Phoenix", destinationState: "AZ", destinationLat: 33.4, destinationLng: -112.0,
  loadedMiles: 1065,
  pickupAt: "2026-06-10T08:00:00.000Z", deliveryAt: "2026-06-11T18:00:00.000Z",
  equipment: "open_car_hauler",
  brokerName: "B", brokerMc: "MC-1",
  brokerScore: 70, fraudRisk: 5, marketQuality: 60,
};

// Layer 2: input schema rejects a negative rate (allows 0 and positive).
assert("insertLoadFullSchema rejects rate < 0",
  insertLoadFullSchema.safeParse({ ...baseLoad, rate: -1 }).success === false);
assert("insertLoadFullSchema accepts rate === 0",
  insertLoadFullSchema.safeParse({ ...baseLoad, rate: 0 }).success === true);
assert("insertLoadFullSchema accepts a positive rate",
  insertLoadFullSchema.safeParse({ ...baseLoad, rate: 1500 }).success === true);

// Layer 1: billing floors a stored negative rate (feed/legacy bypasses Zod).
process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-negrate-${Date.now()}.db`);
const { storage } = await import("../storage");
const { computeInvoiceForWeek, FLAT_FEE_CENTS } = await import("./billing");

const WS = "2026-06-08";
const WE = "2026-06-14";
const BOOKED = "2026-06-10";
const DELIVERED = "2026-06-11T12:00:00.000Z"; // inside [WS, WE]
// Post-2026-07 the fee bills only platform-sourced (sourceId) loads delivered
// in-window; give both loads that provenance + a paying client so the negative-
// rate flooring — not the source/delivery filter or the monthly cap — is what's
// under test.
storage.upsertClient({ id: "C_neg", name: "Neg Co", planTier: "oo_premium", billingStatus: "active" } as any);
storage.upsertLoad({ ...baseLoad, id: "L_pos", rate: 1000, clientId: "C_neg", bookedAt: BOOKED, sourceId: "src-test", sourceExternalId: "ext-pos", deliveredAt: DELIVERED, status: "completed" } as any);
storage.upsertLoad({ ...baseLoad, id: "L_neg", rate: -5000, clientId: "C_neg", bookedAt: BOOKED, sourceId: "src-test", sourceExternalId: "ext-neg", deliveredAt: DELIVERED, status: "completed" } as any);

const inv = computeInvoiceForWeek("C_neg", WS, WE);
assert("gross floors the -$5000 load (only +$1000 counts)",
  inv.grossBookedCents === 100_000, `got ${inv.grossBookedCents}`);
assert("percent fee never negative (3% of $1000 = $30)",
  inv.percentFeeCents === 3_000, `got ${inv.percentFeeCents}`);
assert("flat $150 fee preserved, not cancelled",
  inv.totalDueCents === FLAT_FEE_CENTS + 3_000, `got ${inv.totalDueCents}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
