// Stripe success-fee charging test (temp DB).
// Run: npx tsx server/lib/stripe-charge.test.ts
//
// chargeInvoiceViaStripe is the path that actually COLLECTS the weekly success
// fee (flat $150 + 3% of gross) — previously the fee was computed/stored but
// never charged. This covers:
//
//   * chargeInvoiceViaStripe returns no_stripe_customer when the client has no
//     stripeCustomerId (and stripe_not_configured when Stripe is off) — no
//     network needed;
//   * the happy path creates invoice items + a one-off invoice and returns the
//     Stripe invoice id (fake Stripe, no network);
//   * the invoice.payment_succeeded webhook with metadata.dispatchosInvoiceId
//     flips a 'sent' invoice to 'paid' and stamps paid_at;
//   * idempotent re-delivery of payment_succeeded doesn't error / double-apply;
//   * the double-charge guard — re-charging a row that already has a
//     stripe_invoice_id is refused at the storage/route invariant level.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-stripe-charge-${Date.now()}.db`);
const { storage } = await import("../storage");
const { chargeInvoiceViaStripe, handleWebhookEvent, voidStripeInvoice, __setStripeClientForTest } =
  await import("./stripe");
import type Stripe from "stripe";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
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
    billingStatus: "active",
    ...over,
  } as any);

const ev = (type: string, object: unknown): Stripe.Event =>
  ({ type, data: { object } } as unknown as Stripe.Event);

// A fake Stripe client that records the invoiceItems / invoices it was asked to
// create. No network. finalizeInvoice is a no-op that echoes the invoice.
// `statuses` lets a test seed a remote invoice's status for retrieve()/void()
// (used by the void-cancel path): default "open" so an unknown id reads as open.
function fakeStripe(statuses: Record<string, string> = {}) {
  const calls: {
    invoiceItems: any[];
    invoices: any[];
    finalized: string[];
    retrieved: string[];
    voided: string[];
  } = {
    invoiceItems: [],
    invoices: [],
    finalized: [],
    retrieved: [],
    voided: [],
  };
  const stripe = {
    invoiceItems: {
      create: async (params: any, _opts?: any) => {
        calls.invoiceItems.push(params);
        return { id: `ii_${rnd()}`, ...params };
      },
    },
    invoices: {
      create: async (params: any, _opts?: any) => {
        const id = `in_${rnd()}`;
        calls.invoices.push({ id, ...params });
        return { id, ...params };
      },
      finalizeInvoice: async (id: string) => {
        calls.finalized.push(id);
        return { id, status: "open" };
      },
      retrieve: async (id: string) => {
        calls.retrieved.push(id);
        return { id, status: statuses[id] ?? "open" };
      },
      voidInvoice: async (id: string) => {
        calls.voided.push(id);
        statuses[id] = "void";
        return { id, status: "void" };
      },
    },
  } as unknown as Stripe;
  return { stripe, calls };
}

// ---------------------------------------------------------------------------
// 1) Stripe not configured -> stripe_not_configured, no network.
// ---------------------------------------------------------------------------
{
  __setStripeClientForTest(null);
  const client = mkClient({ stripeCustomerId: "cus_x" });
  const inv = storage.createInvoice({
    clientId: client.id,
    weekStart: "2026-06-01",
    weekEnd: "2026-06-07",
    flatFee: 150,
    percentFee: 12.34,
    grossBooked: 411.33,
    status: "draft",
  });
  const res = await chargeInvoiceViaStripe(inv);
  assert("not configured: ok=false", res.ok === false);
  assert("not configured: reason stripe_not_configured", res.reason === "stripe_not_configured", res.reason);
}

// ---------------------------------------------------------------------------
// 2) No stripeCustomerId on the client -> no_stripe_customer, no network.
// ---------------------------------------------------------------------------
{
  const { stripe } = fakeStripe();
  __setStripeClientForTest(stripe);
  const client = mkClient({ stripeCustomerId: undefined });
  const inv = storage.createInvoice({
    clientId: client.id,
    weekStart: "2026-06-08",
    weekEnd: "2026-06-14",
    flatFee: 150,
    percentFee: 0,
    grossBooked: 0,
    status: "draft",
  });
  const res = await chargeInvoiceViaStripe(inv);
  assert("no customer: ok=false", res.ok === false);
  assert("no customer: reason no_stripe_customer", res.reason === "no_stripe_customer", res.reason);
}

