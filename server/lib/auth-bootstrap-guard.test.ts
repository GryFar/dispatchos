// Auth-bootstrap soft-delete guard regression test (temp DB, no network).
// Run: npx tsx server/lib/auth-bootstrap-guard.test.ts
//
// CROWN-JEWEL PRIMITIVE UNDER GUARD (#210)
// ----------------------------------------
// storage.getAuthState() answers the system-level question "is there already an
// admin / does the system still need bootstrap?" via `isConfigured`. The #210
// fix makes BOTH counting queries scope to `deleted_at IS NULL`:
//
//   SELECT COUNT(*) FROM users WHERE deleted_at IS NULL                    -- userCount
//   SELECT COUNT(*) FROM users WHERE role = 'admin' AND blocked = 0
//                                AND deleted_at IS NULL                     -- adminCount
//
// Every auth lookup (getUserById/getUserByEmail/...) already filters
// `deleted_at IS NULL`, so a SOFT-DELETED admin CANNOT authenticate. If
// getAuthState still counted that ghost admin, isConfigured would report
// "configured / bootstrap done" while NO admin can actually log in — either a
// permanent bootstrap lockout, or a window a takeover could exploit (the system
// "looks set up" so the protected first-admin bootstrap path stays closed).
//
// If a teammate refactors getAuthState and drops the `deleted_at IS NULL` scope
// from EITHER the userCount or the adminCount query, the soft-deleted admin
// would be counted again and these assertions MUST go red.
//
// Determinism: no Date.now() in assertions, no network. We drive everything
// through the real storage API on a unique temp DB created fresh per run.

import { tmpdir } from "node:os";
import { join } from "node:path";

// MUST be set BEFORE importing storage — better-sqlite3 binds the DB file at
// module import time (const sqlite = new Database(... DISPATCHOS_DB_PATH ...)).
process.env.DISPATCHOS_DB_PATH = join(
  tmpdir(),
  `dispatchos-auth-bootstrap-guard-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.db`,
);
// A valid 32-byte base64 keyring primary, in case any transitively-imported
// code touches the keyring at load. storage.ts itself doesn't, but harmless.
process.env.DISPATCHOS_KEYRING_PRIMARY =
  process.env.DISPATCHOS_KEYRING_PRIMARY || Buffer.alloc(32, 7).toString("base64");

const { storage } = await import("../storage");

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

const mkAdmin = () =>
  storage.createUser({
    email: `admin-${rnd()}@example.test`,
    fullName: "Bootstrap Admin",
    role: "admin",
    passwordSalt: "salt",
    passwordHash: "hash",
  });

// --- Baseline: a brand-new DB has no users → system still needs bootstrap. ---
// Establishes the "false" pole so the later isConfigured flips are meaningful.
const base = storage.getAuthState();
assert(
  "fresh DB reports NOT configured (no admin yet)",
  base.isConfigured === false,
  `isConfigured=${base.isConfigured}`,
);
assert("fresh DB userCount is 0", base.userCount === 0, `userCount=${base.userCount}`);

// --- Create an active admin → system is now configured (admin counted). ---
const admin = mkAdmin();
const afterCreate = storage.getAuthState();
assert(
  "active admin makes system configured",
  afterCreate.isConfigured === true,
  `isConfigured=${afterCreate.isConfigured}`,
);
assert(
  "active admin is counted in userCount",
  afterCreate.userCount === 1,
  `userCount=${afterCreate.userCount}`,
);
assert(
  "active admin yields role 'admin'",
  afterCreate.role === "admin",
  `role=${String(afterCreate.role)}`,
);

// --- THE #210 GUARD: soft-delete the ONLY admin → system needs bootstrap again. ---
// softDeleteUser stamps deleted_at (and blocked=1). Because getAuthState scopes
// both counts to `deleted_at IS NULL`, the ghost admin must NOT keep the system
// "configured". Drop that scope and isConfigured wrongly stays true → FAIL here.
const deleted = storage.softDeleteUser(admin.id);
assert("softDeleteUser returned the row", Boolean(deleted), "softDeleteUser undefined");
assert(
  "soft-deleted admin actually has deleted_at stamped",
  Boolean(deleted?.deletedAt),
  `deletedAt=${String(deleted?.deletedAt)}`,
);

const afterDelete = storage.getAuthState();
assert(
  "soft-deleted admin does NOT count → system NOT configured (lockout/takeover guard)",
  afterDelete.isConfigured === false,
  `isConfigured=${afterDelete.isConfigured}`,
);
assert(
  "soft-deleted admin excluded from userCount",
  afterDelete.userCount === 0,
  `userCount=${afterDelete.userCount}`,
);
assert(
  "soft-deleted admin yields no role",
  afterDelete.role === undefined,
  `role=${String(afterDelete.role)}`,
);

// --- Positive control: a NEW active admin re-configures the system. ---
// Proves the assertion above keys on the soft-delete scope, not on something
// that makes getAuthState permanently report "not configured" (which would make
// the test trivially always-true). Active admins are still counted.
mkAdmin();
const afterRecreate = storage.getAuthState();
assert(
  "fresh active admin re-configures the system (positive control)",
  afterRecreate.isConfigured === true,
  `isConfigured=${afterRecreate.isConfigured}`,
);
assert(
  "only the active admin is counted, the soft-deleted one stays excluded",
  afterRecreate.userCount === 1,
  `userCount=${afterRecreate.userCount}`,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
