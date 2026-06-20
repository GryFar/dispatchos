// ===========================================================================
// server/lib/score-weights.ts — per-client dispatchScore weight resolution
// ===========================================================================
//
// scoreLoadForClient blends six 0..100 factor scores into dispatchScore. The
// blend weights were hardcoded; clientSchema has carried an optional
// `scoreWeights` override for a while but nothing ever applied it. This wires
// it: a carrier that, say, hates deadhead can weight it higher.
//
// Safety:
//  - Only finite, non-negative overrides are accepted (garbage / negatives from
//    a bad client payload are ignored, falling back to the default for that key).
//  - Weights are normalized to sum to 1, so dispatchScore stays in its usual
//    0..~100 range no matter what magnitudes a carrier enters.
//  - A client with NO overrides resolves to exactly the defaults (which already
//    sum to 1.0), so existing carriers' scores are unchanged — non-regressive.

export interface ScoreWeights {
  ppm: number;
  deadhead: number;
  feasibility: number;
  broker: number;
  lane: number;
  location: number;
}

export const DEFAULT_SCORE_WEIGHTS: Readonly<ScoreWeights> = Object.freeze({
  ppm: 0.42,
  deadhead: 0.18,
  feasibility: 0.15,
  broker: 0.12,
  lane: 0.08,
  location: 0.05,
});

const KEYS: (keyof ScoreWeights)[] = [
  "ppm",
  "deadhead",
  "feasibility",
  "broker",
  "lane",
  "location",
];

/**
 * Merge client overrides over the defaults (ignoring non-finite/negative
 * values), then normalize to sum to 1. Returns the defaults unchanged when no
 * valid overrides are present.
 */
export function resolveScoreWeights(
  overrides?: Partial<Record<keyof ScoreWeights, unknown>> | null,
): ScoreWeights {
  const merged: ScoreWeights = { ...DEFAULT_SCORE_WEIGHTS };
  if (overrides && typeof overrides === "object") {
    for (const k of KEYS) {
      const v = (overrides as Record<string, unknown>)[k];
      const n = typeof v === "number" ? v : Number.parseFloat(String(v));
      if (Number.isFinite(n) && n >= 0) merged[k] = n;
    }
  }
  const sum = KEYS.reduce((acc, k) => acc + merged[k], 0);
  if (!(sum > 0)) return { ...DEFAULT_SCORE_WEIGHTS };
  return {
    ppm: merged.ppm / sum,
    deadhead: merged.deadhead / sum,
    feasibility: merged.feasibility / sum,
    broker: merged.broker / sum,
    lane: merged.lane / sum,
    location: merged.location / sum,
  };
}