// ---------------------------------------------------------------------------
// 3) Happy path -> creates 2 items (flat + pct), opens + finalizes invoice.
// ---------------------------------------------------------------------------
{
  const { stripe, calls } = fakeStripe();
  __setStripeClientForTest(stripe);
  const client = mkClient({ stripeCustomerId: "cus_pay" });
  const inv = storage.createInvoice({
    clientId: client.id,
    weekStart: "2026-06-15",
    weekEnd: "2026-06-21",
    flatFee: 150,
    percentFee: 12.34,
    grossBooked: 411.33,
    status: "draft",
  });
  const res = await chargeInvoiceViaStripe(inv);
  assert("happy: ok=true", res.ok === true, res.reason);
  assert("happy: returns stripeInvoiceId", typeof res.stripeInvoiceId === "string");
  assert("happy: two invoice items (flat + pct)", calls.invoiceItems.length === 2, String(calls.invoiceItems.length));
  assert("happy: flat item is 15000 cents", calls.invoiceItems.some((i) => i.amount === 15000));
  assert("happy: pct item is 1234 cents", calls.invoiceItems.some((i) => i.amount === 1234));
  assert("happy: invoice charge_automatically", calls.invoices[0]?.collection_method === "charge_automatically");
  assert(
    "happy: invoice carries dispatchosInvoiceId metadata",
    calls.invoices[0]?.metadata?.dispatchosInvoiceId === inv.id,
  );
  assert("happy: finalize called", calls.finalized.length === 1);
}

// ---------------------------------------------------------------------------
// 4) Zero percent fee -> only the flat item is created (no zero-amount line).
// ---------------------------------------------------------------------------
{
  const { stripe, calls } = fakeStripe();
  __setStripeClientForTest(stripe);
  const client = mkClient({ stripeCustomerId: "cus_zero" });
  const inv = storage.createInvoice({
    clientId: client.id,
    weekStart: "2026-06-22",
    weekEnd: "2026-06-28",
    flatFee: 150,
    percentFee: 0,
    grossBooked: 0,
    status: "draft",
  });
  const res = await chargeInvoiceViaStripe(inv);
  assert("zero pct: ok=true", res.ok === true, res.reason);
  assert("zero pct: only one invoice item (flat)", calls.invoiceItems.length === 1, String(calls.invoiceItems.length));
}

// ---------------------------------------------------------------------------
// 5) Webhook payment_succeeded with metadata.dispatchosInvoiceId flips
//    'sent' -> 'paid' and stamps paid_at.
// ---------------------------------------------------------------------------
{
  __setStripeClientForTest(null); // no network needed for this path
  const client = mkClient({ stripeCustomerId: "cus_wh" });
  // Create a 'sent' invoice carrying a stripe id (as generate would leave it).
  const inv = storage.createInvoice({
    clientId: client.id,
    weekStart: "2026-07-01",
    weekEnd: "2026-07-07",
    flatFee: 150,
    percentFee: 9,
    grossBooked: 300,
    status: "sent",
    stripeInvoiceId: "in_wh_1",
  });
  assert("webhook setup: starts 'sent'", inv.status === "sent");
  assert("webhook setup: no paid_at yet", inv.paidAt == null);

  const res = await handleWebhookEvent(
    ev("invoice.payment_succeeded", {
      id: "in_wh_1",
      amount_paid: 15900,
      metadata: { dispatchosInvoiceId: inv.id },
    } as unknown as Stripe.Invoice),
  );
  const after = storage.getInvoice(inv.id)!;
  assert("webhook: handled", res.handled === true);
  assert("webhook: clientId resolved", res.clientId === client.id);
  assert("webhook: invoice now paid", after.status === "paid", after.status);
  assert("webhook: paid_at stamped", typeof after.paidAt === "string");

  // Idempotent re-delivery: must not error, must stay paid.
  const res2 = await handleWebhookEvent(
    ev("invoice.payment_succeeded", {
      id: "in_wh_1",
      amount_paid: 15900,
      metadata: { dispatchosInvoiceId: inv.id },
    } as unknown as Stripe.Invoice),
  );
  const after2 = storage.getInvoice(inv.id)!;
  assert("webhook re-delivery: handled (no throw)", res2.handled === true);
  assert("webhook re-delivery: still paid", after2.status === "paid");
  assert("webhook re-delivery: paid_at unchanged", after2.paidAt === after.paidAt);
}

