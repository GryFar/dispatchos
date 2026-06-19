// Load reassign optimistic-concurrency test (temp DB).
// Run: npx tsx server/lib/load-reassign.test.ts
//
// "Koren #1": two concurrent reassigns must not both win. The second write,
// built on a stale expectedDriverId, must conflict instead of silently
// overwriting (double-book).

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), "dispatchos-reassign-test.db");
const { storage } = await import("../storage");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}
const rnd = () => Math.random().toString(36).slice(2, 10);

const driverA = storage.createUser({ email: `a-${rnd()}@x.com`, fullName: "A", role: "driver", passwordSalt: "s", passwordHash: "h" });
const driverB = storage.createUser({ email: `b-${rnd()}@x.com`, fullName: "B", role: "driver", passwordSalt: "s", passwordHash: "h" });

const load = storage.upsertLoad({
  source: "test", originCity: "X", originState: "TX", originLat: 0, originLng: 0,
  destinationCity: "Y", destinationState: "OK", destinationLat: 0, destinationLng: 0,
  rate: 1000, loadedMiles: 100, pickupAt: new Date().toISOString(), deliveryAt: new Date().toISOString(),
  equipment: "hotshot_flatbed", brokerName: "B", brokerMc: "MC-1", brokerScore: 80, fraudRisk: 10, marketQuality: 60,
} as any);

assert("load starts unassigned", storage.getLoadDriverId(load.id) === null);

const r1 = storage.reassignLoadDriver(load.id, null, driverA.id);
assert("first reassign ok", r1.ok === true);
assert("driver_id column = A", storage.getLoadDriverId(load.id) === driverA.id);
assert("payload driverId = A", (storage.getLoad(load.id) as any).driverId === driverA.id);
assert("payload bookedAt set", typeof (storage.getLoad(load.id) as any).bookedAt === "string");

const r2 = storage.reassignLoadDriver(load.id, null, driverB.id);
assert("stale reassign conflicts", r2.ok === false && "conflict" in r2);
assert("conflict reports actual = A", !r2.ok && r2.actual === driverA.id);
assert("driver_id still A (not overwritten)", storage.getLoadDriverId(load.id) === driverA.id);

const r3 = storage.reassignLoadDriver(load.id, driverA.id, driverB.id);
assert("correct-expected reassign ok", r3.ok === true);
assert("driver_id now B", storage.getLoadDriverId(load.id) === driverB.id);

const r4 = storage.reassignLoadDriver(load.id, driverB.id, null);
assert("unassign ok", r4.ok === true);
assert("driver_id cleared", storage.getLoadDriverId(load.id) === null);
assert("payload bookedAt cleared", (storage.getLoad(load.id) as any).bookedAt == null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
