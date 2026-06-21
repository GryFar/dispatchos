// Audit M5: automatic per-load lifecycle signals must not duplicate -- a second
// load_booked/completed/cancelled for the same load would inflate the broker's
// trust score. A partial UNIQUE(load_id, signal_type) over the auto lifecycle
// types makes the existing INSERT OR IGNORE idempotent. Manual signals are NOT
// deduped. Run: npx tsx server/lib/broker-trust-dedup.test.ts

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-bts-${Date.now()}.db`);
const { storage } = await import("../storage");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

const mc = "MC-DEDUP-1";
const auto = (loadId: string, signalType: string) =>
  storage.appendBrokerTrustSignal({ brokerMc: mc, loadId, signalType, positive: true, source: "automatic" });

auto("L1", "load_booked");
auto("L1", "load_booked"); // duplicate -> ignored by the partial unique index
assert("auto load_booked deduped to 1 per load",
  storage.listBrokerTrustSignals(mc, { types: ["load_booked"] }).length === 1);

auto("L2", "load_booked");
assert("a different load gets its own load_booked",
  storage.listBrokerTrustSignals(mc, { types: ["load_booked"] }).length === 2);

auto("L1", "load_completed");
auto("L1", "load_completed"); // duplicate -> ignored
assert("auto load_completed deduped per load",
  storage.listBrokerTrustSignals(mc, { types: ["load_completed"] }).length === 1);

// Manual signals (dispatcher-logged) are NOT deduped.
storage.appendBrokerTrustSignal({ brokerMc: mc, loadId: "L1", signalType: "ghosted", positive: false, source: "dispatcher" });
storage.appendBrokerTrustSignal({ brokerMc: mc, loadId: "L1", signalType: "ghosted", positive: false, source: "dispatcher" });
assert("manual signals are NOT deduped",
  storage.listBrokerTrustSignals(mc, { types: ["ghosted"] }).length === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