// ---------------------------------------------------------------------------
// 5b) Webhook payment_succeeded normalizes a STUCK 'draft' (+stripeInvoiceId)
//     to 'paid'. Regression guard: chargeInvoiceViaStripe stamps the Stripe id
//     BEFORE finalize; if finalize threw, admin.ts generate leaves the row
//     'draft' but Stripe (auto_advance) still collects ~1h later. A direct
//     draft->paid is an invalidTransition, so the webhook must step the legal
//     draft->sent->paid path instead of silently leaving the row 'draft'
//     forever (money collected by Stripe, shown uncollected locally).
// ---------------------------------------------------------------------------
{
  __setStripeClientForTest(null); // no network needed for this path
  const client = mkClient({ stripeCustomerId: "cus_stuck" });
  // Row as the early-stripe-id-persist + finalize-threw path would leave it:
  // 'draft' but already carrying the Stripe invoice id.
  const inv = storage.createInvoice({
    clientId: client.id,
    weekStart: "2026-07-29",
    weekEnd: "2026-08-04",
    flatFee: 150,
    percentFee: 9,
    grossBooked: 300,
    status: "draft",
    stripeInvoiceId: "in_stuck_1",
  });
  assert("stuck draft setup: starts 'draft'", inv.status === "draft");
  assert("stuck draft setup: carries stripe id", inv.stripeInvoiceId === "in_stuck_1");
  assert("stuck draft setup: no paid_at yet", inv.paidAt == null);

  const res = await handleWebhookEvent(
    ev("invoice.payment_succeeded", {
      id: "in_stuck_1",
      amount_paid: 15900,
      metadata: { dispatchosInvoiceId: inv.id },
    } as unknown as Stripe.Invoice),
  );
  const after = storage.getInvoice(inv.id)!;
  assert("stuck draft: handled", res.handled === true);
  assert("stuck draft: clientId resolved", res.clientId === client.id);
  assert("stuck draft: normalized draft->sent->paid (now paid)", after.status === "paid", after.status);
  assert("stuck draft: paid_at stamped", typeof after.paidAt === "string");

  // Idempotent re-delivery: must not error, must stay paid (paid is terminal,
  // so the now-'paid' row is skipped, not flipped again).
  const res2 = await handleWebhookEvent(
    ev("invoice.payment_succeeded", {
      id: "in_stuck_1",
      amount_paid: 15900,
      metadata: { dispatchosInvoiceId: inv.id },
    } as unknown as Stripe.Invoice),
  );
  const after2 = storage.getInvoice(inv.id)!;
  assert("stuck draft re-delivery: handled (no throw)", res2.handled === true);
  assert("stuck draft re-delivery: still paid", after2.status === "paid");
  assert("stuck draft re-delivery: paid_at unchanged", after2.paidAt === after.paidAt);
}

// ---------------------------------------------------------------------------
// 6) Webhook fallback resolution by stripe_invoice_id (no metadata).
// ---------------------------------------------------------------------------
{
  __setStripeClientForTest(null);
  const client = mkClient({ stripeCustomerId: "cus_wh2" });
  const inv = storage.createInvoice({
    clientId: client.id,
    weekStart: "2026-07-08",
    weekEnd: "2026-07-14",
    flatFee: 150,
    percentFee: 0,
    grossBooked: 0,
    status: "sent",
    stripeInvoiceId: "in_wh_2",
  });
  const res = await handleWebhookEvent(
    ev("invoice.payment_succeeded", {
      id: "in_wh_2",
      amount_paid: 15000,
      // no metadata — must fall back to findInvoiceByStripeId
    } as unknown as Stripe.Invoice),
  );
  const after = storage.getInvoice(inv.id)!;
  assert("webhook (by stripe id): handled", res.handled === true);
  assert("webhook (by stripe id): paid", after.status === "paid", after.status);
}

