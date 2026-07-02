// Onboarding carrier-provisioning test (temp DB).
// Run: npx tsx server/lib/onboarding-provision.test.ts
//
// P0.1: completing onboarding must create the carrier client, link the user,
// and start the 14-day trial — previously it only wrote progress, so the
// carrier never existed and the dispatch board had nothing to score.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), "dispatchos-onboarding-test.db");
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

const user = storage.createUser({
  email: `carrier-${rnd()}@example.com`,
  fullName: "Carrier Owner",
  role: "driver",
  passwordSalt: "s",
  passwordHash: "h",
});
storage.claimMc(`MC-${Math.floor(100000 + Math.random() * 800000)}`, user.id);

assert("user starts unlinked", !storage.getUserById(user.id)!.linkedClientId);

const result = storage.provisionCarrierFromOnboarding(user.id, {
  persona: "owner_operator",
  companyName: "Test Carrier LLC",
  planTier: "oo_basic",
});

assert("provision returns a client", "id" in result);
if ("id" in result) {
  assert("client name from companyName", result.name === "Test Carrier LLC");
  assert("billingStatus = trial", (result as { billingStatus?: string }).billingStatus === "trial");
  assert("trialEndsAt is set & future", Boolean((result as { trialEndsAt?: string }).trialEndsAt) && new Date((result as { trialEndsAt: string }).trialEndsAt).getTime() > Date.now());
  assert("persona stored", (result as { persona?: string }).persona === "owner_operator");
  assert("planTier stored", (result as { planTier?: string }).planTier === "oo_basic");
  assert("mc carried from claim", typeof result.mc === "string" && result.mc.startsWith("MC"));

  const linked = storage.getUserById(user.id)!;
  assert("user now linked to the new client", linked.linkedClientId === result.id);

  // The provisioned client must be visible (active, not archived).
  assert("client resolvable + not archived", !!storage.getClient(result.id) && !(storage.getClient(result.id) as { deletedAt?: string | null }).deletedAt);
}

// Idempotent: a second completion does not create a second carrier.
const again = storage.provisionCarrierFromOnboarding(user.id, { persona: "owner_operator" });
assert("second provision is a no-op (already linked)", "skipped" in again && again.skipped === "already_linked");

// no_mc invariant: a user who never claimed an MC cannot be provisioned,
// even with a valid persona — no mc:"" trial carriers.
const noMcUser = storage.createUser({
  email: `nomc-${rnd()}@example.com`,
  fullName: "No MC Owner",
  role: "driver",
  passwordSalt: "s",
  passwordHash: "h",
});
const noMc = storage.provisionCarrierFromOnboarding(noMcUser.id, {
  persona: "owner_operator",
  companyName: "No MC LLC",
});
assert("provision without claimed MC is skipped (no_mc)", "skipped" in noMc && noMc.skipped === "no_mc");
assert("no-mc user stays unlinked", !storage.getUserById(noMcUser.id)!.linkedClientId);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
