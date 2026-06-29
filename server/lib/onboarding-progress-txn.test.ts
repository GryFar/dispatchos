// Onboarding progress upsert/merge regression test (temp DB).
// Run: npx tsx server/lib/onboarding-progress-txn.test.ts
//
// Locks in the #210 storage fix in server/storage.ts:
//
//   upsertOnboardingProgress wraps its read-modify-write in
//   sqlite.transaction(...) AND merges the `data` blob shallowly
//   ({ ...existing.data, ...patch.data }) so that a caller sending only a
//   PARTIAL set of answers for one step does NOT clobber keys set by an
//   earlier step. Likewise `step` falls back to the stored value when the
//   patch omits it, `started_at` is preserved across updates, and
//   `completed_at` is only stamped when patch.completed is set.
//
// The merge is the observable divergence: if upsert were reverted to a
// naive overwrite (store patch.data as-is, or replace the whole row), the
// second upsert below would DROP the first call's keys and these assertions
// would FAIL. Atomicity itself isn't directly observable from sequential
// storage calls, so we lock the merge/persist contract the txn exists to
// protect, plus the round-trip through getOnboardingProgress.

import { tmpdir } from "node:os";
import { join } from "node:path";

// Unique DB + valid 32-byte keyring BEFORE importing storage (storage.ts opens
// the sqlite Database at module-import time keyed on DISPATCHOS_DB_PATH).
process.env.DISPATCHOS_DB_PATH = join(
  tmpdir(),
  `dispatchos-onboarding-txn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.db`,
);
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
const uid = () => `user-${Math.random().toString(36).slice(2, 10)}`;

// ---------------------------------------------------------------------------
// 0) Unknown user -> null (getter contract; also a sanity baseline).
// ---------------------------------------------------------------------------
{
  const u = uid();
  assert("unknown user reads null", storage.getOnboardingProgress(u) === null);
}

// ---------------------------------------------------------------------------
// 1) Initial upsert persists step + data and is readable via the getter.
// ---------------------------------------------------------------------------
{
  const u = uid();
  storage.upsertOnboardingProgress(u, { step: 1, data: { name: "Acme", mc: "MC-123456" } });
  const row = storage.getOnboardingProgress(u);
  assert("initial: row exists", row !== null);
  assert("initial: userId round-trips", row?.userId === u, row?.userId);
  assert("initial: step persisted", row?.step === 1, String(row?.step));
  assert("initial: data.name persisted", row?.data.name === "Acme");
  assert("initial: data.mc persisted", row?.data.mc === "MC-123456");
  assert("initial: not completed yet", row?.completedAt === null, String(row?.completedAt));
  assert("initial: startedAt stamped", typeof row?.startedAt === "string");
  assert("initial: updatedAt stamped", typeof row?.updatedAt === "string");
}

// ---------------------------------------------------------------------------
// 2) THE FIX: a second PARTIAL upsert merges into `data` without dropping the
//    keys the first call set. A naive overwrite would lose name/mc here.
// ---------------------------------------------------------------------------
{
  const u = uid();
  storage.upsertOnboardingProgress(u, { step: 1, data: { name: "Acme", mc: "MC-999" } });
  // Second step sends ONLY equipment — must not erase name/mc from step 1.
  storage.upsertOnboardingProgress(u, { step: 2, data: { equipment: "flatbed" } });
  const row = storage.getOnboardingProgress(u);
  assert("merge: step advanced to 2", row?.step === 2, String(row?.step));
  assert("merge: new key (equipment) present", row?.data.equipment === "flatbed");
  // The load-bearing guard — these would be undefined if the merge were removed.
  assert("merge: prior key name NOT dropped", row?.data.name === "Acme", JSON.stringify(row?.data));
  assert("merge: prior key mc NOT dropped", row?.data.mc === "MC-999", JSON.stringify(row?.data));
}

// ---------------------------------------------------------------------------
// 3) Overlapping key on merge -> newer value wins (shallow override), other
//    keys untouched. Confirms it's a MERGE, not a no-op union.
// ---------------------------------------------------------------------------
{
  const u = uid();
  storage.upsertOnboardingProgress(u, { step: 1, data: { name: "Old", trucks: 3 } });
  storage.upsertOnboardingProgress(u, { step: 1, data: { name: "New" } });
  const row = storage.getOnboardingProgress(u);
  assert("override: overlapping key takes newer value", row?.data.name === "New", String(row?.data.name));
  assert("override: untouched key survives", row?.data.trucks === 3, String(row?.data.trucks));
}

// ---------------------------------------------------------------------------
// 4) Omitted `step` falls back to the stored step (doesn't reset to 0).
// ---------------------------------------------------------------------------
{
  const u = uid();
  storage.upsertOnboardingProgress(u, { step: 5, data: { a: 1 } });
  storage.upsertOnboardingProgress(u, { data: { b: 2 } }); // no step in patch
  const row = storage.getOnboardingProgress(u);
  assert("step fallback: keeps stored step 5", row?.step === 5, String(row?.step));
  assert("step fallback: data still merged", row?.data.a === 1 && row?.data.b === 2);
}

// ---------------------------------------------------------------------------
// 5) startedAt is preserved across updates; completedAt only stamps when
//    patch.completed is set, and survives subsequent non-completing upserts.
// ---------------------------------------------------------------------------
{
  const u = uid();
  storage.upsertOnboardingProgress(u, { step: 1, data: { x: 1 } });
  const first = storage.getOnboardingProgress(u)!;
  const startedAt0 = first.startedAt;

  storage.upsertOnboardingProgress(u, { step: 2, data: { y: 2 } });
  const second = storage.getOnboardingProgress(u)!;
  assert("startedAt preserved across update", second.startedAt === startedAt0, second.startedAt);
  assert("still not completed", second.completedAt === null);

  storage.upsertOnboardingProgress(u, { completed: true });
  const done = storage.getOnboardingProgress(u)!;
  assert("completedAt stamped on completed=true", typeof done.completedAt === "string", String(done.completedAt));
  assert("completion preserves merged data", done.data.x === 1 && done.data.y === 2);
  assert("completion preserves startedAt", done.startedAt === startedAt0);
  const stampedAt = done.completedAt;

  // A later non-completing upsert must NOT clear the existing completedAt.
  storage.upsertOnboardingProgress(u, { data: { z: 3 } });
  const after = storage.getOnboardingProgress(u)!;
  assert("completedAt survives later upsert", after.completedAt === stampedAt, String(after.completedAt));
}

// ---------------------------------------------------------------------------
// 6) Positive control: an INDEPENDENT user is unaffected by all the above —
//    rules out a trivially-always-true test that ignores the userId key.
// ---------------------------------------------------------------------------
{
  const a = uid();
  const b = uid();
  storage.upsertOnboardingProgress(a, { step: 7, data: { who: "a" } });
  storage.upsertOnboardingProgress(b, { step: 1, data: { who: "b" } });
  const rowA = storage.getOnboardingProgress(a);
  const rowB = storage.getOnboardingProgress(b);
  assert("isolation: A keeps own data", rowA?.data.who === "a" && rowA?.step === 7);
  assert("isolation: B keeps own data", rowB?.data.who === "b" && rowB?.step === 1);
  assert("isolation: A and B are distinct rows", rowA?.userId !== rowB?.userId);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
