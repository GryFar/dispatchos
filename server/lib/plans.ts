// ===========================================================================
// server/lib/plans.ts — pricing tier catalogue + seat enforcement
// ===========================================================================
//
// Per user request 2026-05-26: "так же разница цен конечно должна быть в
// случае если ентерпрайс то дороже, если овнер то дешевле".
//
// Plans are config-as-code for now — when a billing dashboard lands, this
// becomes a DB-backed table. The Stripe price IDs are env-driven (set per
// environment so dev/staging can use test-mode prices).
// ---------------------------------------------------------------------------

export type PersonaCode = "owner_operator" | "fleet" | "enterprise";

export interface PlanDefinition {
  /** Stable identifier used in DB (client.planTier) and Stripe metadata. */
  tier: string;
  /** Marketing label. */
  label: string;
  /** Bucket — drives onboarding wizard branching. */
  persona: PersonaCode;
  /** Monthly price in USD cents. */
  monthlyCents: number;
  /** Stripe price id (env-overridable per tier). */
  stripePriceEnvKey: string;
  /** Included driver seats; overage charged per `additionalDriverCents`. */
  includedDriverSeats: number;
  /** Charge for each driver above included count (per month). */
  additionalDriverCents: number;
  /** Included dispatcher seats. */
  includedDispatcherSeats: number;
  /** Maximum MCs allowed; Infinity = unlimited. */
  maxMcCount: number;
  /** Audit log retention in days. */
  auditRetentionDays: number;
  /** Premium feature flags. */
  features: {
    carrierSafetyProfile: boolean;
    counterpartyVettingPremium: boolean;
    priorityCron: boolean; // min_machines_running=1 for this customer's app
    apiAccess: boolean;
    ssoSaml: boolean;
  };
}

export const PLANS: Record<string, PlanDefinition> = {
  // Trial — auto-assigned at onboarding completion for 14 days regardless of persona.
  trial: {
    tier: "trial",
    label: "14-day Trial",
    persona: "owner_operator",
    monthlyCents: 0,
    stripePriceEnvKey: "STRIPE_PRICE_TRIAL",
    includedDriverSeats: 50,
    additionalDriverCents: 0,
    includedDispatcherSeats: 5,
    maxMcCount: 100,
    auditRetentionDays: 30,
    features: {
      carrierSafetyProfile: true,
      counterpartyVettingPremium: true,
      priorityCron: false,
      apiAccess: false,
      ssoSaml: false,
    },
  },

  // ---- Owner-operator tiers ----
  oo_basic: {
    tier: "oo_basic",
    label: "Owner-Operator Basic",
    persona: "owner_operator",
    monthlyCents: 1900,
    stripePriceEnvKey: "STRIPE_PRICE_OO_BASIC",
    includedDriverSeats: 1,
    additionalDriverCents: 0,
    includedDispatcherSeats: 0,
    maxMcCount: 1,
    auditRetentionDays: 30,
    features: {
      carrierSafetyProfile: false,
      counterpartyVettingPremium: false,
      priorityCron: false,
      apiAccess: false,
      ssoSaml: false,
    },
  },
  oo_premium: {
    tier: "oo_premium",
    label: "Owner-Operator Premium",
    persona: "owner_operator",
    monthlyCents: 2900,
    stripePriceEnvKey: "STRIPE_PRICE_OO_PREMIUM",
    includedDriverSeats: 1,
    additionalDriverCents: 0,
    includedDispatcherSeats: 0,
    maxMcCount: 1,
    auditRetentionDays: 180,
    features: {
      carrierSafetyProfile: true,
      counterpartyVettingPremium: true,
      priorityCron: false,
      apiAccess: false,
      ssoSaml: false,
    },
  },

  // ---- Fleet tiers ----
  fleet_starter: {
    tier: "fleet_starter",
    label: "Fleet Starter (2–5 trucks)",
    persona: "fleet",
    monthlyCents: 4900,
    stripePriceEnvKey: "STRIPE_PRICE_FLEET_STARTER",
    includedDriverSeats: 5,
    additionalDriverCents: 800,
    includedDispatcherSeats: 1,
    maxMcCount: 2,
    auditRetentionDays: 90,
    features: {
      carrierSafetyProfile: false,
      counterpartyVettingPremium: false,
      priorityCron: false,
      apiAccess: false,
      ssoSaml: false,
    },
  },
  fleet_growth: {
    tier: "fleet_growth",
    label: "Fleet Growth (6–20 trucks)",
    persona: "fleet",
    monthlyCents: 7900,
    stripePriceEnvKey: "STRIPE_PRICE_FLEET_GROWTH",
    includedDriverSeats: 20,
    additionalDriverCents: 600,
    includedDispatcherSeats: 2,
    maxMcCount: 5,
    auditRetentionDays: 180,
    features: {
      carrierSafetyProfile: true,
      counterpartyVettingPremium: true,
      priorityCron: false,
      apiAccess: false,
      ssoSaml: false,
    },
  },
  fleet_scale: {
    tier: "fleet_scale",
    label: "Fleet Scale (21–50 trucks)",
    persona: "fleet",
    monthlyCents: 12900,
    stripePriceEnvKey: "STRIPE_PRICE_FLEET_SCALE",
    includedDriverSeats: 50,
    additionalDriverCents: 400,
    includedDispatcherSeats: 5,
    maxMcCount: 999,
    auditRetentionDays: 365,
    features: {
      carrierSafetyProfile: true,
      counterpartyVettingPremium: true,
      priorityCron: true,
      apiAccess: false,
      ssoSaml: false,
    },
  },

  // ---- Enterprise ----
  enterprise: {
    tier: "enterprise",
    label: "Enterprise (50+ trucks)",
    persona: "enterprise",
    monthlyCents: 29900, // starting at; actual is negotiated, Stripe Price uses this as base
    stripePriceEnvKey: "STRIPE_PRICE_ENTERPRISE",
    includedDriverSeats: 999,
    additionalDriverCents: 0,
    includedDispatcherSeats: 999,
    maxMcCount: 999,
    auditRetentionDays: 730,
    features: {
      carrierSafetyProfile: true,
      counterpartyVettingPremium: true,
      priorityCron: true,
      apiAccess: true,
      ssoSaml: true,
    },
  },
};

