// Broker Trust Score tests.
// Run: npx tsx server/lib/ai/broker-trust.test.ts
import {
  computeTrustScore,
  computeBreakdown,
  trustTier,
  type TrustSignalLike,
} from "./broker-trust";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`\u2713 ${name}`); }
  else { fail++; console.error(`\u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`); }
}

const sig = (signalType: string): TrustSignalLike => ({ signalType });

// ---------------------------------------------------------------------------
// computeTrustScore
// ---------------------------------------------------------------------------
assert("empty signals => 50 (neutral)", computeTrustScore([]) === 50);

const allPositive = computeTrustScore([
  sig("paid_on_time"), sig("paid_on_time"), sig("ratecon_honored"),
  sig("fast_response"), sig("detention_paid"),
]);
assert("positive-only => high (>65)", allPositive > 65, `got ${allPositive}`);

const allNegative = computeTrustScore([
  sig("paid_late"), sig("paid_never"), sig("ratecon_reduced_post_bol"),
  sig("no_response"),
]);
assert("negative-only => low (<35)", allNegative < 35, `got ${allNegative}`);

// Bounds: score never escapes 0..100 even with extreme input.
const extremeHigh = computeTrustScore(Array.from({ length: 100 }, () => sig("paid_on_time")));
assert("extreme positive stays <= 100", extremeHigh <= 100 && extremeHigh >= 0, `got ${extremeHigh}`);
const extremeLow = computeTrustScore(Array.from({ length: 100 }, () => sig("fraud_attempt")));
assert("extreme negative stays >= 0", extremeLow >= 0 && extremeLow <= 100, `got ${extremeLow}`);

// Fraud is catastrophic: 5 fraud_attempts => essentially avoid.
const fraud5 = computeTrustScore(Array.from({ length: 5 }, () => sig("fraud_attempt")));
assert("5 fraud_attempts => score < 5", fraud5 < 5, `got ${fraud5}`);

// A single fraud signal should outweigh several good ones.
const mixed = computeTrustScore([
  sig("paid_on_time"), sig("paid_on_time"), sig("ratecon_honored"), sig("fraud_attempt"),
]);
assert("one fraud outweighs 3 positives (<50)", mixed < 50, `got ${mixed}`);

// Unknown signal types contribute 0 (no crash).
const unknown = computeTrustScore([sig("totally_made_up"), sig("paid_on_time")]);
assert("unknown signal type ignored, no crash", unknown > 50, `got ${unknown}`);

// ---------------------------------------------------------------------------
// trustTier
// ---------------------------------------------------------------------------
assert("tier good at 80", trustTier(80) === "good");
assert("tier caution at 50", trustTier(50) === "caution");
assert("tier avoid at 20", trustTier(20) === "avoid");
assert("tier boundary 65 => good", trustTier(65) === "good");
assert("tier boundary 40 => caution", trustTier(40) === "caution");
assert("tier boundary 39 => avoid", trustTier(39) === "avoid");

// ---------------------------------------------------------------------------
// computeBreakdown
// ---------------------------------------------------------------------------
const bd = computeBreakdown([
  sig("paid_on_time"), sig("paid_on_time"), sig("paid_late"),
  sig("ratecon_honored"), sig("ratecon_reduced_post_bol"),
  sig("fast_response"), sig("no_response"),
  sig("fraud_attempt"), sig("double_brokered"),
]);
assert("breakdown payment.onTime = 2", bd.payment.onTime === 2, `got ${bd.payment.onTime}`);
assert("breakdown payment.late = 1", bd.payment.late === 1, `got ${bd.payment.late}`);
assert("breakdown ratecon.honored = 1", bd.ratecon.honored === 1);
assert("breakdown ratecon.reduced = 1", bd.ratecon.reduced === 1);
assert("breakdown response.fast = 1", bd.response.fast === 1);
assert("breakdown response.none = 1", bd.response.none === 1);
assert("breakdown fraud.count = 2", bd.fraud.count === 2, `got ${bd.fraud.count}`);
assert(
  "breakdown fraud.types has both",
  bd.fraud.types.includes("fraud_attempt") && bd.fraud.types.includes("double_brokered"),
);

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
