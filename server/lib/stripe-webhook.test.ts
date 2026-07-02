// Stripe webhook state-machine test (temp DB).
// Run: npx tsx server/lib/stripe-webhook.test.ts
//
// handleWebhookEvent is the actual money-state mutation path (billingStatus /
// planTier / stripeSubscriptionId / stripeCustomerId / pastDueSince) and was
// previously untested. This covers every branch of the switch, plus:
//
//   * the retrieve-failure fix — a transient subscriptions.retrieve() failure on
//     checkout.session.completed must NOT fabricate a free 14-day trial for a
//     customer who paid immediately;
//   * the past_due grace PRODUCER — two successive invoice.payment_failed events
//     must NOT advance pastDueSince (first-failure-only stamping), and
//     invoice.payment_succeeded must flip past_due -> active and clear it;
//   * extractSubscriptionId across legacy + 2025 Stripe Invoice shapes.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), "dispatchos-stripe-webhook-test.db");
const { storage } = await import("../storage");
const { handleWebhookEvent, extractSubscriptionId, __setStripeClientForTest } = await import("./stripe");
import type Stripe from "stripe";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const rnd = () => Math.random().toString(36).slice(2, 10);

const mkClient = (over: Record<string, unknown> = {}) =>
  storage.upsertClient({
    name: `Carrier ${rnd()}`,
    mc: `MC-${Math.floor(Math.random() * 900000 + 100000)}`,
    equipment: "hotshot_flatbed",
    targetPpm: 2,
    minimumPpm: 1.8,
    mpg: 10,
    fuelPrice: 3.6,
    fixedCostPerMile: 0.35,
    preferredLanes: [],
    avoidStates: [],
    billingStatus: "trial",
    ...over,
  } as any);

// A fake Stripe client whose subscriptions.retrieve is controllable per test.
function fakeStripe(opts: {
  retrieve?: (id: string) => Promise<Stripe.Subscription>;
}): Stripe {
  return {
    subscriptions: {
      retrieve: opts.retrieve ?? (async (id: string) => ({ id } as Stripe.Subscription)),
    },
  } as unknown as Stripe;
}

function subObj(over: Partial<Stripe.Subscription> & { status: string; id?: string }): Stripe.Subscription {
  return {
    id: over.id ?? "sub_123",
    status: over.status,
    trial_end: over.trial_end ?? null,
    items: over.items ?? { data: [{ price: { id: "price_unknown" } } as any] },
    metadata: over.metadata ?? {},
  } as unknown as Stripe.Subscription;
}

const ev = (type: string, object: unknown): Stripe.Event =>
  ({ type, data: { object } } as unknown as Stripe.Event);

// ---------------------------------------------------------------------------
// extractSubscriptionId — pure shape probing across API versions.
// ---------------------------------------------------------------------------
assert(
  "extractSubscriptionId: legacy string subscription",
  extractSubscriptionId({ subscription: "sub_legacy" } as unknown as Stripe.Invoice) === "sub_legacy",
);
assert(
  "extractSubscriptionId: legacy object subscription",
  extractSubscriptionId({ subscription: { id: "sub_obj" } } as unknown as Stripe.Invoice) === "sub_obj",
);
assert(
  "extractSubscriptionId: 2025 parent.subscription_details (string)",
  extractSubscriptionId({
    parent: { subscription_details: { subscription: "sub_parent" } },
  } as unknown as Stripe.Invoice) === "sub_parent",
);
assert(
  "extractSubscriptionId: 2025 parent.subscription_details (object)",
  extractSubscriptionId({
    parent: { subscription_details: { subscription: { id: "sub_parent_obj" } } },
  } as unknown as Stripe.Invoice) === "sub_parent_obj",
);
assert(
  "extractSubscriptionId: none present -> null",
  extractSubscriptionId({} as unknown as Stripe.Invoice) === null,
);

// ---------------------------------------------------------------------------
// checkout.session.completed — happy path derives state from the subscription.
// ---------------------------------------------------------------------------
{
  const c = mkClient({ billingStatus: "trial" });
  __setStripeClientForTest(
    fakeStripe({ retrieve: async () => subObj({ status: "active", trial_end: null, id: "sub_paid" }) }),
  );
  const res = await handleWebhookEvent(
    ev("checkout.session.completed", {
      metadata: { clientId: c.id, tier: "oo_basic" },
      customer: "cus_1",
      subscription: "sub_paid",
    } as unknown as Stripe.Checkout.Session),
  );
  const stored = storage.getClient(c.id) as any;
  assert("checkout(active sub): handled", res.handled === true);
  assert("checkout(active sub): billingStatus active, NOT trial", stored.billingStatus === "active");
  assert("checkout(active sub): no fabricated trialEndsAt", stored.trialEndsAt == null);
  assert("checkout(active sub): customer id stored", stored.stripeCustomerId === "cus_1");
  assert("checkout(active sub): subscription id stored", stored.stripeSubscriptionId === "sub_paid");
}

