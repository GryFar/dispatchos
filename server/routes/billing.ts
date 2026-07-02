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

// V4-005: successPath/cancelPath flow into the Stripe return URL, so they must
// be constrained to internal hash-route paths only — start with a single "/",
// safe path chars only, no protocol/host/@/dot/double-slash. Blocks
// open-redirect and query/fragment injection into the checkout return URL.
const safeInternalPath = z
  .string()
  .regex(/^\/[A-Za-z0-9/_-]*$/, "must be an internal path, e.g. /admin/billing")
  .max(128);

const checkoutBodySchema = z.object({
  tier: z.string().min(1).max(64),
  /** Optional override; defaults to /admin/billing if absent. Internal path only. */
  successPath: safeInternalPath.optional(),
  cancelPath: safeInternalPath.optional(),
});

/**
 * Find the carrier (client) this authenticated user represents.
 * - admin: must pass ?clientId or be linked via a future user.clientId column;
 *   for now we hand the first client back since DispatchOS is single-tenant per env.
 * - dispatcher: ?clientId from their assigned set
 * - driver: their linkedClientId
 *
 * Pure (no req) so route-level tenancy logic is unit-testable.
 */
export function resolveClientIdForUser(
  user: { id: string; role: string; linkedClientId?: string },
  queryId: string | null,
): string | null {
  if (user.role === "admin") {
    if (queryId) return queryId;
    // No explicit ?clientId: fall back to the single client ONLY when there is
    // exactly one (unambiguous single-tenant env). Billing is per-carrier
    // (planTier/billingStatus live on the client), so silently picking
    // clients[0] in a multi-carrier env could read — or worse, create a Stripe
    // Checkout/Portal session against — the WRONG carrier (V4-009 tenant
    // collapse). When ambiguous, return null so handlers respond 404 and the
    // caller must pass an explicit ?clientId.
    const clients = storage.listClients();
    return clients.length === 1 ? clients[0]!.id : null;
  }
  if (user.role === "dispatcher") {
    // Tenant-scope (V5): the requested clientId MUST be one of the dispatcher's
    // active assignments. getClient does no scoping, so returning the raw query
    // value here was a cross-tenant read (IDOR) — a dispatcher could read any
    // carrier's billing by guessing an id. Reject anything not assigned to them.
    if (!queryId) return null;
    const isAssigned = storage
      .listAssignmentsForDispatcher(user.id)
      .some((a) => a.clientId === queryId);
    return isAssigned ? queryId : null;
  }
  // driver
  return user.linkedClientId ?? null;
}

function resolveCallerClientId(req: Request): string | null {
  const user = getCurrentUser(req);
  if (!user) return null;
  const queryId = typeof req.query.clientId === "string" ? req.query.clientId : null;
  return resolveClientIdForUser(user, queryId);
}

/**
 * Self-serve billing gate: a non-admin caller may touch billing ONLY for the
 * carrier they OWN — their linkedClientId must resolve to a live client whose
 * ownerUserId is them, and any explicitly requested clientId must be that same
 * client. Hired drivers (linked but not owner) and unlinked users get null →
 * handlers respond 403. Admin never goes through this gate.
 */
export function resolveOwnedClientId(
  user: { id: string; linkedClientId?: string },
  requestedClientId: string | null,
): string | null {
  if (!user.linkedClientId) return null;
  const client = storage.getClient(user.linkedClientId) as
    | (Record<string, unknown> & {
        id: string;
        ownerUserId?: string;
        deletedAt?: string | null;
      })
    | undefined;
  if (!client || client.deletedAt) return null;
  if (client.ownerUserId !== user.id) return null;
  if (requestedClientId && requestedClientId !== client.id) return null;
  return client.id;
}

/**
 * The Stripe customerEmail must belong to the CLIENT OWNER, not whoever is
 * driving the browser — admin-assisted checkout would otherwise stamp the
 * platform operator's email onto the customer's Stripe record (receipts,
 * invoices, portal login all go to that address). Falls back to the caller's
 * email only when the client has no resolvable owner.
 */
export function resolveCheckoutCustomerEmail(
  clientId: string,
  fallbackEmail?: string,
): string | undefined {
  const client = storage.getClient(clientId) as
    | (Record<string, unknown> & { ownerUserId?: string })
    | undefined;
  const ownerId = client?.ownerUserId;
  const owner = typeof ownerId === "string" && ownerId ? storage.getUserById(ownerId) : undefined;
  const email = owner?.email;
  return typeof email === "string" && email.includes("@") ? email : fallbackEmail;
}

