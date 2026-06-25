// Regression tests for deep-audit batch 4 (temp DB).
// Run: npx tsx server/lib/deep-batch4.test.ts
//   - setLastUsedTotpCounter is atomic (rejects replay of the same counter)
//   - createInvoice stores whole-cent total (no float re-sum drift)

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), "dispatchos-batch4-test.db");
const { storage } = await import("../storage");

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

// ---------------------------------------------------------------------------
// TOTP replay: setLastUsedTotpCounter must only advance once per counter
// ---------------------------------------------------------------------------
{
  const u = storage.createUser({
    email: `totp-${rnd()}@example.com`,
    fullName: "T",
    role: "admin",
    passwordSalt: "s",
    passwordHash: "h",
  });
  assert("first set of counter 5 succeeds", storage.setLastUsedTotpCounter(u.id, 5) === true);
  assert("replay of counter 5 is rejected", storage.setLastUsedTotpCounter(u.id, 5) === false);
  assert("lower counter 4 is rejected", storage.setLastUsedTotpCounter(u.id, 4) === false);
  assert("higher counter 6 advances", storage.setLastUsedTotpCounter(u.id, 6) === true);
  assert("replay of 6 is rejected", storage.setLastUsedTotpCounter(u.id, 6) === false);
}

// ---------------------------------------------------------------------------
// TOTP rotation: installTotpSecret resets last_used_totp_counter to NULL so the
// new secret's first code (same time-window as the old secret) can be claimed.
// Regression for "2FA re-enrollment confirm rejected because the replay counter
// is shared across the old and new secret".
// ---------------------------------------------------------------------------
{
  const u = storage.createUser({
    email: `totp-rotate-${rnd()}@example.com`,
    fullName: "R",
    role: "admin",
    passwordSalt: "s",
    passwordHash: "h",
  });
  // Simulate the user having authenticated with the OLD secret at counter N:
  // last_used_totp_counter is now at/above the current time-window counter.
  const N = Math.floor(Date.now() / 30_000);
  storage.setLastUsedTotpCounter(u.id, N);
  // Before the fix, claiming the new secret's first code at counter N would
  // fail because the column is already at N.
  assert(
    "rotation: stale counter blocks new-secret claim (pre-install)",
    storage.setLastUsedTotpCounter(u.id, N) === false,
  );
  // installTotpSecret swaps the secret AND clears the counter atomically.
  assert(
    "installTotpSecret returns true for an existing user",
    storage.installTotpSecret(u.id, "NEWSECRETBASE32AAAA", u.id) === true,
  );
  assert(
    "installTotpSecret cleared last_used_totp_counter to NULL",
    storage.getLastUsedTotpCounter(u.id) === null,
  );
  // Now the new secret's first in-window code at counter N can be claimed.
  assert(
    "rotation: new-secret counter N claims cleanly after reset",
    storage.setLastUsedTotpCounter(u.id, N) === true,
  );
  // And a replay of that same counter is still rejected (replay guard intact).
  assert(
    "rotation: replay of new-secret counter N is rejected",
    storage.setLastUsedTotpCounter(u.id, N) === false,
  );
  assert(
    "installTotpSecret returns false for a missing user",
    storage.installTotpSecret(`missing-${rnd()}`, "X", undefined) === false,
  );
}

// ---------------------------------------------------------------------------
// createInvoice: total_due is exact whole cents, not a re-summed float
// ---------------------------------------------------------------------------
{
  const clientId = `inv-client-${rnd()}`;
  // flatFee + percentFee that drift in float (0.1 + 0.2 style): 150.00 + 12.34
  const inv = storage.createInvoice({
    clientId,
    weekStart: "2026-07-06",
    weekEnd: "2026-07-12",
    flatFee: 150.0,
    percentFee: 12.34,
    grossBooked: 411.33,
  });
  assert("totalDue == 162.34", inv.totalDue === 162.34, String(inv.totalDue));
  assert(
    "totalDue is whole cents (no float drift)",
    Number.isInteger(Math.round(inv.totalDue * 100)) && Math.abs(inv.totalDue * 100 - Math.round(inv.totalDue * 100)) < 1e-9,
    String(inv.totalDue * 100),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