// THE FIX: retrieve throws -> we must NOT stamp a fresh 14-day trial onto a
// customer who paid immediately. billingStatus must be left untouched.
{
  const c = mkClient({ billingStatus: "active", trialEndsAt: undefined });
  __setStripeClientForTest(
    fakeStripe({
      retrieve: async () => {
        throw new Error("transient retrieve failure");
      },
    }),
  );
  const res = await handleWebhookEvent(
    ev("checkout.session.completed", {
      metadata: { clientId: c.id, tier: "oo_basic" },
      customer: "cus_2",
      subscription: "sub_paid_2",
    } as unknown as Stripe.Checkout.Session),
  );
  const stored = storage.getClient(c.id) as any;
  assert("checkout(retrieve fails): handled", res.handled === true);
  assert(
    "checkout(retrieve fails): does NOT fabricate a trial (billingStatus untouched)",
    stored.billingStatus === "active",
    `got billingStatus=${stored.billingStatus}`,
  );
  assert(
    "checkout(retrieve fails): no fake 14d trialEndsAt",
    stored.trialEndsAt == null,
    `got trialEndsAt=${stored.trialEndsAt}`,
  );
  assert("checkout(retrieve fails): still persists customer id", stored.stripeCustomerId === "cus_2");
  assert("checkout(retrieve fails): still persists subscription id", stored.stripeSubscriptionId === "sub_paid_2");
  assert("checkout(retrieve fails): persists the checkout tier", stored.planTier === "oo_basic");
}

// No subscription on the session (Stripe not configured / one-off) -> legacy
// trial default still provisions.
{
  const c = mkClient({ billingStatus: "trial" });
  __setStripeClientForTest(null);
  const res = await handleWebhookEvent(
    ev("checkout.session.completed", {
      metadata: { clientId: c.id, tier: "oo_basic" },
      customer: "cus_3",
      subscription: undefined,
    } as unknown as Stripe.Checkout.Session),
  );
  const stored = storage.getClient(c.id) as any;
  assert("checkout(no sub): handled", res.handled === true);
  assert("checkout(no sub): legacy trial default", stored.billingStatus === "trial");
  assert("checkout(no sub): trialEndsAt set", typeof stored.trialEndsAt === "string");
}

// Missing metadata -> not handled, no client mutation.
{
  const res = await handleWebhookEvent(
    ev("checkout.session.completed", { metadata: {}, customer: "cus_x" } as unknown as Stripe.Checkout.Session),
  );
  assert("checkout(no metadata): not handled", res.handled === false && res.clientId === null);
}

// ---------------------------------------------------------------------------
// customer.subscription.updated / .created — derive from the live subscription.
// ---------------------------------------------------------------------------
{
  const c = mkClient({ billingStatus: "trial" });
  const res = await handleWebhookEvent(
    ev(
      "customer.subscription.updated",
      subObj({ status: "active", id: "sub_u1", metadata: { clientId: c.id } }),
    ),
  );
  const stored = storage.getClient(c.id) as any;
  assert("subscription.updated: handled", res.handled === true);
  assert("subscription.updated: billingStatus active", stored.billingStatus === "active");
  assert("subscription.updated: subscription id carried", stored.stripeSubscriptionId === "sub_u1");
}

// subscription.updated(past_due) WITHOUT a payment_failed must stamp the grace
// start, and a later recovery to active must clear it.
{
  const c = mkClient({ billingStatus: "active" });
  await handleWebhookEvent(
    ev("customer.subscription.updated", subObj({ status: "past_due", id: "sub_u2", metadata: { clientId: c.id } })),
  );
  const afterPastDue = storage.getClient(c.id) as any;
  assert("subscription.updated(past_due): billingStatus past_due", afterPastDue.billingStatus === "past_due");
  assert(
    "subscription.updated(past_due): pastDueSince stamped (grace not collapsed)",
    typeof afterPastDue.pastDueSince === "string",
  );

  await handleWebhookEvent(
    ev("customer.subscription.updated", subObj({ status: "active", id: "sub_u2", metadata: { clientId: c.id } })),
  );
  const afterRecovery = storage.getClient(c.id) as any;
  assert("subscription.updated(recovered): billingStatus active", afterRecovery.billingStatus === "active");
  assert("subscription.updated(recovered): pastDueSince cleared", afterRecovery.pastDueSince == null);
}

