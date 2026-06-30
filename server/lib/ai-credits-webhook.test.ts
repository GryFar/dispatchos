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
  data: { object: { id: "in_aicred_1", metadata: { aiCreditsUserId: U, aiCreditsPack: "100" } } },
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
  data: { object: { id: "in_dup_1", metadata: { aiCreditsUserId: U2, aiCreditsPack: "100" } } },
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
  data: { object: { id: "in_dup_1", metadata: { aiCreditsUserId: U2, aiCreditsPack: "100" } } },
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
  data: { object: { id: "in_dup_2", metadata: { aiCreditsUserId: U2, aiCreditsPack: "50" } } },
} as unknown as Parameters<typeof handleWebhookEvent>[0];
await handleWebhookEvent(freshEvt);
assert("distinct invoice grants again -> 150 credits", storage.getAiCredits(U2) === 150, String(storage.getAiCredits(U2)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
