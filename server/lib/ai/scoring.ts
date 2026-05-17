// AI-driven load scoring engine for DispatchOS.
//
// Pure deterministic logic — no LLM. Takes a Load + a Client (driver) and
// returns a ScoredLoad with verdict, net economics, and human-readable
// reasoning. This is the engine behind /api/dispatch/suggestions.
//
// Design goals:
//  • Sub-15 ms per load (called many times per request when ranking 100+ loads).
//  • Deterministic — same inputs always produce same output. No randomness.
//  • Explainable — `rankReason` and `warnings` give the dispatcher human text
//    so they don't blindly trust the score.
//  • Conservative — when in doubt, prefer "skip" over "book". Trucking margin
//    is too thin to take fraud or lossy loads.

import type { Load, ScoredLoad, Client, DriverLocation } from "@shared/schema";

// ---------------------------------------------------------------------------
// Tunable parameters — adjust as we calibrate against real data
// ---------------------------------------------------------------------------

const FIXED_COST_PER_MILE = 0.45; // insurance + truck payments + maintenance
const FACTORING_RATE = 0.03; // 3% via UC Factors / RTS — assumed for all clients
const DEFAULT_DISPATCH_FEE_PCT = 0.03; // our 3%

// Pickup feasibility — how many miles per hour we assume a truck can actually
// cover under DOT HOS rules. Conservative: 50 mph average including breaks.
const TRUCK_AVG_MPH = 50;

// Verdict thresholds on dispatchScore (0-100)
const SCORE_BOOK_THRESHOLD = 75;
const SCORE_NEGOTIATE_THRESHOLD = 50;

// ---------------------------------------------------------------------------
// Geo helpers
// ---------------------------------------------------------------------------

/** Haversine distance in miles between two lat/lng points. */
export function haversineMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 3958.8; // Earth radius in miles
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ---------------------------------------------------------------------------
// Cost & profit math
// ---------------------------------------------------------------------------

interface EconomicsInput {
  rate: number; // gross paid by broker
  loadedMiles: number;
  deadheadMiles: number;
  mpg: number; // truck MPG (typically 7-10 for hotshot, 8-12 for car hauler)
  fuelPrice: number; // $/gallon, current diesel price
  dispatchFeePct?: number; // optional override; default 3%
}

interface EconomicsOutput {
  totalMiles: number;
  fuelCost: number;
  fixedCost: number;
  factoringCost: number;
  dispatchFee: number;
  estimatedNet: number; // what the driver actually keeps
  loadedPpm: number; // gross / loaded
  totalPpm: number; // gross / (loaded + deadhead)
  netPpmTotal: number; // net / (loaded + deadhead) — the only PPM that matters
}

