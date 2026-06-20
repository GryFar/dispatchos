// resolveOwnerEmail unit tests. Run: npx tsx server/lib/owner-email.test.ts
//
// Unifies the owner alert-email lookup that insurance/trial/compliance each did
// differently. Verifies the priority chain + first-admin fallback.

import { tmpdir } from "node:os";
import { join } from "node:path";

const rnd = () => Math.random().toString(36).slice(2, 10);
process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-owner-email-${Date.now()}-${rnd()}.db`);
delete process.env.DISPATCHOS_OWNER_EMAIL;
delete process.env.OWNER_EMAIL;

const { storage } = await import("../storage");
const { resolveOwnerEmail } = await import("./owner-email");

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

// 1. Nothing configured, no admin → null.
assert("no config + no admin → null", resolveOwnerEmail() === null);

// 2. OWNER_EMAIL env is used.
process.env.OWNER_EMAIL = "owner@x.com";
assert("OWNER_EMAIL env used", resolveOwnerEmail() === "owner@x.com");

// 3. DISPATCHOS_OWNER_EMAIL takes priority over OWNER_EMAIL.
process.env.DISPATCHOS_OWNER_EMAIL = "disp@x.com";
assert("DISPATCHOS_OWNER_EMAIL > OWNER_EMAIL", resolveOwnerEmail() === "disp@x.com");

// 4. Explicit override beats env.
assert("explicit override wins", resolveOwnerEmail("override@x.com") === "override@x.com");

// 5. With env cleared, fall back to first active admin.
delete process.env.DISPATCHOS_OWNER_EMAIL;
delete process.env.OWNER_EMAIL;
const admin = storage.createUser({
  email: `admin-${rnd()}@x.com`,
  fullName: "Admin",
  role: "admin",
  passwordSalt: "s",
  passwordHash: "h",
});
assert("falls back to first active admin", resolveOwnerEmail() === admin.email, `got ${resolveOwnerEmail()}`);

// 6. A blocked admin is NOT used as fallback.
storage.updateUser(admin.id, { blocked: true });
assert("blocked admin not used", resolveOwnerEmail() === null, `got ${resolveOwnerEmail()}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
