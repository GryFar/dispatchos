// Multi-leg load-chain planner test (pure).
// Run: npx tsx server/lib/load-chain.test.ts

import { planLoadChain, type ChainCandidate } from "./load-chain";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = Date.parse("2026-06-20T12:00:00.000Z");
const iso = (hoursFromNow: number) => new Date(NOW + hoursFromNow * 3600_000).toISOString();
const DALLAS = { lat: 32.78, lng: -96.80 };
const ATLANTA = { lat: 33.75, lng: -84.39 };
const CHARLOTTE = { lat: 35.23, lng: -80.84 };
const MIAMI = { lat: 25.76, lng: -80.19 };
const NEWARK = { lat: 40.74, lng: -74.17 };

const start = { lat: DALLAS.lat, lng: DALLAS.lng, availableAt: iso(0) };

// A: Dallas -> Atlanta (starts at the carrier, ~0 deadhead in)
const A: ChainCandidate = {
  id: "A", originCity: "Dallas", originState: "TX", destinationCity: "Atlanta", destinationState: "GA",
  originLat: DALLAS.lat, originLng: DALLAS.lng, destinationLat: ATLANTA.lat, destinationLng: ATLANTA.lng,
  pickupAt: iso(2), deliveryAt: iso(16), rate: 1800, loadedMiles: 780,
};
// B: Atlanta -> Charlotte (origin == A's dest -> ~0 deadhead between legs)
const B: ChainCandidate = {
  id: "B", originCity: "Atlanta", originState: "GA", destinationCity: "Charlotte", destinationState: "NC",
  originLat: ATLANTA.lat, originLng: ATLANTA.lng, destinationLat: CHARLOTTE.lat, destinationLng: CHARLOTTE.lng,
  pickupAt: iso(20), deliveryAt: iso(30), rate: 700, loadedMiles: 250,
};
// C: Miami -> Newark (high rate but far from Dallas -> huge empty repositioning)
const C: ChainCandidate = {
  id: "C", originCity: "Miami", originState: "FL", destinationCity: "Newark", destinationState: "NJ",
  originLat: MIAMI.lat, originLng: MIAMI.lng, destinationLat: NEWARK.lat, destinationLng: NEWARK.lng,
  pickupAt: iso(2), deliveryAt: iso(28), rate: 3000, loadedMiles: 1200,
};

// --- empty ------------------------------------------------------------------
assert("no candidates -> empty chain", planLoadChain(start, []).legs.length === 0);

// --- the chain A->B beats the lone high-rate C ------------------------------
const chain = planLoadChain(start, [A, B, C], { costPerMile: 0.55 });
assert("plans the A->B chain (keeps truck loaded)", chain.legs.map((l) => l.loadId).join(",") === "A,B", chain.legs.map((l) => l.loadId).join(","));
assert("A starts with ~0 deadhead (origin == carrier)", chain.legs[0]!.deadheadMiles < 30, `${chain.legs[0]!.deadheadMiles}`);
assert("B chains with ~0 deadhead (origin == A's dest)", chain.legs[1]!.deadheadMiles < 30, `${chain.legs[1]!.deadheadMiles}`);
assert("total rate = 1800 + 700", chain.totalRate === 2500);
assert("utilization is high (few empty miles)", chain.utilization > 0.95, `${chain.utilization}`);

const cOnly = planLoadChain(start, [C], { costPerMile: 0.55 });
assert("chaining A->B out-values stranding on C", chain.netValue > cOnly.netValue, `chain ${chain.netValue} vs C ${cOnly.netValue}`);

// --- time feasibility: a load picking up before A delivers can't follow A ----
const tooEarly: ChainCandidate = {
  id: "EARLY", originCity: "Atlanta", originState: "GA", destinationCity: "Nashville", destinationState: "TN",
  originLat: ATLANTA.lat, originLng: ATLANTA.lng, destinationLat: 36.16, destinationLng: -86.78,
  pickupAt: iso(4), deliveryAt: iso(12), rate: 900, loadedMiles: 250, // pickup +4h, but A delivers +16h
};
const chain2 = planLoadChain(start, [A, tooEarly], { costPerMile: 0.55 });
const ids = chain2.legs.map((l) => l.loadId);
assert("a load that picks up before the predecessor delivers is not chained after it", !(ids[0] === "A" && ids[1] === "EARLY"), ids.join(","));

// --- money-losing chain -> recommend no load --------------------------------
// A load whose rate cannot cover its operating + deadhead cost must not be
// surfaced as the optimal plan; the empty chain (netValue 0) is preferable.
const LOSS: ChainCandidate = {
  id: "LOSS", originCity: "Miami", originState: "FL", destinationCity: "Newark", destinationState: "NJ",
  originLat: MIAMI.lat, originLng: MIAMI.lng, destinationLat: NEWARK.lat, destinationLng: NEWARK.lng,
  pickupAt: iso(6), deliveryAt: iso(40), rate: 200, loadedMiles: 1200, // rate far below cost + huge deadhead from Dallas
};
const loss = planLoadChain(start, [LOSS], { costPerMile: 0.55 });
assert("a net-negative chain is not recommended (empty chain instead)", loss.legs.length === 0, loss.legs.map((l) => l.loadId).join(","));
assert("net-negative input yields netValue 0", loss.netValue === 0, `${loss.netValue}`);

// --- deterministic ----------------------------------------------------------
const d1 = planLoadChain(start, [A, B, C], { costPerMile: 0.55 });
const d2 = planLoadChain(start, [C, B, A], { costPerMile: 0.55 }); // different input order
assert("result is order-independent / deterministic", JSON.stringify(d1.legs.map((l) => l.loadId)) === JSON.stringify(d2.legs.map((l) => l.loadId)));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
