// Cross-tenant load-visibility (IDOR) regression test (temp DB).
// Run: npx tsx server/lib/dispatcher-load-visibility.test.ts
//
// storage.loadIsVisibleToDispatcher(loadId, dispatcherUserId) is the crown-jewel
// tenant-isolation primitive that the broker-trust + dispatch route fixes sit on
// top of: a dispatcher may only ever touch loads belonging to a client they are
// actively assigned to. Its SQL is:
//
//   SELECT 1 FROM loads l
//     JOIN assignments a ON a.client_id = l.client_id
//    WHERE l.id = ? AND a.dispatcher_user_id = ? AND a.removed_at IS NULL
//    LIMIT 1
//
// This test locks that gate in so a refactor can't silently widen it. We set up
// ONE carrier, TWO tenant clients (A and B), ONE dispatcher assigned to client A
// ONLY, and a load under each client. The regression guards:
//
//   * loadIsVisibleToDispatcher(loadB, dispatcher) === false
//       — the core IDOR guard: another tenant's load must NOT be visible. If the
//         JOIN/WHERE were loosened (e.g. dropping the client_id match) this flips
//         to true and the assertion fails.
//   * loadIsVisibleToDispatcher(loadA, dispatcher) === true
//       — the positive control: an assigned client's load IS visible (so the gate
//         isn't just returning false for everything).
//   * loadIsVisibleToDispatcher("does-not-exist", dispatcher) === false
//       — an unknown/garbage loadId is denied, not defaulted-open.
//   * A soft-removed assignment (removed_at set) revokes visibility
//       — the `a.removed_at IS NULL` clause is load-bearing; deleting it would
//         let a de-assigned dispatcher keep seeing the load.
//
// No network. Deterministic: we control every id + timestamp through storage.

import { tmpdir } from "node:os";
import { join } from "node:path";

// better-sqlite3 binds the DB file at import time, so a unique path MUST be set
// BEFORE importing storage (same pattern as server/lib/stripe-charge.test.ts).
process.env.DISPATCHOS_DB_PATH = join(
  tmpdir(),
  `dispatchos-dispatcher-visibility-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.db`,
);
// Defensive: a valid 32-byte base64 keyring key in case any imported code reads
// it. storage.ts itself doesn't, but this keeps the test robust to future imports.
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

// A minimal-but-valid client payload (matches the stripe-charge test fixture).
const mkClient = (name: string) =>
  storage.upsertClient({
    name,
    mc: `MC-${Math.floor(Math.random() * 900000 + 100000)}`,
    equipment: "hotshot_flatbed",
    targetPpm: 2,
    minimumPpm: 1.8,
    mpg: 10,
    fuelPrice: 3.6,
    fixedCostPerMile: 0.35,
    preferredLanes: [],
    avoidStates: [],
    billingStatus: "active",
  } as any);

// upsertLoad mirrors `clientId` from the payload into the loads.client_id column,
// which is exactly the column loadIsVisibleToDispatcher JOINs on. clientId is not
// declared on the base InsertLoad type (it lives on the booking schema), so we
// cast through `any` — same as the upsertLoad implementation does internally.
const mkLoad = (clientId: string) =>
  storage.upsertLoad({
    source: "TEST",
    originCity: "Dallas",
    originState: "TX",
    originLat: 32.7767,
    originLng: -96.797,
    destinationCity: "Houston",
    destinationState: "TX",
    destinationLat: 29.7604,
    destinationLng: -95.3698,
    rate: 1000,
    loadedMiles: 240,
    pickupAt: "2026-06-01T12:00:00.000Z",
    deliveryAt: "2026-06-02T12:00:00.000Z",
    equipment: "hotshot_flatbed",
    brokerName: "Test Broker",
    brokerMc: `MC-${Math.floor(Math.random() * 900000 + 100000)}`,
    brokerScore: 70,
    fraudRisk: 15,
    marketQuality: 70,
    clientId,
  } as any);

// ---------------------------------------------------------------------------
// Setup: one carrier/admin actor, two tenant clients, one dispatcher assigned to
// client A only, one load per client.
// ---------------------------------------------------------------------------
const admin = storage.createUser({
  email: `admin-${rnd()}@example.com`,
  fullName: "Admin Actor",
  role: "admin",
  passwordSalt: "salt",
  passwordHash: "hash",
});

const dispatcher = storage.createUser({
  email: `dispatcher-${rnd()}@example.com`,
  fullName: "Dispatch User",
  role: "dispatcher",
  passwordSalt: "salt",
  passwordHash: "hash",
});