// Re-read-after-await guard: a client archived during the checkout retrieve must
// not be resurrected by the webhook write.
{
  const c = mkClient({ billingStatus: "trial" });
  __setStripeClientForTest(
    fakeStripe({
      retrieve: async () => {
        // Simulate a concurrent archive committed while we awaited the network.
        storage.upsertClient({ ...(storage.getClient(c.id) as any), deletedAt: new Date().toISOString() } as any);
        return subObj({ status: "active", id: "sub_arch", metadata: { clientId: c.id } });
      },
    }),
  );
  const res = await handleWebhookEvent(
    ev("checkout.session.completed", {
      metadata: { clientId: c.id, tier: "oo_basic" },
      customer: "cus_arch",
      subscription: "sub_arch",
    } as unknown as Stripe.Checkout.Session),
  );
  const stored = storage.getClient(c.id) as any;
  assert("checkout(archived mid-await): not handled", res.handled === false);
  assert("checkout(archived mid-await): stays archived (not resurrected)", typeof stored.deletedAt === "string");
}

// ---------------------------------------------------------------------------
// customer.subscription.deleted -> canceled.
// ---------------------------------------------------------------------------
{
  const c = mkClient({ billingStatus: "active" });
  const res = await handleWebhookEvent(
    ev("customer.subscription.deleted", subObj({ status: "canceled", id: "sub_d1", metadata: { clientId: c.id } })),
  );
  const stored = storage.getClient(c.id) as any;
  assert("subscription.deleted: handled", res.handled === true);
  assert("subscription.deleted: billingStatus canceled", stored.billingStatus === "canceled");
}

// ---------------------------------------------------------------------------
// invoice.payment_failed PRODUCER — first-failure-only grace stamping.
// ---------------------------------------------------------------------------
{
  const c = mkClient({ billingStatus: "active" });
  __setStripeClientForTest(
    fakeStripe({ retrieve: async () => subObj({ status: "past_due", id: "sub_pf1", metadata: { clientId: c.id } }) }),
  );

  // First failure stamps pastDueSince.
  await handleWebhookEvent(
    ev("invoice.payment_failed", { id: "in_1", amount_due: 1900, subscription: "sub_pf1" } as unknown as Stripe.Invoice),
  );
  const after1 = storage.getClient(c.id) as any;
  assert("payment_failed #1: billingStatus past_due", after1.billingStatus === "past_due");
  assert("payment_failed #1: pastDueSince stamped", typeof after1.pastDueSince === "string");
  const firstSince = after1.pastDueSince as string;

  // Force a later wall-clock by hand-rolling a second failure; the grace clock
  // must NOT advance because the carrier is already past_due.
  await handleWebhookEvent(
    ev("invoice.payment_failed", { id: "in_2", amount_due: 1900, subscription: "sub_pf1" } as unknown as Stripe.Invoice),
  );
  const after2 = storage.getClient(c.id) as any;
  assert(
    "payment_failed #2: pastDueSince does NOT advance (grace clock preserved)",
    after2.pastDueSince === firstSince,
    `first=${firstSince} second=${after2.pastDueSince}`,
  );

  // Recovery: payment_succeeded flips past_due -> active and clears pastDueSince.
  await handleWebhookEvent(
    ev("invoice.payment_succeeded", { id: "in_3", amount_paid: 1900, subscription: "sub_pf1" } as unknown as Stripe.Invoice),
  );
  const recovered = storage.getClient(c.id) as any;
  assert("payment_succeeded: billingStatus back to active", recovered.billingStatus === "active");
  assert("payment_succeeded: pastDueSince cleared", recovered.pastDueSince == null, `got ${recovered.pastDueSince}`);
}

// invoice events with no resolvable subscription id -> not handled.
{
  __setStripeClientForTest(fakeStripe({}));
  const res = await handleWebhookEvent(
    ev("invoice.payment_failed", { id: "in_none" } as unknown as Stripe.Invoice),
  );
  assert("payment_failed(no sub id): not handled", res.handled === false);
}

// Unknown event type -> not handled.
{
  const res = await handleWebhookEvent(ev("ping", {}));
  assert("unknown event type: not handled", res.handled === false);
}

__setStripeClientForTest(null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
