#!/usr/bin/env node
// ===========================================================================
// scripts/stripe-live-setup.mjs — one-shot Stripe environment provisioning
// ===========================================================================
//
// Replaces the ~45-minute manual dashboard runbook (6 recurring prices, a
// webhook endpoint with exactly the 10 events the handler consumes, portal
// check) with a single idempotent command. Any mistake in the manual flow —
// a wrong price amount, a missing webhook event — silently breaks checkout
// or loses subscription state; this script makes the whole surface
// reproducible and re-runnable.
//
// Usage (test-mode rehearsal first is recommended — same command, sk_test key):
//
//   node scripts/stripe-live-setup.mjs sk_live_...
//   node scripts/stripe-live-setup.mjs sk_test_...            # dry-run rehearsal
//   node scripts/stripe-live-setup.mjs sk_live_... --rotate-webhook
//   node scripts/stripe-live-setup.mjs sk_live_... --app-url https://demo.dispatchos.co
//
// The key can also come from env STRIPE_SECRET_KEY instead of argv.
//
// What it does (all idempotent — safe to re-run any time):
//   1. Verifies the key (GET /v1/account) and warns if live charges aren't
//      enabled yet (= live mode not fully activated in the dashboard).
//   2. For each plan tier in server/lib/plans.ts: finds the price by its
//      lookup_key (dispatchos_<tier>) or creates product+price. If a price
//      exists with the WRONG amount, a corrected price is created and the
//      lookup_key transferred; the stale price is deactivated.
//   3. Finds-or-creates the webhook endpoint at <app-url>/api/billing/webhook
//      with exactly the events server/lib/stripe.ts handles. Prints the
//      whsec_ signing secret ONCE at creation (Stripe never shows it again;
//      --rotate-webhook deletes + recreates to mint a fresh secret).
//   4. Checks a default Customer Portal configuration exists (the app calls
//      portal sessions with no explicit configuration, which 500s until the
//      dashboard portal settings are saved once). Cannot be created as
//      default via API — prints the one dashboard click if missing.
//   5. Prints the complete `fly secrets set` command + a name=value list for
//      the Fly dashboard. Nothing is written to disk.
//
// No dependencies — raw Stripe REST via global fetch (Node >= 20).
// ---------------------------------------------------------------------------

const STRIPE_API = "https://api.stripe.com";

// Mirror of server/lib/plans.ts (tier → label + monthly USD cents). Keep in
// sync by hand — the script is standalone on purpose so the owner can run it
// without a build step. `trial` is excluded: checkout uses
// subscription_data.trial_period_days, no $0 price object is needed.
const TIERS = [
  { tier: "oo_basic", env: "STRIPE_PRICE_OO_BASIC", label: "DispatchOS Owner-Operator Basic", cents: 1900 },
  { tier: "oo_premium", env: "STRIPE_PRICE_OO_PREMIUM", label: "DispatchOS Owner-Operator Premium", cents: 2900 },
  { tier: "fleet_starter", env: "STRIPE_PRICE_FLEET_STARTER", label: "DispatchOS Fleet Starter (2-5 trucks)", cents: 4900 },
  { tier: "fleet_growth", env: "STRIPE_PRICE_FLEET_GROWTH", label: "DispatchOS Fleet Growth (6-20 trucks)", cents: 7900 },
  { tier: "fleet_scale", env: "STRIPE_PRICE_FLEET_SCALE", label: "DispatchOS Fleet Scale (21-50 trucks)", cents: 12900 },
  { tier: "enterprise", env: "STRIPE_PRICE_ENTERPRISE", label: "DispatchOS Enterprise (50+ trucks)", cents: 29900 },
];

// Exactly the cases in server/lib/stripe.ts handleWebhookEvent — nothing
// more (noise), nothing less (lost state transitions).
const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
  "invoice.voided",
  "invoice.marked_uncollectible",
  "charge.refunded",
  "credit_note.created",
];

// ---------------------------------------------------------------------------
// tiny arg parsing
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
let key = process.env.STRIPE_SECRET_KEY || "";
let appUrl = "https://demo.dispatchos.co";
let publicUrl = "https://dispatchos.co";
let rotateWebhook = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--rotate-webhook") rotateWebhook = true;
  else if (a === "--app-url") appUrl = String(argv[++i] || "").replace(/\/+$/, "");
  else if (a === "--public-url") publicUrl = String(argv[++i] || "").replace(/\/+$/, "");
  else if (a === "--help" || a === "-h") {
    console.log("usage: node scripts/stripe-live-setup.mjs <sk_live_or_sk_test_key> [--app-url URL] [--public-url URL] [--rotate-webhook]");
    process.exit(0);
  } else if (a.startsWith("sk_") || a.startsWith("rk_")) key = a;
  else {
    console.error(`Unknown argument: ${a} (run with --help)`);
    process.exit(1);
  }
}

