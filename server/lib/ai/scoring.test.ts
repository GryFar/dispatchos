// Smoke tests for the load scoring engine. Run via:
//   npx tsx server/lib/ai/scoring.test.ts

import {
  haversineMiles,
  computeEconomics,
  computeFeasibility,
  computeDispatchScore,
  scoreLoadForClient,
  rankLoadsForClient,
} from "./scoring";
import type { Client, Load, DriverLocation } from "@shared/schema";

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

function approx(a: number, b: number, tol = 0.5) {
  return Math.abs(a - b) <= tol;
}

// ---------------------------------------------------------------------------
// haversineMiles
// ---------------------------------------------------------------------------
{
  // Miami (25.76, -80.19) to Atlanta (33.75, -84.39) ≈ 607 mi great-circle
  const d = haversineMiles(25.76, -80.19, 33.75, -84.39);
  assert("haversine: Miami → Atlanta ≈ 607mi", approx(d, 607, 5), `got ${d.toFixed(1)}`);

  // Same point = 0
  assert("haversine: same point = 0", haversineMiles(40, -100, 40, -100) === 0);
}

// ---------------------------------------------------------------------------
// computeEconomics
// ---------------------------------------------------------------------------
{
  const econ = computeEconomics({
    rate: 2100,
    loadedMiles: 650,
    deadheadMiles: 80,
    mpg: 9,
    fuelPrice: 4.0,
  });
  // total = 730 miles
  // fuel = 730/9 * 4 ≈ $324.44
  // fixed = 730 * 0.45 = $328.50
  // factoring = 2100 * 0.03 = $63
  // dispatch fee = 2100 * 0.03 = $63
  // net = 2100 - 324.44 - 328.50 - 63 - 63 = $1321.06
  assert("econ: totalMiles", econ.totalMiles === 730);
  assert("econ: fuelCost ≈ 324.44", approx(econ.fuelCost, 324.44, 0.5));
  assert("econ: fixedCost = 328.50", approx(econ.fixedCost, 328.5, 0.01));
  assert("econ: estimatedNet ≈ 1321", approx(econ.estimatedNet, 1321, 5));
  assert("econ: loadedPpm = 3.23", approx(econ.loadedPpm, 3.23, 0.01));
  assert("econ: netPpmTotal ≈ 1.81", approx(econ.netPpmTotal, 1.81, 0.05));
}

// ---------------------------------------------------------------------------
// computeFeasibility
// ---------------------------------------------------------------------------
{
  const now = new Date();
  const tightPickup = new Date(now.getTime() + 60 * 60 * 1000); // 60 min away
  // 80 miles deadhead at 50 mph = 96 minutes — tight or not feasible
  const f1 = computeFeasibility({
    deadheadMiles: 80,
    pickupAt: tightPickup.toISOString(),
    driverLocationUpdatedAt: now.toISOString(),
  });
  assert("feasibility: 80mi to 60min pickup → not_feasible", f1.pickupFeasibility === "not_feasible");

  const easyPickup = new Date(now.getTime() + 6 * 60 * 60 * 1000); // 6h away
  const f2 = computeFeasibility({
    deadheadMiles: 80,
    pickupAt: easyPickup.toISOString(),
    driverLocationUpdatedAt: now.toISOString(),
  });
  assert("feasibility: 80mi to 6h pickup → easy", f2.pickupFeasibility === "easy");

  const stale = new Date(now.getTime() - 8 * 60 * 60 * 1000); // 8h old
  const f3 = computeFeasibility({
    deadheadMiles: 50,
    pickupAt: easyPickup.toISOString(),
    driverLocationUpdatedAt: stale.toISOString(),
  });
  assert("feasibility: stale 8h location → low confidence", f3.locationConfidence === "low");
}

// ---------------------------------------------------------------------------
// computeDispatchScore
// ---------------------------------------------------------------------------
{
  // Strong fit: hits target PPM, clean broker, easy pickup
  const s1 = computeDispatchScore({
    netPpmTotal: 2.5,
    targetPpm: 2.2,
    minimumPpm: 1.8,
    deadheadRatio: 0.1,
    brokerScore: 90,
    fraudRisk: 5,
    marketQuality: 80,
    pickupFeasibility: "easy",
    locationConfidence: "high",
  });
  assert("score: strong fit ≥ 85", s1.dispatchScore >= 85, `got ${s1.dispatchScore}`);
  assert("score: strong fit no warnings", s1.warnings.length === 0);

  // Weak: below minimum + sketchy broker
  const s2 = computeDispatchScore({
    netPpmTotal: 1.5,
    targetPpm: 2.2,
    minimumPpm: 1.8,
    deadheadRatio: 0.5,
    brokerScore: 40,
    fraudRisk: 75,
    marketQuality: 50,
    pickupFeasibility: "tight",
    locationConfidence: "medium",
  });
  assert("score: weak load ≤ 35", s2.dispatchScore <= 35, `got ${s2.dispatchScore}`);
  assert("score: weak load has warnings", s2.warnings.length >= 3);
}

