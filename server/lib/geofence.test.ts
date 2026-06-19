// Geofence auto-checkin integration test (temp DB).
// Run: npx tsx server/lib/geofence.test.ts
//
// maybeAutoCheckin writes pickup_arrived / delivery_arrived when a driver's
// GPS ping lands within ARRIVAL_RADIUS_KM (1.6km) of a booked load's stop.
// Covers: pickup arrival, idempotency, delivery-requires-pickup-first,
// out-of-range, and the booked-only gate.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), "dispatchos-geofence-test.db");
const { storage } = await import("../storage");
const { maybeAutoCheckin } = await import("./geofence");

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

const PICKUP: [number, number] = [32.8, -96.8]; // Dallas-ish
const DEST: [number, number] = [33.5, -97.5];

function mkDriverWithLoad(booked: boolean) {
  const driver = storage.createUser({
    email: `geo-${rnd()}@example.com`,
    fullName: "Geo Driver",
    role: "driver",
    passwordSalt: "x",
    passwordHash: "y",
  });
  storage.upsertLoad({
    id: `load-geo-${rnd()}`,
    driverId: driver.id,
    ...(booked ? { bookedAt: "2026-05-01T00:00:00.000Z" } : {}),
    originLat: PICKUP[0],
    originLng: PICKUP[1],
    destinationLat: DEST[0],
    destinationLng: DEST[1],
    brokerMc: "MC-1",
    brokerName: "Broker",
    rate: 1000,
  } as Parameters<typeof storage.upsertLoad>[0]);
  return driver;
}

// --- happy path: pickup -> idempotent -> delivery -> idempotent ------------
{
  const driver = mkDriverWithLoad(true);

  const atPickup = maybeAutoCheckin(driver.id, 32.803, -96.803);
  assert("pickup arrival fires", atPickup.length === 1 && atPickup[0].kind === "pickup_arrived");
  assert("pickup distance within radius", atPickup[0]?.distanceKm < 1.6);

  const again = maybeAutoCheckin(driver.id, 32.803, -96.803);
  assert("pickup is idempotent (no duplicate)", again.length === 0);

  const atDelivery = maybeAutoCheckin(driver.id, 33.503, -97.503);
  assert(
    "delivery arrival fires after pickup",
    atDelivery.length === 1 && atDelivery[0].kind === "delivery_arrived",
  );

  const againDel = maybeAutoCheckin(driver.id, 33.503, -97.503);
  assert("delivery is idempotent", againDel.length === 0);

  const loadId = storage.listLoadsForDriver(driver.id).items[0].id;
  const kinds = storage.listCheckinsForLoad(loadId).map((c) => c.kind);
  assert("both arrival checkins persisted", kinds.includes("pickup_arrived") && kinds.includes("delivery_arrived"));
}

// --- delivery must NOT fire before pickup ----------------------------------
{
  const driver = mkDriverWithLoad(true);
  // Ping straight at the delivery point without ever hitting pickup.
  const res = maybeAutoCheckin(driver.id, 33.503, -97.503);
  assert("delivery does not fire before pickup", res.length === 0);
}

// --- out of range: no checkin ----------------------------------------------
{
  const driver = mkDriverWithLoad(true);
  const res = maybeAutoCheckin(driver.id, 40.0, -100.0); // hundreds of km away
  assert("far-away ping writes nothing", res.length === 0);
}

// --- not booked: gate blocks even at the pickup point ----------------------
{
  const driver = mkDriverWithLoad(false);
  const res = maybeAutoCheckin(driver.id, 32.803, -96.803);
  assert("unbooked load does not auto-checkin", res.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
