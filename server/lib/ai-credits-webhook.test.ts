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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
