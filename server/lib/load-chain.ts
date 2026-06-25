// ===========================================================================
// server/lib/load-chain.ts — multi-leg load chaining (continuous-load planner)
// ===========================================================================
//
// The scorer/assignment pick the best SINGLE next load. The bigger efficiency
// lever (and the user's "many factors along the whole route" vision at the
// trip level) is to plan an optimal SEQUENCE of loads: keep the truck loaded,
// minimizing the empty miles BETWEEN loads, over a planning horizon. Empty
// miles are pure loss, so chaining loads whose delivery feeds the next pickup
// is where real margin comes from.
//
// This is a longest-path DP on a time-ordered DAG: a load B can follow load A
// iff you can deadhead from A's destination to B's origin and still make B's
// pickup window. Objective = total rate − costPerMile × (loaded + deadhead
// miles). O(N²), pure, deterministic.

export interface ChainCandidate {
  id: string;
  originCity?: string;
  originState?: string;
  destinationCity?: string;
  destinationState?: string;
  originLat: number;
  originLng: number;
  destinationLat: number;
  destinationLng: number;
  pickupAt: string; // ISO
  deliveryAt: string; // ISO
  rate: number;
  loadedMiles: number;
}

export interface ChainLeg {
  loadId: string;
  lane: string;
  pickupAt: string;
  deliveryAt: string;
  rate: number;
  loadedMiles: number;
  deadheadMiles: number; // empty miles from the previous leg (or start) to this pickup
}

export interface LoadChainResult {
  legs: ChainLeg[];
  totalRate: number;
  totalLoadedMiles: number;
  totalDeadheadMiles: number;
  /** rate − costPerMile × (loaded + deadhead). The objective maximized. */
  netValue: number;
  /** loaded / (loaded + deadhead); 1.0 = zero empty miles. */
  utilization: number;
}

export interface ChainOptions {
  costPerMile?: number; // blended operating cost (fuel + maintenance); default 0.55
  avgSpeedMph?: number; // for deadhead travel-time feasibility; default 50
  circuity?: number; // straight-line → road miles; default 1.18 (matches the scorer)
  maxLegs?: number; // cap chain length; default 8
  horizonHours?: number; // ignore loads picking up beyond this; default 168 (1 week)
}

function haversineMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3958.8;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Plan the highest-value chain of loads a carrier at `start` can run, keeping
 * the truck loaded and minimizing empty miles between legs.
 */
