// Plan / billing helper tests. Pure (PLANS is a constant map); the Stripe
// helpers read process.env, which we set locally in this isolated test process.
// Run: npx tsx server/lib/plans.test.ts

import {
  defaultPlanForPersona,
  plansForPersona,
  planForClient,
  stripePriceForTier,
  tierForStripePrice,
  canAddDriver,
} from "./plans";

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
function eq(name: string, got: unknown, want: unknown) {
  assert(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// --- persona -> default plan ----------------------------------------------
eq("owner_operator default", defaultPlanForPersona("owner_operator"), "oo_basic");
eq("fleet default", defaultPlanForPersona("fleet"), "fleet_starter");
eq("enterprise default", defaultPlanForPersona("enterprise"), "enterprise");

// --- plansForPersona excludes trial, matches persona ----------------------
{
  const oo = plansForPersona("owner_operator");
  assert("owner_operator has at least one plan", oo.length > 0);
  assert("none are trial", oo.every((p) => p.tier !== "trial"));
  assert("all match persona", oo.every((p) => p.persona === "owner_operator"));
  assert("includes oo_basic", oo.some((p) => p.tier === "oo_basic"));
}

// --- planForClient with safe defaults -------------------------------------
eq("known tier resolves", planForClient({ planTier: "oo_basic" }).tier, "oo_basic");
eq("no tier -> trial", planForClient({}).tier, "trial");
eq("unknown tier -> trial", planForClient({ planTier: "does_not_exist" }).tier, "trial");

// --- Stripe price <-> tier round-trip (env-driven) ------------------------
process.env.STRIPE_PRICE_OO_BASIC = "price_oo_basic_123";
eq("stripePriceForTier reads env", stripePriceForTier("oo_basic"), "price_oo_basic_123");
eq("stripePriceForTier unknown tier -> undefined", stripePriceForTier("nope"), undefined);
eq("tierForStripePrice reverse lookup", tierForStripePrice("price_oo_basic_123"), "oo_basic");
eq("tierForStripePrice unknown price -> null", tierForStripePrice("price_unknown"), null);
eq("tierForStripePrice empty -> null", tierForStripePrice(""), null);

// --- canAddDriver seat gating (oo_basic: 1 seat, no paid overage) ---------
{
  const ok = canAddDriver({ planTier: "oo_basic", driverSeatCount: 0 });
  assert("oo_basic allows first driver", ok.allowed === true);

  const blocked = canAddDriver({ planTier: "oo_basic", driverSeatCount: 1 });
  assert("oo_basic blocks beyond included seat", blocked.allowed === false);
  assert("blocked flags needsUpgrade", blocked.needsUpgrade === true);
  assert("blocked has a reason", typeof blocked.reason === "string" && blocked.reason.length > 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
