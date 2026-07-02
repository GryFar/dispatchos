// Weekly success-fee invoice generation, shared by the admin generate route
// (per-client, arbitrary week) and POST /api/cron/weekly-billing (all billable
// clients, last closed Mon–Sun week). Idempotency rests on the partial
// UNIQUE(client_id, week_start) WHERE status != 'void' index — a re-run skips
// already-billed (client, week) pairs instead of double-billing.

import { storage } from "../storage";
import { computeInvoiceForWeek } from "./billing";
import { chargeInvoiceViaStripe } from "./stripe";
import type { Invoice, Client } from "@shared/schema";

/**
 * True when `err` is the SQLite UNIQUE-constraint violation from the partial
 * invoices_client_week_uq index (a live, non-void invoice already covers this
 * (client, week)). better-sqlite3 surfaces these as an Error whose `.code` is
 * "SQLITE_CONSTRAINT_UNIQUE" (older builds: "SQLITE_CONSTRAINT") and whose
 * message names the offending index.
 */
export function isUniqueWeekViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  const codeStr = typeof code === "string" ? code : "";
  const msgStr = typeof message === "string" ? message : "";
  const isUnique =
    codeStr === "SQLITE_CONSTRAINT_UNIQUE" ||
    (codeStr === "SQLITE_CONSTRAINT" && /unique/i.test(msgStr));
  return isUnique && /invoices_client_week_uq|invoices\.(client_id|week_start)/i.test(msgStr);
}

/**
 * Most recently CLOSED Mon–Sun billing week (UTC). A week only closes once its
 * Sunday has fully elapsed, so on any Monday this returns last week, and on any
 * Sunday it returns the week before (the running one is still open).
 * weekOffset shifts further back: 0 = last closed week, 1 = the week before it.
 */
export function lastClosedBillingWeek(
  weekOffset = 0,
  now: Date = new Date(),
): { weekStart: string; weekEnd: string } {
  const DAY_MS = 86_400_000;
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // getUTCDay(): 0=Sun..6=Sat → days since the current week's Monday.
  const daysSinceMonday = (new Date(todayUtc).getUTCDay() + 6) % 7;
  const currentMonday = todayUtc - daysSinceMonday * DAY_MS;
  const start = currentMonday - 7 * (1 + weekOffset) * DAY_MS;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { weekStart: iso(start), weekEnd: iso(start + 6 * DAY_MS) };
}

export type GenerateChargeResult =
  | { ok: true; invoice: Invoice; chargeStatus: string }
  | {
      ok: false;
      conflict: true;
      /** "overlap" = pre-check found an overlapping live invoice; "duplicate" =
       *  the unique index rejected the insert (lost a TOCTOU race). */
      reason: "overlap" | "duplicate";
      existingInvoiceId?: string;
      existingWeek?: { weekStart: string; weekEnd: string };
    };

/**
 * Generate one client's invoice for a week and attempt Stripe collection.
 * Caller must have validated the client (exists, not soft-deleted) and the
 * week window (YYYY-MM-DD, exactly 7 inclusive days) already.
 *
 * The DispatchOS invoice is persisted BEFORE the Stripe attempt — a Stripe
 * failure (no customer, network, unconfigured) must not lose the invoice; it
 * stays 'draft' and retriable via the admin charge route. On charge success we
 * stamp the Stripe id + advance draft → sent; the invoice.payment_succeeded
 * webhook later flips it to 'paid'.
 */
