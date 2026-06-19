// Broker performance tracking — our own internal database of brokers we've
// worked with.
//
// FMCSA tells us if a broker is *legal*. This module tells us if they're
// *good*. We track:
//   • Payment behavior (paid on time? late? underpaid? quickpay used?)
//   • Rate behavior (did they honor agreed rate? change mid-route?)
//   • Communication (responsive? ghosted us?)
//   • Disputes (any legal action, double-brokering attempt, fraud reports?)
//
// This data starts empty for every new dispatcher and grows with each load.
// The score complements the FMCSA score and is critical for repeat
// engagements — a clean FMCSA record means nothing if they pay 60 days late.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const brokerEventTypeSchema = z.enum([
  "load_booked",       // we accepted a load with this broker
  "load_completed",    // load delivered
  "load_cancelled",    // broker cancelled
  "rate_honored",      // paid the agreed rate
  "rate_disputed",     // tried to reduce rate after delivery
  "paid_on_time",      // payment within agreed terms (typically 30d)
  "paid_late",         // payment beyond terms but received
  "non_payment",       // payment never received (>90d)
  "ghosted",           // stopped responding mid-load
  "double_broker_attempt", // attempted to re-broker our load
  "fraud_report",      // reported to FMCSA / industry
  "responsive",        // returned calls/emails within 4h business
  "rude_unprofessional", // verbal incident logged
  "positive_note",     // generic positive interaction
  "negative_note",     // generic negative interaction
]);

export type BrokerEventType = z.infer<typeof brokerEventTypeSchema>;

export const brokerEventSchema = z.object({
  id: z.string(),
  brokerMc: z.string(),                    // normalized e.g. "MC-470488"
  eventType: brokerEventTypeSchema,
  loadId: z.string().optional(),           // link to load if event is load-specific
  amountUsd: z.number().optional(),        // for payment / rate events
  notes: z.string().optional(),
  loggedByUserId: z.string(),              // dispatcher who logged it
  loggedAt: z.string(),                    // ISO timestamp
});

export type BrokerEvent = z.infer<typeof brokerEventSchema>;

export const brokerHistorySchema = z.object({
  brokerMc: z.string(),
  brokerName: z.string().optional(),
  /** Total loads booked with this broker (lifetime). */
  loadsTotal: z.number(),
  /** Loads delivered successfully. */
  loadsCompleted: z.number(),
  /** Loads cancelled by broker. */
  loadsCancelled: z.number(),
  /** Total gross paid by this broker (across all loads). */
  totalGross: z.number(),
  /** Total amount lost to non-payment / disputes. */
  totalLost: z.number(),
  /** Days it typically takes them to pay (median). */
  medianPayDays: z.number().nullable(),
  /** When was the last load delivered. */
  lastLoadAt: z.string().nullable(),
  /** Counts of behavioral events. */
  flags: z.object({
    nonPayments: z.number(),
    ghostings: z.number(),
    doubleBrokerAttempts: z.number(),
    rateDisputes: z.number(),
    fraudReports: z.number(),
  }),
  /** Performance score 0-100, higher = trustier. */
  performanceScore: z.number(),
  /** Verdict same as FMCSA: green/yellow/red. */
  verdict: z.enum(["green", "yellow", "red", "unknown"]),
  /** Why we gave this verdict. */
  reasons: z.array(z.string()),
});

export type BrokerHistory = z.infer<typeof brokerHistorySchema>;

// ---------------------------------------------------------------------------
// Performance score calculation
// ---------------------------------------------------------------------------

/**
 * Compute broker performance from raw event log.
 *
 * Pure function — pass in events, get out summary. Storage layer feeds events.
 */
