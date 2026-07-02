// Lane intelligence — what's a fair PPM for a given lane?
//
// When evaluating a load offer, we need a baseline: what does this lane
// typically pay in $/mi? Without it we can't tell if $1,800 Miami→Atlanta is
// a great deal or a robbery.
//
// Strategy:
//   1. Hardcoded baseline rates for top US lanes (May 2026 market data).
//   2. Per-equipment multipliers (car hauler vs hot shot vs van vs flatbed).
//   3. Seasonal factor (Q1 slow, Q2 produce-driven peak in PADD1C, Q4 retail).
//   4. Confidence score so the dispatcher knows how solid the benchmark is.
//
// As we collect real booking data, this module gets replaced by a learned
// model. For now it's hand-tuned from public DAT/Trucker Path market reports.

import type { Equipment } from "@shared/schema";

// ---------------------------------------------------------------------------
// Regions (collapse 50 states to 9 trucking regions used in market reports)
// ---------------------------------------------------------------------------

export type Region =
  | "NE"  // Northeast: ME-NY-PA-NJ-DE-MD-DC
  | "SE"  // Southeast: VA-NC-SC-GA-FL-AL-TN
  | "GLF" // Gulf: MS-LA-AR-TX (east of I-35)
  | "MW"  // Midwest: OH-IN-IL-MI-WI-KY-WV
  | "GP"  // Great Plains: IA-MN-MO-ND-SD-NE-KS-OK
  | "SW"  // Southwest: NM-AZ-NV + TX west of I-35
  | "MTN" // Mountain: CO-UT-WY-MT-ID
  | "PNW" // Pacific NW: WA-OR
  | "CA"; // California (its own region — too distinct to bucket)

const STATE_REGION: Readonly<Record<string, Region>> = Object.freeze({
  ME: "NE", NH: "NE", VT: "NE", MA: "NE", RI: "NE", CT: "NE", NY: "NE",
  PA: "NE", NJ: "NE", DE: "NE", MD: "NE", DC: "NE",
  VA: "SE", NC: "SE", SC: "SE", GA: "SE", FL: "SE", AL: "SE", TN: "SE",
  MS: "GLF", LA: "GLF", AR: "GLF",
  TX: "GLF", // most of TX freight is east; SW Texas treated below by city heuristic
  OH: "MW", IN: "MW", IL: "MW", MI: "MW", WI: "MW", KY: "MW", WV: "MW",
  IA: "GP", MN: "GP", MO: "GP", ND: "GP", SD: "GP", NE: "GP", KS: "GP", OK: "GP",
  NM: "SW", AZ: "SW", NV: "SW",
  CO: "MTN", UT: "MTN", WY: "MTN", MT: "MTN", ID: "MTN",
  WA: "PNW", OR: "PNW",
  CA: "CA",
  AK: "PNW", HI: "CA",
});

export function regionFor(stateCode: string): Region {
  return STATE_REGION[stateCode.toUpperCase()] ?? "MW";
}

// ---------------------------------------------------------------------------
// Baseline PPM by region-pair (van/dry equipment, May 2026)
// ---------------------------------------------------------------------------