export function planLoadChain(
  start: { lat: number; lng: number; availableAt: string },
  candidates: ChainCandidate[],
  opts: ChainOptions = {},
): LoadChainResult {
  const costPerMile = opts.costPerMile ?? 0.55;
  const avgSpeedMph = opts.avgSpeedMph ?? 50;
  const circuity = opts.circuity ?? 1.18;
  const maxLegs = opts.maxLegs ?? 8;
  const horizonMs = (opts.horizonHours ?? 168) * 3600_000;

  const startMs = Date.parse(start.availableAt);
  const horizonCap = Number.isFinite(startMs) ? startMs + horizonMs : Infinity;

  // Keep only well-formed, in-horizon loads; sort by pickup so any valid
  // predecessor is processed before its successor (predecessor delivers before
  // successor picks up, so it picks up earlier too).
  const loads = candidates
    .filter((l) => {
      const p = Date.parse(l.pickupAt);
      const d = Date.parse(l.deliveryAt);
      return (
        Number.isFinite(p) && Number.isFinite(d) && d >= p && l.loadedMiles >= 0 && p <= horizonCap
      );
    })
    .sort((a, b) => Date.parse(a.pickupAt) - Date.parse(b.pickupAt) || a.id.localeCompare(b.id));

  const roadMiles = (aLat: number, aLng: number, bLat: number, bLng: number) =>
    Math.round(haversineMiles(aLat, aLng, bLat, bLng) * circuity);
  const travelMs = (miles: number) => (miles / avgSpeedMph) * 3600_000;

  // dp[i] = best netValue of a chain ENDING at load i; prev[i] = predecessor idx
  // (or -1 for start); dh[i] = deadhead miles entering load i in the best chain;
  // len[i] = number of legs in that chain.
  const n = loads.length;
  const dp = new Array<number>(n).fill(-Infinity);
  const prev = new Array<number>(n).fill(-1);
  const dh = new Array<number>(n).fill(0);
  const len = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    const L = loads[i]!;
    const Lpick = Date.parse(L.pickupAt);
    const nodeValue = L.rate - costPerMile * L.loadedMiles;

    // Option 1: start directly with this load (deadhead from the carrier).
    const startDh = roadMiles(start.lat, start.lng, L.originLat, L.originLng);
    const canStart = !Number.isFinite(startMs) || startMs + travelMs(startDh) <= Lpick;
    if (canStart) {
      const v = nodeValue - costPerMile * startDh;
      if (v > dp[i]!) {
        dp[i] = v;
        prev[i] = -1;
        dh[i] = startDh;
        len[i] = 1;
      }
    }

    // Option 2: chain after an earlier load j (j delivers, then deadhead to L).
    for (let j = 0; j < i; j++) {
      if (dp[j] === -Infinity || len[j]! >= maxLegs) continue;
      const P = loads[j]!;
      const Pdeliver = Date.parse(P.deliveryAt);
      const legDh = roadMiles(P.destinationLat, P.destinationLng, L.originLat, L.originLng);
      if (Pdeliver + travelMs(legDh) > Lpick) continue; // can't make the pickup in time
      const v = dp[j]! + nodeValue - costPerMile * legDh;
      if (v > dp[i]!) {
        dp[i] = v;
        prev[i] = j;
        dh[i] = legDh;
        len[i] = len[j]! + 1;
      }
    }
  }

  // Best chain end.
  let bestEnd = -1;
  let bestVal = -Infinity;
  for (let i = 0; i < n; i++) {
    if (dp[i]! > bestVal) {
      bestVal = dp[i]!;
      bestEnd = i;
    }
  }

  // A net-negative best chain is worse than running nothing: every feasible
  // candidate loses money once deadhead + operating cost is netted against the
  // rate. Surface the empty chain (recommend no load) rather than a loss-maker.
  if (bestEnd === -1 || bestVal <= 0) {
    return {
      legs: [], totalRate: 0, totalLoadedMiles: 0, totalDeadheadMiles: 0,
      netValue: 0, utilization: 0,
    };
  }

  // Backtrack.
  const order: number[] = [];
  for (let i = bestEnd; i !== -1; i = prev[i]!) order.push(i);
  order.reverse();

  const legs: ChainLeg[] = order.map((idx) => {
    const L = loads[idx]!;
    return {
      loadId: L.id,
      lane:
        `${L.originCity ?? "?"}, ${L.originState ?? "?"} → ` +
        `${L.destinationCity ?? "?"}, ${L.destinationState ?? "?"}`,
      pickupAt: L.pickupAt,
      deliveryAt: L.deliveryAt,
      rate: L.rate,
      loadedMiles: L.loadedMiles,
      deadheadMiles: dh[idx]!,
    };
  });

  const totalRate = legs.reduce((s, l) => s + l.rate, 0);
  const totalLoadedMiles = legs.reduce((s, l) => s + l.loadedMiles, 0);
  const totalDeadheadMiles = legs.reduce((s, l) => s + l.deadheadMiles, 0);
  const denom = totalLoadedMiles + totalDeadheadMiles;
  return {
    legs,
    totalRate,
    totalLoadedMiles,
    totalDeadheadMiles,
    netValue: Math.round(bestVal),
    utilization: denom > 0 ? Number((totalLoadedMiles / denom).toFixed(3)) : 0,
  };
}
