// Regression tests for the deep-audit sweep fixes (temp DB).
// Run: npx tsx server/lib/deep-audit-fixes.test.ts
//   - invite double-redemption is atomic (loser rolls back, no orphan user)
//   - dispatcher assigned-client list excludes soft-deleted clients
//   - backup export redacts raw invite codes from audit entityIds

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), "dispatchos-deep-audit-test.db");
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

function mkClient(id: string): string {
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
  } as Parameters<typeof storage.upsertClient>[0]);
  return id;
}

// ---------------------------------------------------------------------------
// 1. Invite double-redemption is atomic
// ---------------------------------------------------------------------------
{
  const inv = storage.createInvite({ role: "dispatcher", createdByUserId: "admin-x" });
  const e1 = `redeem1-${rnd()}@example.com`;
  const e2 = `redeem2-${rnd()}@example.com`;

  const r1 = storage.createUserConsumingInvite(
    { email: e1, fullName: "R1", role: "dispatcher", passwordSalt: "s", passwordHash: "h" },
    inv.code,
  );
  assert("first redemption creates the user", "id" in r1);

  // Different email (unlocked invite) — the exact race that minted two accounts.
  const r2 = storage.createUserConsumingInvite(
    { email: e2, fullName: "R2", role: "dispatcher", passwordSalt: "s", passwordHash: "h" },
    inv.code,
  );
  assert("second redemption of same code -> alreadyConsumed", "alreadyConsumed" in r2);
  assert("loser user was NOT created (transaction rolled back)", !storage.getUserByEmail(e2));
  assert("winner user exists", !!storage.getUserByEmail(e1));
}

// ---------------------------------------------------------------------------
// 2. Dispatcher assigned-client list excludes soft-deleted clients
// ---------------------------------------------------------------------------
{
  const disp = storage.createUser({
    email: `disp-${rnd()}@example.com`,
    fullName: "Disp",
    role: "dispatcher",
    passwordSalt: "s",
    passwordHash: "h",
  });
  const clientId = mkClient(`da-client-${rnd()}`);
  storage.createAssignment({ clientId, dispatcherUserId: disp.id, createdByUserId: "admin-x" });

  const before = storage.listAssignedClientsForDispatcher(disp.id);
  assert("active client appears in dispatcher list", before.some((c) => c.id === clientId));

  storage.softDeleteClient(clientId);
  const after = storage.listAssignedClientsForDispatcher(disp.id);
  assert("archived client excluded from dispatcher list", !after.some((c) => c.id === clientId));
}

// ---------------------------------------------------------------------------
// 3. Backup export redacts raw invite codes from audit entityIds
// ---------------------------------------------------------------------------
{
  const inv = storage.createInvite({ role: "driver", createdByUserId: "admin-x" });
  const backup = storage.exportBackup() as { auditEvents: Array<{ entityType: string; entityId: string }> };
  const inviteAudits = backup.auditEvents.filter((e) => e.entityType === "invite");
  assert("invite audit events are present", inviteAudits.length > 0);
  assert("all invite entityIds are redacted", inviteAudits.every((e) => e.entityId === "[redacted]"));
  assert(
    "raw invite code does not leak anywhere in the audit dump",
    !JSON.stringify(backup.auditEvents).includes(inv.code),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
