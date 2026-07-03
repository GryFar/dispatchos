// Regression for the cancelled-load billing bug (audit finding:
// "Cancelled loads stay in grossBooked -> carrier billed 3% on revenue that
// never happened").
//
// UPDATED for the 2026-07 fee restructure: the 3% success fee now bills only
// PLATFORM-SOURCED loads (source_id NOT NULL) that were DELIVERED within the
// week (payload.deliveredAt in window). The cancelled-load exclusion still
// matters: a sourced+delivered load that is later cancelled must NOT be billed.
// listDeliveredSourcedLoadsForClientWeek excludes cancelled/canceled at the
// query layer and computeInvoiceForWeek keeps the defense-in-depth filter, so a
// cancelled load contributes 0 even if a stale deliveredAt lingers.
//
// Run: npx tsx server/lib/billing-cancelled-load.test.ts

import { tmpdir } from "node:os";
import { join } from "node:path";

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

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-cancelled-${Date.now()}.db`);
const { storage } = await import("../storage");
const { computeInvoiceForWeek, FLAT_FEE_CENTS } = await import("./billing");

const WS = "2026-06-08";
const WE = "2026-06-14";
const BOOKED = "2026-06-10";
const DELIVERED = "2026-06-11T18:30:00.000Z"; // inside [WS, WE]
const CLIENT = "C_cancelled";

// A paying client on fleet_scale ($129/mo → 2× cap $258) so the monthly cap
// doesn't clamp the $90 fee under test.
storage.upsertClient({ id: CLIENT, name: "Cancel Co", planTier: "fleet_scale", billingStatus: "active" } as any);

// Every load is platform-sourced (sourceId set) AND delivered in-window — the
// only axis under test here is the cancelled-status exclusion.
let seq = 0;
const mkSourced = (id: string, rate: number, extra: Record<string, unknown> = {}) =>
  storage.upsertLoad({
    ...baseLoad, id, rate, clientId: CLIENT, bookedAt: BOOKED,
    sourceId: "src-test", sourceExternalId: `ext-${seq++}`,
    deliveredAt: DELIVERED, status: "completed",
    ...extra,
  } as any);

// A normal sourced+delivered load — billable.
mkSourced("L_booked", 1000);
// A delivered-then-cancelled load — must NOT be billed (deliveredAt still set).
mkSourced("L_cancelled", 4000, { status: "cancelled" });
// The American-spelled alias must also be excluded.
mkSourced("L_canceled", 9000, { status: "canceled" });
// Another normal delivered load stays billable.
mkSourced("L_delivered", 2000);

const inv = computeInvoiceForWeek(CLIENT, WS, WE);

assert("cancelled + canceled loads excluded from the breakdown (2 of 4 remain)",
  inv.breakdown.loadCount === 2, `got ${inv.breakdown.loadCount}`);
assert("cancelled load contributes 0 to gross (only $1000 + $2000 count)",
  inv.grossBookedCents === 300_000, `got ${inv.grossBookedCents}`);
assert("percent fee is 3% of $3000 = $90, not 3% of the cancelled revenue",
  inv.percentFeeCents === 9_000, `got ${inv.percentFeeCents}`);
assert("delivered load IS still billed",
  inv.breakdown.loads.some((l) => l.loadId === "L_delivered"));
assert("cancelled load is NOT in the breakdown",
  !inv.breakdown.loads.some((l) => l.loadId === "L_cancelled" || l.loadId === "L_canceled"));
assert("total = flat $150 + $90 percent",
  inv.totalDueCents === FLAT_FEE_CENTS + 9_000, `got ${inv.totalDueCents}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
