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
//   grossBooked  = sum of `rate` across all loads where load.clientId matches
//                  and load.bookedAt ∈ [weekStart, weekEnd] (date-only,
//                  inclusive on both ends).
//   flatFee      = 150 (USD, configurable below)
//   percentFee   = round(grossBooked * 0.03, cents)
//   totalDue     = round(flatFee + percentFee, cents)
//
// All money values are USD as floats; rounding is to 2 decimal places via
// `roundCents`. The frontend renders with formatMoneyCents — never integer
// cents. See lock-in note in the P2 design conversation.
// ---------------------------------------------------------------------------

import type { Load } from "@shared/schema";
import { storage } from "../storage";

export const FLAT_FEE_USD = 150;
export const PERCENT_FEE_RATE = 0.03;

/** Round to 2 decimal places. Avoids 0.30000000000000004-style float noise. */
export function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface BreakdownLoad {
  loadId: string;
  rate: number;
  originCity: string;
  destinationCity: string;
  deliveredAt?: string;
}

export interface InvoiceCalculation {
  clientId: string;
  weekStart: string;
  weekEnd: string;
  flatFee: number;
  percentFee: number;
  grossBooked: number;
  totalDue: number;
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

  const grossBooked = roundCents(
    loads.reduce((sum, load) => sum + (typeof load.rate === "number" ? load.rate : 0), 0),
  );
  const percentFee = roundCents(grossBooked * PERCENT_FEE_RATE);
  const flatFee = FLAT_FEE_USD;
  const totalDue = roundCents(flatFee + percentFee);

  const breakdownLoads: BreakdownLoad[] = loads.map((load) => ({
    loadId: load.id,
    rate: load.rate,
    originCity: load.originCity,
    destinationCity: load.destinationCity,
    // The spec uses `deliveredAt` here, mapped from the existing `deliveryAt`
    // field on loadSchema. Optional, so omit when missing.
    deliveredAt: load.deliveryAt || undefined,
  }));

  return {
    clientId,
    weekStart,
    weekEnd,
    flatFee,
    percentFee,
    grossBooked,
    totalDue,
    breakdown: {
      loadCount: loads.length,
      loads: breakdownLoads,
    },
  };
}
