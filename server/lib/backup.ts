// Restore-grade DB snapshots (audit H5 — single SQLite file, volume loss =
// total data loss; the JSON export omits the real DB).
//
// createDbSnapshot() writes a CONSISTENT online copy of the live better-sqlite3
// file under ${dataRoot}/backups/ using SQLite's online-backup API (via
// storage.backupDatabaseTo), so the running app is never locked and the event
// loop is never blocked for the copy. The result is a real, openable .db — not
// a logical export — so it can be dropped in place to restore.
//
// The offsite copy is produced by streaming this snapshot out of
// /api/cron/backup into a GitHub Actions artifact (see backup-cron.yml). No S3
// credentials are required; an S3/R2 target is a future owner option, not a
// dependency.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dispatchosDataRoot, backupDatabaseTo } from "../storage";

export const backupsRoot = path.join(dispatchosDataRoot, "backups");

// How many local snapshots to keep. Older ones are pruned each run. The offsite
// GitHub-artifact copies have their own (90-day) retention, independent of this.
function retentionCount(): number {
  const raw = Number(process.env.DISPATCHOS_BACKUP_KEEP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 14;
}

// YYYYMMDD-HHMMSS in UTC, filesystem-safe (no colons).
function timestamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

function sha256OfFile(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

// Drop all but the most recent N snapshots. Best-effort: a failed unlink is
// logged and swallowed so pruning never fails an otherwise-good backup.
function pruneOldSnapshots(keep: number): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(backupsRoot);
  } catch {
    return;
  }
  const snapshots = entries
    .filter((f) => /^dispatchos-\d{8}-\d{6}\.db$/.test(f))
    .sort(); // lexicographic == chronological for this naming
  const stale = snapshots.slice(0, Math.max(0, snapshots.length - keep));
  for (const name of stale) {
    try {
      fs.unlinkSync(path.join(backupsRoot, name));
    } catch (err) {
      console.error(`[backup] failed to prune ${name}:`, (err as Error).message);
    }
  }
}

/**
 * Take a consistent online snapshot of the live DB and return its path, byte
 * size, and sha256. Applies rolling retention (DISPATCHOS_BACKUP_KEEP, default
 * 14) after a successful write. Never throws a raw better-sqlite3 error — wraps
 * failures in a clear message — and cleans up a partial file on failure.
 */
export async function createDbSnapshot(): Promise<{ path: string; bytes: number; sha256: string }> {
  fs.mkdirSync(backupsRoot, { recursive: true });
  const destPath = path.join(backupsRoot, `dispatchos-${timestamp()}.db`);

  let ok = false;
  try {
    await backupDatabaseTo(destPath);
    const bytes = fs.statSync(destPath).size;
    const sha256 = sha256OfFile(destPath);
    ok = true;
    pruneOldSnapshots(retentionCount());
    return { path: destPath, bytes, sha256 };
  } catch (err) {
    throw new Error(`Database snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Clean up a partial/failed snapshot so it can't masquerade as a good one
    // (and so it isn't streamed out by the endpoint).
    if (!ok) {
      try {
        fs.unlinkSync(destPath);
      } catch {
        /* nothing to clean up */
      }
    }
  }
}
