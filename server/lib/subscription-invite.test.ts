// Regression: per-user subscription is set from invite.subscriptionDays at signup.
// Admin creates an invite with N days -> the account created from that invite gets
// subscriptionEndsAt = signup + N days (default 30 when the invite carries none).
// Run: npx tsx server/lib/subscription-invite.test.ts

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-sub-${Date.now()}.db`);
const { storage } = await import("../storage");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}
const rnd = () => Math.random().toString(36).slice(2, 10);
const daysFromNow = (iso: string) => (new Date(iso).getTime() - Date.now()) / (24 * 3600 * 1000);

// 1) Invite with an explicit 45-day subscription.
const inv = storage.createInviteWithCode({
  code: `INV-${rnd()}`, role: "driver", subscriptionDays: 45, createdByUserId: "admin-x",
});
assert("invite carries subscriptionDays", inv.subscriptionDays === 45);

const u1 = storage.createUserConsumingInvite(
  { email: `a-${rnd()}@x.com`, fullName: "A", role: "driver", passwordSalt: "s", passwordHash: "h" },
  inv.code,
);
assert("signup not already-consumed", !("alreadyConsumed" in u1));
if (!("alreadyConsumed" in u1)) {
  assert("user got subscriptionEndsAt", typeof u1.subscriptionEndsAt === "string");
  assert("subscriptionEndsAt ~ 45 days out",
    Math.abs(daysFromNow(u1.subscriptionEndsAt!) - 45) < 1, `got ${u1.subscriptionEndsAt}`);
  const re = storage.getUserById(u1.id);
  assert("getUserById persists subscriptionEndsAt", re?.subscriptionEndsAt === u1.subscriptionEndsAt);
}

// 2) Invite without subscriptionDays -> default 30.
const inv2 = storage.createInviteWithCode({
  code: `INV-${rnd()}`, role: "dispatcher", createdByUserId: "admin-x",
});
const u2 = storage.createUserConsumingInvite(
  { email: `b-${rnd()}@x.com`, fullName: "B", role: "dispatcher", passwordSalt: "s", passwordHash: "h" },
  inv2.code,
);
if (!("alreadyConsumed" in u2)) {
  assert("default subscription ~ 30 days",
    Math.abs(daysFromNow(u2.subscriptionEndsAt!) - 30) < 1, `got ${u2.subscriptionEndsAt}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
