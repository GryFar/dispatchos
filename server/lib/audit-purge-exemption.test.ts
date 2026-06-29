// Audit-retention financial-exemption regression test (temp DB, no network).
// Run: npx tsx server/lib/audit-purge-exemption.test.ts
//
// CROWN-JEWEL PRIMITIVE UNDER GUARD
// --------------------------------
// storage.purgeOldAuditEvents() is the GDPR/CCPA PII-minimization cron that
// deletes audit rows older than the retention window. The money-safety fix it
// must NEVER silently lose: it EXEMPTS financial events (event_type LIKE
// 'invoice.%' OR 'billing.%') from that purge. Those rows are the billing
// trail — who was charged what — and US tax / chargeback / breach rules need
// them for years, far longer than the 180-day PII window. If a teammate
// refactors the DELETE and drops the
//     AND event_type NOT LIKE 'invoice.%' AND event_type NOT LIKE 'billing.%'
// guard, the financial trail would be wiped after 180 days and these
// assertions MUST go red.
//
// Determinism: we never rely on Date.now() inside assertions. We write rows
// via the real storage.audit() path, then stamp their created_at to a FIXED,
// far-in-the-past ISO date (well beyond the default 180-day window) using a
// second better-sqlite3 connection to the SAME temp DB file. We also keep a
// FRESH control set (current created_at) to prove the purge keys on AGE, not on
// type alone — a fresh non-financial row must survive too.

import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

// MUST be set BEFORE importing storage — better-sqlite3 binds the DB file at
// module import time (const sqlite = new Database(... DISPATCHOS_DB_PATH ...)).
const DB_PATH = join(
  tmpdir(),
  `dispatchos-audit-purge-exemption-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.db`,
);
process.env.DISPATCHOS_DB_PATH = DB_PATH;
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

// A fixed timestamp far older than the default 180-day retain window. Using a
// literal date (not Date.now()-based) keeps the test fully deterministic.
const OLD_TS = "2000-01-01T00:00:00.000Z";

// Second connection to the same temp DB to control created_at. storage.audit()
// always stamps now(), so we write through the real path then age the rows.
// WAL mode (set by storage on its connection) lets this second connection see
// and amend the same rows.
const raw = new Database(DB_PATH);
raw.pragma("journal_mode = WAL");

// Tag every row this test creates with a unique entity_id so we can find/assert
// our own rows regardless of anything else in the DB.
const TAG = `purge-exempt-${rnd()}`;

// --- Write the AGED cohort via the real storage.audit() write path. ----------
// Financial (must be RETAINED past the window):
storage.audit("invoice.created", "invoice", `${TAG}:inv-created`, { tag: TAG, amount: 15000 });
storage.audit("invoice.payment_succeeded", "invoice", `${TAG}:inv-paid`, { tag: TAG });
storage.audit("billing.charged", "client", `${TAG}:bill-charged`, { tag: TAG });
// Non-financial PII rows (must be PURGED once aged past the window):
storage.audit("user.login", "user", `${TAG}:login`, { tag: TAG });
storage.audit("lead.subscribed", "lead", `${TAG}:lead`, { tag: TAG, email: "x@y.z" });
storage.audit("safety.profile_viewed", "broker", `${TAG}:safety`, { tag: TAG });

// --- Write a FRESH control cohort (NOT aged) to prove purge keys on AGE. ------
storage.audit("user.login", "user", `${TAG}:fresh-login`, { tag: TAG });
storage.audit("invoice.created", "invoice", `${TAG}:fresh-inv`, { tag: TAG });

// Age ONLY the aged-cohort rows: stamp their created_at far in the past. The
// fresh control rows keep their now() timestamp.
const agedEntityIds = [
  `${TAG}:inv-created`,
  `${TAG}:inv-paid`,
  `${TAG}:bill-charged`,
  `${TAG}:login`,
  `${TAG}:lead`,
  `${TAG}:safety`,
];
const ageStmt = raw.prepare("UPDATE audit_events SET created_at = ? WHERE entity_id = ?");
const ageTxn = raw.transaction(() => {
  for (const eid of agedEntityIds) ageStmt.run(OLD_TS, eid);
});
ageTxn();

