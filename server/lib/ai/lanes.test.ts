// Lane intelligence tests.
// Run: npx tsx server/lib/ai/lanes.test.ts

import { regionFor, quoteLane, classifyOffer, outboundMarketScore, observedLaneQualityAdjustment, MIN_LANE_OBSERVATIONS } from "./lanes";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ---------------------------------------------------------------------------
// Region mapping
// ---------------------------------------------------------------------------
{
  assert("region: FL → SE", regionFor("FL") === "SE");
  assert("region: NY → NE", regionFor("NY") === "NE");
  assert("region: TX → GLF", regionFor("TX") === "GLF");
  assert("region: CA → CA", regionFor("CA") === "CA");
  assert("region: lowercase", regionFor("ga") === "SE");
  assert("region: unknown → MW fallback", regionFor("XX") === "MW");
}

// ---------------------------------------------------------------------------
// Lane quote — strong lanes
// ---------------------------------------------------------------------------
{
  // FL → NY in May (peak produce season + premium lane)
  const q = quoteLane({ originState: "FL", destState: "NY", equipment: "van", asOfDate: "2026-05-15" });
  assert("quote: FL→NY produce season > $2.50/mi",
    q.baselinePpm >= 2.50, `got ${q.baselinePpm}`);
  assert("quote: FL→NY high market quality", q.marketQuality >= 70, `got ${q.marketQuality}`);
  assert("quote: FL→NY confidence ≥ 80", q.confidence >= 80);
  assert("quote: FL→NY classified premium lane", q.source === "regional_pair");

  // GA → CA backhaul direction
  const q2 = quoteLane({ originState: "GA", destState: "CA", equipment: "van", asOfDate: "2026-05-15" });
  assert("quote: SE→CA returns valid baseline", q2.baselinePpm > 0);
}

// ---------------------------------------------------------------------------
// Equipment multipliers
// ---------------------------------------------------------------------------
{
  const open = quoteLane({ originState: "FL", destState: "GA", equipment: "open_car_hauler", asOfDate: "2026-03-15" });
  const enclosed = quoteLane({ originState: "FL", destState: "GA", equipment: "enclosed_car_hauler", asOfDate: "2026-03-15" });
  const hotshot = quoteLane({ originState: "FL", destState: "GA", equipment: "hotshot_flatbed", asOfDate: "2026-03-15" });
  const sprinter = quoteLane({ originState: "FL", destState: "GA", equipment: "sprinter_van", asOfDate: "2026-03-15" });

  assert("equip: enclosed > open", enclosed.baselinePpm > open.baselinePpm);
  assert("equip: open > hotshot", open.baselinePpm > hotshot.baselinePpm);
  assert("equip: enclosed ~42% premium over open",
    Math.abs(enclosed.baselinePpm / open.baselinePpm - 1.42) < 0.05);
  assert("equip: sprinter ~5% premium",
    Math.abs(sprinter.baselinePpm / open.baselinePpm - 1.05) < 0.05);
}

// ---------------------------------------------------------------------------
// Seasonal factor
// ---------------------------------------------------------------------------
{
  const jan = quoteLane({ originState: "OH", destState: "IN", equipment: "van", asOfDate: "2026-01-10" });
  const may = quoteLane({ originState: "OH", destState: "IN", equipment: "van", asOfDate: "2026-05-10" });
  const nov = quoteLane({ originState: "OH", destState: "IN", equipment: "van", asOfDate: "2026-11-10" });
  assert("seasonal: Nov > May", nov.baselinePpm > may.baselinePpm, `nov=${nov.baselinePpm} may=${may.baselinePpm}`);
  assert("seasonal: May > Jan", may.baselinePpm > jan.baselinePpm);
  assert("seasonal: Jan ~8% below normal", jan.seasonalFactor === 0.92);
  assert("seasonal: Nov ~18% above normal", nov.seasonalFactor === 1.18);
}

// ---------------------------------------------------------------------------
// Backhaul fallback
// ---------------------------------------------------------------------------
{
  // Unknown origin state — falls back to MW region; FL stays SE.
  // MW>SE pair exists, so confidence should be 80 (regional pair direct).
  const q1 = quoteLane({ originState: "XX", destState: "FL", equipment: "open_car_hauler" });
  assert("fallback: unknown origin returns valid quote", q1.baselinePpm > 0);
  assert("fallback: still uses regional pair", q1.source === "regional_pair");
}