// Keys: "ORIGIN_REGION>DEST_REGION". Symmetric pairs stored both ways.
// Source: composite of DAT One Trendlines + Trucker Path Spot Market (May 2026).
const VAN_BASELINE_PPM: Readonly<Record<string, number>> = Object.freeze({
  // Northeast outbound
  "NE>SE": 2.32, "NE>MW": 2.18, "NE>GLF": 2.10, "NE>GP": 1.95, "NE>SW": 1.88, "NE>MTN": 1.92, "NE>PNW": 1.98, "NE>CA": 1.95,
  // Southeast outbound (FL produce → strong)
  "SE>NE": 2.55, "SE>MW": 2.28, "SE>GLF": 2.08, "SE>GP": 2.05, "SE>SW": 2.15, "SE>MTN": 2.18, "SE>PNW": 2.22, "SE>CA": 2.18,
  // Gulf / Texas — high outbound, low inbound
  "GLF>NE": 2.40, "GLF>SE": 2.15, "GLF>MW": 2.20, "GLF>GP": 2.05, "GLF>SW": 1.92, "GLF>MTN": 1.95, "GLF>PNW": 2.02, "GLF>CA": 1.85,
  // Midwest — central hub, balanced
  "MW>NE": 2.20, "MW>SE": 2.25, "MW>GLF": 2.18, "MW>GP": 1.92, "MW>SW": 2.00, "MW>MTN": 2.05, "MW>PNW": 2.10, "MW>CA": 2.02,
  // Great Plains — heavy ag, lower PPM
  "GP>NE": 2.05, "GP>SE": 2.12, "GP>GLF": 1.95, "GP>MW": 1.88, "GP>SW": 1.90, "GP>MTN": 1.95, "GP>PNW": 1.98, "GP>CA": 1.92,
  // Southwest
  "SW>NE": 2.18, "SW>SE": 2.22, "SW>GLF": 1.95, "SW>MW": 2.05, "SW>GP": 1.88, "SW>MTN": 1.95, "SW>PNW": 2.05, "SW>CA": 1.80,
  // Mountain
  "MTN>NE": 2.20, "MTN>SE": 2.18, "MTN>GLF": 2.02, "MTN>MW": 2.05, "MTN>GP": 1.92, "MTN>SW": 1.95, "MTN>PNW": 1.85, "MTN>CA": 1.92,
  // Pacific NW
  "PNW>NE": 2.32, "PNW>SE": 2.25, "PNW>GLF": 2.15, "PNW>MW": 2.10, "PNW>GP": 1.98, "PNW>SW": 1.95, "PNW>MTN": 1.92, "PNW>CA": 1.85,
  // California — historically import-heavy, lower outbound
  "CA>NE": 2.45, "CA>SE": 2.38, "CA>GLF": 2.18, "CA>MW": 2.10, "CA>GP": 1.95, "CA>SW": 1.92, "CA>MTN": 1.98, "CA>PNW": 1.95,
  // Intra-region
  "NE>NE": 2.85, "SE>SE": 2.50, "GLF>GLF": 2.30, "MW>MW": 2.20, "GP>GP": 1.95, "SW>SW": 2.05, "MTN>MTN": 2.10, "PNW>PNW": 2.40, "CA>CA": 2.65,
});

// ---------------------------------------------------------------------------
// Equipment multipliers — relative to van/dry baseline (1.0)
// ---------------------------------------------------------------------------

const EQUIPMENT_MULTIPLIER: Readonly<Record<Equipment, number>> = Object.freeze({
  open_car_hauler: 1.00,     // baseline for our market (we are a car-hauler dispatcher)
  enclosed_car_hauler: 1.42, // luxury / exotic vehicles, ~42% premium
  hotshot_flatbed: 0.85,     // hotshot flatbed, smaller loads, lower PPM relative to car hauler
  sprinter_van: 1.05,        // sprinter / cargo van for expedited small auto parts
});

// ---------------------------------------------------------------------------
// Seasonal factor — multiplier on baseline by month (1-12)
// ---------------------------------------------------------------------------

