// ===========================================================================
// server/routes/billing.ts — Stripe Checkout + Customer Portal + webhook
// ===========================================================================
//
// Endpoints:
//   POST /api/billing/checkout      — create Checkout session for current client
//   POST /api/billing/portal        — create Customer Portal session
//   GET  /api/billing/status        — current plan, tier, billingStatus, trialEndsAt
//   POST /api/billing/webhook       — Stripe webhook receiver (raw body required)
//
// Webhook MUST be wired BEFORE express.json() in the middleware chain because
// Stripe signs the raw bytes. We do that in registerBillingRoutes by mounting
// the webhook on its own route with express.raw() before the global json parser.
// ---------------------------------------------------------------------------

import type { Express, Request, Response } from "express";
import express from "express";
import { z } from "zod";
import { storage } from "../storage";
import { getCurrentUser, requireRole } from "../auth";
import { PLANS, planForClient } from "../lib/plans";
import {
  createCheckoutSession,
  createPortalSession,
  constructWebhookEvent,
  handleWebhookEvent,
  isStripeConfigured,
  getClientPlan,
} from "../lib/stripe";

const checkoutBodySchema = z.object({
  tier: z.string().min(1).max(64),
  /** Optional override; defaults to /admin if absent. */
  successPath: z.string().optional(),
  cancelPath: z.string().optional(),
});

/**
 * Find the carrier (client) this authenticated user represents.
 * - admin: must pass ?clientId or be linked via a future user.clientId column;
 *   for now we hand the first client back since DispatchOS is single-tenant per env.
 * - dispatcher: ?clientId from their assigned set
 * - driver: their linkedClientId
 */
function resolveCallerClientId(req: Request): string | null {
  const user = getCurrentUser(req);
  if (!user) return null;
  const queryId = typeof req.query.clientId === "string" ? req.query.clientId : null;

  if (user.role === "admin") {
    if (queryId) return queryId;
    // Default to the first client. Multi-carrier admin can pass clientId.
    const clients = storage.listClients();
    return clients[0]?.id ?? null;
  }
  if (user.role === "dispatcher") {
    // Dispatcher must have a clientId scope on the query; security handled
    // in storage layer.
    return queryId;
  }
  // driver
  return user.linkedClientId ?? null;
}