// ---------------------------------------------------------------------------
// Offer classification
// ---------------------------------------------------------------------------
{
  const lane = quoteLane({ originState: "FL", destState: "GA", equipment: "open_car_hauler", asOfDate: "2026-05-15" });

  // Strong offer: 20% above baseline
  const strong = classifyOffer(lane.baselinePpm * 1.25 * 400, 400, lane);
  assert("classify: 25% above → premium", strong.classification === "premium", `got ${strong.classification}`);
  assert("classify: premium → book", strong.recommendedAction === "book");

  // Fair offer: 10% below baseline
  const fair = classifyOffer(lane.baselinePpm * 0.90 * 400, 400, lane);
  assert("classify: 10% below → fair", fair.classification === "fair", `got ${fair.classification}`);
  assert("classify: fair → counter", fair.recommendedAction === "counter");
  assert("classify: fair has counter offer", fair.suggestedCounter !== null);
  assert("classify: counter rounded to $25",
    fair.suggestedCounter !== null && fair.suggestedCounter % 25 === 0);

  // Lowball: 50% below
  const lowball = classifyOffer(lane.baselinePpm * 0.50 * 400, 400, lane);
  assert("classify: 50% below → lowball", lowball.classification === "lowball");
  assert("classify: lowball → skip", lowball.recommendedAction === "skip");
}

// ---------------------------------------------------------------------------
// Backhaul / outbound-market score
// ---------------------------------------------------------------------------
{
  const tx = outboundMarketScore("TX", "open_car_hauler");   // GLF — high outbound
  const ga = outboundMarketScore("GA", "open_car_hauler");   // SE — strong (FL produce)
  const ks = outboundMarketScore("KS", "open_car_hauler");   // GP — ag-heavy, weak outbound

  assert("outbound: TX in 0..100", tx > 0 && tx <= 100, `tx=${tx}`);
  assert("outbound: GA in 0..100", ga > 0 && ga <= 100, `ga=${ga}`);
  assert("outbound: KS in 0..100", ks > 0 && ks <= 100, `ks=${ks}`);

  // Strong outbound regions must beat the ag-heavy plains — the whole point of
  // the signal is to reflect how easy it is to get the NEXT load out.
  assert("outbound: GLF(TX) >= GP(KS)", tx >= ks, `tx=${tx} ks=${ks}`);
  assert("outbound: SE(GA) >= GP(KS)", ga >= ks, `ga=${ga} ks=${ks}`);

  // Deterministic — same inputs, same output (pure benchmark lookup).
  assert("outbound: deterministic", outboundMarketScore("TX", "open_car_hauler") === tx);

  // Unknown state falls back to a region (regionFor → "MW") and still scores.
  const zz = outboundMarketScore("ZZ", "open_car_hauler");
  assert("outbound: unknown state still scores 0..100", zz > 0 && zz <= 100, `zz=${zz}`);

  // Equipment changes the economics → the score can move with it.
  const txEnclosed = outboundMarketScore("TX", "enclosed_car_hauler");
  assert("outbound: enclosed (higher PPM) >= open for TX", txEnclosed >= tx, `enc=${txEnclosed} open=${tx}`);
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Observed-rate lane quality refinement (completes the lane_history pipeline)
// ---------------------------------------------------------------------------
{
  const eq = "open_car_hauler" as const;
  const bench = quoteLane({ originState: "GA", destState: "FL", equipment: eq }).baselinePpm;

  // cold-start / missing data -> no adjustment (non-regressive at launch)
  assert("observed: undefined -> 0", observedLaneQualityAdjustment("GA", "FL", eq, undefined) === 0);
  assert("observed: too few data points -> 0", observedLaneQualityAdjustment("GA", "FL", eq, { avgPpm: 9, loadsSeen: MIN_LANE_OBSERVATIONS - 1 }) === 0);
  assert("observed: zero avgPpm -> 0", observedLaneQualityAdjustment("GA", "FL", eq, { avgPpm: 0, loadsSeen: 50 }) === 0);

  // a hot lane (paying well above benchmark) -> positive boost, clamped at +15
  const hot = observedLaneQualityAdjustment("GA", "FL", eq, { avgPpm: bench * 2, loadsSeen: 50 });
  assert("observed: hot lane boosts quality", hot > 0, `${hot}`);
  assert("observed: boost clamped to +15", hot <= 15);

  // a soft lane (paying well below benchmark) -> negative, clamped at -15
  const soft = observedLaneQualityAdjustment("GA", "FL", eq, { avgPpm: bench * 0.4, loadsSeen: 50 });
  assert("observed: soft lane reduces quality", soft < 0, `${soft}`);
  assert("observed: reduction clamped to -15", soft >= -15);

  // at benchmark -> ~no change
  const flat = observedLaneQualityAdjustment("GA", "FL", eq, { avgPpm: bench, loadsSeen: 50 });
  assert("observed: at benchmark -> ~0", Math.abs(flat) < 0.001, `${flat}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
