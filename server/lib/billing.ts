// ===========================================================================
// server/lib/billing.ts — invoice calculation for Phase 3 P2
// ===========================================================================
//
// Both POST /api/admin/billing/preview and POST /api/admin/billing/generate
// run the SAME math through `computeInvoiceForWeek`. Preview returns the
// result inline (with id/status/generatedAt = null); generate also persists
// via storage.createInvoice.
//
// Formula (spec §4.1, §4.2):
//   grossBookedCents = Σ rate-in-cents across booked loads
//                      where load.clientId matches AND
//                      load.bookedAt ∈ [weekStart, weekEnd] (date-only, inclusive)
//   flatFeeCents     = 15_000 (configurable)
//   percentFeeCents  = round(grossBookedCents * 0.03)
//   totalDueCents    = flatFeeCents + percentFeeCents
//
// Audit Critical #7 (2026-05-26):
//   Money is now computed in integer cents end-to-end. Prior implementation
//   accumulated `rate` floats and applied `roundCents(value*100)/100` per
//   aggregation — sum-then-round vs round-then-sum disagreed at cents on
//   weekly invoices and at dollars over a quarter.
//
//   For backwards compatibility (frontend renders `flatFee`, `percentFee`,
//   `grossBooked`, `totalDue` as USD floats from this exact shape), the
//   returned interface keeps the dollar fields but adds canonical *_cents
//   counterparts. Floats are derived from cents at the I/O boundary, never
//   summed.
// ---------------------------------------------------------------------------

import type { Load } from "@shared/schema";
import { storage } from "../storage";

export const FLAT_FEE_CENTS = 15_000;            // $150.00 in integer cents
export const PERCENT_FEE_BASIS_POINTS = 300;     // 0.03 = 300 bps. 10_000 bps = 100%.
export const PERCENT_FEE_DIVISOR = 10_000;

// ---------------------------------------------------------------------------
// Conversion helpers — single point where USD floats meet integer cents.
// Use these at the boundary; never multiply/divide by 100 inline elsewhere.
// ---------------------------------------------------------------------------

/**
 * Convert a USD float (possibly `undefined`/`NaN`) to integer cents.
 * Rounds half-away-from-zero so `1.235 → 124` is consistent with
 * conventional money rounding, not banker's. NaN/null/undefined → 0.
 */
export function dollarsToCents(usd: number | undefined | null): number {
  if (usd == null) return 0;
  if (!Number.isFinite(usd)) return 0;
  // Round to nearest cent using Math.round of (usd * 100). For values where
  // float imprecision lands ε below .5 (e.g. 1.005), nudge with toFixed first.
  // Math.round(1.005 * 100) = 100 on V8 — we want 101.
  const fixed = Number((usd as number).toFixed(2));
  return Math.round(fixed * 100);
}

/** Convert integer cents to USD float (2 decimals). Pure transformation. */
export function centsToDollars(cents: number): number {
  if (!Number.isFinite(cents)) return 0;
  return Math.round(cents) / 100;
}

// ---------------------------------------------------------------------------
// Legacy alias kept for callers that still want to round a float to cents.
// New code should compute in cents and convert via centsToDollars at the edge.
// ---------------------------------------------------------------------------

/** @deprecated use dollarsToCents/centsToDollars; kept for back-compat. */
export function roundCents(value: number): number {
  return centsToDollars(dollarsToCents(value));
}

export interface BreakdownLoad {
  loadId: string;
  rate: number;          // USD float — display field
  rateCents: number;     // canonical integer cents
  originCity: string;
  destinationCity: string;
  deliveredAt?: string;
}

export interface InvoiceCalculation {
  clientId: string;
  weekStart: string;
  weekEnd: string;
  // USD floats — preserved for existing UI/JSON shape, derived from cents.
  flatFee: number;
  percentFee: number;
  grossBooked: number;
  totalDue: number;
  // Canonical integer cents — what we actually store/compute on.
  flatFeeCents: number;
  percentFeeCents: number;
  grossBookedCents: number;
  totalDueCents: number;
  breakdown: {
    loadCount: number;
    loads: BreakdownLoad[];
  };
}

/**
 * Calculate an invoice without touching the database.
 *
 * `weekStart` and `weekEnd` are date-only strings ("YYYY-MM-DD"). Bounds are
 * INCLUSIVE on both ends, matching `bookedAt >= weekStart AND <= weekEnd` in
 * the storage index lookup.
 *
 * Caller must validate that the client exists and that weekStart <= weekEnd
 * before calling this. We don't repeat those checks here so the function is a
 * pure transformation suitable for unit testing.
 */
export function computeInvoiceForWeek(
  clientId: string,
  weekStart: string,
  weekEnd: string,
): InvoiceCalculation {
  const loads: Load[] = storage.listBookedLoadsForClientWeek(clientId, weekStart, weekEnd);

  // Sum in cents to avoid float accumulation drift.
  const grossBookedCents = loads.reduce(
    (sum, load) => sum + dollarsToCents(typeof load.rate === "number" ? load.rate : 0),
    0,
  );

  // 3 % fee. Integer math: cents * 300 / 10_000, rounded once.
  const percentFeeCents = Math.round(
    (grossBookedCents * PERCENT_FEE_BASIS_POINTS) / PERCENT_FEE_DIVISOR,
  );
  const flatFeeCents = FLAT_FEE_CENTS;
  const totalDueCents = flatFeeCents + percentFeeCents;

  const breakdownLoads: BreakdownLoad[] = loads.map((load) => {
    const rateCents = dollarsToCents(load.rate);
    return {
      loadId: load.id,
      rate: centsToDollars(rateCents),
      rateCents,
      originCity: load.originCity,
      destinationCity: load.destinationCity,
      // The spec uses `deliveredAt` here, mapped from the existing `deliveryAt`
      // field on loadSchema. Optional, so omit when missing.
      deliveredAt: load.deliveryAt || undefined,
    };
  });

  return {
    clientId,
    weekStart,
    weekEnd,
    flatFee: centsToDollars(flatFeeCents),
    percentFee: centsToDollars(percentFeeCents),
    grossBooked: centsToDollars(grossBookedCents),
    totalDue: centsToDollars(totalDueCents),
    flatFeeCents,
    percentFeeCents,
    grossBookedCents,
    totalDueCents,
    breakdown: {
      loadCount: loads.length,
      loads: breakdownLoads,
    },
  };
}
