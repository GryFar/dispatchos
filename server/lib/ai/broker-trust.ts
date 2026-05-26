// Broker Trust Score — Killer Feature #1.
//
// Aggregates real dispatcher experience with a broker (MC#) into a single
// 0..100 score. This is the read/compute layer; persistence lives in
// storage.ts (broker_trust_signals). Pure functions only — no DB, no I/O —
// so the formula is unit-testable in isolation.
//
// NOTE: distinct from broker_safety_audit_snapshots (server #54, FMCSA/legal
// layer). That captures regulatory vetting at booking time; THIS captures
// behavioural signals (pays on time, honours ratecon, responds, fraud).

export type TrustSignalType =
  | "paid_on_time"
  | "paid_late"
  | "paid_never"
  | "ratecon_honored"
  | "ratecon_reduced_post_bol"
  | "rate_negotiation_fair"
  | "rate_negotiation_aggressive"
  | "fast_response"
  | "slow_response"
  | "no_response"
  | "detention_paid"
  | "detention_disputed"
  | "tonu_paid"
  | "tonu_disputed"
  | "lumper_reimbursed"
  | "lumper_not_reimbursed"
  | "fraud_attempt"
  | "double_brokered"
  | "factoring_friendly"
  | "factoring_blocked";

export const TRUST_SIGNAL_TYPES: TrustSignalType[] = [
  "paid_on_time", "paid_late", "paid_never",
  "ratecon_honored", "ratecon_reduced_post_bol",
  "rate_negotiation_fair", "rate_negotiation_aggressive",
  "fast_response", "slow_response", "no_response",
  "detention_paid", "detention_disputed",
  "tonu_paid", "tonu_disputed",
  "lumper_reimbursed", "lumper_not_reimbursed",
  "fraud_attempt", "double_brokered",
  "factoring_friendly", "factoring_blocked",
];

// Per-signal weights. Fraud/double-broker are catastrophic by design.
export const TRUST_WEIGHTS: Record<TrustSignalType, number> = {
  paid_on_time: +10, paid_late: -10, paid_never: -50,
  ratecon_honored: +5, ratecon_reduced_post_bol: -25,
  rate_negotiation_fair: +3, rate_negotiation_aggressive: -3,
  fast_response: +2, slow_response: -2, no_response: -5,
  detention_paid: +5, detention_disputed: -10,
  tonu_paid: +5, tonu_disputed: -10,
  lumper_reimbursed: +3, lumper_not_reimbursed: -5,
  fraud_attempt: -100, double_brokered: -100,
  factoring_friendly: +5, factoring_blocked: -3,
};

export interface TrustSignalLike {
  signalType: TrustSignalType | string;
}

/**
 * Compute a 0..100 trust score from a list of signals.
 *
 * Empty -> 50 (neutral, no data). Sigmoid over the weighted raw sum keeps the
 * output bounded; /30 sets how fast it saturates. 50 = neutral, 100 = excellent,
 * 0 = avoid.
 */
export function computeTrustScore(signals: TrustSignalLike[]): number {
  if (signals.length === 0) return 50;
  const raw = signals.reduce((sum, sig) => {
    const w = TRUST_WEIGHTS[sig.signalType as TrustSignalType];
    return sum + (w ?? 0);
  }, 0);
  const normalized = 100 / (1 + Math.exp(-raw / 30));
  return Math.round(Math.min(100, Math.max(0, normalized)));
}

/** A traffic-light bucket for the UI badge. */
export function trustTier(score: number): "good" | "caution" | "avoid" {
  if (score >= 65) return "good";
  if (score >= 40) return "caution";
  return "avoid";
}

export interface TrustBreakdown {
  payment: { onTime: number; late: number; never: number };
  negotiation: { fair: number; aggressive: number };
  ratecon: { honored: number; reduced: number };
  response: { fast: number; slow: number; none: number };
  fraud: { count: number; types: string[] };
}

/** Bucket signals into the breakdown shape the API/UI consume. */
export function computeBreakdown(signals: TrustSignalLike[]): TrustBreakdown {
  const count = (t: TrustSignalType) =>
    signals.filter((s) => s.signalType === t).length;
  const fraudSignals = signals.filter(
    (s) => s.signalType === "fraud_attempt" || s.signalType === "double_brokered",
  );
  return {
    payment: {
      onTime: count("paid_on_time"),
      late: count("paid_late"),
      never: count("paid_never"),
    },
    negotiation: {
      fair: count("rate_negotiation_fair"),
      aggressive: count("rate_negotiation_aggressive"),
    },
    ratecon: {
      honored: count("ratecon_honored"),
      reduced: count("ratecon_reduced_post_bol"),
    },
    response: {
      fast: count("fast_response"),
      slow: count("slow_response"),
      none: count("no_response"),
    },
    fraud: {
      count: fraudSignals.length,
      types: Array.from(new Set(fraudSignals.map((s) => String(s.signalType)))),
    },
  };
}