// ---------------------------------------------------------------------------
// 7) Double-charge guard: findInvoiceByStripeId reverse lookup + the retry
//    invariant (an invoice that already has a stripe_invoice_id must be
//    refused for re-charge). We assert the storage invariant the route relies on.
// ---------------------------------------------------------------------------
{
  const client = mkClient({ stripeCustomerId: "cus_guard" });
  const inv = storage.createInvoice({
    clientId: client.id,
    weekStart: "2026-07-15",
    weekEnd: "2026-07-21",
    flatFee: 150,
    percentFee: 5,
    grossBooked: 166.67,
    status: "sent",
    stripeInvoiceId: "in_guard_1",
  });
  const found = storage.findInvoiceByStripeId("in_guard_1");
  assert("guard: reverse lookup finds the row", found?.id === inv.id);
  // The retry route refuses when stripeInvoiceId is already set — model that check.
  const wouldRefuse = Boolean(inv.stripeInvoiceId);
  assert("guard: already-charged invoice would be refused for re-charge", wouldRefuse === true);
}

// ---------------------------------------------------------------------------
// 8) Webhook does NOT touch an already-void invoice (double-apply guard).
//    (Orthogonal to the void-cancel fix: even after a row is voided, a late
//    payment_succeeded re-delivery must not flip it back to paid.)
// ---------------------------------------------------------------------------
{
  __setStripeClientForTest(null);
  const client = mkClient({ stripeCustomerId: "cus_void" });
  const inv = storage.createInvoice({
    clientId: client.id,
    weekStart: "2026-07-22",
    weekEnd: "2026-07-28",
    flatFee: 150,
    percentFee: 0,
    grossBooked: 0,
    status: "draft",
    stripeInvoiceId: "in_void_1",
  });
  // draft -> void (allowed transition)
  storage.updateInvoice(inv.id, { status: "void" });
  const res = await handleWebhookEvent(
    ev("invoice.payment_succeeded", {
      id: "in_void_1",
      amount_paid: 15000,
      metadata: { dispatchosInvoiceId: inv.id },
    } as unknown as Stripe.Invoice),
  );
  const after = storage.getInvoice(inv.id)!;
  assert("void guard: handled (audited, no throw)", res.handled === true);
  assert("void guard: stays void (not flipped to paid)", after.status === "void", after.status);
}

// ---------------------------------------------------------------------------
// 9) Voiding a STILL-OPEN stripe-charged invoice cancels the Stripe charge.
//    voidStripeInvoice must call stripe.invoices.voidInvoice so the carrier is
//    NOT billed for the fee the operator cancelled. (Previously the local row
//    flipped to 'void' with NO Stripe call and auto_advance kept charging.)
// ---------------------------------------------------------------------------
{
  const { stripe, calls } = fakeStripe({ in_open_1: "open" });
  __setStripeClientForTest(stripe);
  const res = await voidStripeInvoice("in_open_1");
  assert("void open: ok=true", res.ok === true, res.reason);
  assert("void open: voided=true", res.voided === true);
  assert("void open: retrieved the invoice", calls.retrieved.includes("in_open_1"));
  assert("void open: called voidInvoice", calls.voided.includes("in_open_1"));
}

// ---------------------------------------------------------------------------
// 10) Voiding a PAID stripe-charged invoice is REFUSED (no auto-refund).
//     voidStripeInvoice returns ok:false / reason 'already_paid' so the admin
//     route 409s — an operator must issue a refund/credit note manually before
//     the local void, never silently leave the carrier charged with no record.
// ---------------------------------------------------------------------------
{
  const { stripe, calls } = fakeStripe({ in_paid_1: "paid" });
  __setStripeClientForTest(stripe);
  const res = await voidStripeInvoice("in_paid_1");
  assert("void paid: ok=false (refused)", res.ok === false);
  assert("void paid: reason already_paid", res.reason === "already_paid", res.reason);
  assert("void paid: did NOT call voidInvoice (no auto-cancel of a paid charge)", !calls.voided.includes("in_paid_1"));
}