const clientA = mkClient("Tenant A Trucking");
const clientB = mkClient("Tenant B Trucking");

const loadA = mkLoad(clientA.id);
const loadB = mkLoad(clientB.id);

// Assign the dispatcher to client A ONLY (NOT client B).
const assignmentA = storage.createAssignment({
  clientId: clientA.id,
  dispatcherUserId: dispatcher.id,
  createdByUserId: admin.id,
});

// Sanity: the fixture is wired the way we think it is.
assert("setup: dispatcher != admin", dispatcher.id !== admin.id);
assert("setup: clientA != clientB", clientA.id !== clientB.id);
assert("setup: loadA != loadB", loadA.id !== loadB.id);
assert(
  "setup: assignment is active (not removed)",
  storage.findActiveAssignment(clientA.id, dispatcher.id)?.id === assignmentA.id,
);
assert(
  "setup: dispatcher has NO assignment to clientB",
  storage.findActiveAssignment(clientB.id, dispatcher.id) === undefined,
);

// ---------------------------------------------------------------------------
// CORE IDOR GUARD: another tenant's load must NOT be visible.
// Regression intent: if the cross-tenant gate (the client_id JOIN) is removed,
// this returns true and the test FAILS.
// ---------------------------------------------------------------------------
assert(
  "IDOR: loadB (other tenant) NOT visible to dispatcher",
  storage.loadIsVisibleToDispatcher(loadB.id, dispatcher.id) === false,
  String(storage.loadIsVisibleToDispatcher(loadB.id, dispatcher.id)),
);

// ---------------------------------------------------------------------------
// Positive control: the assigned client's load IS visible. Without this, a gate
// that simply returns false for everything would also pass the IDOR check —
// this proves the primitive actually grants access when it should.
// ---------------------------------------------------------------------------
assert(
  "positive: loadA (assigned tenant) IS visible to dispatcher",
  storage.loadIsVisibleToDispatcher(loadA.id, dispatcher.id) === true,
  String(storage.loadIsVisibleToDispatcher(loadA.id, dispatcher.id)),
);

// ---------------------------------------------------------------------------
// Unknown/garbage loadId is denied (deny-by-default, never default-open).
// ---------------------------------------------------------------------------
assert(
  "garbage: unknown loadId NOT visible",
  storage.loadIsVisibleToDispatcher(`load_does_not_exist_${rnd()}`, dispatcher.id) === false,
);
assert(
  "garbage: empty loadId NOT visible",
  storage.loadIsVisibleToDispatcher("", dispatcher.id) === false,
);

// A dispatcher id that owns no assignments at all sees nothing — even loadA.
const strangerDispatcher = storage.createUser({
  email: `stranger-${rnd()}@example.com`,
  fullName: "Unassigned Dispatcher",
  role: "dispatcher",
  passwordSalt: "salt",
  passwordHash: "hash",
});
assert(
  "no-assignments: unassigned dispatcher sees neither load",
  storage.loadIsVisibleToDispatcher(loadA.id, strangerDispatcher.id) === false &&
    storage.loadIsVisibleToDispatcher(loadB.id, strangerDispatcher.id) === false,
);

// ---------------------------------------------------------------------------
// Soft-removed assignment revokes visibility (the `removed_at IS NULL` clause).
// Regression intent: dropping that clause would let a de-assigned dispatcher keep
// seeing the load; this asserts visibility flips true -> false on removal.
// ---------------------------------------------------------------------------
{
  // Fresh client + dispatcher + load so we don't disturb the assertions above.
  const clientC = mkClient("Tenant C Trucking");
  const loadC = mkLoad(clientC.id);
  const disp2 = storage.createUser({
    email: `disp2-${rnd()}@example.com`,
    fullName: "Dispatch Two",
    role: "dispatcher",
    passwordSalt: "salt",
    passwordHash: "hash",
  });
  const asn = storage.createAssignment({
    clientId: clientC.id,
    dispatcherUserId: disp2.id,
    createdByUserId: admin.id,
  });
  assert(
    "revoke: visible while assignment active",
    storage.loadIsVisibleToDispatcher(loadC.id, disp2.id) === true,
  );
  storage.removeAssignmentById(asn.id, admin.id);
  assert(
    "revoke: NOT visible after assignment soft-removed",
    storage.loadIsVisibleToDispatcher(loadC.id, disp2.id) === false,
    String(storage.loadIsVisibleToDispatcher(loadC.id, disp2.id)),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
