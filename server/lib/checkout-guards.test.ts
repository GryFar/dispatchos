// Checkout guards test (temp DB, no network): live-subscription 409 gate +
// one-trial-per-carrier Checkout gate.
// Run: npx tsx server/lib/checkout-guards.test.ts
//
// Two money-path guards introduced by the dead-end P0 batch:
//
//   * hasLiveSubscription (routes/billing.ts) — POST /api/billing/checkout
//     must 409 when the carrier already has a live subscription: a second
//     Checkout creates a SECOND Stripe subscription (double monthly billing,
//     and the old sub's later deletion used to 402-lock the paying carrier).
//
//   * shouldGrantCheckoutTrial (lib/stripe.ts) — trial_period_days:14 was
//     hardcoded on every Checkout, so an expired/canceled carrier could cycle
//     cancel→re-checkout for unlimited free trials (the legal page promises
//     "one per carrier"). The trial is now granted only to a carrier that has
//     never had a trial or subscription; we also capture the actual params
//     createCheckoutSession sends via the injectable Stripe stub.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(
  tmpdir(),
  `dispatchos-checkout-guards-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.db`,
);
// createCheckoutSession resolves the price id from the plan's env key.
process.env.STRIPE_PRICE_OO_BASIC = "price_test_oo_basic";

const { storage } = await import("../storage");
const { hasLiveSubscription } = await import("../routes/billing");
const { shouldGrantCheckoutTrial, createCheckoutSession, __setStripeClientForTest } =
  await import("./stripe");
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

// ---------------------------------------------------------------------------
// hasLiveSubscription — the 409 gate predicate.
// ---------------------------------------------------------------------------
assert(
  "no stripeSubscriptionId → not live (onboarding trial can check out)",
  hasLiveSubscription({ billingStatus: "trial" }) === false,
);
assert(
  "sub + active → live",
  hasLiveSubscription({ stripeSubscriptionId: "sub_1", billingStatus: "active" }) === true,
);
assert(
  "sub + trial (trialing Stripe sub after checkout) → live",
  hasLiveSubscription({ stripeSubscriptionId: "sub_1", billingStatus: "trial" }) === true,
);
assert(
  "sub + past_due (dunning) → live",
  hasLiveSubscription({ stripeSubscriptionId: "sub_1", billingStatus: "past_due" }) === true,
);
assert(
  "sub + canceled → NOT live (re-subscribe via Checkout allowed)",
  hasLiveSubscription({ stripeSubscriptionId: "sub_1", billingStatus: "canceled" }) === false,
);
assert(
  "sub + expired → NOT live",
  hasLiveSubscription({ stripeSubscriptionId: "sub_1", billingStatus: "expired" }) === false,
);
assert(
  "sub + missing status (defaults trial) → live",
  hasLiveSubscription({ stripeSubscriptionId: "sub_1" }) === true,
);

// ---------------------------------------------------------------------------
// shouldGrantCheckoutTrial — one trial per carrier, ever.
// ---------------------------------------------------------------------------
assert("virgin carrier → trial granted", shouldGrantCheckoutTrial({}) === true);
assert(
  "trialEndsAt stamped (onboarding trial ran) → no trial",
  shouldGrantCheckoutTrial({ trialEndsAt: "2026-06-01T00:00:00.000Z" }) === false,
);
assert(
  "prior stripeSubscriptionId (survives cancel) → no trial",
  shouldGrantCheckoutTrial({ stripeSubscriptionId: "sub_old" }) === false,
);
assert(
  "both markers → no trial",
  shouldGrantCheckoutTrial({
    trialEndsAt: "2026-06-01T00:00:00.000Z",
    stripeSubscriptionId: "sub_old",
  }) === false,
);

// ---------------------------------------------------------------------------
// createCheckoutSession — the params actually sent to Stripe.
// ---------------------------------------------------------------------------
let captured: Stripe.Checkout.SessionCreateParams | null = null;
__setStripeClientForTest({
  checkout: {
    sessions: {
      create: async (params: Stripe.Checkout.SessionCreateParams) => {
        captured = params;
        return { id: `cs_${rnd()}`, url: "https://stripe.test/cs" };
      },
    },
  },
} as unknown as Stripe);

const urls = { successUrl: "https://x.test/#/billing?s", cancelUrl: "https://x.test/#/billing?c" };

// Virgin carrier: trial_period_days present.
{
  captured = null;
  const c = mkClient({});
  await createCheckoutSession({ clientId: c.id, tier: "oo_basic", ...urls });
  assert(
    "virgin carrier Checkout carries trial_period_days 14",
    captured?.subscription_data?.trial_period_days === 14,
    JSON.stringify(captured?.subscription_data),
  );
}

// Expired-trial carrier: no trial_period_days → charges immediately.
{
  captured = null;
  const c = mkClient({ billingStatus: "expired", trialEndsAt: "2026-06-01T00:00:00.000Z" });
  await createCheckoutSession({ clientId: c.id, tier: "oo_basic", ...urls });
  assert(
    "expired-trial carrier Checkout omits trial_period_days",
    captured !== null && captured!.subscription_data?.trial_period_days === undefined,
    JSON.stringify(captured?.subscription_data),
  );
  assert(
    "reconciliation metadata still present without trial",
    captured?.subscription_data?.metadata?.clientId === c.id,
  );
}

// Canceled subscriber re-buying: no fresh trial either.
{
  captured = null;
  const c = mkClient({ billingStatus: "canceled", stripeSubscriptionId: "sub_prev" });
  await createCheckoutSession({ clientId: c.id, tier: "oo_basic", ...urls });
  assert(
    "canceled ex-subscriber Checkout omits trial_period_days",
    captured !== null && captured!.subscription_data?.trial_period_days === undefined,
    JSON.stringify(captured?.subscription_data),
  );
}

__setStripeClientForTest(null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