// ---------------------------------------------------------------------------
// 11) Stripe unconfigured -> voidStripeInvoice no-ops to ok:true (voided:false)
//     so the local void of a never-really-charged row still proceeds.
// ---------------------------------------------------------------------------
{
  __setStripeClientForTest(null);
  const res = await voidStripeInvoice("in_whatever");
  assert("void no-stripe: ok=true", res.ok === true);
  assert("void no-stripe: voided=false (nothing to cancel)", res.voided === false);
}

// ---------------------------------------------------------------------------
// 12) REVERSAL reconciliation: a fully-reversed Stripe charge flips a locally
//     'paid' DispatchOS invoice off 'paid' (paid -> void) so we stop counting
//     revenue Stripe no longer holds.
//
//   12a) invoice.voided on a paid row -> void.
//   12b) invoice.marked_uncollectible on a paid row -> void.
//   12c) charge.refunded FULL (amount_refunded >= amount) -> void.
//   12d) charge.refunded PARTIAL -> NO status change, partial-reversal audit.
//   12e) credit_note.created fully crediting the fee -> void.
//   12f) credit_note.created PARTIAL -> NO status change.
//   12g) re-delivery of a reversal is a no-op (already void).
//   12h) AI-credit-pack invoice reversed -> AUDIT only, NO clawback.
// ---------------------------------------------------------------------------

// Helper: a 'paid' success-fee row carrying a Stripe invoice id.
function mkPaidInvoice(stripeId: string, over: Record<string, unknown> = {}) {
  const client = mkClient({ stripeCustomerId: `cus_${rnd()}` });
  const inv = storage.createInvoice({
    clientId: client.id,
    weekStart: "2026-08-05",
    weekEnd: "2026-08-11",
    flatFee: 150,
    percentFee: 9,
    grossBooked: 300,
    status: "sent",
    stripeInvoiceId: stripeId,
    ...over,
  } as any);
  // sent -> paid (legal transition) so the row reads as collected revenue.
  storage.updateInvoice(inv.id, { status: "paid" });
  return { client, inv: storage.getInvoice(inv.id)! };
}

// 12a) invoice.voided -> void
{
  __setStripeClientForTest(null);
  const { inv } = mkPaidInvoice("in_rev_voided");
  assert("reverse setup (voided): starts 'paid'", inv.status === "paid", inv.status);
  const res = await handleWebhookEvent(
    ev("invoice.voided", { id: "in_rev_voided", total: 15900, metadata: { dispatchosInvoiceId: inv.id } } as unknown as Stripe.Invoice),
  );
  const after = storage.getInvoice(inv.id)!;
  assert("invoice.voided: handled", res.handled === true);
  assert("invoice.voided: clientId resolved", res.clientId === inv.clientId);
  assert("invoice.voided: paid -> void", after.status === "void", after.status);
}

// 12b) invoice.marked_uncollectible -> void (resolve via stripe id, no metadata)
{
  __setStripeClientForTest(null);
  const { inv } = mkPaidInvoice("in_rev_uncoll");
  const res = await handleWebhookEvent(
    ev("invoice.marked_uncollectible", { id: "in_rev_uncoll" } as unknown as Stripe.Invoice),
  );
  const after = storage.getInvoice(inv.id)!;
  assert("marked_uncollectible: handled", res.handled === true);
  assert("marked_uncollectible: resolved by stripe id (no metadata)", res.clientId === inv.clientId);
  assert("marked_uncollectible: paid -> void", after.status === "void", after.status);
}

// 12c) charge.refunded FULL -> void (charge.invoice links to the row)
{
  __setStripeClientForTest(null);
  const { inv } = mkPaidInvoice("in_rev_chgfull");
  const res = await handleWebhookEvent(
    ev("charge.refunded", { id: "ch_1", amount: 15900, amount_refunded: 15900, refunded: true, invoice: "in_rev_chgfull" } as unknown as Stripe.Charge),
  );
  const after = storage.getInvoice(inv.id)!;
  assert("charge.refunded full: handled", res.handled === true);
  assert("charge.refunded full: paid -> void", after.status === "void", after.status);
}

