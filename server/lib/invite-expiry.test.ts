// Regression test: storage.consumeInvite EXPIRY gate (temp DB, no network).
// Run: npx tsx server/lib/invite-expiry.test.ts
//
// CROWN-JEWEL INVARIANT under guard
// ---------------------------------
// consumeInvite atomically flips a single-use invite to consumed with:
//
//   UPDATE invites SET consumed_at=?, consumed_by_user_id=?
//   WHERE code=? AND consumed_at IS NULL AND expires_at > ?
//
// The `expires_at > ?` clause is the EXPIRY (and revocation) gate. It is a
// money/security primitive: an EXPIRED or REVOKED invite must NOT be
// redeemable. If a refactor drops that clause (or moves expiry to a TOCTOU-racy
// route-level read), an attacker could redeem a stale/revoked invite and mint
// an account — silently. This file locks the gate in.
//
// This is DISTINCT from the already-tested alreadyConsumed path in
// deep-audit-fixes.test.ts: there the invite is rejected because it was already
// redeemed; here it is rejected purely because it is past its expiry.
//
// Coverage:
//   * EXPIRED invite -> consumeInvite returns false and the invite stays
//     unconsumed (no consumedAt / consumedByUserId written -> no account could
//     be minted from it).
//   * REVOKED invite (revokeInvite stamps expires_at = now()) -> same rejection,
//     same atomic clause.
//   * CONTROL: a still-valid invite consumes successfully and is stamped.
//
// Deterministic: every invite's lifetime is controlled in-test (revoke ages it
// into the past; the control invite has a wide TTL). No assertion depends on
// Date.now() flakiness, and there is no HTTP / network.

import { tmpdir } from "node:os";
import { join } from "node:path";

// MUST set a unique DB path BEFORE importing storage (better-sqlite3 binds the
// file at import time). Mirror server/lib/stripe-charge.test.ts.
process.env.DISPATCHOS_DB_PATH = join(
  tmpdir(),
  `dispatchos-invite-expiry-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.db`,
);
// Valid 32-byte base64 keyring key in case any imported code touches the keyring.
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

// A real consumer user id (so the test is faithful to how consumeInvite is
// called by the signup path) — its presence on the invite proves consumption.
const consumer = storage.createUser({
  email: `consumer-${rnd()}@example.com`,
  fullName: "Consumer",
  role: "dispatcher",
  passwordSalt: "s",
  passwordHash: "h",
});

// Busy-wait until wall-clock has advanced past `afterIso` so a subsequent
// now() inside storage is STRICTLY greater. Bounded + deterministic (no async
// timers): used only to make "expired" unambiguous against the gate's `> ?`.
function spinPast(afterIso: string) {
  const target = Date.parse(afterIso);
  // Spin a tiny, bounded amount; Date.now() is monotonic enough here.
  while (Date.now() <= target) {
    /* tight spin, sub-millisecond */
  }
}

// ---------------------------------------------------------------------------
// 1) EXPIRED invite is rejected by the expiry gate (revoked == expires_at past).
//    Guard intent: if `expires_at > ?` is removed from the UPDATE WHERE, an
//    expired/revoked invite would consume here and this assertion would FAIL.
// ---------------------------------------------------------------------------
{
  const inv = storage.createInvite({ role: "dispatcher", createdByUserId: "admin-x" });
  assert("expired-setup: invite starts unconsumed", storage.getInvite(inv.code)?.consumedAt == null);

  // Age it into the past: revokeInvite stamps expires_at = now() (this is the
  // exact revocation primitive the gate also enforces).
  const rev = storage.revokeInvite(inv.code, "admin-x");
  assert("expired-setup: revoke succeeded", "revokedAt" in rev);
  // Ensure the next now() inside consumeInvite is STRICTLY after expires_at,
  // so `expires_at > now()` is unambiguously false (== expired).
  spinPast(storage.getInvite(inv.code)!.expiresAt);

  const consumed = storage.consumeInvite(inv.code, consumer.id);
  // CORE GUARD: expired invite must be rejected.
  assert("EXPIRED invite is rejected (consumeInvite -> false)", consumed === false);

  const after = storage.getInvite(inv.code)!;
  // No consumption was recorded -> no account could have been minted from it.
  assert("EXPIRED invite stays unconsumed (no consumedAt)", after.consumedAt == null);
  assert(
    "EXPIRED invite has no consumedByUserId (not linked to any user)",
    after.consumedByUserId == null,
  );
}

// ---------------------------------------------------------------------------
// 2) Second, independent EXPIRED invite — same rejection, proving it's the
//    expiry clause and not an artifact of the specific code above.
// ---------------------------------------------------------------------------
{
  const inv = storage.createInvite({
    role: "driver",
    email: `e-${rnd()}@example.com`,
    createdByUserId: "admin-y",
  });
  storage.revokeInvite(inv.code, "admin-y");
  spinPast(storage.getInvite(inv.code)!.expiresAt);

  const consumed = storage.consumeInvite(inv.code, consumer.id);
  assert("second EXPIRED invite is also rejected", consumed === false);
  assert(
    "second EXPIRED invite remains unconsumed",
    storage.getInvite(inv.code)?.consumedByUserId == null,
  );
}

// ---------------------------------------------------------------------------
// 3) CONTROL: a still-valid invite consumes successfully and is stamped.
//    Proves the gate rejects ONLY because of expiry, not because consumeInvite
//    is broken for everyone. A wide TTL keeps this deterministic (never expires
//    during the test run).
// ---------------------------------------------------------------------------
{
  const inv = storage.createInvite({
    role: "dispatcher",
    ttlHours: 24 * 365, // far-future expiry: cannot lapse mid-test
    createdByUserId: "admin-z",
  });
  assert("control-setup: invite starts unconsumed", storage.getInvite(inv.code)?.consumedAt == null);

  const consumed = storage.consumeInvite(inv.code, consumer.id);
  // CONTROL: valid invite must succeed (proves the negative cases above are the
  // expiry gate doing its job, not a blanket failure).
  assert("VALID invite consumes successfully (consumeInvite -> true)", consumed === true);

  const after = storage.getInvite(inv.code)!;
  assert("VALID invite is now stamped consumed", after.consumedAt != null);
  assert("VALID invite is linked to the consuming user", after.consumedByUserId === consumer.id);

  // And it is genuinely single-use now: a second consume returns false (this is
  // the alreadyConsumed path, included only to confirm the control invite was
  // truly written through — the expiry path is the focus of this file).
  assert(
    "VALID invite cannot be consumed twice",
    storage.consumeInvite(inv.code, consumer.id) === false,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