if (!key) {
  console.error("Missing Stripe secret key. Pass it as the first argument or set STRIPE_SECRET_KEY.");
  console.error("  node scripts/stripe-live-setup.mjs sk_live_...");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Stripe REST helper (form-encoded, Bearer auth)
// ---------------------------------------------------------------------------
function formEncode(obj, prefix = "") {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object") parts.push(formEncode(item, `${name}[${i}]`));
        else parts.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(item)}`);
      });
    } else if (typeof v === "object") {
      parts.push(formEncode(v, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(v)}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

async function stripe(method, path, body) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: body ? formEncode(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    const err = new Error(`Stripe ${method} ${path} failed: ${msg}`);
    err.stripeCode = json?.error?.code;
    err.status = res.status;
    throw err;
  }
  return json;
}

const out = { prices: {}, webhookSecret: null, webhookId: null, portalOk: false };
const warnings = [];

function log(msg) { console.log(msg); }
function warn(msg) { warnings.push(msg); console.warn(`  ⚠ ${msg}`); }

// ---------------------------------------------------------------------------
// 1. account sanity
// ---------------------------------------------------------------------------
async function checkAccount() {
  const acct = await stripe("GET", "/v1/account");
  const live = key.startsWith("sk_live") || key.startsWith("rk_live");
  log(`\n== Stripe account ==`);
  log(`  account:          ${acct.id} (${acct.settings?.dashboard?.display_name || acct.email || "no name"})`);
  log(`  key mode:         ${live ? "LIVE" : "TEST (rehearsal — re-run with sk_live_ for production)"}`);
  log(`  charges_enabled:  ${acct.charges_enabled}`);
  log(`  details_submitted:${acct.details_submitted}`);
  if (live && !acct.charges_enabled) {
    warn("Live key works but charges are NOT enabled yet — finish live-mode activation (business + bank details) in the dashboard. Catalog/webhook created now will be ready when you do.");
  }
  return live;
}

// ---------------------------------------------------------------------------
// 2. products + prices (idempotent via lookup_key)
// ---------------------------------------------------------------------------
async function ensurePrice(t) {
  const lookupKey = `dispatchos_${t.tier}`;
  const found = await stripe(
    "GET",
    `/v1/prices?lookup_keys[]=${encodeURIComponent(lookupKey)}&limit=1&expand[]=data.product`,
  );
  const existing = found.data?.[0];

  if (
    existing &&
    existing.active &&
    existing.unit_amount === t.cents &&
    existing.currency === "usd" &&
    existing.recurring?.interval === "month"
  ) {
    log(`  ✓ ${t.tier}: reusing ${existing.id} ($${(t.cents / 100).toFixed(0)}/mo)`);
    return existing.id;
  }

  // Product: reuse the existing price's product when shape mismatched, else create.
  let productId = existing?.product?.id || existing?.product;
  if (!productId) {
    const product = await stripe("POST", "/v1/products", {
      name: t.label,
      metadata: { tier: t.tier, managed_by: "stripe-live-setup" },
    });
    productId = product.id;
  }

  const price = await stripe("POST", "/v1/prices", {
    product: productId,
    unit_amount: t.cents,
    currency: "usd",
    recurring: { interval: "month" },
    lookup_key: lookupKey,
    transfer_lookup_key: true, // steal the key from a stale/wrong-amount price
    metadata: { tier: t.tier, managed_by: "stripe-live-setup" },
  });

  if (existing) {
    // Deactivate the stale price so nobody picks it in the dashboard by mistake.
    try {
      await stripe("POST", `/v1/prices/${existing.id}`, { active: false });
      log(`  ✓ ${t.tier}: created ${price.id} ($${(t.cents / 100).toFixed(0)}/mo), deactivated stale ${existing.id} (was $${(existing.unit_amount / 100).toFixed(2)})`);
    } catch {
      log(`  ✓ ${t.tier}: created ${price.id}; could not deactivate stale ${existing.id} — deactivate it in the dashboard`);
    }
  } else {
    log(`  ✓ ${t.tier}: created ${price.id} ($${(t.cents / 100).toFixed(0)}/mo)`);
  }
  return price.id;
}

// ---------------------------------------------------------------------------
// 3. webhook endpoint
// ---------------------------------------------------------------------------
async function ensureWebhook() {
  const url = `${appUrl}/api/billing/webhook`;
  log(`\n== Webhook endpoint (${url}) ==`);
  const list = await stripe("GET", "/v1/webhook_endpoints?limit=100");
  let existing = (list.data || []).find((w) => w.url === url);

  if (existing && rotateWebhook) {
    await stripe("DELETE", `/v1/webhook_endpoints/${existing.id}`);
    log(`  ✓ deleted ${existing.id} (--rotate-webhook)`);
    existing = null;
  }

  if (!existing) {
    const created = await stripe("POST", "/v1/webhook_endpoints", {
      url,
      description: "DispatchOS billing webhook (managed by stripe-live-setup)",
      enabled_events: WEBHOOK_EVENTS,
    });
    out.webhookId = created.id;
    out.webhookSecret = created.secret;
    log(`  ✓ created ${created.id} with ${WEBHOOK_EVENTS.length} events`);
    log(`  ✓ signing secret minted (see summary below) — Stripe will never show it again`);
    return;
  }

  out.webhookId = existing.id;
  const have = new Set(existing.enabled_events || []);
  const wantAll = have.has("*");
  const missing = WEBHOOK_EVENTS.filter((e) => !have.has(e) && !wantAll);
  const extra = wantAll ? [] : [...have].filter((e) => !WEBHOOK_EVENTS.includes(e));

  if (missing.length || extra.length || existing.status !== "enabled") {
    await stripe("POST", `/v1/webhook_endpoints/${existing.id}`, {
      enabled_events: WEBHOOK_EVENTS,
      ...(existing.status !== "enabled" ? { disabled: false } : {}),
    });
    log(`  ✓ ${existing.id} existed — events corrected (${missing.length} added, ${extra.length} removed)${existing.status !== "enabled" ? ", re-enabled" : ""}`);
  } else {
    log(`  ✓ ${existing.id} already correct (all ${WEBHOOK_EVENTS.length} events)`);
  }
  warn(`Webhook endpoint already existed, so its whsec_ signing secret cannot be read back. If STRIPE_WEBHOOK_SECRET on Fly is not ALREADY set to this endpoint's secret, re-run with --rotate-webhook to mint a fresh one.`);
}

