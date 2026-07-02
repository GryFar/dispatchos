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
   * "verified" — both checkins corroborated by GPS pings in the on-site window
   * "auto" — both checkins present, GPS not provided to the caller (callers
   *           that want fraud-safe billing should pass gpsPings; otherwise we
   *           fall back to this legacy label)
   * "estimated" — only arrival recorded, no completion yet (driver on-site)
   * "unverified" — GPS pings were provided but did NOT corroborate the
   *           claimed on-site window. UI shows red; production billing
   *           should NOT auto-bill these (Audit V3-5).
   */
  source: "verified" | "auto" | "estimated" | "unverified";
  /** Count of GPS pings observed in radius during the window, when checked. */
  pingCount?: number;
}

export interface DetentionInput {
  load: Pick<Load, "id"> & {
    originLat?: number | null;
    originLng?: number | null;
    destinationLat?: number | null;
    destinationLng?: number | null;
  };
  checkins: LoadCheckin[];
  /** Per-client override of free hours; falls back to DEFAULT_FREE_HOURS. */
  freeHours?: number;
  /** Per-client override of $/hr; falls back to DEFAULT_DETENTION_RATE_PER_HOUR_CENTS. */
  ratePerHourCents?: number;
  /** "now" injection for testability + for legs still in progress. */
  nowIso?: string;
  /**
   * Audit V3-5 — GPS pings during the on-site window. When supplied, an
   * event is marked source='unverified' if no pings within ARRIVAL_RADIUS_KM
   * of origin/destination exist during the claimed window. Callers that
   * want strict billing (production) should pass this and only bill events
   * with source='auto' or 'verified'. Pure-compute callers (preview, tests)
   * can omit it and accept self-reported data.
   */
  gpsPings?: Array<{ lat: number; lng: number; capturedAt: string }>;
}

/** 1 mile — same radius the geofence module uses. */
const VERIFICATION_RADIUS_KM = 1.6;

/**
 * Minimum in-radius GPS pings during the on-site window to treat a completed
 * leg as 'verified' (billable). One fix already proves presence; sparse GPS on
 * a long stationary wait is normal, so demanding more than one silently dropped
 * real detention revenue. 0 pings → 'unverified' (fraud/off-device guard).
 */
const MIN_CORROBORATING_PINGS = 1;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * V3-5 corroboration helper. Counts how many GPS pings within radius of the
 * given lat/lng fall inside [startIso, endIso]. Returns 0 when no pings
 * (caller decides whether to trust the checkin).
 */
function countPingsInRadius(
  pings: Array<{ lat: number; lng: number; capturedAt: string }> | undefined,
  lat: number | null | undefined,
  lng: number | null | undefined,
  startIso: string,
  endIso: string,
): number {
  if (!pings || !pings.length || lat == null || lng == null) return 0;
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  let count = 0;
  for (const p of pings) {
    const pMs = new Date(p.capturedAt).getTime();
    if (!Number.isFinite(pMs) || pMs < startMs || pMs > endMs) continue;
    if (haversineKm(lat, lng, p.lat, p.lng) <= VERIFICATION_RADIUS_KM) count++;
  }
  return count;
}

/**
 * Compute the latest checkin of a given kind. Checkins are stored
 * `ORDER BY created_at ASC` by the storage layer; we walk from the
 * end to grab the freshest. Used for COMPLETION anchors (loaded /
 * delivered), where the most recent event is the real end of the leg.
 */
function lastByKind(checkins: LoadCheckin[], kind: LoadCheckin["kind"]) {
  for (let i = checkins.length - 1; i >= 0; i--) {
    if (checkins[i]!.kind === kind) return checkins[i]!;
  }
  return undefined;
}

/**
 * Compute the EARLIEST checkin of a given kind. Used for ARRIVAL anchors
 * (pickup_arrived / delivery_arrived): if a driver records arrival more
 * than once, detention must be measured from the FIRST time the truck was
 * on-site, not the latest — otherwise (completedAt - arrivedAt) shrinks and
 * billable detention is understated or dropped entirely (Audit).
 */
