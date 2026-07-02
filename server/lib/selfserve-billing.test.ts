// Self-serve billing gate + checkout email resolution (temp DB, no network).
// Run: npx tsx server/lib/selfserve-billing.test.ts
//
// Self-serve customers sign up as role 'driver'; only the carrier OWNER
// (client.ownerUserId === user.id via user.linkedClientId) may reach billing
// status/checkout/portal. The route handlers gate through the exported pure
// helpers tested here:
//   - resolveOwnedClientId    — owner gate (null → handler responds 403)
//   - resolveClientIdForUser  — admin/dispatcher/driver tenancy resolution
//     (dispatcher /status keeps its assignment-scoped read access)
//   - resolveCheckoutCustomerEmail — Stripe customerEmail must be the CLIENT
//     OWNER's email, falling back to the caller only when no owner resolves.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), "dispatchos-selfserve-billing-test.db");

const { storage } = await import("../storage");
const { resolveOwnedClientId, resolveClientIdForUser, resolveCheckoutCustomerEmail } =
  await import("../routes/billing");

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
const rnd = () => Math.random().toString(36).slice(2, 10);
const sfx = rnd();

function mkClient(id: string, extra: Record<string, unknown>): string {
  storage.upsertClient({
    id,
    name: `Carrier ${id}`,
    mc: `MC-${Math.floor(100000 + Math.random() * 800000)}`,
    equipment: "hotshot_flatbed",
    targetPpm: 2.2,
    minimumPpm: 1.9,
    mpg: 10,
    fuelPrice: 3.6,
    fixedCostPerMile: 0.35,
    preferredLanes: [],
    avoidStates: [],
    ...extra,
  } as Parameters<typeof storage.upsertClient>[0]);
  return id;
}

function mkUser(input: {
  email: string;
  role: "admin" | "dispatcher" | "driver";
  linkedClientId?: string;
}) {
  return storage.createUser({
    email: input.email,
    fullName: `User ${input.email}`,
    role: input.role,
    passwordSalt: "salt",
    passwordHash: "hash",
    linkedClientId: input.linkedClientId,
  });
}

// --- fixtures ---------------------------------------------------------------
// Owner user id isn't known before createUser, so create user first (unlinked),
// then the client with ownerUserId, then link the user to it.
const owner = mkUser({ email: `owner-${sfx}@test.dev`, role: "driver" });
const clientId = mkClient(`bill-c1-${sfx}`, {
  persona: "owner_operator",
  ownerUserId: owner.id,
  billingStatus: "trial",
});
storage.updateUser(owner.id, { linkedClientId: clientId }, owner.id);
const ownerLinked = storage.getUserById(owner.id)!;

const hiredDriver = mkUser({
  email: `hired-${sfx}@test.dev`,
  role: "driver",
  linkedClientId: clientId,
});
const unlinkedDriver = mkUser({ email: `unlinked-${sfx}@test.dev`, role: "driver" });

const otherClientId = mkClient(`bill-c2-${sfx}`, {
  ownerUserId: "someone-else",
});

const admin = mkUser({ email: `admin-${sfx}@test.dev`, role: "admin" });
const dispatcher = mkUser({ email: `disp-${sfx}@test.dev`, role: "dispatcher" });

// --- resolveOwnedClientId (owner gate; null → 403 in the handlers) -----------
assert(
  "owner passes the gate (no explicit clientId)",
  resolveOwnedClientId(ownerLinked, null) === clientId,
);
assert(
  "owner passes with matching explicit clientId",
  resolveOwnedClientId(ownerLinked, clientId) === clientId,
);
assert(
  "owner rejected for ANOTHER carrier's clientId",
  resolveOwnedClientId(ownerLinked, otherClientId) === null,
);
assert(
  "hired (non-owner) driver rejected",
  resolveOwnedClientId(hiredDriver, null) === null,
);
assert(
  "unlinked driver rejected",
  resolveOwnedClientId(unlinkedDriver, null) === null,
);

// Archived carrier must not reach billing even for its owner.
storage.softDeleteClient(clientId, admin.id);
assert(
  "owner of an ARCHIVED carrier rejected",
  resolveOwnedClientId(ownerLinked, null) === null,
);
storage.restoreClient(clientId, admin.id);
assert(
  "owner passes again after restore",
  resolveOwnedClientId(ownerLinked, null) === clientId,
);

// --- resolveClientIdForUser (status resolution for admin/dispatcher) ---------
// Assignment created AFTER the archive/restore block above — softDeleteClient
// cascades assignment removal, and restore does not resurrect them.
storage.createAssignment({
  clientId,
  dispatcherUserId: dispatcher.id,
  createdByUserId: admin.id,
});
assert(
  "dispatcher resolves an ASSIGNED clientId (/status read access kept)",
  resolveClientIdForUser(dispatcher, clientId) === clientId,
);
assert(
  "dispatcher rejected for an UNASSIGNED clientId",
  resolveClientIdForUser(dispatcher, otherClientId) === null,
);
assert(
  "dispatcher without ?clientId gets no context",
  resolveClientIdForUser(dispatcher, null) === null,
);
assert(
  "admin explicit ?clientId passes through",
  resolveClientIdForUser(admin, otherClientId) === otherClientId,
);
assert(
  "driver resolution stays linkedClientId (plan route unchanged)",
  resolveClientIdForUser(ownerLinked, null) === clientId,
);

// --- resolveCheckoutCustomerEmail ---------------------------------------------
assert(
  "checkout email picks the CLIENT OWNER's email, not the caller's",
  resolveCheckoutCustomerEmail(clientId, admin.email) === ownerLinked.email,
);
assert(
  "falls back to caller email when owner user doesn't resolve",
  resolveCheckoutCustomerEmail(otherClientId, admin.email) === admin.email,
);
const noOwnerClient = mkClient(`bill-c3-${sfx}`, {});
assert(
  "falls back to caller email when client has no ownerUserId",
  resolveCheckoutCustomerEmail(noOwnerClient, "caller@test.dev") === "caller@test.dev",
);
assert(
  "unknown client falls back to caller email",
  resolveCheckoutCustomerEmail("missing-client-id", "caller@test.dev") ===
    "caller@test.dev",
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