/** Default plan suggestion based on the persona picked at onboarding step 1. */
export function defaultPlanForPersona(p: PersonaCode): string {
  switch (p) {
    case "owner_operator":
      return "oo_basic";
    case "fleet":
      return "fleet_starter";
    case "enterprise":
      return "enterprise";
  }
}

/** Plans the user can pick at the plan step (filtered by persona for clarity). */
export function plansForPersona(p: PersonaCode): PlanDefinition[] {
  return Object.values(PLANS).filter(
    (plan) => plan.tier !== "trial" && plan.persona === p,
  );
}

/** Look up the active plan definition for a client, with safe defaults. */
export function planForClient(client: {
  planTier?: string;
  persona?: PersonaCode;
}): PlanDefinition {
  if (client.planTier && PLANS[client.planTier]) return PLANS[client.planTier]!;
  // No plan set yet — treat as trial so feature flags don't gate inactive customers.
  return PLANS.trial!;
}

/** Resolve the Stripe price id for a tier, with env override. */
export function stripePriceForTier(tier: string): string | undefined {
  const def = PLANS[tier];
  if (!def) return undefined;
  return process.env[def.stripePriceEnvKey];
}

/**
 * V4-010: reverse lookup — resolve the tier from the Stripe price id that was
 * actually charged. Lets the webhook verify session.metadata.tier against what
 * Stripe really billed, instead of trusting metadata blindly (a stale or
 * mismatched metadata.tier could otherwise grant a higher plan than was paid
 * for). Returns null if no plan maps to this price (env unset / unknown price).
 */
export function tierForStripePrice(priceId: string): string | null {
  if (!priceId) return null;
  for (const tier of Object.keys(PLANS)) {
    const envKey = PLANS[tier]?.stripePriceEnvKey;
    if (envKey && process.env[envKey] && process.env[envKey] === priceId) {
      return tier;
    }
  }
  return null;
}

/**
 * Returns true if the client can add another driver under their current
 * plan. Used by /api/admin/users POST to gate new driver invites.
 */
export function canAddDriver(client: {
  planTier?: string;
  persona?: PersonaCode;
  driverSeatCount?: number;
}): { allowed: boolean; reason?: string; needsUpgrade?: boolean } {
  const plan = planForClient(client);
  const current = client.driverSeatCount ?? 0;
  // Hard cap = included + additional (we allow paid overage); only block if
  // additionalDriverCents is 0 AND we're at the included limit.
  if (plan.additionalDriverCents === 0 && current >= plan.includedDriverSeats) {
    return {
      allowed: false,
      needsUpgrade: true,
      reason: `Plan ${plan.label} caps at ${plan.includedDriverSeats} drivers. Upgrade to add more.`,
    };
  }
  return { allowed: true };
}
