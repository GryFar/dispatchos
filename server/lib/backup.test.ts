// DB snapshot integration test (temp DB, no network).
// Run: npx tsx server/lib/backup.test.ts
//
// createDbSnapshot() takes a CONSISTENT online copy of the live better-sqlite3
// file. We seed a known row through storage, snapshot, then assert the snapshot
// is a REAL, openable SQLite db (open read-only and read the row back), that the
// returned sha256/bytes match the file on disk, and that rolling retention
// prunes to DISPATCHOS_BACKUP_KEEP.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const rnd = () => Math.random().toString(36).slice(2, 10);
const suffix = rnd();
const dataRoot = join(tmpdir(), `dispatchos-backup-test-${suffix}`);
process.env.DISPATCHOS_DATA_ROOT = dataRoot;
process.env.DISPATCHOS_DB_PATH = join(dataRoot, "dispatchos-unified.db");
process.env.DISPATCHOS_BACKUP_KEEP = "2";
fs.mkdirSync(dataRoot, { recursive: true });

const { storage } = await import("../storage");
const { createDbSnapshot, backupsRoot } = await import("./backup");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Seed a known row we can read back out of the snapshot. A client is a simple,
// always-present table with a primary key we control.
const clientId = `backup-${suffix}`;
const clientName = `Backup Carrier ${suffix}`;
storage.upsertClient({
  id: clientId,
  name: clientName,
  mc: `MC-${Math.floor(100000 + Math.random() * 800000)}`,
  equipment: "hotshot_flatbed",
  targetPpm: 2.2,
  minimumPpm: 1.9,
  mpg: 10,
  fuelPrice: 3.6,
  fixedCostPerMile: 0.35,
  preferredLanes: [],
  avoidStates: [],
} as Parameters<typeof storage.upsertClient>[0]);

const snap = await createDbSnapshot();

assert("snapshot file exists", fs.existsSync(snap.path), snap.path);
assert("snapshot lives under backupsRoot", path.dirname(snap.path) === backupsRoot);
assert("snapshot filename matches convention", /^dispatchos-\d{8}-\d{6}\.db$/.test(path.basename(snap.path)));

// Returned bytes / sha256 match the file on disk.
const onDisk = fs.readFileSync(snap.path);
const diskSha = crypto.createHash("sha256").update(onDisk).digest("hex");
assert("returned bytes match file size", snap.bytes === onDisk.length, `${snap.bytes} vs ${onDisk.length}`);
assert("returned sha256 matches file", snap.sha256 === diskSha, `${snap.sha256} vs ${diskSha}`);
assert("bytes is non-trivial (real db)", snap.bytes > 0);

// Snapshot is a VALID SQLite db: open it READ-ONLY and read the known row back.
{
  const ro = new Database(snap.path, { readonly: true });
  try {
    // clients store their fields as JSON in a `payload` column.
    const row = ro.prepare("SELECT payload FROM clients WHERE id = ?").get(clientId) as
      | { payload: string }
      | undefined;
    assert("snapshot is a valid, openable SQLite db", true);
    const name = row ? (JSON.parse(row.payload) as { name?: string }).name : undefined;
    assert("known row survived into the snapshot", name === clientName, JSON.stringify(row));
  } finally {
    ro.close();
  }
}

// Retention: take enough snapshots to exceed KEEP (=2) and confirm pruning.
// Timestamps are second-granular; force distinct filenames by clearing the dir
// and writing synthetic snapshots alongside a fresh real one would be brittle,
// so instead we create extra real snapshots with a tiny delay to advance the
// second, then assert the count is clamped.
async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}
for (let i = 0; i < 3; i++) {
  await sleep(1100); // advance the YYYYMMDD-HHMMSS timestamp by >=1s
  await createDbSnapshot();
}
const remaining = fs
  .readdirSync(backupsRoot)
  .filter((f) => /^dispatchos-\d{8}-\d{6}\.db$/.test(f));
assert(
  "retention prunes to DISPATCHOS_BACKUP_KEEP",
  remaining.length === 2,
  `kept ${remaining.length}: ${remaining.join(", ")}`,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