export function registerBillingRoutes(app: Express): void {
  // ---------------------------------------------------------------------
  // Stripe sends a signed payload — verification needs the EXACT raw bytes.
  // NOTE: the global express.json() in server/index.ts is mounted at the app
  // root and runs first, so it consumes the stream and the express.raw() below
  // does NOT actually deliver req.body as a Buffer. The raw bytes are instead
  // captured by json()'s verify hook into req.rawBody, which we pass to
  // constructWebhookEvent. The express.raw() is kept only as a harmless
  // belt-and-suspenders for the (non-current) case where json() didn't run.
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
        // Verify against the RAW signed bytes. The global express.json() at
        // server/index.ts already consumes the stream (setting req._body), so
        // the route-level express.raw() below short-circuits and req.body is a
        // parsed object — NOT the bytes Stripe signed. The json() verify hook
        // captures the raw Buffer as req.rawBody; use that. (Fixes signature
        // verification silently failing for every real Stripe event.)
        const rawBody = (req.rawBody as Buffer | undefined) ?? req.body;
        event = constructWebhookEvent(rawBody, sig);
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
        // We claimed this event id BEFORE handling (to block concurrent
        // duplicates). The handler failed transiently, so un-claim it — Stripe
        // will retry, and the retry must re-enter the handler instead of being
        // skipped as a "duplicate" (which would silently drop the event).
        try {
          storage.unmarkStripeEventProcessed(event.id);
        } catch (unmarkErr) {
          console.error("[billing/webhook] failed to un-claim event:", unmarkErr);
        }
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
  app.get("/api/billing/status", requireRole("admin", "dispatcher", "driver"), (req, res) => {
    if (!isStripeConfigured()) {
      return res.json({
        configured: false,
        message: "Stripe is not configured on this deployment.",
      });
    }
    const user = getCurrentUser(req)!;
    // Self-serve signups land as role 'driver'; only the carrier OWNER among
    // them may read billing. Admin/dispatcher resolution is unchanged.
    let clientId: string | null;
    let isBillingOwner: boolean;
    if (user.role === "driver") {
      const queryId = typeof req.query.clientId === "string" ? req.query.clientId : null;
      clientId = resolveOwnedClientId(user, queryId);
      if (!clientId) {
        return res.status(403).json({ message: "Only the carrier owner can view billing" });
      }
      isBillingOwner = true;
    } else {
      clientId = resolveCallerClientId(req);
      isBillingOwner = user.role === "admin";
    }
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
      isBillingOwner,
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
        driverSeatCount: storage.countDriverSeats(clientId),
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
  app.post("/api/billing/checkout", requireRole("admin", "driver"), async (req, res) => {
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

    const user = getCurrentUser(req)!;
    let clientId: string | null;
    if (user.role === "driver") {
      const queryId = typeof req.query.clientId === "string" ? req.query.clientId : null;
      clientId = resolveOwnedClientId(user, queryId);
      if (!clientId) {
        return res.status(403).json({ message: "Only the carrier owner can manage billing" });
      }
    } else {
      clientId = resolveCallerClientId(req);
    }
    if (!clientId) {
      return res.status(404).json({ message: "No client context for caller" });
    }

    const base = process.env.DISPATCHOS_PUBLIC_URL || "https://dispatchos.co";
    // Default return page depends on who is checking out: platform admins land
    // back on the admin billing screen, customers on the customer billing page.
    const defaultPath = user.role === "admin" ? "/admin/billing" : "/billing";
    const successUrl = `${base}/#${body.successPath ?? defaultPath}?checkout=success`;
    const cancelUrl = `${base}/#${body.cancelPath ?? defaultPath}?checkout=canceled`;

    try {
      const session = await createCheckoutSession({
        clientId,
        tier: body.tier,
        successUrl,
        cancelUrl,
        customerEmail: resolveCheckoutCustomerEmail(clientId, user.email),
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
  app.post("/api/billing/portal", requireRole("admin", "driver"), async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({ message: "Stripe is not configured" });
    }
    const user = getCurrentUser(req)!;
    let clientId: string | null;
    if (user.role === "driver") {
      const queryId = typeof req.query.clientId === "string" ? req.query.clientId : null;
      clientId = resolveOwnedClientId(user, queryId);
      if (!clientId) {
        return res.status(403).json({ message: "Only the carrier owner can manage billing" });
      }
    } else {
      clientId = resolveCallerClientId(req);
    }
    if (!clientId) {
      return res.status(404).json({ message: "No client context for caller" });
    }
    const base = process.env.DISPATCHOS_PUBLIC_URL || "https://dispatchos.co";
    const returnUrl = `${base}/#${user.role === "admin" ? "/admin/billing" : "/billing"}`;
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
