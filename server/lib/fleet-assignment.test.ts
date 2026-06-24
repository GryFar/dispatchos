// Network-wide fleet assignment test (pure).
// Run: npx tsx server/lib/fleet-assignment.test.ts
//
// Verifies the marketplace's core economic step: across many carriers and loads,
// pick the assignment that maximizes total network value (each load to <=1
// carrier, each carrier to <=1 next load), excluding unbookable loads.

import { assignLoadsToFleet } from "./fleet-assignment";
import type { Client, Load, ScoredLoad } from "@shared/schema";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const carrier = (id: string): Client => ({ id, name: id.toUpperCase() } as unknown as Client);
const load = (id: string): Load => ({ id } as unknown as Load);

// scorer driven by a score matrix: scores[clientId][loadId]; 0 => skip.
function mockScorer(scores: Record<string, Record<string, number>>) {
  return (c: Client, l: Load): ScoredLoad | null => {
    const s = scores[c.id]?.[l.id] ?? 0;
    return {
      id: l.id, originCity: "A", originState: "TX", destinationCity: "B", destinationState: "GA",
      dispatchScore: s, verdict: s === 0 ? "skip" : "book", estimatedNet: s * 10,
    } as unknown as ScoredLoad;
  };
}

// --- empty ------------------------------------------------------------------
const empty = assignLoadsToFleet([], [], mockScorer({}));
assert("empty input -> no assignments", empty.assignments.length === 0 && empty.totalScore === 0);

// --- conflict: both carriers want load X; higher pair wins, other gets next --
// c1: X=90, Y=50 | c2: X=80, Y=70
// Greedy: (c1,X)=90 -> assign; (c2,Y)=70 -> assign; (c2,X) blocked, (c1,Y) blocked.
const r1 = assignLoadsToFleet(
  [carrier("c1"), carrier("c2")],
  [load("x"), load("y")],
  mockScorer({ c1: { x: 90, y: 50 }, c2: { x: 80, y: 70 } }),
);
const byClient = Object.fromEntries(r1.assignments.map((a) => [a.clientId, a.loadId]));
assert("c1 takes its best (x)", byClient.c1 === "x");
assert("c2 takes its next-best (y), not the taken x", byClient.c2 === "y");
assert("no load assigned twice", new Set(r1.assignments.map((a) => a.loadId)).size === r1.assignments.length);
assert("no carrier assigned twice", new Set(r1.assignments.map((a) => a.clientId)).size === r1.assignments.length);
assert("total network value = 90 + 70", r1.totalScore === 160, `${r1.totalScore}`);
assert("total net = (90+70)*10", r1.totalEstimatedNet === 1600);

// --- skip loads are not assignable ------------------------------------------
const r2 = assignLoadsToFleet(
  [carrier("c1")],
  [load("bad"), load("ok")],
  mockScorer({ c1: { bad: 0, ok: 60 } }), // bad -> skip
);
assert("skip load never assigned", r2.assignments.length === 1 && r2.assignments[0]!.loadId === "ok");
assert("the skip load is reported unassigned", r2.unassignedLoadIds.includes("bad"));

// --- more carriers than loads -> some carriers unassigned -------------------
const r3 = assignLoadsToFleet(
  [carrier("c1"), carrier("c2"), carrier("c3")],
  [load("only")],
  mockScorer({ c1: { only: 40 }, c2: { only: 95 }, c3: { only: 70 } }),
);
assert("scarce load goes to the highest scorer (c2)", r3.assignments.length === 1 && r3.assignments[0]!.clientId === "c2");
assert("the other two carriers are unassigned", r3.unassignedClientIds.sort().join(",") === "c1,c3");

// --- deterministic ----------------------------------------------------------
const a = assignLoadsToFleet([carrier("c1"), carrier("c2")], [load("x"), load("y")], mockScorer({ c1: { x: 50, y: 50 }, c2: { x: 50, y: 50 } }));
const b = assignLoadsToFleet([carrier("c1"), carrier("c2")], [load("x"), load("y")], mockScorer({ c1: { x: 50, y: 50 }, c2: { x: 50, y: 50 } }));
assert("ties resolve deterministically", JSON.stringify(a.assignments) === JSON.stringify(b.assignments));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
