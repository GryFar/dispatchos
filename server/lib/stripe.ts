// ===========================================================================
// server/lib/stripe.ts — Stripe Checkout + Customer Portal + webhook handling
// ===========================================================================
//
// Built on top of PR #89 (onboarding backend with plan tiers).
//
// Architecture:
//   - Stripe Checkout (hosted page) for plan upgrades → we never see card data.
//   - Customer Portal for self-service (change plan, cancel, update card).
//   - Webhook handler reconciles client.billingStatus + planTier + subscription_id
//     on customer.subscription.* + invoice.payment_* events.
//   - Trial: 14 days, handled by `subscription_data.trial_period_days` on
//     Checkout. No webhook trigger needed on trial start.
//
// Env vars:
//   STRIPE_SECRET_KEY            — sk_test_... / sk_live_...
//   STRIPE_WEBHOOK_SECRET        — whsec_... (set after creating endpoint in dashboard)
//   STRIPE_PRICE_OO_BASIC        — price_... (and similar for each tier)
//   STRIPE_PRICE_OO_PREMIUM
//   STRIPE_PRICE_FLEET_STARTER
//   STRIPE_PRICE_FLEET_GROWTH
//   STRIPE_PRICE_FLEET_SCALE
//   STRIPE_PRICE_ENTERPRISE
// ---------------------------------------------------------------------------

import Stripe from "stripe";
import { storage } from "../storage";
import { getIntegrationValue } from "./integration-config";
import { PLANS, stripePriceForTier, tierForStripePrice, planForClient } from "./plans";
import { dollarsToCents } from "./billing";
import type { Invoice } from "@shared/schema";

let _stripe: Stripe | null = null;

/** Lazy-init Stripe client. Reads from integration store first, env fallback. */
export function stripeClient(): Stripe | null {
  if (_stripe) return _stripe;
  const key =
    getIntegrationValue("stripe", "STRIPE_SECRET_KEY") ?? process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  // Omit apiVersion entirely — SDK pins one internally per release. If you
  // need to lock to a specific version, set STRIPE_API_VERSION env and pass
  // it through here. This keeps us forward-compatible with SDK upgrades.
  _stripe = new Stripe(key, {
    appInfo: { name: "DispatchOS", version: "1.3.1" },
  });
  return _stripe;
}

/**
 * Test-only seam: inject (or clear) the memoized Stripe client so unit tests can
 * exercise the webhook state machine without real network calls. Pass null to
 * reset back to lazy initialization. Not used by production code paths.
 */
export function __setStripeClientForTest(stub: Stripe | null): void {
  _stripe = stub;
}

/** Was Stripe configured at any source (DB or env)? Cheap check. */
export function isStripeConfigured(): boolean {
  return Boolean(
    getIntegrationValue("stripe", "STRIPE_SECRET_KEY") ?? process.env.STRIPE_SECRET_KEY,
  );
}

export interface CheckoutInput {
  clientId: string;
  /** Plan tier from PLANS catalogue (e.g. "fleet_starter"). */
  tier: string;
  /** Where to send the user after successful payment. */
  successUrl: string;
  /** Where to send the user if they cancel from Checkout. */
  cancelUrl: string;
  /** Optional customer email — prefills Checkout form. */
  customerEmail?: string;
}

/**
 * Create a Stripe Checkout session for a plan tier. Returns the URL to
 * redirect the browser to. We honor the 14-day trial via
 * `subscription_data.trial_period_days = 14`.
 *
 * If the client already has a stripeCustomerId, we reuse it so the same
 * Customer accumulates subscription history (and Customer Portal works).
 */
export async function createCheckoutSession(
  input: CheckoutInput,
): Promise<{ url: string; sessionId: string }> {
  const stripe = stripeClient();
  if (!stripe) throw new Error("Stripe is not configured");

  const plan = PLANS[input.tier];
  if (!plan) throw new Error(`Unknown plan tier: ${input.tier}`);
  if (plan.tier === "trial") throw new Error("Trial tier doesn't need Checkout");

  const priceId = stripePriceForTier(input.tier);
  if (!priceId) {
    throw new Error(
      `Missing Stripe price id for tier ${input.tier} (expected env ${plan.stripePriceEnvKey})`,
    );
  }

  const client = storage.getClient(input.clientId) as
    | (Record<string, unknown> & { name?: string; stripeCustomerId?: string; deletedAt?: string | null })
    | undefined;
  // getClient resolves archived clients (needed for webhook reconciliation);
  // an archived carrier must not be able to START a new checkout.
  if (!client || client.deletedAt) throw new Error("Client not found");

  // Reuse existing customer if we have one; otherwise let Stripe create on success.
  const customerParam: Pick<Stripe.Checkout.SessionCreateParams, "customer" | "customer_email"> =
    client.stripeCustomerId
      ? { customer: client.stripeCustomerId }
      : input.customerEmail
        ? { customer_email: input.customerEmail }
        : {};

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    subscription_data: {
      trial_period_days: 14,
      // We embed clientId so the webhook can reconcile back to our DB
      // without needing a Stripe Customer lookup.
      metadata: {
        clientId: input.clientId,
        tier: input.tier,
      },
    },
    metadata: {
      clientId: input.clientId,
      tier: input.tier,
    },
    // Collect address for tax + future invoicing.
    billing_address_collection: "auto",
    automatic_tax: { enabled: false },
    ...customerParam,
  });

  if (!session.url) {
    throw new Error("Stripe returned no checkout URL");
  }

  storage.audit("billing.checkout_created", "client", input.clientId, {
    sessionId: session.id,
    tier: input.tier,
  });

  return { url: session.url, sessionId: session.id };
}

/**
 * Create a Customer Portal session — lets the customer self-serve plan
 * changes, cancellations, card updates, invoice history. We host nothing.
 */
export async function createPortalSession(
  clientId: string,
  returnUrl: string,
): Promise<{ url: string }> {
  const stripe = stripeClient();
  if (!stripe) throw new Error("Stripe is not configured");

  const client = storage.getClient(clientId) as
    | (Record<string, unknown> & { stripeCustomerId?: string; deletedAt?: string | null })
    | undefined;
  // Mirror createCheckoutSession exactly: a missing OR archived carrier is
  // "not found" — an archived tenant must not reach the billing portal.
  if (!client || client.deletedAt) throw new Error("Client not found");
  if (!client.stripeCustomerId) {
    throw new Error(
      "No Stripe customer for this client. Complete a Checkout first.",
    );
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: client.stripeCustomerId,
    return_url: returnUrl,
  });

  storage.audit("billing.portal_created", "client", clientId, {
    sessionId: session.id,
  });

  return { url: session.url };
}