// ---------------------------------------------------------------------------
// 4. customer portal default configuration (check only — API cannot mark default)
// ---------------------------------------------------------------------------
async function checkPortal() {
  log(`\n== Customer Portal ==`);
  const res = await stripe("GET", "/v1/billing_portal/configurations?is_default=true&active=true&limit=1");
  if (res.data?.length) {
    out.portalOk = true;
    log(`  ✓ default portal configuration exists (${res.data[0].id}) — /api/billing/portal will work`);
  } else {
    warn(`No default Customer Portal configuration. One dashboard click required: Settings → Billing → Customer portal → Save. Without it POST /api/billing/portal returns 500.`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
(async () => {
  try {
    const live = await checkAccount();

    log(`\n== Prices (idempotent via lookup_key) ==`);
    for (const t of TIERS) {
      out.prices[t.env] = await ensurePrice(t);
    }

    await ensureWebhook();
    await checkPortal();

    // ---- summary ----------------------------------------------------------
    const pairs = [
      ["STRIPE_SECRET_KEY", key],
      ["STRIPE_WEBHOOK_SECRET", out.webhookSecret || "<already set — or re-run with --rotate-webhook>"],
      ...TIERS.map((t) => [t.env, out.prices[t.env]]),
      ["DISPATCHOS_PUBLIC_URL", publicUrl],
    ];

    log(`\n${"=".repeat(74)}`);
    log(`SUMMARY — copy into Fly (dashboard → app → Secrets), or run:`);
    log(`${"=".repeat(74)}\n`);
    const flyArgs = pairs
      .filter(([, v]) => v && !String(v).startsWith("<"))
      .map(([k2, v]) => `${k2}=${v}`)
      .join(" `\n  ");
    log(`flyctl secrets set -a dispatchos-demo \`\n  ${flyArgs}\n`);
    log(`Name=value list:`);
    for (const [k2, v] of pairs) log(`  ${k2}=${v}`);

    if (warnings.length) {
      log(`\nRemaining manual steps / warnings:`);
      warnings.forEach((w, i) => log(`  ${i + 1}. ${w}`));
    } else {
      log(`\nNo manual steps left on the Stripe side. 🎉`);
    }
    if (!live) {
      log(`\nThis was a TEST-mode run — everything above lives in test mode.`);
      log(`Re-run with your sk_live_ key for production.`);
    }
    log("");
  } catch (err) {
    console.error(`\n✗ ${err.message}`);
    if (err.status === 401) {
      console.error("  The key was rejected — check you pasted the full sk_... value.");
    }
    // process.exit() here can race undici's keep-alive sockets on Windows
    // (libuv assert); set the code and let the loop drain instead.
    process.exitCode = 1;
  }
})();
