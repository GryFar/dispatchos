// AI credit-pack grant via Stripe invoice.payment_succeeded webhook.
// Run: npx tsx server/lib/ai-credits-webhook.test.ts
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-aicred-${Date.now()}.db`);
const { storage } = await import("../storage");
const { handleWebhookEvent } = await import("./stripe");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

const U = "u-aicred-test";
assert("starts with 0 credits", storage.getAiCredits(U) === 0);

const evt = {
  id: "evt_aicred_1",
  type: "invoice.payment_succeeded",
  data: { object: { id: "in_aicred_1", amount_paid: 500, metadata: { aiCreditsUserId: U, aiCreditsPack: "100" } } },
} as unknown as Parameters<typeof handleWebhookEvent>[0];

const out = await handleWebhookEvent(evt);
assert("webhook handled", out.handled === true, JSON.stringify(out));
assert("granted 100 credits", storage.getAiCredits(U) === 100, String(storage.getAiCredits(U)));

// An invoice WITHOUT our metadata must not grant anything.
const evt2 = {
  id: "evt_other",
  type: "invoice.payment_succeeded",
  data: { object: { id: "in_other", metadata: {} } },
} as unknown as Parameters<typeof handleWebhookEvent>[0];
await handleWebhookEvent(evt2);
assert("no metadata -> credits unchanged", storage.getAiCredits(U) === 100, String(storage.getAiCredits(U)));

// ---------------------------------------------------------------------------
// IDEMPOTENCY: the route un-claims the event id on a handler throw, so a Stripe
// retry re-enters handleWebhookEvent with the SAME invoice. Re-delivering the
// same credit-pack invoice must NOT grant the credits a second time. We invoke
// handleWebhookEvent directly (the route's event.id dedup is bypassed — exactly
// the "unmarked + retried" race), with the SAME invoice id, twice.
const U2 = "u-aicred-dup";
const dupEvt = {
  id: "evt_dup_1",
  type: "invoice.payment_succeeded",
  data: { object: { id: "in_dup_1", amount_paid: 500, metadata: { aiCreditsUserId: U2, aiCreditsPack: "100" } } },
} as unknown as Parameters<typeof handleWebhookEvent>[0];

assert("dup user starts at 0", storage.getAiCredits(U2) === 0);
const dup1 = await handleWebhookEvent(dupEvt);
assert("first delivery handled", dup1.handled === true, JSON.stringify(dup1));
assert("first delivery granted=true", (dup1.changes as { granted?: boolean })?.granted === true, JSON.stringify(dup1.changes));
assert("first delivery -> 100 credits", storage.getAiCredits(U2) === 100, String(storage.getAiCredits(U2)));

// Same invoice id, but simulate a retry under a DIFFERENT event id too — must
// still be a single grant (we key on invoice id, not event id).
const dupEvt2 = {
  id: "evt_dup_2_different_event_id",
  type: "invoice.payment_succeeded",
  data: { object: { id: "in_dup_1", amount_paid: 500, metadata: { aiCreditsUserId: U2, aiCreditsPack: "100" } } },
} as unknown as Parameters<typeof handleWebhookEvent>[0];
const dup2 = await handleWebhookEvent(dupEvt2);
assert("second delivery still handled", dup2.handled === true, JSON.stringify(dup2));
assert("second delivery granted=false", (dup2.changes as { granted?: boolean })?.granted === false, JSON.stringify(dup2.changes));
assert("DOUBLE-GRANT PREVENTED: still 100 credits", storage.getAiCredits(U2) === 100, String(storage.getAiCredits(U2)));

// A third delivery for good measure (N deliveries => exactly once).
await handleWebhookEvent(dupEvt);
assert("third delivery -> still 100 credits", storage.getAiCredits(U2) === 100, String(storage.getAiCredits(U2)));

// A DIFFERENT invoice for the same user SHOULD grant again (not over-dedup).
const freshEvt = {
  id: "evt_fresh",
  type: "invoice.payment_succeeded",
  data: { object: { id: "in_dup_2", amount_paid: 500, metadata: { aiCreditsUserId: U2, aiCreditsPack: "50" } } },
} as unknown as Parameters<typeof handleWebhookEvent>[0];
await handleWebhookEvent(freshEvt);
assert("distinct invoice grants again -> 150 credits", storage.getAiCredits(U2) === 150, String(storage.getAiCredits(U2)));

// ---------------------------------------------------------------------------
// MONEY GATE: a coupon / customer-balance that zeroes (or reduces) the charge
// below the pack price must NOT grant the pack. amount_paid is what Stripe
// actually collected after the discount. Two cases: fully zeroed and partially
// discounted — both below the $5 (500c) pack price → no credits.
const U3 = "u-aicred-discount";
assert("discount user starts at 0", storage.getAiCredits(U3) === 0);

const zeroedEvt = {
  id: "evt_zeroed",
  type: "invoice.payment_succeeded",
  data: { object: { id: "in_zeroed", amount_paid: 0, metadata: { aiCreditsUserId: U3, aiCreditsPack: "100" } } },
} as unknown as Parameters<typeof handleWebhookEvent>[0];
const zeroed = await handleWebhookEvent(zeroedEvt);
assert("zeroed invoice handled (acked)", zeroed.handled === true, JSON.stringify(zeroed));
assert("zeroed invoice granted=false", (zeroed.changes as { granted?: boolean })?.granted === false, JSON.stringify(zeroed.changes));
assert("FREE-PACK PREVENTED: zeroed invoice grants 0 credits", storage.getAiCredits(U3) === 0, String(storage.getAiCredits(U3)));

const partialEvt = {
  id: "evt_partial",
  type: "invoice.payment_succeeded",
  data: { object: { id: "in_partial", amount_paid: 499, metadata: { aiCreditsUserId: U3, aiCreditsPack: "100" } } },
} as unknown as Parameters<typeof handleWebhookEvent>[0];
const partial = await handleWebhookEvent(partialEvt);
assert("partial invoice granted=false", (partial.changes as { granted?: boolean })?.granted === false, JSON.stringify(partial.changes));
assert("UNDERPAY PREVENTED: 499c (< 500) grants 0 credits", storage.getAiCredits(U3) === 0, String(storage.getAiCredits(U3)));

// Exactly the pack price (500c) DOES grant — boundary is inclusive.
const exactEvt = {
  id: "evt_exact",
  type: "invoice.payment_succeeded",
  data: { object: { id: "in_exact", amount_paid: 500, metadata: { aiCreditsUserId: U3, aiCreditsPack: "100" } } },
} as unknown as Parameters<typeof handleWebhookEvent>[0];
await handleWebhookEvent(exactEvt);
assert("exact pack price grants -> 100 credits", storage.getAiCredits(U3) === 100, String(storage.getAiCredits(U3)));

// ---------------------------------------------------------------------------
// VALUE-MISATTRIBUTION FIX: a pack carrying aiCreditsClientId is SCOPED to that
// carrier. A scoped credit is spent FIRST for its own carrier; for a DIFFERENT
// carrier only the legacy NULL bucket is reachable. We use a tiny free tier (0)
// so consumeAiQuota goes straight to credits.
const US = "u-scoped";
const CARRIER_A = "carrier-A";
const CARRIER_B = "carrier-B";

// Grant a scoped pack billed to carrier-A.
const scopedEvt = {
  id: "evt_scoped",
  type: "invoice.payment_succeeded",
  data: {
    object: {
      id: "in_scoped_A",
      amount_paid: 500,
      metadata: { aiCreditsUserId: US, aiCreditsPack: "100", aiCreditsClientId: CARRIER_A },
    },
  },
} as unknown as Parameters<typeof handleWebhookEvent>[0];
const scoped = await handleWebhookEvent(scopedEvt);
assert("scoped grant handled+granted", scoped.handled === true && (scoped.changes as { granted?: boolean })?.granted === true, JSON.stringify(scoped.changes));
// Badge total (no clientId) sees the scoped pack.
assert("scoped: badge total = 100", storage.getAiCredits(US) === 100, String(storage.getAiCredits(US)));
// Per-carrier view: carrier-A sees its 100; carrier-B sees 0 (no legacy bucket yet).
assert("scoped: carrier-A view = 100", storage.getAiCredits(US, CARRIER_A) === 100, String(storage.getAiCredits(US, CARRIER_A)));
assert("scoped: carrier-B view = 0 (can't see A's pack)", storage.getAiCredits(US, CARRIER_B) === 0, String(storage.getAiCredits(US, CARRIER_B)));

// Spend for carrier-B (free tier 0): MUST be denied — B can't reach A's credits.
const spendB = storage.consumeAiQuota(US, 0, CARRIER_B);
assert("scoped: spend for carrier-B DENIED (no misattribution)", spendB.ok === false && spendB.source === null, JSON.stringify(spendB));
assert("scoped: A's balance untouched after B attempt = 100", storage.getAiCredits(US) === 100, String(storage.getAiCredits(US)));

// Spend for carrier-A: consumes A's scoped credit.
const spendA = storage.consumeAiQuota(US, 0, CARRIER_A);
assert("scoped: spend for carrier-A OK from credit", spendA.ok === true && spendA.source === "credit", JSON.stringify(spendA));
assert("scoped: carrier-A view now 99", storage.getAiCredits(US, CARRIER_A) === 99, String(storage.getAiCredits(US, CARRIER_A)));

// ---------------------------------------------------------------------------
// LEGACY FALLBACK: an unscoped (admin/legacy NULL) grant is spendable for ANY
// carrier, and a scoped bucket prefers itself before falling back to legacy.
const UL = "u-legacy";
storage.addAiCredits(UL, 2); // lands in the legacy NULL bucket
assert("legacy: badge total = 2", storage.getAiCredits(UL) === 2, String(storage.getAiCredits(UL)));
assert("legacy: any-carrier view sees it", storage.getAiCredits(UL, "any-carrier") === 2, String(storage.getAiCredits(UL, "any-carrier")));
// Spend for some carrier with no scoped bucket → falls back to legacy NULL.
const legSpend = storage.consumeAiQuota(UL, 0, "carrier-X");
assert("legacy: spend falls back to NULL bucket", legSpend.ok === true && legSpend.source === "credit", JSON.stringify(legSpend));
assert("legacy: balance now 1", storage.getAiCredits(UL) === 1, String(storage.getAiCredits(UL)));
// And a spend with NO clientId (undefined) still works off legacy — unchanged old behavior.
const legSpend2 = storage.consumeAiQuota(UL, 0);
assert("legacy: spend with undefined clientId works", legSpend2.ok === true && legSpend2.source === "credit", JSON.stringify(legSpend2));
assert("legacy: balance now 0", storage.getAiCredits(UL) === 0, String(storage.getAiCredits(UL)));

// Scoped-prefers-self-then-legacy: a user with BOTH a scoped (1) and legacy (1)
// bucket spends scoped first, then legacy.
const UB = "u-both";
storage.grantAiCreditsForInvoice("in_both_scoped", UB, 1, CARRIER_A); // scoped to A
storage.addAiCredits(UB, 1); // legacy NULL
assert("both: badge total = 2", storage.getAiCredits(UB) === 2, String(storage.getAiCredits(UB)));
const both1 = storage.consumeAiQuota(UB, 0, CARRIER_A);
assert("both: first spend hits scoped bucket", both1.ok === true && storage.getAiCredits(UB, CARRIER_A) === 1, JSON.stringify({ ok: both1.ok, aView: storage.getAiCredits(UB, CARRIER_A) }));
const both2 = storage.consumeAiQuota(UB, 0, CARRIER_A);
assert("both: second spend falls back to legacy", both2.ok === true, JSON.stringify(both2));
assert("both: balance now 0", storage.getAiCredits(UB) === 0, String(storage.getAiCredits(UB)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
