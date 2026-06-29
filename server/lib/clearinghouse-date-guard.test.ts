// FMCSA Clearinghouse date-guard regression test (#210) — temp DB.
// Run: npx tsx server/lib/clearinghouse-date-guard.test.ts
//
// storage.recordClearinghouseQuery() logs a 49 CFR Part 382 Drug & Alcohol
// Clearinghouse query (pre_employment / annual). The #210 storage guard
// (server/storage.ts) parses input.queriedAt into a Date and REJECTS an
// unparseable / empty value:
//
//     const queriedAt = new Date(input.queriedAt);
//     if (Number.isNaN(queriedAt.getTime())) {
//       throw new Error(`recordClearinghouseQuery: invalid queriedAt "..."`);
//     }
//
// Why the guard matters (the divergence it locks in):
//   * annual branch: validUntil is computed as new Date(queriedAt) +1yr then
//     v.toISOString(). On a NaN date toISOString() throws RangeError mid-INSERT
//     — a crash. The guard throws a CLEAN, named error BEFORE any DB write.
//   * pre_employment branch: validUntil is the constant 9999 sentinel, so a NaN
//     date would NOT crash — it would SILENTLY persist a garbage queried_at
//     ("Invalid Date" / empty string) as a "valid" compliance record. The guard
//     stops that false-valid row from ever being written.
//
// Each assertion below would FAIL if the guard were removed:
//   - a valid date persists exactly one row (positive control, not always-true);
//   - empty / whitespace / unparseable queriedAt throws and writes NOTHING,
//     for BOTH the annual (crash) and pre_employment (silent-garbage) branches.

import { tmpdir } from "node:os";
import { join } from "node:path";

// Unique DB + valid 32-byte base64 keyring BEFORE importing storage — the
// module opens the DB at import time from DISPATCHOS_DB_PATH.
process.env.DISPATCHOS_DB_PATH = join(
  tmpdir(),
  `dispatchos-chq-dateguard-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.db`,
);
process.env.DISPATCHOS_KEYRING_PRIMARY ||= Buffer.alloc(32, 7).toString("base64");

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

// Runs fn, returns the thrown Error (or null if it didn't throw).
function caught(fn: () => unknown): Error | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e as Error;
  }
}

// ---------------------------------------------------------------------------
// 0) POSITIVE CONTROL — a valid ISO date is accepted and persists exactly one
//    row. Proves the function works (so the rejection tests aren't trivially
//    "throws on everything") and that the guard isn't over-broad.
// ---------------------------------------------------------------------------
{
  const userId = `drv_ctrl_${rnd()}`;
  const res = storage.recordClearinghouseQuery({
    userId,
    clientId: null,
    queryType: "annual",
    queriedAt: "2026-06-01T00:00:00.000Z",
    result: "clear",
    notes: "control",
    recordedByUserId: `adm_${rnd()}`,
  });
  assert("control: returns an id", typeof res.id === "string" && res.id.length > 0);
  const rows = storage.listClearinghouseQueriesForDriver(userId);
  assert("control: exactly one row persisted", rows.length === 1, String(rows.length));
  assert(
    "control: stored queried_at is the supplied valid date",
    rows[0]?.queried_at === "2026-06-01T00:00:00.000Z",
    String(rows[0]?.queried_at),
  );
  // annual branch computed validUntil = queriedAt + 12 months (no crash).
  assert(
    "control: annual valid_until is +1 year",
    rows[0]?.valid_until === "2027-06-01T00:00:00.000Z",
    String(rows[0]?.valid_until),
  );
}

// ---------------------------------------------------------------------------
// 1) GUARD, annual branch (the crash path): an unparseable queriedAt must
//    throw the named guard error — NOT a raw RangeError from toISOString — and
//    must write no row. Without the guard this throws RangeError mid-INSERT.
// ---------------------------------------------------------------------------
{
  const userId = `drv_bad_annual_${rnd()}`;
  const err = caught(() =>
    storage.recordClearinghouseQuery({
      userId,
      clientId: null,
      queryType: "annual",
      queriedAt: "not-a-real-date",
      result: "clear",
      recordedByUserId: `adm_${rnd()}`,
    }),
  );
  assert("annual/unparseable: threw", err !== null);
  assert(
    "annual/unparseable: it's the named guard error (not a raw RangeError)",
    !!err && err.message.includes("recordClearinghouseQuery: invalid queriedAt"),
    err?.message,
  );
  const rows = storage.listClearinghouseQueriesForDriver(userId);
  assert("annual/unparseable: nothing persisted (no false row)", rows.length === 0, String(rows.length));
}

// ---------------------------------------------------------------------------
// 2) GUARD, pre_employment branch (the silent-garbage path): pre_employment
//    uses a constant sentinel validUntil, so a bad date would NOT crash — it
//    would silently persist a garbage queried_at as an indefinitely-valid
//    compliance record. The guard must still reject it and write nothing.
// ---------------------------------------------------------------------------
{
  const userId = `drv_bad_pre_${rnd()}`;
  const err = caught(() =>
    storage.recordClearinghouseQuery({
      userId,
      clientId: null,
      queryType: "pre_employment",
      queriedAt: "2026-13-99", // structurally ISO-ish but not a real date
      result: "clear",
      recordedByUserId: `adm_${rnd()}`,
    }),
  );
  assert("pre_employment/unparseable: threw (not silently stored)", err !== null);
  assert(
    "pre_employment/unparseable: named guard error",
    !!err && err.message.includes("invalid queriedAt"),
    err?.message,
  );
  const rows = storage.listClearinghouseQueriesForDriver(userId);
  assert(
    "pre_employment/unparseable: no false-valid 9999 row persisted",
    rows.length === 0,
    String(rows.length),
  );
}

// ---------------------------------------------------------------------------
// 3) GUARD, empty / whitespace queriedAt — new Date("") and new Date("   ")
//    are both Invalid Date. Must be rejected and persist nothing.
// ---------------------------------------------------------------------------
for (const bad of ["", "   "]) {
  const userId = `drv_empty_${rnd()}`;
  const err = caught(() =>
    storage.recordClearinghouseQuery({
      userId,
      clientId: null,
      queryType: "annual",
      queriedAt: bad,
      result: "clear",
      recordedByUserId: `adm_${rnd()}`,
    }),
  );
  const label = bad === "" ? "empty-string" : "whitespace";
  assert(`${label}: threw`, err !== null);
  assert(
    `${label}: named guard error`,
    !!err && err.message.includes("invalid queriedAt"),
    err?.message,
  );
  const rows = storage.listClearinghouseQueriesForDriver(userId);
  assert(`${label}: nothing persisted`, rows.length === 0, String(rows.length));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
