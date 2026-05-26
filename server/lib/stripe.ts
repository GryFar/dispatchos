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
import { PLANS, stripePriceForTier, planForClient } from "./plans";

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
    | (Record<string, unknown> & { name?: string; stripeCustomerId?: string })
    | undefined;
  if (!client) throw new Error("Client not found");

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
    | (Record<string, unknown> & { stripeCustomerId?: string })
    | undefined;
  if (!client?.stripeCustomerId) {
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

/**
 * Extract subscription id from an Invoice across Stripe API versions.
 * Older API: invoice.subscription (string | Subscription).
 * 2025+ API: invoice.parent.subscription_details.subscription.
 * We probe both — cast as `any` because the TS types pin to the new shape.
 */
function extractSubscriptionId(invoice: Stripe.Invoice): string | null {
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

      const updates: Record<string, unknown> = {
        stripeCustomerId:
          typeof session.customer === "string" ? session.customer : session.customer?.id,
        stripeSubscriptionId:
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription?.id,
        planTier: tier,
        billingStatus: "trial",
        // trial_period_days = 14
        trialEndsAt: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
      };
      storage.upsertClient({
        ...(client as unknown as Parameters<typeof storage.upsertClient>[0]),
        ...updates,
      } as Parameters<typeof storage.upsertClient>[0]);
      storage.audit("billing.subscription_started", "client", clientId, updates);
      return { handled: true, clientId, changes: updates };
    }

    case "customer.subscription.updated":
    case "customer.subscription.created": {
      const sub = event.data.object as Stripe.Subscription;
      const clientId = sub.metadata?.clientId;
      if (!clientId) return { handled: false, clientId: null };
      const client = storage.getClient(clientId);
      if (!client) return { handled: false, clientId };

      // Stripe statuses: incomplete, incomplete_expired, trialing, active,
      // past_due, canceled, unpaid, paused.
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

      const updates: Record<string, unknown> = {
        stripeSubscriptionId: sub.id,
        billingStatus,
        trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : undefined,
      };
      storage.upsertClient({
        ...(client as unknown as Parameters<typeof storage.upsertClient>[0]),
        ...updates,
      } as Parameters<typeof storage.upsertClient>[0]);
      storage.audit("billing.subscription_updated", "client", clientId, {
        status: sub.status,
        ...updates,
      });
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
      const subId = extractSubscriptionId(invoice);
      if (!stripe || !subId) {
        return { handled: false, clientId: null };
      }
      const sub = await stripe.subscriptions.retrieve(subId);
      const clientId = sub.metadata?.clientId;
      if (!clientId) return { handled: false, clientId: null };
      const client = storage.getClient(clientId);
      if (!client) return { handled: false, clientId };
      storage.upsertClient({
        ...(client as unknown as Parameters<typeof storage.upsertClient>[0]),
        billingStatus: "past_due",
      } as Parameters<typeof storage.upsertClient>[0]);
      storage.audit("billing.payment_failed", "client", clientId, {
        invoiceId: invoice.id,
        amountDue: invoice.amount_due,
      });
      return { handled: true, clientId, changes: { billingStatus: "past_due" } };
    }

    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;
      const stripe = stripeClient();
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
        } as Parameters<typeof storage.upsertClient>[0]);
      }
      storage.audit("billing.payment_succeeded", "client", clientId, {
        invoiceId: invoice.id,
        amountPaid: invoice.amount_paid,
        recoveredFromPastDue: wasPastDue,
      });
      return { handled: true, clientId, changes: wasPastDue ? { billingStatus: "active" } : {} };
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