// Sanity: confirm the aged rows really carry the old timestamp before purging,
// otherwise the test would be vacuous.
const agedCountBefore = (
  raw
    .prepare("SELECT COUNT(*) AS c FROM audit_events WHERE entity_id LIKE ? AND created_at = ?")
    .get(`${TAG}:%`, OLD_TS) as { c: number }
).c;
assert("setup: 6 of our rows are aged to the old timestamp", agedCountBefore === 6, String(agedCountBefore));

// Helper: read back which of OUR tagged rows still exist, by entity_id.
function survivingEntityIds(): Set<string> {
  const rows = raw
    .prepare("SELECT entity_id AS eid FROM audit_events WHERE entity_id LIKE ?")
    .all(`${TAG}:%`) as Array<{ eid: string }>;
  return new Set(rows.map((r) => r.eid));
}

// ---------------------------------------------------------------------------
// Run the purge with the default 180-day window. The aged cohort (year 2000)
// is far past the cutoff; the fresh cohort is well inside it.
// ---------------------------------------------------------------------------
const deleted = storage.purgeOldAuditEvents();

const survivors = survivingEntityIds();

// --- CORE GUARD: aged financial rows are RETAINED. -------------------------
// These three FAIL the moment the invoice.%/billing.% exemption is dropped.
assert(
  "RETAINED: aged invoice.created survives the purge",
  survivors.has(`${TAG}:inv-created`),
  "invoice.* must be exempt from retention purge",
);
assert(
  "RETAINED: aged invoice.payment_succeeded survives the purge",
  survivors.has(`${TAG}:inv-paid`),
  "invoice.* must be exempt from retention purge",
);
assert(
  "RETAINED: aged billing.charged survives the purge",
  survivors.has(`${TAG}:bill-charged`),
  "billing.* must be exempt from retention purge",
);

// --- The purge still WORKS: aged non-financial PII rows ARE deleted. --------
// If these survive, the purge isn't purging anything (exemption too broad / no
// cutoff), which would also be a regression.
assert(
  "PURGED: aged user.login is deleted",
  !survivors.has(`${TAG}:login`),
  "non-financial aged row must be purged",
);
assert(
  "PURGED: aged lead.subscribed is deleted",
  !survivors.has(`${TAG}:lead`),
  "non-financial aged row must be purged",
);
assert(
  "PURGED: aged safety.profile_viewed is deleted",
  !survivors.has(`${TAG}:safety`),
  "non-financial aged row must be purged",
);

// --- Purge keys on AGE, not type: fresh rows of BOTH kinds survive. ---------
assert(
  "RETAINED: fresh (in-window) user.login is untouched",
  survivors.has(`${TAG}:fresh-login`),
  "purge must not delete rows inside the retention window",
);
assert(
  "RETAINED: fresh (in-window) invoice.created is untouched",
  survivors.has(`${TAG}:fresh-inv`),
);

// --- Return value reflects ONLY the rows actually deleted. ------------------
// We aged exactly 3 non-financial rows; with no other aged rows in this fresh
// temp DB the purge must report exactly 3 deletions.
assert(
  "purge return count == 3 aged non-financial rows deleted",
  deleted === 3,
  `purgeOldAuditEvents returned ${deleted}`,
);

// --- Cross-check the count: of our tagged rows, exactly 5 must remain --------
// (3 aged financial + 2 fresh control), and the 3 aged PII rows are gone.
assert(
  "exactly 5 of our tagged rows remain (3 financial + 2 fresh)",
  survivors.size === 5,
  `survivors=${[...survivors].sort().join(",")}`,
);

raw.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