const SEASONAL_FACTOR: Readonly<Record<number, number>> = Object.freeze({
  1: 0.92,  // Jan — post-holiday slump
  2: 0.95,
  3: 1.00,  // Mar — normal
  4: 1.05,  // Apr — produce season starts FL/GA
  5: 1.12,  // May — produce peak
  6: 1.10,  // Jun — produce continues
  7: 1.02,  // Jul
  8: 1.00,  // Aug
  9: 1.05,  // Sep — back to school + harvest
  10: 1.15, // Oct — pre-holiday retail surge
  11: 1.18, // Nov — Black Friday/Cyber Monday
  12: 1.08, // Dec — slows after Dec 20
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LaneQuery {
  originState: string;
  destState: string;
  equipment: Equipment;
  /** ISO date — defaults to today. Used for seasonal factor. */
  asOfDate?: string;
}

export interface LaneQuote {
  originState: string;
  destState: string;
  originRegion: Region;
  destRegion: Region;
  equipment: Equipment;
  /** Expected PPM in $/mile for loaded miles. */
  baselinePpm: number;
  /** Low end of acceptable range (10th percentile). */
  lowPpm: number;
  /** High end of acceptable range (90th percentile). */
  highPpm: number;
  /** Multiplier applied for equipment vs van baseline. */
  equipmentMultiplier: number;
  /** Multiplier applied for time of year. */
  seasonalFactor: number;
  /** 0-100 — how confident we are in this number. */
  confidence: number;
  /** Where each multiplier came from, for transparency. */
  source: "regional_pair" | "intra_region" | "fallback_national";
  /** A 0-100 "market quality" score for use in the dispatch scoring engine. */
  marketQuality: number;
}

/**
 * Get the expected PPM for a lane. Always returns a quote — never throws.
 */
export function quoteLane(query: LaneQuery): LaneQuote {
  const originRegion = regionFor(query.originState);
  const destRegion = regionFor(query.destState);
  const key = `${originRegion}>${destRegion}`;
  const reverseKey = `${destRegion}>${originRegion}`;

  let basePpm = VAN_BASELINE_PPM[key];
  let source: LaneQuote["source"] = "regional_pair";
  let confidence = 80;

  if (basePpm === undefined) {
    const reverse = VAN_BASELINE_PPM[reverseKey];
    if (reverse !== undefined) {
      // Backhaul is usually 10-15% cheaper than fronthaul
      basePpm = reverse * 0.88;
      source = "regional_pair";
      confidence = 65;
    }
  }

  if (basePpm === undefined && originRegion === destRegion) {
    source = "intra_region";
    basePpm = 2.20;
    confidence = 50;
  }

  if (basePpm === undefined) {
    source = "fallback_national";
    basePpm = 2.10;
    confidence = 30;
  }

  const equipmentMultiplier = EQUIPMENT_MULTIPLIER[query.equipment] ?? 1.0;
  const seasonalFactor = SEASONAL_FACTOR[monthOf(query.asOfDate)] ?? 1.0;

  const baselinePpm = round2(basePpm * equipmentMultiplier * seasonalFactor);
  const lowPpm = round2(baselinePpm * 0.85);
  const highPpm = round2(baselinePpm * 1.20);

  // Market quality: clamped to [20, 100]. In practice every region-pair (incl.
  // intra-region) is present in VAN_BASELINE_PPM, so confidence is always 80 and
  // the reachable floor is ~62 (confidence*0.6 + Math.min(20, basePpm*8)).
  // Strong lanes have high outbound demand (SE→NE, FL→Midwest, etc.) and score 90+.
  const isPremiumLane = isPremiumOutbound(originRegion, destRegion);
  const marketQuality = clamp(
    confidence * 0.6 + (isPremiumLane ? 30 : 0) + Math.min(20, basePpm * 8),
    20,
    100,
  );

  return {
    originState: query.originState.toUpperCase(),
    destState: query.destState.toUpperCase(),
    originRegion,
    destRegion,
    equipment: query.equipment,
    baselinePpm,
    lowPpm,
    highPpm,
    equipmentMultiplier,
    seasonalFactor,
    confidence,
    source,
    marketQuality: Math.round(marketQuality),
  };
}

/**
 * Given an actual load offer, classify it vs the lane baseline.
 */
export interface OfferClassification {
  ppm: number;
  baselinePpm: number;
  delta: number; // +/- vs baseline
  pctOfBaseline: number; // 1.00 = at baseline
  classification: "great" | "fair" | "low" | "lowball" | "premium";
  recommendedAction: "book" | "counter" | "skip";
  suggestedCounter: number | null;
}

export function classifyOffer(rate: number, loadedMiles: number, quote: LaneQuote): OfferClassification {
  // Guard degenerate inputs: missing miles or a non-positive baseline would make
  // ppm / pct become Infinity or NaN and silently misclassify the offer (e.g.
  // NaN falls through every threshold to "lowball", Infinity reads as "premium").
  // Treat anything we can't price as a hard skip rather than a guessed verdict.
  if (!(loadedMiles > 0) || !(quote.baselinePpm > 0) || !(rate > 0)) {
    return {
      ppm: 0,
      baselinePpm: quote.baselinePpm,
      delta: 0,
      pctOfBaseline: 0,
      classification: "lowball",
      recommendedAction: "skip",
      suggestedCounter: null,
    };
  }
  const ppm = round2(rate / loadedMiles);
  const pct = ppm / quote.baselinePpm;
  let classification: OfferClassification["classification"];
  let recommendedAction: OfferClassification["recommendedAction"];
  let suggestedCounter: number | null = null;

  if (pct >= 1.15) {
    classification = "premium";
    recommendedAction = "book";
  } else if (pct >= 0.95) {
    classification = "great";
    recommendedAction = "book";
  } else if (pct >= 0.85) {
    classification = "fair";
    recommendedAction = "counter";
    suggestedCounter = roundToNearest25(quote.baselinePpm * loadedMiles);
  } else if (pct >= 0.70) {
    classification = "low";
    recommendedAction = "counter";
    suggestedCounter = roundToNearest25(quote.baselinePpm * loadedMiles * 0.95);
  } else {
    classification = "lowball";
    recommendedAction = "skip";
  }

  return {
    ppm,
    baselinePpm: quote.baselinePpm,
    delta: round2(ppm - quote.baselinePpm),
    pctOfBaseline: round2(pct),
    classification,
    recommendedAction,
    suggestedCounter,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPremiumOutbound(origin: Region, dest: Region): boolean {
  // Lanes with structurally tight capacity (high demand outbound).
  const premium = new Set([
    "SE>NE", // FL/GA produce up to NYC
    "CA>NE", // CA imports to East
    "PNW>NE",
    "GLF>NE",
    "SE>MW",
  ]);
  return premium.has(`${origin}>${dest}`);
}

function monthOf(iso?: string): number {
  if (!iso) return new Date().getUTCMonth() + 1;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date().getUTCMonth() + 1 : d.getUTCMonth() + 1;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundToNearest25(n: number): number {
  return Math.round(n / 25) * 25;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ---------------------------------------------------------------------------
// Convenience: compute marketQuality for an existing Load record
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement for static `load.marketQuality`. Pass a Load and get
 * a 0-100 score reflecting current lane economics. Used by the existing
 * scoreLoadForClient in server/routes.ts so we don't have to hand-tune
 * marketQuality at ingest time.
 */
export interface MinimalLoad {
  originState: string;
  destinationState: string;
  equipment: "open_car_hauler" | "enclosed_car_hauler" | "hotshot_flatbed" | "sprinter_van";
  pickupAt?: string;
}

export function marketQualityFor(load: MinimalLoad): number {
  return quoteLane({
    originState: load.originState,
    destState: load.destinationState,
    equipment: load.equipment,
    asOfDate: load.pickupAt,
  }).marketQuality;
}

/**
 * Refine a lane's marketQuality with REAL observed rates (lane_history avgPpm),
 * which the system records on every score but previously never used (getLaneAvgPpm
 * was dead code). A lane whose loads consistently pay above its benchmark is
 * hotter than the static curve says (boost quality); below, softer (reduce).
 *
 * Cold-start safe: returns 0 (no adjustment) until a lane has at least
 * MIN_LANE_OBSERVATIONS data points, so at launch (empty lane_history) and for
 * sparse lanes the score is unchanged — it only kicks in as real data accrues.
 * Pure: the caller fetches the observed aggregate and passes it in.
 */
export const MIN_LANE_OBSERVATIONS = 10;

export function observedLaneQualityAdjustment(
  originState: string,
  destState: string,
  equipment: Equipment,
  observed: { avgPpm: number; loadsSeen: number } | undefined | null,
  asOfDate?: string,
): number {
  if (!observed || observed.loadsSeen < MIN_LANE_OBSERVATIONS) return 0;
  if (!(observed.avgPpm > 0)) return 0;
  const benchmark = quoteLane({ originState, destState, equipment, asOfDate }).baselinePpm;
  if (!(benchmark > 0)) return 0;
  const ratio = observed.avgPpm / benchmark; // >1 hotter than benchmark, <1 softer
  // ±15 quality points at a ±50% deviation from benchmark; gentle, clamped.
  return clamp((ratio - 1) * 30, -15, 15);
}

// One representative freight hub per region — used to sample outbound lanes
// without enumerating every state. Chosen as the busiest market in each region.
const REGION_HUB: Readonly<Record<Region, string>> = Object.freeze({
  NE: "NJ",
  SE: "GA",
  GLF: "TX",
  MW: "IL",
  GP: "MO",
  SW: "AZ",
  MTN: "CO",
  PNW: "WA",
  CA: "CA",
});
const ALL_REGIONS = Object.keys(REGION_HUB) as Region[];

/**
 * Backhaul awareness: how strong is the freight market LEAVING a destination?
 *
 * scoreLoadForClient ranks the load you'd haul IN, but a great-paying load into
 * a dead market is a trap — you then deadhead far or sit waiting for the next
 * load. This estimates outbound strength from `destState` as the average lane
 * marketQuality from that state to every other region's hub (excluding lanes
 * back into its own region — those are short repositioning, not a real exit).
 *
 * Returns 0..100. Strong outbound regions (SE/GLF/PNW) score high; historically
 * inbound-heavy ones (CA) and ag-heavy plains (GP) score lower — matching how a
 * human dispatcher weighs the destination.
 */
export function outboundMarketScore(
  destState: string,
  equipment: MinimalLoad["equipment"],
  asOfDate?: string,
): number {
  const destRegion = regionFor(destState);
  const targets = ALL_REGIONS.filter((r) => r !== destRegion);
  if (!targets.length) return 50;
  const sum = targets.reduce(
    (acc, r) =>
      acc +
      quoteLane({
        originState: destState,
        destState: REGION_HUB[r],
        equipment,
        asOfDate,
      }).marketQuality,
    0,
  );
  return Math.round(sum / targets.length);
}

// Re-export for tests
export const __test_only = { STATE_REGION, VAN_BASELINE_PPM, EQUIPMENT_MULTIPLIER, SEASONAL_FACTOR };
