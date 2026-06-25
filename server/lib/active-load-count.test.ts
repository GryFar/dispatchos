// Active-load count semantics test (temp DB).
// Run: npx tsx server/lib/active-load-count.test.ts
//
// A dispatcher's "active loads" = booked AND still in progress. booked_at is
// never cleared on delivery (it is the revenue-window key), so the count must
// exclude completed / cancelled / delivered loads via the JSON payload.
// Critically: revenue (grossBookedInWindow) must STILL include delivered loads,
// so this test pins both behaviours so they can't regress into each other.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const rnd = () => Math.random().toString(36).slice(2, 10);
const DB_PATH = join(tmpdir(), `dispatchos-active-load-${Date.now()}-${rnd()}.db`);
process.env.DISPATCHOS_DB_PATH = DB_PATH;
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

const clientId = `client-alc-${rnd()}`;
storage.upsertClient({ id: clientId, name: "Active-Load Co" } as any);

const dispatcher = storage.createUser({
  email: `disp-${rnd()}@x.com`,
  fullName: "Disp",
  role: "dispatcher",
  passwordSalt: "s",
  passwordHash: "h",
});
storage.createAssignment({
  clientId,
  dispatcherUserId: dispatcher.id,
  createdByUserId: dispatcher.id,
});

const BOOKED_AT = "2026-03-15T12:00:00.000Z";
const baseLoad = {
  source: "test",
  originCity: "X",
  originState: "TX",
  originLat: 0,
  originLng: 0,
  destinationCity: "Y",
  destinationState: "OK",
  destinationLat: 0,
  destinationLng: 0,
  loadedMiles: 100,
  pickupAt: BOOKED_AT,
  deliveryAt: BOOKED_AT,
  equipment: "hotshot_flatbed",
  brokerName: "B",
  brokerMc: "MC-ALC",
  brokerScore: 80,
  fraudRisk: 10,
  marketQuality: 60,
  clientId,
};

// 1 active, 3 booked-but-terminal, 1 available (not booked).
storage.upsertLoad({ ...baseLoad, rate: 1000, bookedAt: BOOKED_AT } as any); // active
storage.upsertLoad({ ...baseLoad, rate: 2000, bookedAt: BOOKED_AT, status: "completed" } as any);
storage.upsertLoad({ ...baseLoad, rate: 3000, bookedAt: BOOKED_AT, deliveredAt: BOOKED_AT } as any);
storage.upsertLoad({ ...baseLoad, rate: 4000, bookedAt: BOOKED_AT, status: "cancelled" } as any);
storage.upsertLoad({ ...baseLoad, rate: 5000 } as any); // available — no bookedAt

// --- active-load count: only the in-progress booked load counts ---
const clients = storage.listAssignedClientsForDispatcher(dispatcher.id);
const row = clients.find((c) => c.id === clientId);
assert("dispatcher sees the assigned client", !!row, JSON.stringify(clients));
assert(
  "activeLoadsCount excludes completed/cancelled/delivered/available",
  row?.activeLoadsCount === 1,
  `got ${row?.activeLoadsCount} (expected 1)`,
);

// --- revenue: delivered/completed booked loads still count, but a CANCELLED
// booked load must NOT — booked_at survives a cancellation, so billing it would
// charge the 3% success fee on revenue that never existed. The active load
// (1000) + completed (2000) + delivered (3000) are billable; the cancelled
// (4000) is excluded.
const gross = storage.grossBookedInWindow("2026-03-15", "2026-03-15");
assert(
  "grossBookedInWindow includes delivered/completed but EXCLUDES cancelled booked loads",
  gross === 6000,
  `got ${gross} (expected 1000+2000+3000=6000, cancelled 4000 excluded)`,
);

console.log(`\n${pass} passed, ${fail} failed`);
try {
  rmSync(DB_PATH, { force: true });
  rmSync(`${DB_PATH}-wal`, { force: true });
  rmSync(`${DB_PATH}-shm`, { force: true });
} catch {
  /* best-effort */
}
process.exit(fail > 0 ? 1 : 0);