/** Compute load economics given truck profile. */
export function computeEconomics(input: EconomicsInput): EconomicsOutput {
  const totalMiles = input.loadedMiles + input.deadheadMiles;
  const fuelCost = (totalMiles / input.mpg) * input.fuelPrice;
  const fixedCost = totalMiles * FIXED_COST_PER_MILE;
  const factoringCost = input.rate * FACTORING_RATE;
  const dispatchFee = input.rate * (input.dispatchFeePct ?? DEFAULT_DISPATCH_FEE_PCT);
  const estimatedNet = input.rate - fuelCost - fixedCost - factoringCost - dispatchFee;

  return {
    totalMiles,
    fuelCost: round2(fuelCost),
    fixedCost: round2(fixedCost),
    factoringCost: round2(factoringCost),
    dispatchFee: round2(dispatchFee),
    estimatedNet: round2(estimatedNet),
    loadedPpm: round2(input.rate / input.loadedMiles),
    totalPpm: round2(input.rate / totalMiles),
    netPpmTotal: round2(estimatedNet / totalMiles),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Pickup feasibility
// ---------------------------------------------------------------------------

interface FeasibilityInput {
  deadheadMiles: number;
  pickupAt: string; // ISO timestamp
  driverLocationUpdatedAt: string;
}

interface FeasibilityOutput {
  pickupBufferMinutes: number; // how much slack the driver has
  pickupFeasibility: "easy" | "tight" | "not_feasible";
  locationConfidence: "high" | "medium" | "low";
  locationAgeMinutes: number;
}

/**
 * Determine if the truck can physically reach the pickup in time.
 * Returns the buffer (positive = on time with slack, negative = late).
 */
export function computeFeasibility(input: FeasibilityInput): FeasibilityOutput {
  const now = Date.now();
  const pickupTime = new Date(input.pickupAt).getTime();
  const minutesAvailable = (pickupTime - now) / (60 * 1000);
  const minutesNeeded = (input.deadheadMiles / TRUCK_AVG_MPH) * 60;
  const pickupBufferMinutes = Math.round(minutesAvailable - minutesNeeded);

  let pickupFeasibility: FeasibilityOutput["pickupFeasibility"];
  if (pickupBufferMinutes < 0) pickupFeasibility = "not_feasible";
  else if (pickupBufferMinutes < 90) pickupFeasibility = "tight";
  else pickupFeasibility = "easy";

  // Location confidence depends on freshness of last GPS check-in.
  const locationAgeMinutes = Math.max(
    0,
    Math.round((now - new Date(input.driverLocationUpdatedAt).getTime()) / (60 * 1000)),
  );
  let locationConfidence: FeasibilityOutput["locationConfidence"];
  if (locationAgeMinutes < 60) locationConfidence = "high";
  else if (locationAgeMinutes < 360) locationConfidence = "medium";
  else locationConfidence = "low";

  return { pickupBufferMinutes, pickupFeasibility, locationConfidence, locationAgeMinutes };
}

// ---------------------------------------------------------------------------
// Dispatch score (0-100)
// ---------------------------------------------------------------------------

interface ScoreInputs {
  netPpmTotal: number;
  targetPpm: number;
  minimumPpm: number;
  deadheadRatio: number; // 0-1
  brokerScore: number; // 0-100, from FMCSA + history
  fraudRisk: number; // 0-100
  marketQuality: number; // 0-100, lane benchmark
  pickupFeasibility: "easy" | "tight" | "not_feasible";
  locationConfidence: "high" | "medium" | "low";
}

interface ScoreOutput {
  dispatchScore: number;
  warnings: string[];
}

/**
 * Combine signals into a single 0-100 dispatch score.
 *
 * Weights are tuned for a hot-shot / car-hauler dispatcher who values:
 *   1. Net economics (PPM vs target) — 40%
 *   2. Broker trust + fraud risk — 25%
 *   3. Pickup feasibility — 15%
 *   4. Lane / market quality — 10%
 *   5. Deadhead efficiency — 10%
 */
export function computeDispatchScore(inputs: ScoreInputs): ScoreOutput {
  const warnings: string[] = [];

  // 1. PPM vs target — log curve so we don't over-reward huge PPM,
  //    but we heavily punish below-minimum.
  let ppmComponent: number;
  if (inputs.netPpmTotal < inputs.minimumPpm) {
    ppmComponent = 0;
    warnings.push(
      `Net PPM $${inputs.netPpmTotal.toFixed(2)} below minimum $${inputs.minimumPpm.toFixed(2)}`,
    );
  } else if (inputs.netPpmTotal >= inputs.targetPpm) {
    ppmComponent = 100;
  } else {
    const range = inputs.targetPpm - inputs.minimumPpm;
    ppmComponent = ((inputs.netPpmTotal - inputs.minimumPpm) / range) * 100;
  }

  // 2. Broker trust = brokerScore minus fraud penalty.
  const brokerComponent = Math.max(0, inputs.brokerScore - inputs.fraudRisk);
  if (inputs.fraudRisk >= 60) {
    warnings.push(`High fraud risk (${inputs.fraudRisk}/100) — verify broker by phone`);
  } else if (inputs.fraudRisk >= 30) {
    warnings.push(`Moderate fraud risk (${inputs.fraudRisk}/100)`);
  }
  if (inputs.brokerScore < 50) {
    warnings.push(`Low broker score (${inputs.brokerScore}/100) — limited history`);
  }

  // 3. Pickup feasibility
  let feasibilityComponent: number;
  switch (inputs.pickupFeasibility) {
    case "easy":
      feasibilityComponent = 100;
      break;
    case "tight":
      feasibilityComponent = 50;
      warnings.push("Tight pickup window — under 90 min buffer");
      break;
    case "not_feasible":
      feasibilityComponent = 0;
      warnings.push("Pickup not feasible at current truck speed");
      break;
  }
  if (inputs.locationConfidence === "low") {
    warnings.push("Driver location data is stale (>6h) — confirm before booking");
  }

  // 4. Market quality
  const marketComponent = inputs.marketQuality;

  // 5. Deadhead efficiency — punish high deadhead ratios.
  let deadheadComponent: number;
  if (inputs.deadheadRatio < 0.1) deadheadComponent = 100;
  else if (inputs.deadheadRatio < 0.25) deadheadComponent = 80;
  else if (inputs.deadheadRatio < 0.4) deadheadComponent = 50;
  else {
    deadheadComponent = 20;
    warnings.push(`High deadhead ${Math.round(inputs.deadheadRatio * 100)}%`);
  }

  const dispatchScore = Math.round(
    0.4 * ppmComponent +
      0.25 * brokerComponent +
      0.15 * feasibilityComponent +
      0.1 * marketComponent +
      0.1 * deadheadComponent,
  );

  return { dispatchScore: clamp(dispatchScore, 0, 100), warnings };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------
// Counter-offer suggestion
// ---------------------------------------------------------------------------

/**
 * If verdict is "negotiate", suggest a counter rate that brings net PPM up
 * to the target. Returns null if already at/above target.
 */
function suggestCounter(
  load: Load,
  client: Client,
  deadheadMiles: number,
): number | null {
  const totalMiles = load.loadedMiles + deadheadMiles;
  // Solve for rate where netPpmTotal = targetPpm
  // estimatedNet = rate - fuelCost - fixedCost - rate*0.03 - rate*0.03
  // estimatedNet = rate * 0.94 - (fuelCost + fixedCost)
  // netPpmTotal = estimatedNet / totalMiles = targetPpm
  // => rate = (targetPpm * totalMiles + fuelCost + fixedCost) / 0.94
  const fuelCost = (totalMiles / client.mpg) * client.fuelPrice;
  const fixedCost = totalMiles * FIXED_COST_PER_MILE;
  const targetGross =
    (client.targetPpm * totalMiles + fuelCost + fixedCost) /
    (1 - FACTORING_RATE - DEFAULT_DISPATCH_FEE_PCT);
  // Don't suggest a counter higher than 25% above current rate — brokers won't
  // entertain it.
  const cappedCounter = Math.min(targetGross, load.rate * 1.25);
  if (cappedCounter <= load.rate) return null;
  return Math.round(cappedCounter / 25) * 25; // round to nearest $25 — broker convention
}

// ---------------------------------------------------------------------------
// Public API: scoreLoadForClient
// ---------------------------------------------------------------------------

export interface ScoreLoadInput {
  load: Load;
  client: Client;
  driverLocation: DriverLocation;
}

/**
 * Score a single load against a single driver. Returns a fully populated
 * `ScoredLoad` ready for the dispatcher pipeline.
 */
export function scoreLoadForClient(input: ScoreLoadInput): ScoredLoad {
  const { load, client, driverLocation } = input;

  const deadheadMiles = haversineMiles(
    driverLocation.lat,
    driverLocation.lng,
    load.originLat,
    load.originLng,
  );

  const econ = computeEconomics({
    rate: load.rate,
    loadedMiles: load.loadedMiles,
    deadheadMiles,
    mpg: client.mpg,
    fuelPrice: client.fuelPrice,
  });

  const deadheadRatio = econ.totalMiles > 0 ? deadheadMiles / econ.totalMiles : 0;

  const feas = computeFeasibility({
    deadheadMiles,
    pickupAt: load.pickupAt,
    driverLocationUpdatedAt: driverLocation.updatedAt,
  });

  // Equipment match is a hard constraint — wrong equipment is auto-skip.
  const equipmentMatch = client.equipment === load.equipment;
  const score = computeDispatchScore({
    netPpmTotal: econ.netPpmTotal,
    targetPpm: client.targetPpm,
    minimumPpm: client.minimumPpm,
    deadheadRatio,
    brokerScore: load.brokerScore,
    fraudRisk: load.fraudRisk,
    marketQuality: load.marketQuality,
    pickupFeasibility: feas.pickupFeasibility,
    locationConfidence: feas.locationConfidence,
  });

  if (!equipmentMatch) {
    score.warnings.unshift(
      `Equipment mismatch — load needs ${load.equipment}, truck is ${client.equipment}`,
    );
  }

  // Verdict: book / negotiate / skip
  let verdict: ScoredLoad["verdict"];
  let counterOffer: number | null = null;
  let rankReason: string;

  if (!equipmentMatch || feas.pickupFeasibility === "not_feasible") {
    verdict = "skip";
    rankReason = !equipmentMatch
      ? "Equipment mismatch — cannot haul this load"
      : "Pickup not reachable at average truck speed";
  } else if (econ.netPpmTotal < client.minimumPpm) {
    verdict = "skip";
    rankReason = `Net PPM $${econ.netPpmTotal.toFixed(2)} below client minimum`;
  } else if (load.fraudRisk >= 70) {
    verdict = "skip";
    rankReason = `Fraud risk ${load.fraudRisk}/100 — broker not safe`;
  } else if (score.dispatchScore >= SCORE_BOOK_THRESHOLD) {
    verdict = "book";
    rankReason = `Strong fit: ${econ.netPpmTotal.toFixed(2)} net PPM vs $${client.targetPpm} target, ${Math.round(deadheadRatio * 100)}% deadhead, broker ${load.brokerScore}/100`;
  } else if (score.dispatchScore >= SCORE_NEGOTIATE_THRESHOLD) {
    verdict = "negotiate";
    counterOffer = suggestCounter(load, client, deadheadMiles);
    rankReason = counterOffer
      ? `Below target — counter at $${counterOffer.toLocaleString()} to hit $${client.targetPpm}/mi net`
      : `Below target but already at market ceiling — accept or skip`;
  } else {
    verdict = "skip";
    rankReason = `Composite score ${score.dispatchScore} too low — better loads available`;
  }

  return {
    ...load,
    deadheadMiles: round2(deadheadMiles),
    totalMiles: round2(econ.totalMiles),
    deadheadRatio: round2(deadheadRatio),
    fuelCost: econ.fuelCost,
    fixedCost: econ.fixedCost,
    estimatedNet: econ.estimatedNet,
    loadedPpm: econ.loadedPpm,
    totalPpm: econ.totalPpm,
    netPpmTotal: econ.netPpmTotal,
    locationConfidence: feas.locationConfidence,
    locationAgeMinutes: feas.locationAgeMinutes,
    pickupFeasibility: feas.pickupFeasibility,
    pickupBufferMinutes: feas.pickupBufferMinutes,
    dispatchScore: score.dispatchScore,
    verdict,
    counterOffer,
    rankReason,
    warnings: score.warnings,
  };
}

/**
 * Rank an array of loads for one client and return the top N suggestions.
 * Drops "skip" verdicts (unless `includeSkipped`).
 */
export interface RankOptions {
  topN?: number;
  includeSkipped?: boolean;
}

export function rankLoadsForClient(
  loads: Load[],
  client: Client,
  driverLocation: DriverLocation,
  options: RankOptions = {},
): ScoredLoad[] {
  const { topN = 5, includeSkipped = false } = options;
  const scored = loads.map((load) =>
    scoreLoadForClient({ load, client, driverLocation }),
  );
  const filtered = includeSkipped ? scored : scored.filter((s) => s.verdict !== "skip");
  filtered.sort((a, b) => b.dispatchScore - a.dispatchScore);
  return filtered.slice(0, topN);
}