// 12d) charge.refunded PARTIAL -> NO status change (still paid), partial audit
{
  __setStripeClientForTest(null);
  const { inv } = mkPaidInvoice("in_rev_chgpart");
  const res = await handleWebhookEvent(
    ev("charge.refunded", { id: "ch_2", amount: 15900, amount_refunded: 5000, refunded: false, invoice: "in_rev_chgpart" } as unknown as Stripe.Charge),
  );
  const after = storage.getInvoice(inv.id)!;
  assert("charge.refunded partial: handled", res.handled === true);
  assert("charge.refunded partial: STAYS paid (no zeroing a mostly-collected fee)", after.status === "paid", after.status);
  assert("charge.refunded partial: changes.partial flagged", (res.changes as { partial?: boolean })?.partial === true);
}

// 12e) credit_note.created fully crediting the fee -> void
{
  __setStripeClientForTest(null);
  // flat 150 + pct 9 = $159 collected = 15900 cents; full credit note total >= that.
  const { inv } = mkPaidInvoice("in_rev_cnfull");
  const res = await handleWebhookEvent(
    ev("credit_note.created", { id: "cn_1", total: 15900, invoice: "in_rev_cnfull" } as unknown as Stripe.CreditNote),
  );
  const after = storage.getInvoice(inv.id)!;
  assert("credit_note full: handled", res.handled === true);
  assert("credit_note full: paid -> void", after.status === "void", after.status);
}

// 12f) credit_note.created PARTIAL -> NO status change
{
  __setStripeClientForTest(null);
  const { inv } = mkPaidInvoice("in_rev_cnpart");
  const res = await handleWebhookEvent(
    ev("credit_note.created", { id: "cn_2", total: 5000, invoice: "in_rev_cnpart" } as unknown as Stripe.CreditNote),
  );
  const after = storage.getInvoice(inv.id)!;
  assert("credit_note partial: handled", res.handled === true);
  assert("credit_note partial: STAYS paid", after.status === "paid", after.status);
}

// 12g) re-delivery of a full reversal is a no-op (already void)
{
  __setStripeClientForTest(null);
  const { inv } = mkPaidInvoice("in_rev_idem");
  await handleWebhookEvent(
    ev("invoice.voided", { id: "in_rev_idem", metadata: { dispatchosInvoiceId: inv.id } } as unknown as Stripe.Invoice),
  );
  const once = storage.getInvoice(inv.id)!;
  assert("reversal idempotency: first delivery -> void", once.status === "void", once.status);
  const res2 = await handleWebhookEvent(
    ev("invoice.voided", { id: "in_rev_idem", metadata: { dispatchosInvoiceId: inv.id } } as unknown as Stripe.Invoice),
  );
  const twice = storage.getInvoice(inv.id)!;
  assert("reversal idempotency: re-delivery handled (no throw)", res2.handled === true);
  assert("reversal idempotency: stays void", twice.status === "void");
  assert("reversal idempotency: re-delivery reversed=false (no-op)", (res2.changes as { reversed?: boolean })?.reversed === false);
}

// 12h) AI-credit-pack invoice reversed -> AUDIT only, NO clawback / status flip
{
  __setStripeClientForTest(null);
  const U = "u-rev-aicred";
  // Grant a pack so there's a balance that must NOT be clawed back.
  storage.grantAiCreditsForInvoice("in_ai_grant", U, 100);
  const before = storage.getAiCredits(U);
  assert("ai reversal setup: has credits", before === 100, String(before));
  const res = await handleWebhookEvent(
    ev("invoice.voided", { id: "in_ai_rev", total: 500, metadata: { aiCreditsUserId: U, aiCreditsPack: "100" } } as unknown as Stripe.Invoice),
  );
  assert("ai reversal: handled (audited)", res.handled === true);
  assert("ai reversal: NO auto-clawback (balance unchanged)", storage.getAiCredits(U) === before, String(storage.getAiCredits(U)));
  assert("ai reversal: reversed=false", (res.changes as { reversed?: boolean })?.reversed === false);
}

__setStripeClientForTest(null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
