// Regression for the cancelled-load billing bug (audit finding:
// "Cancelled loads stay in grossBooked -> carrier billed 3% on revenue that
// never happened").
//
// booked_at is the revenue-window key and is NEVER cleared on cancel, so
// cancelling a load only stamps `status: "cancelled"` in the payload. The
// window query (listBookedLoadsForClientWeek) has no status predicate, so a
// booked-then-cancelled load used to flow into grossBookedCents and get charged
// the 3% percent fee on revenue that never happened. computeInvoiceForWeek now
// drops cancelled/canceled loads before summing. Delivered/completed loads stay
// billable.
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
const CLIENT = "C_cancelled";

// A normal booked load — billable.
storage.upsertLoad({ ...baseLoad, id: "L_booked", rate: 1000, clientId: CLIENT, bookedAt: BOOKED } as any);
// A booked-then-cancelled load — must NOT be billed (booked_at still set).
storage.upsertLoad({ ...baseLoad, id: "L_cancelled", rate: 4000, clientId: CLIENT, bookedAt: BOOKED, status: "cancelled" } as any);
// The American-spelled alias must also be excluded.
storage.upsertLoad({ ...baseLoad, id: "L_canceled", rate: 9000, clientId: CLIENT, bookedAt: BOOKED, status: "canceled" } as any);
// A delivered/completed load stays billable (revenue did happen).
storage.upsertLoad({ ...baseLoad, id: "L_delivered", rate: 2000, clientId: CLIENT, bookedAt: BOOKED, status: "delivered" } as any);

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