export function buildHistory(events: BrokerEvent[], brokerName?: string): BrokerHistory {
  const flags = {
    nonPayments: 0,
    ghostings: 0,
    doubleBrokerAttempts: 0,
    rateDisputes: 0,
    fraudReports: 0,
  };

  let loadsTotal = 0;
  let loadsCompleted = 0;
  let loadsCancelled = 0;
  let totalGross = 0;
  let totalLost = 0;
  const payDays: number[] = []; // would need (booked, paid) pairs; we approximate
  let lastLoadAt: string | null = null;
  let onTimePays = 0;
  let latePays = 0;
  let rateHonored = 0;
  let responsiveCount = 0;
  let rudeCount = 0;

  if (events.length === 0) {
    return {
      brokerMc: "",
      brokerName,
      loadsTotal: 0,
      loadsCompleted: 0,
      loadsCancelled: 0,
      totalGross: 0,
      totalLost: 0,
      medianPayDays: null,
      lastLoadAt: null,
      flags,
      performanceScore: 50, // neutral when unknown
      verdict: "unknown",
      reasons: ["No history with this broker yet"],
    };
  }

  const brokerMc = events[0]!.brokerMc;

  for (const e of events) {
    switch (e.eventType) {
      case "load_booked":
        loadsTotal++;
        if (!lastLoadAt || e.loggedAt > lastLoadAt) lastLoadAt = e.loggedAt;
        if (e.amountUsd) totalGross += e.amountUsd;
        break;
      case "load_completed":
        loadsCompleted++;
        break;
      case "load_cancelled":
        loadsCancelled++;
        break;
      case "paid_on_time":
        onTimePays++;
        break;
      case "paid_late":
        latePays++;
        break;
      case "non_payment":
        flags.nonPayments++;
        if (e.amountUsd) totalLost += e.amountUsd;
        break;
      case "rate_honored":
        rateHonored++;
        break;
      case "rate_disputed":
        flags.rateDisputes++;
        if (e.amountUsd) totalLost += e.amountUsd;
        break;
      case "ghosted":
        flags.ghostings++;
        break;
      case "double_broker_attempt":
        flags.doubleBrokerAttempts++;
        break;
      case "fraud_report":
        flags.fraudReports++;
        break;
      case "responsive":
        responsiveCount++;
        break;
      case "rude_unprofessional":
        rudeCount++;
        break;
      case "positive_note":
      case "negative_note":
        // Neutral — used for notes only
        break;
    }
  }

  // Score start at 70 (neutral-positive for any broker we've worked with > 0 loads)
  let score = 70;
  const reasons: string[] = [];

  // Hard kills
  if (flags.fraudReports > 0) {
    return {
      brokerMc,
      brokerName,
      loadsTotal,
      loadsCompleted,
      loadsCancelled,
      totalGross: round2(totalGross),
      totalLost: round2(totalLost),
      medianPayDays: median(payDays),
      lastLoadAt,
      flags,
      performanceScore: 0,
      verdict: "red",
      reasons: [`${flags.fraudReports} fraud report(s) on file — do not engage`],
    };
  }
  if (flags.doubleBrokerAttempts >= 2) {
    return {
      brokerMc,
      brokerName,
      loadsTotal,
      loadsCompleted,
      loadsCancelled,
      totalGross: round2(totalGross),
      totalLost: round2(totalLost),
      medianPayDays: median(payDays),
      lastLoadAt,
      flags,
      performanceScore: 5,
      verdict: "red",
      reasons: [`${flags.doubleBrokerAttempts} double-broker attempts — pattern of fraud`],
    };
  }

  // Payment behavior
  const totalPays = onTimePays + latePays;
  if (totalPays > 0) {
    const onTimeRate = onTimePays / totalPays;
    if (onTimeRate >= 0.95) {
      score += 15;
      reasons.push(`Pays on time ${Math.round(onTimeRate * 100)}% of the time`);
    } else if (onTimeRate >= 0.80) {
      score += 5;
      reasons.push(`Pays on time ${Math.round(onTimeRate * 100)}% of the time`);
    } else if (onTimeRate >= 0.60) {
      score -= 10;
      reasons.push(`Late payments ${Math.round((1 - onTimeRate) * 100)}% of the time`);
    } else {
      score -= 25;
      reasons.push(`Frequent late payments — only ${Math.round(onTimeRate * 100)}% on time`);
    }
  }

  if (flags.nonPayments > 0) {
    score -= 30 * flags.nonPayments;
    reasons.push(`${flags.nonPayments} non-payment incident(s) — $${Math.round(totalLost)} lost`);
  }

  // Rate honesty
  if (loadsCompleted > 0) {
    const rateHonorRate = rateHonored / loadsCompleted;
    if (flags.rateDisputes > 0) {
      score -= 15 * flags.rateDisputes;
      reasons.push(`${flags.rateDisputes} rate disputes after delivery`);
    } else if (rateHonorRate >= 0.95) {
      score += 5;
      reasons.push("Always honors agreed rate");
    }
  }

  // Cancel rate
  if (loadsTotal > 0) {
    const cancelRate = loadsCancelled / loadsTotal;
    if (cancelRate > 0.20) {
      score -= 15;
      reasons.push(`High cancel rate ${Math.round(cancelRate * 100)}%`);
    }
  }

  // Communication
  if (flags.ghostings > 0) {
    score -= 12 * flags.ghostings;
    reasons.push(`Ghosted ${flags.ghostings} time(s) mid-load`);
  }
  if (rudeCount > 0) {
    score -= 4 * rudeCount;
    reasons.push(`${rudeCount} unprofessional incident(s) logged`);
  }
  if (responsiveCount >= 3) {
    score += 5;
    reasons.push("Consistently responsive");
  }

  // Volume bonus — long-term partners
  if (loadsCompleted >= 50) {
    score += 10;
    reasons.push(`${loadsCompleted} completed loads — established partner`);
  } else if (loadsCompleted >= 10) {
    score += 5;
    reasons.push(`${loadsCompleted} completed loads — known relationship`);
  }

  score = clamp(score, 0, 100);
  let verdict: BrokerHistory["verdict"];
  // A hard-negative signal (non-payment / ghosting / fraud report) must NOT be
  // hidden behind "unknown" just because history is thin: a broker who burned
  // you on your only load should still flag (the low score then drives
  // red/yellow), instead of deferring 100% to FMCSA-green.
  const hardNegative = flags.nonPayments > 0 || flags.ghostings > 0 || flags.fraudReports > 0;
  if (loadsTotal < 3 && !hardNegative) {
    verdict = "unknown";
    reasons.push(`Only ${loadsTotal} load(s) of history — not enough signal`);
  } else if (score >= 75) verdict = "green";
  else if (score >= 50) verdict = "yellow";
  else verdict = "red";

  return {
    brokerMc,
    brokerName,
    loadsTotal,
    loadsCompleted,
    loadsCancelled,
    totalGross: round2(totalGross),
    totalLost: round2(totalLost),
    medianPayDays: median(payDays),
    lastLoadAt,
    flags,
    performanceScore: score,
    verdict,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Combined trust score — fuse FMCSA verdict + internal history
// ---------------------------------------------------------------------------

import type { FmcsaVerdict } from "./fmcsa";

export interface CombinedBrokerVerdict {
  /** Final verdict combining FMCSA + history. */
  verdict: "green" | "yellow" | "red";
  /** 0-100 combined score. */
  score: number;
  /** All reasons (merged from both sources). */
  reasons: string[];
  /** Critical red flags requiring action. */
  redFlags: string[];
  /** Whether we have any internal history. */
  hasHistory: boolean;
}

/**
 * Combine FMCSA legality check with our own performance data.
 *
 * Rules:
 *  • Any RED from either source → RED.
 *  • If we have history (≥3 loads), it dominates — FMCSA is just a sanity check.
 *  • If no history, FMCSA verdict carries fully.
 *  • Internal red overrides FMCSA green (we got burned, FMCSA doesn't know).
 */
export function combineVerdicts(
  fmcsa: FmcsaVerdict,
  history: BrokerHistory,
): CombinedBrokerVerdict {
  const reasons = [...fmcsa.reasons, ...history.reasons];
  const redFlags = [...fmcsa.redFlags];
  const hasHistory = history.loadsTotal >= 3;

  // Either source red = red
  if (fmcsa.verdict === "red" || history.verdict === "red") {
    return {
      verdict: "red",
      score: Math.min(fmcsa.score, history.performanceScore),
      reasons,
      redFlags,
      hasHistory,
    };
  }

  let score: number;
  let verdict: "green" | "yellow" | "red";

  if (hasHistory) {
    // History weighted 70%, FMCSA 30% (our experience matters more)
    score = Math.round(history.performanceScore * 0.7 + fmcsa.score * 0.3);
  } else {
    // FMCSA weighted 100% — we have no signal yet
    score = fmcsa.score;
  }

  if (score >= 75) verdict = "green";
  else if (score >= 50) verdict = "yellow";
  else verdict = "red";

  return { verdict, score, reasons, redFlags, hasHistory };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function median(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
