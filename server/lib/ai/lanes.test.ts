// Lane intelligence tests.
// Run: npx tsx server/lib/ai/lanes.test.ts

import { regionFor, quoteLane, classifyOffer } from "./lanes";

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
// Done
// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
