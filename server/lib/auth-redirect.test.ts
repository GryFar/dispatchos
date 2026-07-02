// Post-auth redirect test (temp DB, no network).
// Run: npx tsx server/lib/auth-redirect.test.ts
//
// postAuthRedirect is the login / confirm-signup destination resolver. The
// launch-critical case: a self-serve carrier owner (role 'driver', no
// linkedClientId, onboarding not completed) must be routed back into the
// resumable /onboarding wizard — the pre-fix role-only redirect dropped every
// interrupted signup into an empty /d portal with no path back to the MC
// claim / plan / trial (the whole paid funnel silently lost). Invited team
// members must be unaffected: driver invites carry a linkedClientId, and the
// invite signup branch stamps onboarding completed at creation.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(
  tmpdir(),
  `dispatchos-auth-redirect-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.db`,
);

const { storage } = await import("../storage");
const { postAuthRedirect } = await import("./auth-redirect");

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

function mkUser(input: { role: "admin" | "dispatcher" | "driver"; linkedClientId?: string }) {
  return storage.createUser({
    email: `redir-${rnd()}@example.com`,
    fullName: "Redirect Test",
    role: input.role,
    passwordSalt: "s",
    passwordHash: "h",
    linkedClientId: input.linkedClientId,
  });
}

// --- role-only paths are unchanged -----------------------------------------
assert("admin → /admin", postAuthRedirect(mkUser({ role: "admin" })) === "/admin");
assert(
  "dispatcher → /dispatch",
  postAuthRedirect(mkUser({ role: "dispatcher" })) === "/dispatch",
);

// --- invited driver (linked to a carrier) stays on /d -----------------------
{
  const u = mkUser({ role: "driver", linkedClientId: "cli-any" });
  assert("driver with linkedClientId → /d", postAuthRedirect(u) === "/d");
}

// --- self-serve owner, wizard never started → /onboarding -------------------
{
  const u = mkUser({ role: "driver" });
  assert(
    "carrier-less driver with no onboarding row → /onboarding",
    postAuthRedirect(u) === "/onboarding",
  );
}

// --- self-serve owner, wizard abandoned mid-way → /onboarding ---------------
{
  const u = mkUser({ role: "driver" });
  storage.upsertOnboardingProgress(u.id, { step: 2, data: { persona: "owner_operator" } });
  assert(
    "carrier-less driver mid-wizard (no completedAt) → /onboarding",
    postAuthRedirect(u) === "/onboarding",
  );
}

// --- invite-branch parity: onboarding stamped completed at creation → /d ----
// (routes.ts invite signup calls upsertOnboardingProgress(..., completed: true)
// for invited users so they never land in the carrier wizard.)
{
  const u = mkUser({ role: "driver" });
  storage.upsertOnboardingProgress(u.id, { step: 4, data: {}, completed: true });
  assert(
    "carrier-less driver with COMPLETED onboarding → /d",
    postAuthRedirect(u) === "/d",
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
