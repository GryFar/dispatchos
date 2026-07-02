// Load lifecycle → broker-trust signal tests.
// Run: npx tsx server/lib/load-transitions.test.ts
//
// upsertLoad auto-emits broker-trust signals on terminal transitions. These
// must only fire on a LEGAL transition: a cancelled load that is later
// re-upserted as delivered must NOT emit a positive load_completed signal
// (which would otherwise inflate the broker's score).

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), "dispatchos-loadtx-test.db");
const { storage } = await import("../storage");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function signalTypesForLoad(loadId: string): string[] {
  return storage
    .listBrokerTrustSignalsByLoad(loadId)
    .map((r) => r.signal_type as string);
}

// Unique ids so a persisted temp DB across runs never leaks signals between runs.
const rnd = () => Math.random().toString(36).slice(2, 10);

// ---------------------------------------------------------------------------
// Illegal transition: booked -> cancelled -> (attempt) delivered
// ---------------------------------------------------------------------------
{
  const id = `loadtx-cancelled-${rnd()}`;
  const mc = `MC-${rnd()}`;
  const base = { id, brokerMc: mc, brokerName: "Test Broker", rate: 1500, bookedAt: "2026-01-01T00:00:00.000Z" };

  storage.upsertLoad({ ...base } as any); // booked
  storage.upsertLoad({ ...base, status: "cancelled" } as any); // booked -> cancelled
  storage.upsertLoad({ ...base, status: "cancelled", deliveredAt: "2026-01-02T00:00:00.000Z" } as any); // illegal

  const types = signalTypesForLoad(id);
  assert("illegal: load_booked emitted", types.includes("load_booked"), types.join(","));
  assert("illegal: load_cancelled_by_broker emitted", types.includes("load_cancelled_by_broker"), types.join(","));
  assert("illegal: NO spurious load_completed after cancel", !types.includes("load_completed"), types.join(","));
}

// ---------------------------------------------------------------------------
// Legal transition: booked -> delivered
// ---------------------------------------------------------------------------
{
  const id = `loadtx-completed-${rnd()}`;
  const mc = `MC-${rnd()}`;
  const base = { id, brokerMc: mc, brokerName: "Test Broker", rate: 1500, bookedAt: "2026-01-01T00:00:00.000Z" };

  storage.upsertLoad({ ...base } as any); // booked
  storage.upsertLoad({ ...base, deliveredAt: "2026-01-03T00:00:00.000Z" } as any); // booked -> delivered

  const types = signalTypesForLoad(id);
  assert("legal: load_completed emitted on delivery", types.includes("load_completed"), types.join(","));
  assert("legal: no cancel signal", !types.includes("load_cancelled_by_broker"), types.join(","));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
