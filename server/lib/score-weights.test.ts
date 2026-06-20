// resolveScoreWeights unit tests. Run: npx tsx server/lib/score-weights.test.ts
//
// Wires the long-dormant clientSchema.scoreWeights override into the scorer.
// Must stay non-regressive: a carrier with no overrides resolves to the exact
// defaults (which sum to 1.0), so their dispatchScore is unchanged.

import { resolveScoreWeights, DEFAULT_SCORE_WEIGHTS } from "./score-weights";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const sum = (w: { ppm: number; deadhead: number; feasibility: number; broker: number; lane: number; location: number }) =>
  w.ppm + w.deadhead + w.feasibility + w.broker + w.lane + w.location;
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// defaults already sum to 1.0
assert("defaults sum to 1", approx(sum(DEFAULT_SCORE_WEIGHTS), 1));

// no overrides → exactly the defaults (non-regressive)
const none = resolveScoreWeights(undefined);
assert("no overrides → defaults (ppm)", approx(none.ppm, 0.42));
assert("no overrides → defaults (location)", approx(none.location, 0.05));
assert("null overrides → defaults", approx(resolveScoreWeights(null).deadhead, 0.18));
assert("empty obj → defaults", approx(resolveScoreWeights({}).broker, 0.12));

// any override result is normalized to sum 1
const heavy = resolveScoreWeights({ deadhead: 1 }); // bump deadhead only
assert("override result normalized to 1", approx(sum(heavy), 1));
assert("bumping deadhead raises its share", heavy.deadhead > DEFAULT_SCORE_WEIGHTS.deadhead, `${heavy.deadhead}`);
assert("bumping deadhead lowers others' share", heavy.ppm < DEFAULT_SCORE_WEIGHTS.ppm);

// equal weights → 1/6 each
const equal = resolveScoreWeights({ ppm: 1, deadhead: 1, feasibility: 1, broker: 1, lane: 1, location: 1 });
assert("all-equal → 1/6 each", approx(equal.ppm, 1 / 6) && approx(equal.location, 1 / 6));
assert("all-equal still sums to 1", approx(sum(equal), 1));

// garbage / negative values are ignored (fall back to default for that key)
const dirty = resolveScoreWeights({ ppm: -5, deadhead: NaN, feasibility: "oops" as unknown as number, broker: 2 });
assert("negative ppm ignored (uses default before norm)", dirty.ppm > 0);
assert("dirty result still normalized", approx(sum(dirty), 1));
assert("valid broker override applied (raised vs default share)", dirty.broker > DEFAULT_SCORE_WEIGHTS.broker);

// all-zero overrides → safe fallback to defaults (no divide-by-zero)
const zero = resolveScoreWeights({ ppm: 0, deadhead: 0, feasibility: 0, broker: 0, lane: 0, location: 0 });
assert("all-zero → fallback defaults", approx(zero.ppm, 0.42) && approx(sum(zero), 1));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
