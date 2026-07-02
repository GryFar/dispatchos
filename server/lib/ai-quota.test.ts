// AI usage quota (persistent daily + purchased credits).
// Run: npx tsx server/lib/ai-quota.test.ts
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-aiquota-${Date.now()}.db`);
const { storage } = await import("../storage");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

const U = "user-quota-test";
const FREE = 3; // small free tier for the test

let r = storage.consumeAiQuota(U, FREE);
assert("1st free ok (source=free)", r.ok && r.source === "free", JSON.stringify(r));
storage.consumeAiQuota(U, FREE);
r = storage.consumeAiQuota(U, FREE);
assert("3rd free ok, remainingToday=0", r.ok && r.source === "free" && r.remainingToday === 0, JSON.stringify(r));

r = storage.consumeAiQuota(U, FREE);
assert("4th denied without credits", r.ok === false && r.source === null, JSON.stringify(r));

assert("addAiCredits(2) returns 2", storage.addAiCredits(U, 2) === 2);
r = storage.consumeAiQuota(U, FREE);
assert("free exhausted -> consumes a credit", r.ok && r.source === "credit" && r.credits === 1, JSON.stringify(r));

const s = storage.getAiQuotaStatus(U, FREE);
assert("status: usedToday>=3 + credits=1", s.usedToday >= 3 && s.credits === 1, JSON.stringify(s));

const r2 = storage.consumeAiQuota("other-user-quota", FREE);
assert("separate user has its own quota", r2.ok && r2.source === "free", JSON.stringify(r2));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
