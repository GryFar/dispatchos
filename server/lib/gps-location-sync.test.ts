// GPS -> carrier location sync test (temp DB).
// Run: npx tsx server/lib/gps-location-sync.test.ts
//
// Latent core bug: recordLocationPing wrote driver_location_pings + users.last_*
// but NEVER updated client.currentLocation — which is the ONLY location
// scoreLoadForClient reads. So live driver GPS never reached the matcher;
// deadhead/ranking used the stale manual /loc position. Fix: sync the carrier's
// currentLocation from the ping for owner-operators (fleets share one carrier
// location across drivers, so they're intentionally left alone).

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-gps-sync-${Date.now()}.db`);
const { storage } = await import("../storage");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const rnd = () => Math.random().toString(36).slice(2, 10);
const near = (a: number, b: number) => Math.abs(a - b) < 0.001;

// --- owner-operator: GPS ping MUST move the carrier's currentLocation --------
const owner = storage.createUser({
  email: `oo-${rnd()}@e.com`, fullName: "OO", role: "driver",
  passwordSalt: "s", passwordHash: "h",
});
storage.claimMc(`MC-${Math.floor(100000 + Math.random() * 800000)}`, owner.id);
const ooClient = storage.provisionCarrierFromOnboarding(owner.id, {
  persona: "owner_operator", companyName: "OO Hauling", planTier: "oo_basic",
}) as { id: string };

const before = storage.getClient(ooClient.id) as any;
const beforeLat = before.currentLocation.lat;

// Driver streams a GPS fix near Dallas.
storage.recordLocationPing({
  userId: owner.id, lat: 32.776, lng: -96.797,
  source: "osmand", capturedAt: new Date().toISOString(),
});

const after = storage.getClient(ooClient.id) as any;
assert("owner-op carrier location moved to the GPS fix", near(after.currentLocation.lat, 32.776) && near(after.currentLocation.lng, -96.797), JSON.stringify(after.currentLocation));
assert("it actually changed (was different before)", beforeLat !== after.currentLocation.lat);
assert("source recorded as live_gps", after.currentLocation.source === "live_gps", after.currentLocation.source);
assert("updatedAt is fresh (location confidence won't nag)", typeof after.currentLocation.updatedAt === "string");
// the ping itself is still recorded
assert("ping row still written", storage.listLocationPings(owner.id).length >= 1);

// --- fleet: a hired driver's GPS must NOT thrash the shared carrier location --
const fleetOwner = storage.createUser({
  email: `fo-${rnd()}@e.com`, fullName: "FO", role: "driver",
  passwordSalt: "s", passwordHash: "h",
});
storage.claimMc(`MC-${Math.floor(100000 + Math.random() * 800000)}`, fleetOwner.id);
const fleetClient = storage.provisionCarrierFromOnboarding(fleetOwner.id, {
  persona: "fleet", companyName: "Fleet LLC", planTier: "fleet_pro",
}) as { id: string };
const hired = storage.createUser({
  email: `hd-${rnd()}@e.com`, fullName: "Hired", role: "driver",
  passwordSalt: "s", passwordHash: "h", linkedClientId: fleetClient.id,
});
const fleetBefore = storage.getClient(fleetClient.id) as any;
storage.recordLocationPing({
  userId: hired.id, lat: 25.761, lng: -80.191,
  source: "osmand", capturedAt: new Date().toISOString(),
});
const fleetAfter = storage.getClient(fleetClient.id) as any;
assert("fleet carrier location NOT moved by a hired driver's GPS", fleetAfter.currentLocation.lat === fleetBefore.currentLocation.lat, JSON.stringify(fleetAfter.currentLocation));
assert("but the hired driver's ping was still recorded", storage.listLocationPings(hired.id).length >= 1);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