function firstByKind(checkins: LoadCheckin[], kind: LoadCheckin["kind"]) {
  for (let i = 0; i < checkins.length; i++) {
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
 * Sanitize a caller-supplied config number (freeHours / ratePerHourCents)
 * before it feeds billing math. Null/undefined and non-finite values fall
 * back to the default; negative values are clamped to 0. This guards against
 * malformed per-client config over-billing (negative freeHours) or producing
 * a negative charge (negative rate).
 */
function clampConfig(value: number | null | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

/**
 * Inspect a load's check-ins and emit one DetentionEvent per leg that
 * exceeded the free window. Returns empty array if no detention.
 */
export function computeDetentionForLoad(input: DetentionInput): DetentionEvent[] {
  // Clamp caller-supplied config before it reaches money math. A non-finite
  // value (NaN/Infinity from malformed per-client config) falls back to the
  // default; a negative value is floored to 0. Without this, a negative
  // freeHours over-bills nearly every leg and a negative rate yields a
  // negative amountCents (Audit medium).
  const freeHours = clampConfig(input.freeHours, DEFAULT_FREE_HOURS);
  const rate = clampConfig(input.ratePerHourCents, DEFAULT_DETENTION_RATE_PER_HOUR_CENTS);
  const now = input.nowIso ?? new Date().toISOString();
  const events: DetentionEvent[] = [];

  /**
   * Classify the source of a leg given (a) whether completion checkin
   * exists and (b) whether GPS pings corroborate. Caller controls strictness
   * by passing gpsPings or not (V3-5).
   */
  const classify = (
    hasCompletion: boolean,
    pingCount: number,
    gpsChecked: boolean,
  ): DetentionEvent["source"] => {
    if (!hasCompletion) return "estimated";
    if (!gpsChecked) return "auto";
    // A single GPS fix inside the on-site radius during the claimed window IS
    // corroboration — the truck demonstrably was there. The old 2-ping bar
    // zeroed legitimate long detention whenever GPS was sparse (device asleep
    // / poor signal during a multi-hour stationary wait), i.e. exactly the
    // revenue this feature exists to capture. Only a TOTAL absence of pings
    // (0) stays unverified — that's the real fraud/off-device signal.
    if (pingCount >= MIN_CORROBORATING_PINGS) return "verified";
    return "unverified";
  };

  const pickupArrived = firstByKind(input.checkins, "pickup_arrived");
  const loaded = lastByKind(input.checkins, "loaded");
  if (pickupArrived) {
    const completedAt = loaded?.createdAt ?? now;
    const totalHours = hoursBetween(pickupArrived.createdAt, completedAt);
    if (totalHours > freeHours) {
      const billableHours = ceilQuarterHour(totalHours - freeHours);
      const amountCents = Math.round(billableHours * rate);
      const pingCount = countPingsInRadius(
        input.gpsPings,
        input.load.originLat,
        input.load.originLng,
        pickupArrived.createdAt,
        completedAt,
      );
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
        source: classify(Boolean(loaded), pingCount, Array.isArray(input.gpsPings)),
        pingCount: Array.isArray(input.gpsPings) ? pingCount : undefined,
      });
    }
  }

  const deliveryArrived = firstByKind(input.checkins, "delivery_arrived");
  const delivered = lastByKind(input.checkins, "delivered");
  if (deliveryArrived) {
    const completedAt = delivered?.createdAt ?? now;
    const totalHours = hoursBetween(deliveryArrived.createdAt, completedAt);
    if (totalHours > freeHours) {
      const billableHours = ceilQuarterHour(totalHours - freeHours);
      const amountCents = Math.round(billableHours * rate);
      const pingCount = countPingsInRadius(
        input.gpsPings,
        input.load.destinationLat,
        input.load.destinationLng,
        deliveryArrived.createdAt,
        completedAt,
      );
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
        source: classify(Boolean(delivered), pingCount, Array.isArray(input.gpsPings)),
        pingCount: Array.isArray(input.gpsPings) ? pingCount : undefined,
      });
    }
  }

  return events;
}

/** Sum only billable (verified or auto-without-GPS-check) events. Excludes
 *  unverified events from totals — production billing must use this. */
export function billableDetentionCents(events: DetentionEvent[]): number {
  return events
    .filter((e) => e.source === "verified" || e.source === "auto")
    .reduce((sum, e) => sum + e.amountCents, 0);
}

/**
 * GROSS sum of amountCents across ALL events — including 'estimated'
 * (leg still in progress) and 'unverified' (GPS did not corroborate).
 *
 * ⚠️ NOT bill-safe. This is a PREVIEW/opportunity figure for the admin UI
 * only (e.g. "potential detention to chase"). Do NOT use it to compute an
 * invoice line or charge a customer — for anything that touches money use
 * {@link billableDetentionCents}, which excludes unverified/estimated events
 * per Audit V3-5.
 */
export function previewDetentionCents(events: DetentionEvent[]): number {
  return events.reduce((sum, e) => sum + e.amountCents, 0);
}

/**
 * @deprecated Misleadingly named — sums non-bill-safe (unverified/estimated)
 * events too. Kept as an alias for existing admin preview callers. Use
 * {@link previewDetentionCents} for previews or {@link billableDetentionCents}
 * for anything billing-related.
 */
export const totalDetentionCents = previewDetentionCents;
