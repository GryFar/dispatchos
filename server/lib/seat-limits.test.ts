// Seat-limit enforcement test (temp DB).
// Run: npx tsx server/lib/seat-limits.test.ts
//
// P1 (revenue leak): driver seats were never enforced — `canAddDriver` was dead
// code and `driverSeatCount` was always 0, so a $19 owner-operator (oo_basic,
// 1 included seat, no paid overage) could add unlimited drivers. This verifies
// (a) storage.countDriverSeats derives seats live from active drivers + pending
// driver invites, and (b) canAddDriver gates correctly off that count.
//
// NOTE: provisionCarrierFromOnboarding links the onboarding user (role=driver)
// to the carrier, so a freshly-provisioned oo_basic carrier already occupies
// its 1 included seat with the owner-operator themselves — adding ANY second
// driver must be blocked. That is exactly the revenue-leak we're closing.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), "dispatchos-seat-limits-test.db");
const { storage } = await import("../storage");
const { canAddDriver } = await import("./plans");

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

// --- Set up an oo_basic carrier (1 included seat, no paid overage) -----------
const owner = storage.createUser({
  email: `owner-${rnd()}@example.com`,
  fullName: "Carrier Owner",
  role: "driver",
  passwordSalt: "s",
  passwordHash: "h",
});
storage.claimMc(`MC-${Math.floor(100000 + Math.random() * 800000)}`, owner.id);
const client = storage.provisionCarrierFromOnboarding(owner.id, {
  persona: "owner_operator",
  companyName: "Seat Test LLC",
  planTier: "oo_basic",
}) as { id: string };
const clientId = client.id;

// The owner-operator themselves occupies the single oo_basic seat.
assert("owner occupies the 1 oo_basic seat", storage.countDriverSeats(clientId) === 1);
const gate = canAddDriver({ planTier: "oo_basic", driverSeatCount: storage.countDriverSeats(clientId) });
assert("oo_basic blocks a second driver (the fix)", !gate.allowed);
assert("block carries needsUpgrade", gate.needsUpgrade === true);

// --- Counting mechanics ------------------------------------------------------
const driver1 = storage.createUser({
  email: `driver1-${rnd()}@example.com`,
  fullName: "Driver One",
  role: "driver",
  passwordSalt: "s",
  passwordHash: "h",
  linkedClientId: clientId,
});
assert("second linked driver → 2 seats", storage.countDriverSeats(clientId) === 2);

// A pending driver invite reserves a seat (anti invite-spam bypass).
storage.createInviteWithCode({
  code: `DOS-${rnd()}-${rnd()}-${rnd()}`.toUpperCase(),
  role: "driver",
  linkedClientId: clientId,
  ttlHours: 72,
  createdByUserId: owner.id,
});
assert("pending driver invite counts as a seat", storage.countDriverSeats(clientId) === 3);

// An invite for a *different* client must not inflate this carrier's count.
storage.createInviteWithCode({
  code: `DOS-${rnd()}-${rnd()}-${rnd()}`.toUpperCase(),
  role: "driver",
  linkedClientId: `other-${rnd()}`,
  ttlHours: 72,
  createdByUserId: owner.id,
});
assert("other-client invite does not leak", storage.countDriverSeats(clientId) === 3);

// A non-driver invite (dispatcher) is not a driver seat.
storage.createInviteWithCode({
  code: `DOS-${rnd()}-${rnd()}-${rnd()}`.toUpperCase(),
  role: "dispatcher",
  linkedClientId: clientId,
  ttlHours: 72,
  createdByUserId: owner.id,
});
assert("dispatcher invite is not a driver seat", storage.countDriverSeats(clientId) === 3);

// Soft-deleting a driver frees the seat.
storage.softDeleteUser(driver1.id, owner.id);
assert("soft-deleted driver frees its seat", storage.countDriverSeats(clientId) === 2);

// --- Pure canAddDriver across tiers -----------------------------------------
assert(
  "oo_basic allows a driver when the carrier is empty",
  canAddDriver({ planTier: "oo_basic", driverSeatCount: 0 }).allowed,
);
// fleet_starter: 5 included + paid overage → never hard-blocks.
assert(
  "fleet_starter allows overage beyond included",
  canAddDriver({ planTier: "fleet_starter", driverSeatCount: 99 }).allowed,
);
// enterprise: 999 included.
assert(
  "enterprise allows many drivers",
  canAddDriver({ planTier: "enterprise", driverSeatCount: 100 }).allowed,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
