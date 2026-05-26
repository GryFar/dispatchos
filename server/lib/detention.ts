// ===========================================================================
// server/lib/detention.ts — auto-detect detention events from check-ins
// ===========================================================================
//
// Killer feature #4 (roadmap 2026-05-26). Carriers leak $1-4K/week to
// brokers when drivers wait at pickup/delivery without billing for it.
// FreightWaves: average carrier waits 2.4h beyond scheduled time per stop.
// At $50-100/hr accessorial, that's $120-240 per leg → many missed lines.
//
// Detention is computed from existing load_checkins (PR #66 geofence):
//   pickup_detention   = (loaded_at - pickup_arrived_at) - FREE_HOURS
//   delivery_detention = (delivered_at - delivery_arrived_at) - FREE_HOURS
//
// Industry standard "free time" is 2 hours per stop (some shippers 1 h,
// some Walmart-style 30 min). Configurable per client; default 2 h.
//
// This module is PURE (no DB writes). It reads check-ins and Load row,
// returns DetentionEvent[]. The caller decides whether to persist as an
// accessorial line and whether to alert the dispatcher.
// ---------------------------------------------------------------------------

import type { Load, LoadCheckin } from "@shared/schema";

/** Industry default — 2 hours free per stop (FMCSA convention). */
export const DEFAULT_FREE_HOURS = 2;

/** Default accessorial rate when client/load doesn't specify one. */
export const DEFAULT_DETENTION_RATE_PER_HOUR_CENTS = 7_500; // $75/h

export type DetentionLeg = "pickup" | "delivery";

export interface DetentionEvent {
  loadId: string;
  leg: DetentionLeg;
  /** ISO when the driver arrived (pickup_arrived or delivery_arrived). */
  arrivedAt: string;
  /** ISO when the driver completed the leg (loaded or delivered). */
  completedAt: string;
  /** Total time on-site, including the free window. */
  totalHours: number;
  /** Free window granted (default 2 h). */
  freeHours: number;
  /** Billable hours after free window. Rounded UP to nearest 0.25h. */
  billableHours: number;
  /** Hourly rate used. */
  ratePerHourCents: number;
  /** billableHours * ratePerHourCents, rounded half-away-from-zero. */
  amountCents: number;
  /**
   * "auto" if both arrival + completion check-ins were captured by the
   * driver/geofence; "estimated" if only arrival is recorded and we used
   * `now` as a placeholder (driver still on-site). UI should show pending.
   */
  source: "auto" | "estimated";
}

export interface DetentionInput {
  load: Pick<Load, "id">;
  checkins: LoadCheckin[];
  /** Per-client override of free hours; falls back to DEFAULT_FREE_HOURS. */
  freeHours?: number;
  /** Per-client override of $/hr; falls back to DEFAULT_DETENTION_RATE_PER_HOUR_CENTS. */
  ratePerHourCents?: number;
  /** "now" injection for testability + for legs still in progress. */
  nowIso?: string;
}

/**
 * Compute the latest checkin of a given kind. Checkins are stored
 * `ORDER BY created_at ASC` by the storage layer; we walk from the
 * end to grab the freshest.
 */
function lastByKind(checkins: LoadCheckin[], kind: LoadCheckin["kind"]) {
  for (let i = checkins.length - 1; i >= 0; i--) {
    if (checkins[i]!.kind === kind) return checkins[i]!;
  }
  return undefined;
}

/**
 * Round up to the nearest 1/4 hour. Industry convention: a 2h12m wait
 * bills as 2.25h, not 2.2h.
 */
function ceilQuarterHour(hours: number): number {
  if (hours <= 0) return 0;
  return Math.ceil(hours * 4) / 4;
}

function hoursBetween(startIso: string, endIso: string): number {
  const a = new Date(startIso).getTime();
  const b = new Date(endIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return (b - a) / 3_600_000;
}

/**
 * Inspect a load's check-ins and emit one DetentionEvent per leg that
 * exceeded the free window. Returns empty array if no detention.
 */
export function computeDetentionForLoad(input: DetentionInput): DetentionEvent[] {
  const freeHours = input.freeHours ?? DEFAULT_FREE_HOURS;
  const rate = input.ratePerHourCents ?? DEFAULT_DETENTION_RATE_PER_HOUR_CENTS;
  const now = input.nowIso ?? new Date().toISOString();
  const events: DetentionEvent[] = [];

  const pickupArrived = lastByKind(input.checkins, "pickup_arrived");
  const loaded = lastByKind(input.checkins, "loaded");
  if (pickupArrived) {
    const completedAt = loaded?.createdAt ?? now;
    const totalHours = hoursBetween(pickupArrived.createdAt, completedAt);
    if (totalHours > freeHours) {
      const billableHours = ceilQuarterHour(totalHours - freeHours);
      const amountCents = Math.round(billableHours * rate);
      events.push({
        loadId: input.load.id,
        leg: "pickup",
        arrivedAt: pickupArrived.createdAt,
        completedAt,
        totalHours: Number(totalHours.toFixed(2)),
        freeHours,
        billableHours,
        ratePerHourCents: rate,
        amountCents,
        source: loaded ? "auto" : "estimated",
      });
    }
  }

  const deliveryArrived = lastByKind(input.checkins, "delivery_arrived");
  const delivered = lastByKind(input.checkins, "delivered");
  if (deliveryArrived) {
    const completedAt = delivered?.createdAt ?? now;
    const totalHours = hoursBetween(deliveryArrived.createdAt, completedAt);
    if (totalHours > freeHours) {
      const billableHours = ceilQuarterHour(totalHours - freeHours);
      const amountCents = Math.round(billableHours * rate);
      events.push({
        loadId: input.load.id,
        leg: "delivery",
        arrivedAt: deliveryArrived.createdAt,
        completedAt,
        totalHours: Number(totalHours.toFixed(2)),
        freeHours,
        billableHours,
        ratePerHourCents: rate,
        amountCents,
        source: delivered ? "auto" : "estimated",
      });
    }
  }

  return events;
}

/** Sum amount across multiple events. Convenience for invoice totals. */
export function totalDetentionCents(events: DetentionEvent[]): number {
  return events.reduce((sum, e) => sum + e.amountCents, 0);
}
