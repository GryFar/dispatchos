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

// ===========================================================================
// REGRESSION GUARDS for the trim + must-contain-'@' validation that
// resolveOwnerEmail applies to EVERY configured source (not just the admin
// fallback). Before the fix, a configured env/override value was returned
// VERBATIM — stray whitespace shipped a non-RFC address to SMTP and a value
// with no '@' was returned instead of being skipped so the next source / the
// admin fallback could win. These exercise the override channel (source #1)
// and the DISPATCHOS_OWNER_EMAIL env channel (source #3), both of which are
// read directly (no integration-config 5s cache), so they stay deterministic.
// At this point env is clear and the only admin is blocked, so an unusable
// configured value must resolve to null.
// ---------------------------------------------------------------------------

// 7. Surrounding whitespace on a configured value is TRIMMED.
//    Pre-fix: returned "  owner@x.com  " verbatim → FAIL (=== check). Now passes.
assert(
  "configured value is trimmed (override)",
  resolveOwnerEmail("  owner@x.com  ") === "owner@x.com",
  `got ${JSON.stringify(resolveOwnerEmail("  owner@x.com  "))}`,
);

// 7b. Trim also applies to the env channel (DISPATCHOS_OWNER_EMAIL, source #3).
//     Pre-fix this env value was returned untrimmed → FAIL. Now trimmed.
process.env.DISPATCHOS_OWNER_EMAIL = "\tenvowner@x.com \n";
assert(
  "configured value is trimmed (DISPATCHOS_OWNER_EMAIL env)",
  resolveOwnerEmail() === "envowner@x.com",
  `got ${JSON.stringify(resolveOwnerEmail())}`,
);
delete process.env.DISPATCHOS_OWNER_EMAIL;

// 8. A configured value with NO '@' is REJECTED and the resolver falls THROUGH.
//    Here the override (source #1) is "not-an-email"; with env clear and no
//    usable admin, it must skip the bad override and yield null.
//    Pre-fix: returned "not-an-email" verbatim → FAIL (expected null). Now null.
assert(
  "no-'@' override is rejected → falls through to null",
  resolveOwnerEmail("not-an-email") === null,
  `got ${JSON.stringify(resolveOwnerEmail("not-an-email"))}`,
);

// 8b. A no-'@' value in an env source is likewise skipped so a LATER source can
//     win. DISPATCHOS_OWNER_EMAIL (source #3) is garbage, OWNER_EMAIL (source #4)
//     is a real address → the later valid source must be chosen.
//     Pre-fix: source #3 returned "garbage" verbatim and short-circuited → FAIL.
process.env.DISPATCHOS_OWNER_EMAIL = "garbage-no-at-sign";
process.env.OWNER_EMAIL = "real@x.com";
assert(
  "no-'@' env source is skipped → next source wins",
  resolveOwnerEmail() === "real@x.com",
  `got ${JSON.stringify(resolveOwnerEmail())}`,
);
delete process.env.DISPATCHOS_OWNER_EMAIL;
delete process.env.OWNER_EMAIL;

// 9. A VALID configured email passes through unchanged (control: proves the
//    validation only rejects the bad inputs above, never a good address).
assert(
  "valid configured email passes through (override)",
  resolveOwnerEmail("valid@x.com") === "valid@x.com",
  `got ${JSON.stringify(resolveOwnerEmail("valid@x.com"))}`,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
