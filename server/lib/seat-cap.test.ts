// Atomic seat-cap create test (temp DB).
// Run: npx tsx server/lib/seat-cap.test.ts
//
// The route-level driver seat gate (POST /api/admin/users, /api/admin/invites,
// lead approval) was check-then-create: canAddDriver() on a fresh count, then a
// separate insert. Single-process SQLite makes the race inert today, but the
// invariant belongs in storage — createUserIfSeatAvailable /
// createInviteIfSeatAvailable re-count and insert inside ONE transaction and
// throw Error code='SEAT_CAP_EXCEEDED' on overflow WITHOUT inserting anything.

import { tmpdir } from "node:os";
import { join } from "node:path";

// Unique temp DB BEFORE importing storage (better-sqlite3 binds the file at
// import time) — mirrors broker-email.test.ts.
process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-seat-cap-${Date.now()}-${process.pid}.db`);

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

// The helpers count seats by linked_client_id only, so a synthetic client id is
// enough — no plan/provisioning machinery needed (the ROUTE derives maxSeats
// from the plan; here we exercise the storage contract directly).
const clientId = `cli_${rnd()}`;
const cap2 = { clientId, maxSeats: 2 };

function driverInput(tag: string) {
  return {
    email: `${tag}-${rnd()}@example.com`,
    fullName: `Driver ${tag}`,
    role: "driver" as const,
    passwordSalt: "s",
    passwordHash: "h",
    linkedClientId: clientId,
  };
}

// --- Under cap: creates succeed ----------------------------------------------
const d1 = storage.createUserIfSeatAvailable(driverInput("d1"), cap2);
assert("under-cap user create succeeds", Boolean(d1?.id));
assert("seat count after first create = 1", storage.countDriverSeats(clientId) === 1);

const inviteCode = `DOS-${rnd()}-${rnd()}`.toUpperCase();
const inv = storage.createInviteIfSeatAvailable(
  { code: inviteCode, role: "driver", linkedClientId: clientId, ttlHours: 72, createdByUserId: d1.id },
  cap2,
);
assert("under-cap invite create succeeds (fills the cap)", inv.code === inviteCode);
assert("pending invite counts as a seat → 2", storage.countDriverSeats(clientId) === 2);

// --- At cap: create throws SEAT_CAP_EXCEEDED and inserts NOTHING --------------
{
  const input = driverInput("overflow");
  let err: (Error & { code?: string }) | undefined;
  try {
    storage.createUserIfSeatAvailable(input, cap2);
  } catch (e) {
    err = e as Error & { code?: string };
  }
  assert("at-cap user create throws", Boolean(err));
  assert("thrown error carries code=SEAT_CAP_EXCEEDED", err?.code === "SEAT_CAP_EXCEEDED");
  assert("overflow user NOT inserted", storage.getUserByEmail(input.email) === undefined);
  assert("seat count unchanged after rejected create", storage.countDriverSeats(clientId) === 2);
}
{
  const code = `DOS-${rnd()}-${rnd()}`.toUpperCase();
  let err: (Error & { code?: string }) | undefined;
  try {
    storage.createInviteIfSeatAvailable(
      { code, role: "driver", linkedClientId: clientId, ttlHours: 72, createdByUserId: d1.id },
      cap2,
    );
  } catch (e) {
    err = e as Error & { code?: string };
  }
  assert("at-cap invite create throws SEAT_CAP_EXCEEDED", err?.code === "SEAT_CAP_EXCEEDED");
  assert("overflow invite NOT inserted", storage.getInvite(code) === undefined);
  assert("seat count unchanged after rejected invite", storage.countDriverSeats(clientId) === 2);
}

// --- maxSeats=Infinity = uncapped (plan sells overage seats) ------------------
const d3 = storage.createUserIfSeatAvailable(driverInput("d3"), { clientId, maxSeats: Infinity });
assert("Infinity cap never blocks", Boolean(d3?.id));
assert("uncapped create raises the count → 3", storage.countDriverSeats(clientId) === 3);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