// ---------------------------------------------------------------------------
// scoreLoadForClient — full pipeline
// ---------------------------------------------------------------------------
{
  const client: Client = {
    id: "c1",
    name: "Ivan Petrov",
    mc: "MC1234567",
    equipment: "open_car_hauler",
    targetPpm: 2.2,
    minimumPpm: 1.8,
    mpg: 9,
    fuelPrice: 4.0,
  } as Client;

  const driverLocation: DriverLocation = {
    city: "Miami",
    state: "FL",
    lat: 25.76,
    lng: -80.19,
    source: "gps" as any,
    updatedAt: new Date().toISOString(),
    status: "available" as any,
    availableAt: new Date().toISOString(),
  };

  const goodLoad: Load = {
    id: "L1",
    source: "central_dispatch",
    originCity: "Miami",
    originState: "FL",
    originLat: 25.9,
    originLng: -80.3,
    destinationCity: "Atlanta",
    destinationState: "GA",
    destinationLat: 33.75,
    destinationLng: -84.39,
    rate: 2100,
    loadedMiles: 650,
    pickupAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
    deliveryAt: new Date(Date.now() + 36 * 3600 * 1000).toISOString(),
    equipment: "open_car_hauler",
    brokerName: "TQL",
    brokerMc: "MC470488",
    brokerScore: 88,
    fraudRisk: 8,
    marketQuality: 75,
  };

  const scored = scoreLoadForClient({ load: goodLoad, client, driverLocation });
  assert("scored: clean load → not skip", scored.verdict !== "skip", `verdict=${scored.verdict}`);
  assert("scored: dispatchScore present", scored.dispatchScore > 0);
  assert("scored: rankReason populated", scored.rankReason.length > 10);

  // Mismatched equipment → must be skip
  const wrongEquip = { ...goodLoad, equipment: "sprinter_van" as const };
  const scoredWrong = scoreLoadForClient({ load: wrongEquip, client, driverLocation });
  assert("scored: equipment mismatch → skip", scoredWrong.verdict === "skip");

  // High fraud risk → skip
  const fraudyLoad = { ...goodLoad, fraudRisk: 80 };
  const scoredFraud = scoreLoadForClient({ load: fraudyLoad, client, driverLocation });
  assert("scored: high fraud → skip", scoredFraud.verdict === "skip");

  // Low rate → negotiate, with counter-offer
  const cheapLoad = { ...goodLoad, rate: 1500 };
  const scoredCheap = scoreLoadForClient({ load: cheapLoad, client, driverLocation });
  if (scoredCheap.verdict === "negotiate") {
    assert(
      "scored: negotiate → counter > original",
      scoredCheap.counterOffer !== null && scoredCheap.counterOffer > 1500,
      `counter=${scoredCheap.counterOffer}`,
    );
  } else {
    assert("scored: low rate → not book", scoredCheap.verdict !== "book");
  }
}

// ---------------------------------------------------------------------------
// rankLoadsForClient
// ---------------------------------------------------------------------------
{
  const client: Client = {
    id: "c1",
    name: "Test",
    mc: "MC1",
    equipment: "open_car_hauler",
    targetPpm: 2.2,
    minimumPpm: 1.8,
    mpg: 9,
    fuelPrice: 4.0,
  } as Client;
  const driverLocation: DriverLocation = {
    city: "Miami",
    state: "FL",
    lat: 25.76,
    lng: -80.19,
    source: "gps" as any,
    updatedAt: new Date().toISOString(),
    status: "available" as any,
    availableAt: new Date().toISOString(),
  };
  const baseLoad: Load = {
    id: "L",
    source: "cd",
    originCity: "Miami",
    originState: "FL",
    originLat: 25.9,
    originLng: -80.3,
    destinationCity: "Atlanta",
    destinationState: "GA",
    destinationLat: 33.75,
    destinationLng: -84.39,
    rate: 2100,
    loadedMiles: 650,
    pickupAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
    deliveryAt: new Date(Date.now() + 36 * 3600 * 1000).toISOString(),
    equipment: "open_car_hauler",
    brokerName: "TQL",
    brokerMc: "MC1",
    brokerScore: 88,
    fraudRisk: 8,
    marketQuality: 75,
  };
  const loads: Load[] = [
    { ...baseLoad, id: "premium", rate: 2400, brokerScore: 95, fraudRisk: 3 },
    { ...baseLoad, id: "skip-fraud", fraudRisk: 90 },
    { ...baseLoad, id: "skip-equip", equipment: "sprinter_van" },
    { ...baseLoad, id: "ok", rate: 2000 },
    { ...baseLoad, id: "lowppm", rate: 1300 },
  ];
  const ranked = rankLoadsForClient(loads, client, driverLocation, { topN: 3 });
  assert("rank: returns ≤ topN", ranked.length <= 3);
  assert("rank: all kept loads non-skip", ranked.every((s) => s.verdict !== "skip"));
  assert("rank: descending by score", ranked.every((s, i, arr) => i === 0 || s.dispatchScore <= arr[i - 1].dispatchScore));
  assert("rank: top is the premium load", ranked[0]?.id === "premium");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