// ---------------------------------------------------------------------------
// One-off success-fee charging.
//
// The weekly success fee (flat $150 + 3% of gross booked) is computed and
// stored on the DispatchOS invoice but was never actually collected. We charge
// it as a one-off Stripe invoice against the carrier's saved default payment
// method: create one invoice item per fee component (in integer cents), open an
// invoice with collection_method 'charge_automatically' + auto_advance, then
// finalize so Stripe attempts collection immediately. The invoice.payment_succeeded
// webhook (below) reconciles the DispatchOS row to 'paid'.
//
// Money is integer cents end-to-end: the stored row keeps USD floats, so we
// re-derive cents at this boundary via dollarsToCents (the same helper billing.ts
// uses), never multiplying by 100 inline.
//
// Every Stripe create call carries a deterministic idempotency key derived from
// the DispatchOS invoice id, so an admin retry (or a generate that partially ran
// then re-ran) can NEVER double-charge the carrier.
// ---------------------------------------------------------------------------

export async function chargeInvoiceViaStripe(
  invoice: Invoice,
): Promise<{ ok: boolean; stripeInvoiceId?: string; reason?: string }> {
  const stripe = stripeClient();
  if (!stripe) return { ok: false, reason: "stripe_not_configured" };

  const client = storage.getClient(invoice.clientId) as
    | (Record<string, unknown> & { stripeCustomerId?: string; deletedAt?: string | null })
    | undefined;
  if (!client || client.deletedAt) return { ok: false, reason: "client_not_found" };
  const customer = client.stripeCustomerId;
  if (!customer) return { ok: false, reason: "no_stripe_customer" };

  // Re-derive integer cents from the stored USD floats at this boundary.
  const flatFeeCents = dollarsToCents(invoice.flatFee);
  const percentFeeCents = dollarsToCents(invoice.percentFee);

  try {
    // Flat platform fee — always present.
    if (flatFeeCents > 0) {
      await stripe.invoiceItems.create(
        {
          customer,
          amount: flatFeeCents,
          currency: "usd",
          description: `DispatchOS platform fee — week of ${invoice.weekStart}`,
        },
        { idempotencyKey: `dos_inv_${invoice.id}_flat` },
      );
    }
    // 3% success fee — skip a zero-amount item (Stripe rejects amount 0 here and
    // an empty week shouldn't create a noise line).
    if (percentFeeCents > 0) {
      await stripe.invoiceItems.create(
        {
          customer,
          amount: percentFeeCents,
          currency: "usd",
          description: `DispatchOS 3% success fee — week of ${invoice.weekStart}`,
        },
        { idempotencyKey: `dos_inv_${invoice.id}_pct` },
      );
    }

    const created = await stripe.invoices.create(
      {
        customer,
        collection_method: "charge_automatically",
        auto_advance: true,
        // Sweep the pending invoice items we just created onto this invoice.
        pending_invoice_items_behavior: "include",
        metadata: {
          dispatchosInvoiceId: invoice.id,
          clientId: invoice.clientId,
          weekStart: invoice.weekStart,
        },
      },
      { idempotencyKey: `dos_inv_${invoice.id}` },
    );

    if (!created.id) return { ok: false, reason: "stripe_no_invoice_id" };

    // Persist the Stripe invoice id on the DispatchOS row IMMEDIATELY, before
    // finalize. If invoices.create succeeded (the draft exists and, with
    // auto_advance:true, Stripe will auto-finalize it ~1h later regardless) but
    // finalizeInvoice below throws, the catch leaves the row chargeable. Without
    // this stamp a retry >24h later — after the idempotency keys have expired —
    // would mint a fresh invoice and double-charge the carrier. Stamping the id
    // here makes the route-level guard (refuse when stripeInvoiceId is set) see
    // the in-flight charge and refuse the re-charge.
    storage.setInvoiceStripeId(invoice.id, created.id);

    // Finalize so Stripe attempts collection now (auto_advance handles the
    // charge against the default payment method).
    await stripe.invoices.finalizeInvoice(created.id);

    return { ok: true, stripeInvoiceId: created.id };
  } catch (err) {
    // Never throw — generation/retry must not fail because of Stripe. The caller
    // leaves the DispatchOS invoice chargeable and audits the reason.
    return { ok: false, reason: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Voiding a success-fee charge.
//
// When an operator voids a DispatchOS invoice that was already charged (it has a
// stripeInvoiceId), the local row flipping to 'void' is NOT enough: Stripe is
// still collecting flat+3% from the carrier's card (auto_advance). We must also
// cancel the open Stripe invoice so the carrier is not billed for a fee the
// operator cancelled.
//
// This helper inspects the live Stripe invoice and:
//   - voids it (stripe.invoices.voidInvoice) when it is still OPEN/uncollected
//     (status draft|open|uncollectible) → the carrier is NOT charged;
//   - treats already-void as a no-op success (idempotent);
//   - REFUSES (ok:false, reason:"already_paid") when Stripe already collected —
//     the caller must NOT auto-refund; an operator issues a refund/credit note
//     manually before voiding;
//   - no-ops to ok:true when Stripe is unconfigured (tests / self-host without
//     Stripe) so the local void still proceeds for never-really-charged rows.
//
// Returns { ok, voided?, status?, reason? }:
//   - ok:true, voided:true   — Stripe invoice was voided (or already void).
//   - ok:true, voided:false  — nothing to void (Stripe off); proceed locally.
//   - ok:false, reason:"already_paid" — refuse the local void (paid in Stripe).
//   - ok:false, reason:<msg> — Stripe error; caller should NOT void locally
//     (better to leave the row consistent with the still-open Stripe charge).
// ---------------------------------------------------------------------------
export async function voidStripeInvoice(
  stripeInvoiceId: string,
): Promise<{ ok: boolean; voided?: boolean; status?: string; reason?: string }> {
  const stripe = stripeClient();
  // Stripe not configured (e.g. tests, or a self-host without billing): there is
  // no remote charge to cancel, so let the local void proceed.
  if (!stripe) return { ok: true, voided: false, reason: "stripe_not_configured" };

  try {
    const remote = await stripe.invoices.retrieve(stripeInvoiceId);
    const status = remote.status ?? undefined;

    // Already collected — do NOT auto-refund. Refuse so the operator handles the
    // refund/credit note manually and the carrier charge isn't silently orphaned.
    if (status === "paid") {
      return { ok: false, status, reason: "already_paid" };
    }

    // Already void — nothing to do; treat as success so the local void is allowed.
    if (status === "void") {
      return { ok: true, voided: true, status };
    }

    // Open / draft / uncollectible — finalizing collection is still pending, so
    // voiding stops the charge. (A draft can't be voided until finalized; but our
    // charge path finalizes immediately, so in practice it's 'open'. We still try
    // voidInvoice and let Stripe reject a not-yet-finalizable draft, which the
    // catch surfaces as a reason rather than a silent local-only void.)
    const voided = await stripe.invoices.voidInvoice(stripeInvoiceId);
    return { ok: true, voided: true, status: voided.status ?? status };
  } catch (err) {
    // Surface the error; the caller must NOT flip the local row to 'void' while
    // the Stripe invoice may still be collecting — that's the exact bug we fix.
    return { ok: false, reason: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// AI credit packs (Variant 2: user buys, charged to their carrier's Stripe
// customer). Granted on the invoice.payment_succeeded webhook below.
// ---------------------------------------------------------------------------
export const AI_CREDIT_PACK = { credits: 100, priceCents: 500 } as const; // 100 requests for $5

export async function chargeAiCreditPack(
  userId: string,
  clientId: string,
): Promise<{ ok: boolean; stripeInvoiceId?: string; reason?: string }> {
  const stripe = stripeClient();
  if (!stripe) return { ok: false, reason: "stripe_not_configured" };
  const client = storage.getClient(clientId) as
    | (Record<string, unknown> & { stripeCustomerId?: string; deletedAt?: string | null })
    | undefined;
  if (!client || client.deletedAt) return { ok: false, reason: "client_not_found" };
  const customer = client.stripeCustomerId;
  if (!customer) return { ok: false, reason: "no_stripe_customer" };
  // Deterministic idempotency key for this purchase. There is no pre-existing
  // DispatchOS invoice id to key on (the Stripe invoice IS the purchase record),
  // so we derive a stable identity from (userId, clientId, pack, coarse time
  // bucket). A double-clicked button or a succeeded-but-client-timed-out retry
  // within the same bucket therefore collapses onto ONE Stripe invoice instead
  // of minting a second one — which would both double-charge the carrier's card
  // and (via two distinct invoice ids) double-grant credits in the webhook.
  // Mirrors chargeInvoiceViaStripe's dos_inv_X keys. A deliberate repeat
  // purchase in a later bucket still gets a fresh invoice, as intended.
  //
  // Bucket is 10 minutes (not 1): a 1-minute window let a double-submit that
  // straddled the minute boundary (e.g. t=59.9s and t=60.1s) land in two
  // buckets, mint two invoices, and double-charge+double-grant. A coarser,
  // stable window closes that race. NOTE: this is still a best-effort dedup —
  // the fully robust fix is a CLIENT-SUPPLIED request id threaded into the
  // idempotency key, so any retry of the SAME user action collapses regardless
  // of wall-clock timing. The 10-minute bucket is the minimal stop-gap.
  const bucket = Math.floor(Date.now() / 600000);
  const idemBase = `ai_pack_${userId}_${clientId}_${AI_CREDIT_PACK.credits}_${bucket}`;
  try {
    // Create the invoice FIRST (empty), attach ONLY the AI-pack item to it, then
    // finalize. This avoids pending_invoice_items_behavior:"include" sweeping
    // unrelated pending items (e.g. a weekly success fee) onto this charge.
    const created = await stripe.invoices.create(
      {
        customer,
        collection_method: "charge_automatically",
        auto_advance: false,
        metadata: { aiCreditsUserId: userId, aiCreditsPack: String(AI_CREDIT_PACK.credits) },
      },
      { idempotencyKey: idemBase },
    );
    if (!created.id) return { ok: false, reason: "stripe_no_invoice_id" };
    await stripe.invoiceItems.create(
      {
        customer,
        invoice: created.id,
        amount: AI_CREDIT_PACK.priceCents,
        currency: "usd",
        description: `DispatchOS - ${AI_CREDIT_PACK.credits} AI requests`,
      },
      { idempotencyKey: `${idemBase}_item` },
    );
    await stripe.invoices.finalizeInvoice(
      created.id,
      { auto_advance: true },
      { idempotencyKey: `${idemBase}_fin` },
    );
    return { ok: true, stripeInvoiceId: created.id };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Resolve the ISO date that a confirmed-active per-user subscription window
 * should be extended to: the subscription's current_period_end, or a 30-day
 * window from now when that field is unavailable.
 *
 * `current_period_end` location varies across Stripe API versions: legacy puts
 * it at the subscription top level; the 2025+ API moved it onto each line item
 * (items.data[].current_period_end). We probe both (Unix seconds → ISO) and fall
 * back to now()+30d so the window is always refreshed, even on a thin sub object.
 */
export function subscriptionPeriodEndIso(sub: Stripe.Subscription): string {
  const topLevel = (sub as unknown as { current_period_end?: number }).current_period_end;
  const itemLevel = sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined;
  const epochSec =
    typeof topLevel === "number" && topLevel > 0
      ? topLevel
      : typeof itemLevel?.current_period_end === "number" && itemLevel.current_period_end > 0
        ? itemLevel.current_period_end
        : null;
  if (epochSec) return new Date(epochSec * 1000).toISOString();
  return new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
}

/**
 * Extract subscription id from an Invoice across Stripe API versions.
 * Older API: invoice.subscription (string | Subscription).
 * 2025+ API: invoice.parent.subscription_details.subscription.
 * We probe both — cast as `any` because the TS types pin to the new shape.
 */
export function extractSubscriptionId(invoice: Stripe.Invoice): string | null {
  const legacy = (invoice as unknown as { subscription?: string | { id: string } }).subscription;
  if (legacy) return typeof legacy === "string" ? legacy : legacy.id;
  const parent = (invoice as unknown as {
    parent?: { subscription_details?: { subscription?: string | { id: string } } };
  }).parent;
  const sub = parent?.subscription_details?.subscription;
  if (sub) return typeof sub === "string" ? sub : sub.id;
  return null;
}

// ---------------------------------------------------------------------------
// Webhook handler — reconciles DB state with Stripe events.
// ---------------------------------------------------------------------------

/**
 * Verify webhook signature and parse the event. Caller MUST pass the raw
 * body (Buffer or string) — JSON.parse strips the signature material.
 */
export function constructWebhookEvent(
  rawBody: Buffer | string,
  signatureHeader: string,
): Stripe.Event {
  const stripe = stripeClient();
  if (!stripe) throw new Error("Stripe is not configured");
  const secret =
    getIntegrationValue("stripe", "STRIPE_WEBHOOK_SECRET") ?? process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET not set");
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
}

/**
 * Map a live Stripe.Subscription to our client billing fields. Single source of
 * truth so checkout.session.completed and subscription.created/updated agree on
 * status/trial/tier — all derived from the authoritative subscription object,
 * never hardcoded. `trialEndsAt` is left undefined (not cleared) when the sub
 * has no trial. planTier is set only when resolvable from the paid price.
 *
 * pastDueSince is kept consistent with the invoice.payment_failed producer so
 * the 7-day grace clock (consumed by requireActiveBilling) is never lost: a
 * subscription.updated that lands in past_due BEFORE/WITHOUT a payment_failed
 * stamps the grace start here (first-failure-only — an already-past_due client
 * keeps its original date so retries don't reset the clock), and a return to
 * active/trial clears it.
 */
export function deriveSubscriptionUpdates(
  sub: Stripe.Subscription,
  client: unknown,
): Record<string, unknown> {
  const billingStatus =
    sub.status === "trialing"
      ? "trial"
      : sub.status === "active"
        ? "active"
        : sub.status === "past_due" || sub.status === "unpaid"
          ? "past_due"
          : sub.status === "canceled"
            ? "canceled"
            : (client as { billingStatus?: string }).billingStatus ?? "trial";

  const paidPriceId = sub.items?.data?.[0]?.price?.id ?? "";
  const resolvedTier = tierForStripePrice(paidPriceId);

  const updates: Record<string, unknown> = {
    stripeSubscriptionId: sub.id,
    billingStatus,
    trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : undefined,
  };
  if (resolvedTier) updates.planTier = resolvedTier;

  const prev = client as { billingStatus?: string; pastDueSince?: string };
  if (billingStatus === "past_due") {
    // Only stamp on the FIRST transition into past_due — keep the original date
    // if the carrier was already past_due so the grace window isn't reset.
    updates.pastDueSince =
      prev.billingStatus === "past_due" && prev.pastDueSince
        ? prev.pastDueSince
        : new Date().toISOString();
  } else if (billingStatus === "active" || billingStatus === "trial") {
    // Recovered (or trialing again) — clear the failure marker so a future
    // past_due gets a fresh grace window.
    updates.pastDueSince = undefined;
  }
  return updates;
}

// ---------------------------------------------------------------------------
// Reversal reconciliation.
//
// After an operator manually refunds / credit-notes / voids / marks-uncollectible
// a PAID DispatchOS success-fee invoice in Stripe (the local void route
// deliberately REFUSES to auto-refund a paid invoice — voidStripeInvoice returns
// already_paid), nothing flips the local row off 'paid'. DispatchOS would keep
// counting revenue Stripe no longer holds. These handlers reconcile a FULL
// reversal by moving the linked DispatchOS invoice to 'void'; a PARTIAL reversal
// is audited loudly but does NOT change status (a partial doesn't zero a
// mostly-collected fee — that's a human call).
// ---------------------------------------------------------------------------

/** Resolve the local DispatchOS invoice for a reversal event: metadata id first,
 *  then the Stripe invoice id stamped on the row (findInvoiceByStripeId). */
function resolveDosInvoiceForReversal(
  metadataInvoiceId: string | null | undefined,
  stripeInvoiceId: string | null | undefined,
): Invoice | undefined {
  let dos = metadataInvoiceId ? storage.getInvoice(metadataInvoiceId) : undefined;
  if (!dos && stripeInvoiceId) dos = storage.findInvoiceByStripeId(stripeInvoiceId);
  return dos;
}

/**
 * Apply a FULL reversal to the linked DispatchOS invoice: move paid|sent|draft
 * -> void so it stops counting as collected revenue, and audit billing.invoice_reversed.
 * Idempotent: an already-void row is a no-op (re-delivered reversal => no-op).
 * Status moves go through the legal transition machine; paid->void is now allowed.
 */
function applyFullReversal(
  dos: Invoice,
  kind: string,
  stripeInvoiceId: string | null | undefined,
  amount: number | null | undefined,
): { handled: true; clientId: string; changes: Record<string, unknown> } {
  if (dos.status === "void") {
    // Already reconciled (re-delivery, or operator voided locally first). No-op.
    return {
      handled: true,
      clientId: dos.clientId,
      changes: { dispatchosInvoiceId: dos.id, invoiceStatus: "void", reversed: false, reason: "already_void" },
    };
  }
  const fromStatus = dos.status; // capture before the transition (becomes 'void')
  const result = storage.updateInvoice(dos.id, { status: "void" });
  if ("invoice" in result) {
    storage.audit("billing.invoice_reversed", "invoice", dos.id, {
      kind,
      dispatchosInvoiceId: dos.id,
      clientId: dos.clientId,
      stripeInvoiceId: stripeInvoiceId ?? dos.stripeInvoiceId ?? null,
      amount: amount ?? null,
      from: fromStatus,
    });
    return {
      handled: true,
      clientId: dos.clientId,
      changes: { dispatchosInvoiceId: dos.id, invoiceStatus: "void", reversed: true, kind },
    };
  }
  // invalidTransition (shouldn't happen now that paid->void is allowed, but be
  // loud rather than silently leaving collected-yet-reversed revenue on the books).
  console.error(
    `[stripe] ${kind}: could not move dispatchosInvoice=${dos.id} ` +
      `(stripeInvoice=${stripeInvoiceId ?? dos.stripeInvoiceId ?? "?"}) to 'void': ` +
      `invalidTransition ${"from" in result ? `${result.from}->${result.to}` : "?"}. ` +
      `Stripe reversed the charge but the local row is stuck — manual reconciliation required.`,
  );
  storage.audit("billing.invoice_reverse_failed", "invoice", dos.id, {
    kind,
    dispatchosInvoiceId: dos.id,
    clientId: dos.clientId,
    stripeInvoiceId: stripeInvoiceId ?? dos.stripeInvoiceId ?? null,
    from: "from" in result ? result.from : dos.status,
    to: "void",
  });
  return {
    handled: true,
    clientId: dos.clientId,
    changes: { dispatchosInvoiceId: dos.id, invoiceStatus: dos.status, reversed: false, reason: "invalid_transition" },
  };
}

/**
 * Apply a parsed Stripe event to our DB. Idempotent — safe to retry. We use
 * Stripe's event types to drive a small state machine over the client's
 * billing fields.
 */
export async function handleWebhookEvent(event: Stripe.Event): Promise<{
  handled: boolean;
  clientId: string | null;
  changes?: Record<string, unknown>;
}> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const clientId = session.metadata?.clientId;
      const tier = session.metadata?.tier;
      if (!clientId || !tier) return { handled: false, clientId: null };
      const client = storage.getClient(clientId);
      if (!client) return { handled: false, clientId };

      const stripeCustomerId =
        typeof session.customer === "string" ? session.customer : session.customer?.id;
      const subId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;

      // Derive the real billing state from the subscription instead of blindly
      // stamping the just-paid carrier as 'trial' with a fake 14d window. The
      // old code did exactly that, so a customer who paid immediately (no trial)
      // sat as 'trial' until a later subscription.updated happened to correct it
      // — order-dependent and wrong if that event was delayed/dropped. Pull the
      // authoritative status/trial_end/tier from Stripe.
      let updates: Record<string, unknown>;
      const stripe = stripeClient();
      let derivedFromSub = false;
      if (stripe && subId) {
        try {
          const sub = await stripe.subscriptions.retrieve(subId);
          updates = { stripeCustomerId, ...deriveSubscriptionUpdates(sub, client) };
          derivedFromSub = true;
        } catch (err) {
          console.error(
            `[stripe] checkout.session.completed: retrieve ${subId} failed:`,
            (err as Error).message,
          );
          // Do NOT fabricate a 14-day trial on a transient retrieve failure: a
          // customer who paid immediately (no trial) would be handed a free
          // window. Persist only the durable linkage (customer/subscription id +
          // the tier the checkout was for) and leave billingStatus/trialEndsAt
          // untouched — the authoritative customer.subscription.created/updated
          // event (which Stripe also emits for this checkout) is the source of
          // truth for status/trial and will set them correctly.
          updates = {
            stripeCustomerId,
            stripeSubscriptionId: subId,
            planTier: tier,
          };
        }
      } else {
        // No subscription on the session (or Stripe not configured) → keep the
        // legacy trial default so non-subscription checkouts still provision.
        updates = {
          stripeCustomerId,
          stripeSubscriptionId: subId,
          planTier: tier,
          billingStatus: "trial",
          trialEndsAt: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
        };
      }
      // Re-read the client AFTER the await: upsertClient overwrites the whole
      // payload, so spreading the pre-await snapshot would silently revert any
      // concurrent mutation (admin archive, location ping, a racing
      // subscription.* event) committed while we were awaiting the network
      // retrieve. Also bail if it was archived in that window — don't resurrect.
      const fresh = storage.getClient(clientId) as
        | (Record<string, unknown> & { deletedAt?: string | null })
        | undefined;
      if (!fresh || fresh.deletedAt) return { handled: false, clientId };
      storage.upsertClient({
        ...(fresh as unknown as Parameters<typeof storage.upsertClient>[0]),
        ...updates,
      } as Parameters<typeof storage.upsertClient>[0]);
      storage.audit("billing.subscription_started", "client", clientId, {
        ...updates,
        derivedFromSub,
      });
      return { handled: true, clientId, changes: updates };
    }

    case "customer.subscription.updated":
    case "customer.subscription.created": {
      const sub = event.data.object as Stripe.Subscription;
      const clientId = sub.metadata?.clientId;
      if (!clientId) return { handled: false, clientId: null };
      const client = storage.getClient(clientId);
      if (!client) return { handled: false, clientId };

      // V4-010: derive status + plan tier from the live subscription (price &
      // status), not from one-time checkout metadata — a Customer-Portal plan
      // change swaps the price, and mismatched metadata could grant an unpaid
      // tier. Shared with checkout.session.completed via deriveSubscriptionUpdates.
      const metadataTier = sub.metadata?.tier ?? null;
      const updates = deriveSubscriptionUpdates(sub, client);
      if (updates.planTier && metadataTier && updates.planTier !== metadataTier) {
        console.warn(
          `[stripe] tier mismatch on ${sub.id}: metadata=${metadataTier} ` +
            `price=${updates.planTier} — using price-derived tier`,
        );
      }
      storage.upsertClient({
        ...(client as unknown as Parameters<typeof storage.upsertClient>[0]),
        ...updates,
      } as Parameters<typeof storage.upsertClient>[0]);
      storage.audit("billing.subscription_updated", "client", clientId, {
        status: sub.status,
        ...updates,
      });
      // Per-user renewal: when the carrier's subscription is confirmed ACTIVE,
      // keep the per-user subscription_ends_at window fresh for the users linked
      // to this carrier (drivers + owner via linked_client_id, dispatchers via
      // assignments) so an invite-created user's one-time ~30d window doesn't go
      // stale (and read as expired) while their carrier keeps paying. Extend-only;
      // never shortens. Admins are untouched. Pure self-serve users with NO
      // carrier remain a known gap (no per-user payment flow exists).
      if (updates.billingStatus === "active") {
        const endsAt = subscriptionPeriodEndIso(sub);
        const renewed = storage.extendSubscriptionForCarrierUsers(clientId, endsAt);
        if (renewed > 0) {
          storage.audit("billing.per_user_subscription_renewed", "client", clientId, {
            usersRenewed: renewed,
            subscriptionEndsAt: endsAt,
            source: event.type,
          });
        }
      }
      return { handled: true, clientId, changes: updates };
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const clientId = sub.metadata?.clientId;
      if (!clientId) return { handled: false, clientId: null };
      const client = storage.getClient(clientId);
      if (!client) return { handled: false, clientId };
      storage.upsertClient({
        ...(client as unknown as Parameters<typeof storage.upsertClient>[0]),
        billingStatus: "canceled",
      } as Parameters<typeof storage.upsertClient>[0]);
      storage.audit("billing.subscription_canceled", "client", clientId, {
        subscriptionId: sub.id,
      });
      return { handled: true, clientId, changes: { billingStatus: "canceled" } };
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      // Look up clientId via subscription metadata (we set it on creation).
      // Stripe 2025+ API moved invoice.subscription → invoice.parent.subscription_details.subscription.
      const stripe = stripeClient();

      // Success-fee one-off path: if this is one of OUR weekly success-fee
      // charges, audit the failure so it's visible/retriable, but do NOT change
      // the DispatchOS invoice status — it stays 'sent'/unpaid and chargeable.
      const dosInvoiceId = invoice.metadata?.dispatchosInvoiceId;
      let dosInvoice = dosInvoiceId ? storage.getInvoice(dosInvoiceId) : undefined;
      if (!dosInvoice && invoice.id) {
        dosInvoice = storage.findInvoiceByStripeId(invoice.id);
      }
      if (dosInvoice) {
        storage.audit("billing.invoice_payment_failed", "invoice", dosInvoice.id, {
          dispatchosInvoiceId: dosInvoice.id,
          clientId: dosInvoice.clientId,
          stripeInvoiceId: invoice.id,
          amountDue: invoice.amount_due,
          status: dosInvoice.status,
        });
        return {
          handled: true,
          clientId: dosInvoice.clientId,
          changes: { dispatchosInvoiceId: dosInvoice.id, invoiceStatus: dosInvoice.status },
        };
      }

      const subId = extractSubscriptionId(invoice);
      if (!stripe || !subId) {
        // Never drop a payment_failed silently: if the subscription id can't be
        // extracted (neither legacy invoice.subscription nor parent.subscription_details),
        // we can't stamp past_due/pastDueSince — leave a loud trace so the missed
        // dunning event is visible/alertable instead of vanishing behind a 200 ack.
        console.error(
          `[stripe] invoice.payment_failed dropped: no subscription id ` +
            `(invoice=${invoice.id ?? "?"}, customer=${
              typeof invoice.customer === "string"
                ? invoice.customer
                : invoice.customer?.id ?? "?"
            }, stripeConfigured=${Boolean(stripe)}) — past_due NOT stamped`,
        );
        return { handled: false, clientId: null };
      }
      const sub = await stripe.subscriptions.retrieve(subId);
      const clientId = sub.metadata?.clientId;
      if (!clientId) return { handled: false, clientId: null };
      const client = storage.getClient(clientId);
      if (!client) return { handled: false, clientId };
      // Stamp the actual failure date so requireActiveBilling can compute the
      // 7-day grace from THIS event, not from trialEndsAt (which could be months
      // earlier for a long-active carrier — Nikita's 🟡). Only stamp on the FIRST
      // failure of a past_due streak: if already past_due, keep the original date
      // so retries don't keep resetting the grace clock.
      const alreadyPastDue =
        (client as { billingStatus?: string; pastDueSince?: string }).billingStatus === "past_due";
      const existingSince = (client as { pastDueSince?: string }).pastDueSince;
      storage.upsertClient({
        ...(client as unknown as Parameters<typeof storage.upsertClient>[0]),
        billingStatus: "past_due",
        pastDueSince: alreadyPastDue && existingSince ? existingSince : new Date().toISOString(),
      } as Parameters<typeof storage.upsertClient>[0]);
      storage.audit("billing.payment_failed", "client", clientId, {
        invoiceId: invoice.id,
        amountDue: invoice.amount_due,
      });
      return { handled: true, clientId, changes: { billingStatus: "past_due" } };
    }

    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;

      // AI credit-pack top-up (one-off, no subscription). Grant the purchased
      // credits to the user from metadata.
      //
      // IDEMPOTENCY: the webhook route dedupes by event.id, but that claim is
      // UN-claimed on a handler throw — and if the throw happens AFTER the grant
      // (e.g. the audit write below fails), a Stripe retry would re-run this
      // branch and double-grant for free. So the grant itself is guarded on the
      // Stripe INVOICE id via grantAiCreditsForInvoice (atomic claim + balance
      // bump in one txn). N deliveries of the same invoice => credited exactly
      // once. We deliberately key on the invoice id (not event.id) so even a
      // re-delivery under a fresh event id can't double-grant.
      const aiCreditsUserId = invoice.metadata?.aiCreditsUserId;
      const aiCreditsPack = Number(invoice.metadata?.aiCreditsPack ?? 0);
      if (aiCreditsUserId && aiCreditsPack > 0) {
        // MONEY GATE: only grant the pack if the carrier actually PAID for it.
        // invoice.amount_paid (integer cents) is what Stripe collected AFTER any
        // coupon / customer-balance / credit-note has been applied. A discount
        // that zeroes (or merely reduces) the charge would otherwise hand out a
        // full pack for free. Require the collected amount to cover the pack
        // price before crediting. Refuse + log loudly + audit otherwise so an
        // under-paid grant is visible, not silent.
        const amountPaid = invoice.amount_paid ?? 0;
        if (amountPaid < AI_CREDIT_PACK.priceCents) {
          console.error(
            `[stripe] invoice.payment_succeeded AI credit-pack grant REFUSED: ` +
              `amount_paid=${amountPaid} < pack price ${AI_CREDIT_PACK.priceCents} ` +
              `(invoice=${invoice.id ?? "?"}, user=${aiCreditsUserId}, pack=${aiCreditsPack}) ` +
              `— carrier did not pay full pack price; NO credits granted`,
          );
          storage.audit("ai.credits_grant_refused", "user", aiCreditsUserId, {
            reason: "underpaid",
            amountPaid,
            packPriceCents: AI_CREDIT_PACK.priceCents,
            pack: aiCreditsPack,
            stripeInvoiceId: invoice.id,
          });
          return {
            handled: true,
            clientId: null,
            changes: { aiCreditsUserId, aiCreditsPack, granted: false, reason: "underpaid" },
          };
        }
        // Need a stable id to dedupe on. If Stripe somehow sent no invoice id we
        // cannot safely guarantee single-grant, so fall back to the event id
        // (still scoped per delivery) rather than crediting with no guard.
        const grantKey = invoice.id ?? `evt:${event.id}`;
        const { granted, balance } = storage.grantAiCreditsForInvoice(
          grantKey,
          aiCreditsUserId,
          aiCreditsPack,
        );
        if (granted) {
          storage.audit("ai.credits_purchased", "user", aiCreditsUserId, {
            pack: aiCreditsPack,
            balance,
            stripeInvoiceId: invoice.id,
          });
        } else {
          // Re-delivery of an already-credited invoice: ack handled, no grant,
          // no duplicate purchase audit. Leave a quiet trace for observability.
          console.log(
            `[stripe] invoice.payment_succeeded duplicate credit-pack grant skipped ` +
              `(invoice=${grantKey}, user=${aiCreditsUserId}, pack=${aiCreditsPack})`,
          );
        }
        return {
          handled: true,
          clientId: null,
          changes: { aiCreditsUserId, aiCreditsPack, balance, granted },
        };
      }

      const stripe = stripeClient();

      // --- Success-fee reconciliation (one-off invoices have NO subscription) ---
      // If this Stripe invoice is one of OUR weekly success-fee charges, flip the
      // linked DispatchOS invoice to 'paid'. Resolve by metadata first (set at
      // creation), then fall back to the stripe_invoice_id stamped on the row.
      // This runs BEFORE the subscription gate so subscription-less one-offs still
      // reconcile. Double-apply is guarded: skip if already paid/void.
      const dosInvoiceId = invoice.metadata?.dispatchosInvoiceId;
      let dosInvoice = dosInvoiceId ? storage.getInvoice(dosInvoiceId) : undefined;
      if (!dosInvoice && invoice.id) {
        dosInvoice = storage.findInvoiceByStripeId(invoice.id);
      }
      if (dosInvoice) {
        if (dosInvoice.status !== "paid" && dosInvoice.status !== "void") {
          // Ensure the row carries the Stripe id even if only metadata matched.
          if (!dosInvoice.stripeInvoiceId && invoice.id) {
            storage.setInvoiceStripeId(dosInvoice.id, invoice.id);
          }
          // Normalize a stuck 'draft' before paying. The status machine only
          // allows draft->[sent,void] and sent->[paid,void], so a direct
          // draft->paid is an invalidTransition and the row would stay 'draft'
          // FOREVER while Stripe (auto_advance) has already collected. This
          // happens when chargeInvoiceViaStripe stamped the Stripe id but then
          // finalize threw, so admin.ts generate took the charge_skipped else
          // branch and never advanced draft->sent. Step through the legal
          // draft->sent->paid path so this webhook reconciles instead of
          // orphaning the money as locally-uncollected.
          if (dosInvoice.status === "draft") {
            const norm = storage.updateInvoice(dosInvoice.id, { status: "sent" });
            if ("invoice" in norm) {
              dosInvoice = norm.invoice;
            } else if ("invalidTransition" in norm) {
              // Surface (don't swallow) — a stuck reconciliation must be visible.
              console.error(
                `[stripe] invoice.payment_succeeded could not normalize draft->sent for ` +
                  `dispatchosInvoice=${dosInvoice.id} (stripeInvoice=${invoice.id ?? "?"}): ` +
                  `invalidTransition ${norm.from}->${norm.to}. Stripe has collected but the ` +
                  `local row is stuck — manual reconciliation required.`,
              );
              storage.audit("billing.invoice_paid_transition_failed", "invoice", dosInvoice.id, {
                dispatchosInvoiceId: dosInvoice.id,
                clientId: dosInvoice.clientId,
                stripeInvoiceId: invoice.id,
                from: norm.from,
                to: norm.to,
                step: "draft_to_sent",
              });
            }
          }
          // Pay (sent->paid). If we just normalized draft->sent this now succeeds.
          if (dosInvoice.status !== "paid" && dosInvoice.status !== "void") {
            const result = storage.updateInvoice(dosInvoice.id, { status: "paid" });
            if ("invoice" in result) {
              dosInvoice = result.invoice;
            } else if ("invalidTransition" in result) {
              // Surface (don't swallow) — the money is collected in Stripe but the
              // local row didn't advance to 'paid'; make the divergence visible.
              console.error(
                `[stripe] invoice.payment_succeeded could not flip to 'paid' for ` +
                  `dispatchosInvoice=${dosInvoice.id} (stripeInvoice=${invoice.id ?? "?"}): ` +
                  `invalidTransition ${result.from}->${result.to}. Stripe has collected but the ` +
                  `local row is stuck — manual reconciliation required.`,
              );
              storage.audit("billing.invoice_paid_transition_failed", "invoice", dosInvoice.id, {
                dispatchosInvoiceId: dosInvoice.id,
                clientId: dosInvoice.clientId,
                stripeInvoiceId: invoice.id,
                from: result.from,
                to: result.to,
                step: "sent_to_paid",
              });
            }
          }
        }
        storage.audit("billing.invoice_paid", "invoice", dosInvoice.id, {
          dispatchosInvoiceId: dosInvoice.id,
          clientId: dosInvoice.clientId,
          stripeInvoiceId: invoice.id,
          amountPaid: invoice.amount_paid,
          status: dosInvoice.status,
        });
        // Don't treat the success-fee charge as subscription recovery — return
        // here so we don't also try to retrieve a (non-existent) subscription.
        return {
          handled: true,
          clientId: dosInvoice.clientId,
          changes: { dispatchosInvoiceId: dosInvoice.id, invoiceStatus: dosInvoice.status },
        };
      }

      // --- Subscription invoice path (plan billing recovery) ---
      const subId = extractSubscriptionId(invoice);
      if (!stripe || !subId) {
        return { handled: false, clientId: null };
      }
      const sub = await stripe.subscriptions.retrieve(subId);
      const clientId = sub.metadata?.clientId;
      if (!clientId) return { handled: false, clientId: null };
      const client = storage.getClient(clientId);
      if (!client) return { handled: false, clientId };
      // Move out of past_due if we were there; otherwise no-op.
      const wasPastDue = (client as { billingStatus?: string }).billingStatus === "past_due";
      if (wasPastDue) {
        storage.upsertClient({
          ...(client as unknown as Parameters<typeof storage.upsertClient>[0]),
          billingStatus: "active",
          // Clear the failure marker — the streak is resolved, so a future
          // payment_failed stamps a fresh date and gets a fresh grace window.
          pastDueSince: undefined,
        } as Parameters<typeof storage.upsertClient>[0]);
      }
      storage.audit("billing.payment_succeeded", "client", clientId, {
        invoiceId: invoice.id,
        amountPaid: invoice.amount_paid,
        recoveredFromPastDue: wasPastDue,
      });
      // Per-user renewal: a successful subscription invoice means the carrier
      // paid (this is the recurring-renewal path), so refresh the per-user
      // subscription_ends_at window for the users linked to this carrier — keeps
      // an invite-created user's one-time ~30d window from going stale (and
      // reading as expired) across billing cycles. Only fires when Stripe reports
      // the subscription is currently active (a renewal payment, not a stale
      // event for a since-canceled sub). Extend-only; never shortens; skips
      // admins. Self-serve users with no carrier remain a known gap.
      let usersRenewed = 0;
      if (sub.status === "active" || sub.status === "trialing") {
        const endsAt = subscriptionPeriodEndIso(sub);
        usersRenewed = storage.extendSubscriptionForCarrierUsers(clientId, endsAt);
        if (usersRenewed > 0) {
          storage.audit("billing.per_user_subscription_renewed", "client", clientId, {
            usersRenewed,
            subscriptionEndsAt: endsAt,
            source: "invoice.payment_succeeded",
          });
        }
      }
      return {
        handled: true,
        clientId,
        changes: {
          ...(wasPastDue ? { billingStatus: "active" } : {}),
          ...(usersRenewed > 0 ? { usersRenewed } : {}),
        },
      };
    }

    // -----------------------------------------------------------------------
    // REVERSAL reconciliation: a paid DispatchOS success-fee invoice that Stripe
    // no longer holds (voided / marked uncollectible / refunded / credit-noted)
    // must flip the local row off 'paid' so we stop counting that revenue.
    // -----------------------------------------------------------------------

    case "invoice.voided":
    case "invoice.marked_uncollectible": {
      // The whole invoice was reversed → FULL reversal regardless of amount.
      const invoice = event.data.object as Stripe.Invoice;
      const kind = event.type; // "invoice.voided" | "invoice.marked_uncollectible"

      // AI-credit-pack invoices: AUDIT but do NOT auto-claw credits (could drive
      // the balance negative). Leave the clawback decision to a human.
      const aiCreditsUserId = invoice.metadata?.aiCreditsUserId;
      if (aiCreditsUserId) {
        storage.audit("ai.credits_charge_reversed", "user", aiCreditsUserId, {
          kind,
          stripeInvoiceId: invoice.id ?? null,
          amount: invoice.total ?? invoice.amount_due ?? null,
          note: "no auto-clawback — review balance manually",
        });
        return {
          handled: true,
          clientId: null,
          changes: { aiCreditsUserId, reversed: false, audited: true, kind },
        };
      }

      const dos = resolveDosInvoiceForReversal(
        invoice.metadata?.dispatchosInvoiceId,
        invoice.id,
      );
      if (!dos) return { handled: false, clientId: null };
      return applyFullReversal(dos, kind, invoice.id, invoice.total ?? invoice.amount_paid);
    }

    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      // Resolve the invoice this charge paid. The Stripe invoice id may live on
      // charge.invoice (string | Invoice) across API versions; charges carry no
      // dispatchosInvoiceId of their own.
      const chargeInvoice = (charge as unknown as { invoice?: string | { id: string } }).invoice;
      const stripeInvoiceId =
        typeof chargeInvoice === "string" ? chargeInvoice : chargeInvoice?.id ?? null;

      const amount = charge.amount ?? 0;
      const amountRefunded = charge.amount_refunded ?? 0;
      const fullyRefunded = charge.refunded === true || (amount > 0 && amountRefunded >= amount);

      // Try AI-credit-pack first via the linked invoice's metadata. We need the
      // invoice to know whether this was an AI-pack charge.
      const dos = stripeInvoiceId
        ? resolveDosInvoiceForReversal(null, stripeInvoiceId)
        : undefined;

      // If we can't map the charge to a DispatchOS success-fee row, it may be a
      // subscription/plan charge or an AI-pack charge — neither of which we flip
      // here. For AI-pack we can only detect via the invoice metadata, which we
      // don't have on the charge; audit the unmapped reversal for visibility.
      if (!dos) {
        if (fullyRefunded) {
          console.warn(
            `[stripe] charge.refunded (full) not mapped to a DispatchOS invoice ` +
              `(charge=${charge.id ?? "?"}, stripeInvoice=${stripeInvoiceId ?? "?"}) — no local row to reverse`,
          );
        }
        return { handled: false, clientId: null };
      }

      if (!fullyRefunded) {
        // PARTIAL refund: do NOT change status — a partial doesn't zero a
        // mostly-collected fee. Audit loudly so it's visible for a human.
        storage.audit("billing.invoice_partial_reversal", "invoice", dos.id, {
          kind: "charge.refunded",
          dispatchosInvoiceId: dos.id,
          clientId: dos.clientId,
          stripeInvoiceId,
          stripeChargeId: charge.id ?? null,
          amount,
          amountRefunded,
        });
        return {
          handled: true,
          clientId: dos.clientId,
          changes: { dispatchosInvoiceId: dos.id, invoiceStatus: dos.status, reversed: false, partial: true },
        };
      }

      return applyFullReversal(dos, "charge.refunded", stripeInvoiceId, amountRefunded);
    }

    case "credit_note.created": {
      const note = event.data.object as Stripe.CreditNote;
      const noteInvoice = (note as unknown as { invoice?: string | { id: string } }).invoice;
      const stripeInvoiceId =
        typeof noteInvoice === "string" ? noteInvoice : noteInvoice?.id ?? null;

      const dos = stripeInvoiceId
        ? resolveDosInvoiceForReversal(null, stripeInvoiceId)
        : undefined;
      if (!dos) return { handled: false, clientId: null };

      // A credit note fully credits when its total covers the invoice total_due.
      // We don't have the live invoice here, so compare the credit-note total to
      // the DispatchOS row's collected amount (flat + percent fees, in cents).
      const creditTotal = note.total ?? note.amount ?? 0;
      const collectedCents =
        dollarsToCents(dos.flatFee ?? 0) + dollarsToCents(dos.percentFee ?? 0);
      const fullyCredited = collectedCents > 0 && creditTotal >= collectedCents;

      if (!fullyCredited) {
        // PARTIAL credit note: do NOT change status — audit loudly for a human.
        storage.audit("billing.invoice_partial_reversal", "invoice", dos.id, {
          kind: "credit_note.created",
          dispatchosInvoiceId: dos.id,
          clientId: dos.clientId,
          stripeInvoiceId,
          creditNoteId: note.id ?? null,
          creditTotal,
          collectedCents,
        });
        return {
          handled: true,
          clientId: dos.clientId,
          changes: { dispatchosInvoiceId: dos.id, invoiceStatus: dos.status, reversed: false, partial: true },
        };
      }

      return applyFullReversal(dos, "credit_note.created", stripeInvoiceId, creditTotal);
    }

    default:
      return { handled: false, clientId: null };
  }
}

// Convenience: returns the plan a client is currently on, with feature flags.
export function getClientPlan(clientId: string) {
  const client = storage.getClient(clientId);
  if (!client) return null;
  return planForClient(client as { planTier?: string; persona?: "owner_operator" | "fleet" | "enterprise" });
}