export function registerBillingRoutes(app: Express): void {
  // ---------------------------------------------------------------------
  // Webhook MUST be registered BEFORE express.json() runs on this path.
  // Stripe sends a signed payload — we need the raw bytes for verification.
  // Our global express.json() is mounted at the app root in server/index.ts;
  // by using express.raw() on this specific path, we override it.
  // ---------------------------------------------------------------------
  app.post(
    "/api/billing/webhook",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req: Request, res: Response) => {
      const sig = req.headers["stripe-signature"];
      if (!sig || typeof sig !== "string") {
        return res.status(400).json({ message: "Missing stripe-signature header" });
      }
      let event;
      try {
        event = constructWebhookEvent(req.body, sig);
      } catch (err) {
        console.error("[billing/webhook] signature verification failed:", err);
        return res.status(400).json({
          message: "Webhook signature verification failed",
        });
      }

      // V4-004: idempotency. Stripe retries on timeout / can deliver an event
      // more than once; processing a duplicate would double-apply a plan
      // upgrade or refund. Claim the event id atomically — if it was already
      // processed, ack with 200 (so Stripe stops retrying) and skip the handler.
      if (!storage.markStripeEventProcessed(event.id, event.type)) {
        console.log(`[billing/webhook] duplicate event ${event.id} (${event.type}) — skipping`);
        return res.json({ received: true, handled: true, duplicate: true });
      }

      try {
        const outcome = await handleWebhookEvent(event);
        if (!outcome.handled) {
          // Unhandled event types — log + return 200 so Stripe doesn't retry
          // forever. We only handle subscriptions + invoices.
          console.log(`[billing/webhook] unhandled event ${event.type}`);
        }
        return res.json({ received: true, handled: outcome.handled });
      } catch (err) {
        console.error("[billing/webhook] handler threw:", err);
        // Return 500 so Stripe retries (transient DB error, network blip, etc).
        return res.status(500).json({ message: "Internal error processing event" });
      }
    },
  );

  // ---------------------------------------------------------------------
  // GET /api/billing/status — current plan + features for the caller's
  // carrier. Used by the dashboard banner ("Trial ends in 9 days") and the
  // settings/billing page.
  // ---------------------------------------------------------------------
  app.get("/api/billing/status", requireRole("admin", "dispatcher"), (req, res) => {
    if (!isStripeConfigured()) {
      return res.json({
        configured: false,
        message: "Stripe is not configured on this deployment.",
      });
    }
    const clientId = resolveCallerClientId(req);
    if (!clientId) {
      return res.status(404).json({ message: "No client context for caller" });
    }
    const client = storage.getClient(clientId);
    if (!client) return res.status(404).json({ message: "Client not found" });
    const plan = planForClient(
      client as { planTier?: string; persona?: "owner_operator" | "fleet" | "enterprise" },
    );
    const c = client as Record<string, unknown>;
    return res.json({
      configured: true,
      clientId,
      planTier: c.planTier ?? "trial",
      planLabel: plan.label,
      monthlyCents: plan.monthlyCents,
      billingStatus: c.billingStatus ?? "trial",
      trialEndsAt: c.trialEndsAt ?? null,
      hasStripeCustomer: Boolean(c.stripeCustomerId),
      hasSubscription: Boolean(c.stripeSubscriptionId),
      features: plan.features,
      seats: {
        includedDriverSeats: plan.includedDriverSeats,
        additionalDriverCents: plan.additionalDriverCents,
        driverSeatCount: c.driverSeatCount ?? 0,
        includedDispatcherSeats: plan.includedDispatcherSeats,
        dispatcherSeatCount: c.dispatcherSeatCount ?? 0,
      },
    });
  });

  // ---------------------------------------------------------------------
  // POST /api/billing/checkout
  // Creates a Stripe Checkout session for the chosen plan tier. Returns the
  // URL; frontend does `window.location.href = url`.
  // ---------------------------------------------------------------------
  app.post("/api/billing/checkout", requireRole("admin"), async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({ message: "Stripe is not configured" });
    }
    let body: ReturnType<typeof checkoutBodySchema.parse>;
    try {
      body = checkoutBodySchema.parse(req.body);
    } catch (err) {
      return res
        .status(400)
        .json({ message: "Invalid body", issues: (err as Error).message });
    }
    if (!PLANS[body.tier]) {
      return res.status(400).json({ message: `Unknown tier: ${body.tier}` });
    }
    if (body.tier === "trial") {
      return res
        .status(400)
        .json({ message: "Trial doesn't need Checkout — it's auto-assigned on onboarding completion" });
    }

    const clientId = resolveCallerClientId(req);
    if (!clientId) {
      return res.status(404).json({ message: "No client context for caller" });
    }
    const user = getCurrentUser(req)!;

    const base = process.env.DISPATCHOS_PUBLIC_URL || "https://dispatchos.co";
    const successUrl = `${base}/#${body.successPath ?? "/admin/billing"}?checkout=success`;
    const cancelUrl = `${base}/#${body.cancelPath ?? "/admin/billing"}?checkout=canceled`;

    try {
      const session = await createCheckoutSession({
        clientId,
        tier: body.tier,
        successUrl,
        cancelUrl,
        customerEmail: user.email,
      });
      return res.json({ url: session.url, sessionId: session.sessionId });
    } catch (err) {
      console.error("[billing/checkout] failed:", err);
      return res.status(500).json({
        message: "Failed to create Checkout session",
        error: (err as Error).message,
      });
    }
  });

  // ---------------------------------------------------------------------
  // POST /api/billing/portal
  // Creates a Stripe Customer Portal session for self-service plan/card
  // management. Returns the URL.
  // ---------------------------------------------------------------------
  app.post("/api/billing/portal", requireRole("admin"), async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({ message: "Stripe is not configured" });
    }
    const clientId = resolveCallerClientId(req);
    if (!clientId) {
      return res.status(404).json({ message: "No client context for caller" });
    }
    const base = process.env.DISPATCHOS_PUBLIC_URL || "https://dispatchos.co";
    const returnUrl = `${base}/#/admin/billing`;
    try {
      const session = await createPortalSession(clientId, returnUrl);
      return res.json({ url: session.url });
    } catch (err) {
      console.error("[billing/portal] failed:", err);
      return res.status(500).json({
        message: "Failed to create Portal session",
        error: (err as Error).message,
      });
    }
  });

  // Convenience: GET /api/billing/plan — returns the active plan blob for
  // the caller's client. Used by frontend feature gates.
  app.get("/api/billing/plan", requireRole("admin", "dispatcher", "driver"), (req, res) => {
    const clientId = resolveCallerClientId(req);
    if (!clientId) {
      return res.status(404).json({ message: "No client context for caller" });
    }
    const plan = getClientPlan(clientId);
    return res.json(plan);
  });
}