export async function generateAndChargeInvoiceForClient(input: {
  clientId: string;
  weekStart: string;
  weekEnd: string;
  status?: "draft" | "sent";
  /** Admin actor id; omitted for cron runs (audits stamp generatedBy=cron). */
  actorId?: string;
  /** Override the $150 legacy flat fee — the weekly cron passes 0 because
   *  self-serve clients are sold "subscription + 3%", not the managed-dispatch
   *  flat. Omitted (admin route) keeps the legacy default. */
  flatFeeCents?: number;
}): Promise<GenerateChargeResult> {
  const actorMeta = input.actorId
    ? { createdByAdminId: input.actorId }
    : { generatedBy: "cron" };

  const dup = storage.findOverlappingInvoice(input.clientId, input.weekStart, input.weekEnd);
  if (dup) {
    return {
      ok: false,
      conflict: true,
      reason: "overlap",
      existingInvoiceId: dup.id,
      existingWeek: { weekStart: dup.weekStart, weekEnd: dup.weekEnd },
    };
  }

  const calc = computeInvoiceForWeek(input.clientId, input.weekStart, input.weekEnd, {
    flatFeeCents: input.flatFeeCents,
  });
  // The findOverlappingInvoice pre-check above is best-effort and TOCTOU-racy
  // (a concurrent generate can slip between the check and this insert). The
  // partial UNIQUE(client_id, week_start) WHERE status != 'void' index is the
  // real guard: it lets a voided week be re-billed but rejects a duplicate of
  // a LIVE (non-void) invoice.
  let invoice: Invoice;
  try {
    invoice = storage.createInvoice({
      clientId: calc.clientId,
      weekStart: calc.weekStart,
      weekEnd: calc.weekEnd,
      flatFee: calc.flatFee,
      percentFee: calc.percentFee,
      grossBooked: calc.grossBooked,
      status: input.status,
    });
  } catch (err) {
    if (isUniqueWeekViolation(err)) {
      const existing = storage.findInvoiceForWeek(calc.clientId, calc.weekStart);
      return {
        ok: false,
        conflict: true,
        reason: "duplicate",
        existingInvoiceId: existing?.id,
        existingWeek: existing
          ? { weekStart: existing.weekStart, weekEnd: existing.weekEnd }
          : undefined,
      };
    }
    throw err;
  }

  // storage.createInvoice already emits `invoice.created`; add a caller-context
  // event with the actor for traceability.
  storage.audit(
    input.actorId ? "invoice.created.admin" : "invoice.created.cron",
    "invoice",
    invoice.id,
    {
      invoiceId: invoice.id,
      clientId: invoice.clientId,
      weekStart: invoice.weekStart,
      weekEnd: invoice.weekEnd,
      totalDue: invoice.totalDue,
      ...actorMeta,
    },
  );

  const advanced = await chargeAndAdvance(invoice, actorMeta);
  return { ok: true, invoice: advanced.invoice, chargeStatus: advanced.chargeStatus };
}

/**
 * Attempt Stripe collection for a persisted invoice and advance draft → sent
 * on success. Shared by first-run generation and the weekly cron's retry of
 * still-draft invoices from earlier runs. chargeInvoiceViaStripe never throws.
 */
async function chargeAndAdvance(
  invoice: Invoice,
  actorMeta: Record<string, unknown>,
): Promise<{ invoice: Invoice; chargeStatus: string }> {
  let chargeStatus: string;
  let finalInvoice = invoice;
  const charge = await chargeInvoiceViaStripe(invoice);
  if (charge.ok && charge.stripeInvoiceId) {
    storage.setInvoiceStripeId(invoice.id, charge.stripeInvoiceId);
    // Only advance draft → sent; if generated as 'sent' already, the
    // transition is a no-op.
    if (invoice.status === "draft") {
      const upd = storage.updateInvoice(invoice.id, { status: "sent" });
      if ("invoice" in upd) finalInvoice = upd.invoice;
      else finalInvoice = storage.getInvoice(invoice.id) ?? invoice;
    } else {
      finalInvoice = storage.getInvoice(invoice.id) ?? invoice;
    }
    chargeStatus = "charged";
    storage.audit("billing.charge_initiated", "invoice", invoice.id, {
      invoiceId: invoice.id,
      clientId: invoice.clientId,
      stripeInvoiceId: charge.stripeInvoiceId,
      ...actorMeta,
    });
  } else {
    chargeStatus = charge.reason ?? "charge_failed";
    storage.audit("billing.charge_skipped", "invoice", invoice.id, {
      invoiceId: invoice.id,
      clientId: invoice.clientId,
      reason: chargeStatus,
      ...actorMeta,
    });
  }
  return { invoice: finalInvoice, chargeStatus };
}

export interface WeeklyBillingSummary {
  weekStart: string;
  weekEnd: string;
  clients: number;
  generated: number;
  charged: number;
  /** Still-draft invoices from earlier runs whose charge was re-attempted. */
  retried: number;
  skipped: number;
  failed: number;
  results: Array<{
    clientId: string;
    outcome: "generated" | "retried" | "skipped" | "failed";
    invoiceId?: string;
    chargeStatus?: string;
    reason?: string;
  }>;
}

