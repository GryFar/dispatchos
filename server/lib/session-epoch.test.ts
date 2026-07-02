// Session-epoch invalidation test (temp DB).
// Run: npx tsx server/lib/session-epoch.test.ts
//
// An admin password/TOTP reset bumps users.session_epoch. getCurrentUser must
// then reject any session whose stamped epoch is stale, while a fresh login
// (new epoch) keeps working. Legacy sessions with no epoch read as 0 and must
// still authenticate until the first bump.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const rnd = () => Math.random().toString(36).slice(2, 10);
const DB = join(tmpdir(), `dispatchos-epoch-${Date.now()}-${rnd()}.db`);
process.env.DISPATCHOS_DB_PATH = DB;
const { storage } = await import("../storage");
const { getCurrentUser } = await import("../auth");

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

const u = storage.createUser({
  email: `epoch-${rnd()}@x.com`,
  fullName: "Epoch",
  role: "admin",
  passwordSalt: "s",
  passwordHash: "h",
});

// Minimal Request mock — getCurrentUser only touches session.{userId,epoch,destroy}.
const mkReq = (epoch: number | undefined) =>
  ({ session: { userId: u.id, epoch, destroy: (cb?: () => void) => cb && cb() } }) as any;

assert("fresh session (epoch 0) authenticates", getCurrentUser(mkReq(0))?.id === u.id);
assert("legacy session (epoch undefined) authenticates", getCurrentUser(mkReq(undefined))?.id === u.id);

const newEpoch = storage.bumpUserSessionEpoch(u.id);
assert("bump returns 1", newEpoch === 1, `got ${newEpoch}`);

assert("stale session (epoch 0) rejected after reset", getCurrentUser(mkReq(0)) === undefined);
assert("stale legacy session (undefined→0) rejected after reset", getCurrentUser(mkReq(undefined)) === undefined);
assert("re-login session (new epoch) authenticates", getCurrentUser(mkReq(newEpoch))?.id === u.id);

console.log(`\n${pass} passed, ${fail} failed`);
try {
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });
} catch {
  /* best-effort */
}
process.exit(fail > 0 ? 1 : 0);
