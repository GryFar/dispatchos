// Fuel-transaction write-path + IFTA gallons integration test (temp DB).
// Run: npx tsx server/lib/fuel-transactions.test.ts
//
// Before this, fuel_transactions had no writer, so buildIftaQuarterly always
// reported 0 gallons. This proves recordFuelTransaction feeds the IFTA
// gallons-per-state aggregation (state inferred from station coords).

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), "dispatchos-fueltx-test.db");
const { storage } = await import("../storage");
const { buildIftaQuarterly } = await import("./ifta");

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
const near = (got: number, want: number, tol: number) => Math.abs(got - want) <= tol;

const clientId = `fuel-client-${rnd()}`;
const driver = storage.createUser({
  email: `fuel-driver-${rnd()}@example.com`,
  fullName: "Fuel Driver",
  role: "driver",
  passwordSalt: "x",
  passwordHash: "y",
  linkedClientId: clientId,
});

// Two fuel stops in Q2 2026: 50 gal in TX, 30 gal in OK.
const tx1 = storage.recordFuelTransaction({
  userId: driver.id,
  clientId,
  fuelType: "diesel",
  gallons: 50,
  pricePerGallonCents: 430,
  totalCents: 21500,
  stationName: "Pilot Dallas",
  stationLat: 32.8, // TX
  stationLng: -96.8,
  occurredAt: "2026-05-15T12:00:00.000Z",
});
storage.recordFuelTransaction({
  userId: driver.id,
  clientId,
  fuelType: "diesel",
  gallons: 30,
  pricePerGallonCents: 440,
  totalCents: 13200,
  stationName: "Loves OKC",
  stationLat: 35.5, // OK
  stationLng: -97.5,
  occurredAt: "2026-05-20T09:00:00.000Z",
});
// Outside the quarter — must be excluded.
storage.recordFuelTransaction({
  userId: driver.id,
  clientId,
  fuelType: "diesel",
  gallons: 99,
  pricePerGallonCents: 400,
  totalCents: 39600,
  stationLat: 32.8,
  stationLng: -96.8,
  occurredAt: "2026-08-01T09:00:00.000Z", // Q3
});

// getFuelTransaction round-trips.
const got = storage.getFuelTransaction(tx1);
assert("getFuelTransaction round-trips", got?.gallons === 50 && got?.totalCents === 21500);
assert("station + fuel type stored", got?.stationName === "Pilot Dallas" && got?.fuelType === "diesel");

const q2 = buildIftaQuarterly(clientId, 2026, 2);
const tx = q2.rows.find((r) => r.state === "TX");
const ok = q2.rows.find((r) => r.state === "OK");

assert("TX gallons attributed (was always 0 before)", !!tx && near(tx.gallons, 50, 0.01), JSON.stringify(tx));
assert("OK gallons attributed", !!ok && near(ok.gallons, 30, 0.01), JSON.stringify(ok));
assert("TX fuel cost in USD", !!tx && near(tx.fuelCostUsd, 215, 0.01), JSON.stringify(tx));
assert("total gallons = 80 (Q3 stop excluded)", near(q2.totals.gallons, 80, 0.01), String(q2.totals.gallons));
assert("Q3 stop not in Q2", !near(q2.totals.gallons, 179, 0.01));

// Quarter isolation: the August stop shows up in Q3.
const q3 = buildIftaQuarterly(clientId, 2026, 3);
assert("Q3 has the 99-gal stop", near(q3.totals.gallons, 99, 0.01), String(q3.totals.gallons));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
