// deriveSubscriptionUpdates unit tests.
// Run: npx tsx server/lib/stripe-derive.test.ts
//
// Guards the shared mapper that both checkout.session.completed and
// subscription.created/updated use. The bug it closes: checkout.session.completed
// used to hardcode billingStatus='trial' + a fake 14d trialEndsAt for EVERY
// checkout, so a customer who paid immediately (no trial) was mislabeled 'trial'
// until a later subscription.updated happened to fix it (order-dependent). Now
// status/trial/tier are derived from the real subscription via this function.

import { deriveSubscriptionUpdates } from "./stripe";
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

function sub(over: Partial<Stripe.Subscription> & { status: string }): Stripe.Subscription {
  return {
    id: "sub_123",
    status: over.status,
    trial_end: over.trial_end ?? null,
    items: over.items ?? { data: [{ price: { id: "price_unknown" } } as any] },
    metadata: over.metadata ?? {},
  } as unknown as Stripe.Subscription;
}

const client = { billingStatus: "trial" };

// status mapping
assert("trialing -> trial", deriveSubscriptionUpdates(sub({ status: "trialing" }), client).billingStatus === "trial");
assert("active -> active", deriveSubscriptionUpdates(sub({ status: "active" }), client).billingStatus === "active");
assert("past_due -> past_due", deriveSubscriptionUpdates(sub({ status: "past_due" }), client).billingStatus === "past_due");
assert("unpaid -> past_due", deriveSubscriptionUpdates(sub({ status: "unpaid" }), client).billingStatus === "past_due");
assert("canceled -> canceled", deriveSubscriptionUpdates(sub({ status: "canceled" }), client).billingStatus === "canceled");

// unknown status falls back to the client's current status (never clobbers)
assert(
  "incomplete -> keeps client's status",
  deriveSubscriptionUpdates(sub({ status: "incomplete" }), { billingStatus: "active" }).billingStatus === "active",
);
assert(
  "unknown with no client status -> trial default",
  deriveSubscriptionUpdates(sub({ status: "paused" }), {}).billingStatus === "trial",
);

// the core fix: an ACTIVE (paid, no trial) subscription must NOT be marked trial
const active = deriveSubscriptionUpdates(sub({ status: "active", trial_end: null }), client);
assert("active sub is not trial (the bug)", active.billingStatus === "active");
assert("active sub with no trial_end -> trialEndsAt undefined", active.trialEndsAt === undefined);

// trial_end is surfaced as ISO when present
const withTrial = deriveSubscriptionUpdates(sub({ status: "trialing", trial_end: 1_900_000_000 }), client);
assert("trial_end -> ISO trialEndsAt", withTrial.trialEndsAt === new Date(1_900_000_000 * 1000).toISOString());

// stripeSubscriptionId always carried; planTier only when price resolves
assert("carries stripeSubscriptionId", deriveSubscriptionUpdates(sub({ status: "active" }), client).stripeSubscriptionId === "sub_123");
assert(
  "unknown price -> no planTier (never grant unpaid tier)",
  !("planTier" in deriveSubscriptionUpdates(sub({ status: "active" }), client)),
);

// pastDueSince grace clock — kept consistent with the invoice.payment_failed
// producer so a subscription.updated(past_due) without a payment_failed event
// doesn't collapse the 7-day grace.
const firstPastDue = deriveSubscriptionUpdates(sub({ status: "past_due" }), { billingStatus: "active" });
assert("past_due from active -> stamps pastDueSince", typeof firstPastDue.pastDueSince === "string");

const stillPastDue = deriveSubscriptionUpdates(
  sub({ status: "past_due" }),
  { billingStatus: "past_due", pastDueSince: "2026-01-01T00:00:00.000Z" },
);
assert(
  "past_due while already past_due -> preserves original pastDueSince (no grace reset)",
  stillPastDue.pastDueSince === "2026-01-01T00:00:00.000Z",
);

const recovered = deriveSubscriptionUpdates(
  sub({ status: "active" }),
  { billingStatus: "past_due", pastDueSince: "2026-01-01T00:00:00.000Z" },
);
assert("recovered to active -> clears pastDueSince", recovered.pastDueSince === undefined);

const trialingAgain = deriveSubscriptionUpdates(
  sub({ status: "trialing" }),
  { billingStatus: "past_due", pastDueSince: "2026-01-01T00:00:00.000Z" },
);
assert("trialing -> clears pastDueSince", trialingAgain.pastDueSince === undefined);

// canceled must NOT touch pastDueSince (terminal status handled by consumer).
assert(
  "canceled -> pastDueSince untouched",
  !("pastDueSince" in deriveSubscriptionUpdates(sub({ status: "canceled" }), { billingStatus: "active" })),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
