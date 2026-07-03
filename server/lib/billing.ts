// ===========================================================================
// server/lib/billing.ts — invoice calculation for Phase 3 P2
// ===========================================================================
//
// Both POST /api/admin/billing/preview and POST /api/admin/billing/generate
// run the SAME math through `computeInvoiceForWeek`. Preview returns the
// result inline (with id/status/generatedAt = null); generate also persists
// via storage.createInvoice.
//
// Fee policy (2026-07 restructure — supersedes the original booked-based spec):
//   The 3% success fee is charged ONLY on loads that are BOTH platform-sourced
//   (source_id IS NOT NULL) AND delivered within the billed week. Loads the
//   carrier enters themselves (manual / CSV / self-dispatch → source_id NULL)
//   are FREE. Booking no longer triggers the fee — DELIVERY does — so a load
//   booked in one week and delivered in a later week bills in the delivery week.
//   The fee is then capped monthly at 2× the client's plan price.
//
//   grossBookedCents = Σ rate-in-cents across platform-sourced loads
//                      where load.clientId matches AND
//                      payload.deliveredAt ∈ [weekStart, weekEnd] (inclusive)
//   flatFeeCents     = 15_000 (legacy managed-dispatch flat; cron passes 0)
//   percentFeeCents  = min(round(grossBookedCents * 0.03),
//                          max(0, monthlyCap − already-billed-this-month))
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
import { planForClient } from "./plans";

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

/**
 * A booked load is excluded from revenue when its lifecycle status is
 * cancelled. `bookedAt` is never cleared on cancel (it is the revenue-window
 * key), so cancelling only stamps `status` in the JSON payload — meaning a
 * booked-then-cancelled load otherwise stays in grossBooked and is charged the
 * 3% fee on revenue that never happened. Delivered/completed loads ARE
 * billable, so only the cancelled aliases are filtered here.
 *
 * `status` is not on the read `Load` type (it lives in the payload JSON and is
 * surfaced at runtime by parsePayloads), so we read it through a narrow cast.
 * This mirrors the ACTIVE_LOAD_SQL exclusion list in storage.ts and is
 * defense-in-depth alongside the storage-layer query filter.
 */
function isCancelledLoad(load: Load): boolean {
  const status = (load as { status?: unknown }).status;
  return status === "cancelled" || status === "canceled";
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
  // Monthly cap telemetry (2026-07). The uncapped 3% before clamping, the cap
  // itself (2× plan price), how much fee the month already carried, and whether
  // the clamp actually bit — surfaced in the invoice notes + audit log.
  percentFeeUncappedCents: number;
  monthlyCapCents: number;
  monthAlreadyBilledCents: number;
  capApplied: boolean;
  breakdown: {
    loadCount: number;
    loads: BreakdownLoad[];
  };
}

/**
 * Calculate an invoice without touching the database.
 *
 * `weekStart` and `weekEnd` are date-only strings ("YYYY-MM-DD"). Bounds are
 * INCLUSIVE on both ends, matching `deliveredAt >= weekStart AND <= weekEnd` in
 * the storage selector (listDeliveredSourcedLoadsForClientWeek).
 *
 * NOT a pure transformation anymore: it reads the client's plan (for the monthly
 * cap) and the month's already-billed success fees. Caller must validate that
 * the client exists and that weekStart <= weekEnd before calling this.
 */
export function computeInvoiceForWeek(
  clientId: string,
  weekStart: string,
  weekEnd: string,
  // The $150 flat fee is the legacy managed-dispatch model (admin generates by
  // hand). Self-serve subscription clients are sold "plan + 3% success fee",
  // so the automated weekly cron overrides this to 0 — see billing-run.ts.
  opts?: { flatFeeCents?: number },
): InvoiceCalculation {
  // Fee-restructure (2026-07): bill ONLY platform-sourced loads (source_id NOT
  // NULL) that were DELIVERED within the week (payload.deliveredAt in window).
  // listDeliveredSourcedLoadsForClientWeek already enforces both plus the
  // cancelled/canceled exclusion; the redundant isCancelledLoad filter is kept
  // as cheap defense-in-depth (mirrors the storage-layer predicate).
  const loads: Load[] = storage
    .listDeliveredSourcedLoadsForClientWeek(clientId, weekStart, weekEnd)
    .filter((load) => !isCancelledLoad(load));

  // Sum in cents to avoid float accumulation drift.
  const grossBookedCents = loads.reduce(
    (sum, load) => sum + Math.max(0, dollarsToCents(typeof load.rate === "number" ? load.rate : 0)),
    0,
  );

  // 3 % fee before the monthly cap. Integer math: cents * 300 / 10_000, once.
  const percentFeeUncappedCents = Math.round(
    (grossBookedCents * PERCENT_FEE_BASIS_POINTS) / PERCENT_FEE_DIVISOR,
  );

  // Monthly cap = 2× the client's plan monthlyCents. Sum the client's existing
  // NON-VOID success-fee invoices whose week_start is in the SAME calendar month
  // as this week, then clamp the new fee so the month total ≤ cap (clamp to 0 if
  // the cap is already exhausted). The cap is keyed on weekStart's month — the
  // billed week's Monday — which is how the cron/admin windows are aligned.
  const client = storage.getClient(clientId) as
    | { planTier?: string; persona?: "owner_operator" | "fleet" | "enterprise" }
    | undefined;
  const plan = planForClient(client ?? {});
  const monthlyCapCents = plan.monthlyCents * 2;
  const monthAlreadyBilledCents = storage.sumMonthPercentFeeCents(clientId, weekStart);
  const capRemainingCents = Math.max(0, monthlyCapCents - monthAlreadyBilledCents);
  const percentFeeCents = Math.min(percentFeeUncappedCents, capRemainingCents);
  const capApplied = percentFeeCents < percentFeeUncappedCents;

  const flatFeeCents = opts?.flatFeeCents ?? FLAT_FEE_CENTS;
  const totalDueCents = flatFeeCents + percentFeeCents;

  const breakdownLoads: BreakdownLoad[] = loads.map((load) => {
    const rateCents = Math.max(0, dollarsToCents(load.rate));
    return {
      loadId: load.id,
      rate: centsToDollars(rateCents),
      rateCents,
      originCity: load.originCity,
      destinationCity: load.destinationCity,
      // Prefer the real delivery timestamp (what triggered billing); fall back
      // to the planned deliveryAt for older rows that predate deliveredAt.
      deliveredAt:
        (load as { deliveredAt?: string }).deliveredAt || load.deliveryAt || undefined,
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
    percentFeeUncappedCents,
    monthlyCapCents,
    monthAlreadyBilledCents,
    capApplied,
    breakdown: {
      loadCount: loads.length,
      loads: breakdownLoads,
    },
  };
}
