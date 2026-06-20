// Scorer fuel-pricing test (temp DB).
// Run: npx tsx server/lib/fuel-routing-scorer.test.ts
//
// Latent core bug: scoreLoadForClient computed fuelCost from the STATIC
// client.fuelPrice (set once at onboarding, ~$3.60) and never called
// getRouteFuelPrice — even though that function + the EIA refresh cron exist to
// give real regional diesel. So a California load (real ~$5.18/gal) was priced
// at $3.60/gal — ~44% under real fuel — inflating its net profit and ranking.
// This verifies the scorer now uses the per-route price.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-fuel-scorer-${Date.now()}.db`);
const { storage } = await import("../storage");
const { scoreLoadForClient } = await import("../routes");
const { getRouteFuelPrice } = await import("./ai/fuel");
import type { Client, Load } from "@shared/schema";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const rnd = () => Math.random().toString(36).slice(2, 10);

const STATIC_PRICE = 3.6;
const MPG = 8;

const owner = storage.createUser({
  email: `o-${rnd()}@e.com`, fullName: "O", role: "driver", passwordSalt: "s", passwordHash: "h",
});
storage.claimMc(`MC-${Math.floor(100000 + Math.random() * 800000)}`, owner.id);
const carrier = storage.provisionCarrierFromOnboarding(owner.id, {
  persona: "owner_operator", companyName: "Fuel Test", planTier: "oo_basic",
}) as { id: string };
storage.upsertClient({
  ...(storage.getClient(carrier.id) as any),
  equipment: "open_car_hauler",
  mpg: MPG,
  fuelPrice: STATIC_PRICE,
  currentLocation: {
    city: "Los Angeles", state: "CA", lat: 34.05, lng: -118.24,
    source: "manual_checkin", updatedAt: new Date().toISOString(),
    status: "empty", availableAt: new Date().toISOString(),
  },
} as any);

// A California load (PADD5 = expensive diesel).
const load: Load = {
  id: `load-${rnd()}`, source: "test",
  originCity: "Los Angeles", originState: "CA", originLat: 34.05, originLng: -118.24,
  destinationCity: "Los Angeles", destinationState: "CA", destinationLat: 34.05, destinationLng: -118.24,
  rate: 2400, loadedMiles: 600,
  pickupAt: new Date(Date.now() + 3600_000).toISOString(),
  deliveryAt: new Date(Date.now() + 9 * 3600_000).toISOString(),
  equipment: "open_car_hauler",
  brokerName: "Acme", brokerMc: "MC-100200",
  brokerScore: 80, fraudRisk: 5, marketQuality: 70,
} as unknown as Load;
storage.upsertLoad(load as any);

const client = storage.getClient(carrier.id) as Client;
const scored = scoreLoadForClient(client, load, false)!;
assert("CA load scores", !!scored);

const routePrice = getRouteFuelPrice("CA", "CA").price;
assert("CA route diesel is well above the static price", routePrice > STATIC_PRICE * 1.2, `route=${routePrice} static=${STATIC_PRICE}`);

const expectedRouteFuel = Math.round((scored.totalMiles / MPG) * routePrice);
const wouldBeStaticFuel = Math.round((scored.totalMiles / MPG) * STATIC_PRICE);
assert("scorer fuelCost uses the ROUTE price", scored.fuelCost === expectedRouteFuel, `got ${scored.fuelCost}, route-expected ${expectedRouteFuel}`);
assert("scorer fuelCost is NOT the static-price value (the bug)", scored.fuelCost !== wouldBeStaticFuel, `static would be ${wouldBeStaticFuel}`);
assert("real fuel is materially higher (was under-counted)", scored.fuelCost > wouldBeStaticFuel * 1.2);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