/**
 * Statuses the automated weekly run may bill. Everything else is skipped:
 * 'trial' clients are inside the advertised free window (a trialing sub with a
 * card on file IS chargeable — billing them here would charge real money during
 * "free"), 'expired' clients are read-only and can't have used the service,
 * 'canceled' left, and a missing status means never-subscribed legacy data.
 * 'past_due' stays billable — the service was used; Stripe dunning handles the
 * failing card.
 */
const CRON_BILLABLE_STATUSES = new Set(["active", "past_due"]);

/** Flat fee for the AUTOMATED weekly run. Self-serve pricing is
 *  "subscription + 3% success fee" — no $150 managed-dispatch flat — so this
 *  defaults to 0. Env knob for a future managed tier; the manual admin route
 *  keeps the legacy $150 default regardless. Read per-call so tests (and a
 *  fly secret change + restart) take effect without a rebuild. */
function cronFlatFeeCents(): number {
  const raw = Number(process.env.DISPATCHOS_WEEKLY_FLAT_FEE_CENTS);
  return Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/**
 * Generate + charge last CLOSED week's success-fee invoice for every billable
 * client. Cron policy (differs from the manual admin route on purpose):
 * only 'active'/'past_due' clients, no invoice at all for a zero-booked week,
 * flat fee 0 (3% only) — see CRON_BILLABLE_STATUSES/cronFlatFeeCents above.
 * Idempotent: an already-billed (client, week) counts as skipped — except a
 * still-draft, never-charged invoice, whose charge is re-attempted (`retried`)
 * so a Stripe outage or a late-added card heals on the next Monday run.
 * A per-client error never aborts the run — it's counted under `failed`.
 */
export async function runWeeklyBillingForAllClients(
  weekOffset = 0,
): Promise<WeeklyBillingSummary> {
  const { weekStart, weekEnd } = lastClosedBillingWeek(weekOffset);
  const clients = storage.listClients();
  const summary: WeeklyBillingSummary = {
    weekStart,
    weekEnd,
    clients: clients.length,
    generated: 0,
    charged: 0,
    retried: 0,
    skipped: 0,
    failed: 0,
    results: [],
  };

  for (const client of clients) {
    const billingStatus = (client as Client & { billingStatus?: string }).billingStatus;
    if (!billingStatus || !CRON_BILLABLE_STATUSES.has(billingStatus)) {
      summary.skipped += 1;
      summary.results.push({
        clientId: client.id,
        outcome: "skipped",
        reason: `client_${billingStatus ?? "no_status"}`,
      });
      continue;
    }
    try {
      // No booked loads in the window → 3% of nothing. Don't create a $0
      // ledger row per idle client per week; skip before any insert.
      const calc = computeInvoiceForWeek(client.id, weekStart, weekEnd, { flatFeeCents: 0 });
      if (calc.grossBookedCents === 0) {
        summary.skipped += 1;
        summary.results.push({ clientId: client.id, outcome: "skipped", reason: "no_booked_loads" });
        continue;
      }

      const result = await generateAndChargeInvoiceForClient({
        clientId: client.id,
        weekStart,
        weekEnd,
        flatFeeCents: cronFlatFeeCents(),
      });
      if (!result.ok) {
        // A draft that never reached Stripe (charge failed on a previous run,
        // or the client added a card since) is retried, not skipped.
        const existing = result.existingInvoiceId
          ? storage.getInvoice(result.existingInvoiceId)
          : undefined;
        if (existing && existing.status === "draft" && !existing.stripeInvoiceId) {
          const retry = await chargeAndAdvance(existing, { generatedBy: "cron", retry: "true" });
          summary.retried += 1;
          if (retry.chargeStatus === "charged") summary.charged += 1;
          summary.results.push({
            clientId: client.id,
            outcome: "retried",
            invoiceId: existing.id,
            chargeStatus: retry.chargeStatus,
          });
          continue;
        }
        summary.skipped += 1;
        summary.results.push({
          clientId: client.id,
          outcome: "skipped",
          reason: "already_billed",
          invoiceId: result.existingInvoiceId,
        });
        continue;
      }
      summary.generated += 1;
      if (result.chargeStatus === "charged") summary.charged += 1;
      summary.results.push({
        clientId: client.id,
        outcome: "generated",
        invoiceId: result.invoice.id,
        chargeStatus: result.chargeStatus,
      });
    } catch (err) {
      summary.failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[billing-run] client ${client.id} failed:`, msg);
      summary.results.push({ clientId: client.id, outcome: "failed", reason: msg });
    }
  }

  return summary;
}
