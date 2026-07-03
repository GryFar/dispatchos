// Eval harness for the AI dispatch advisor (server/lib/ai/dispatch-advisor.ts).
//
// NOT part of smoke — a repeatable quality gauge you run by hand before shipping
// prompt changes:
//
//     npx tsx scripts/eval-advisor.mjs
//
// Each scenario feeds a carrier + already-scored loads to getAiRecommendation and
// checks "golden" expectations with simple, deterministic checks:
//   - pick:     recommendedLoadId is in the acceptable set (the load a good
//               dispatcher should book first);
//   - mentions: the reasoning/watch-outs mention the concepts that scenario is
//               about (deadhead, RPM/PPM, broker risk, soft backhaul, ...).
//
// Without ANTHROPIC_API_KEY the advisor returns null by design, so the harness
// prints a clear "no key" banner and exits 0 (nothing to score) — the scaffold
// still type-runs. With a key it prints a per-scenario table + a summary line;
// run it before and after a prompt edit to see the metric move.

import { getAiRecommendation } from "../server/lib/ai/dispatch-advisor";

// --- builders (only the fields compactLoad / the carrier block actually read) --
function mkLoad(id, o = {}) {
  return {
    id,
    originCity: o.originCity ?? "Dallas",
    originState: o.originState ?? "TX",
    destinationCity: o.destinationCity ?? "Atlanta",
    destinationState: o.destinationState ?? "GA",
    rate: o.rate ?? 2000,
    loadedMiles: o.loadedMiles ?? 780,
    deadheadMiles: o.deadheadMiles ?? 40,
    deadheadRatio: o.deadheadRatio ?? 0.05,
    netPpmTotal: o.netPpmTotal ?? 2.2,
    fuelCost: o.fuelCost ?? 300,
    dispatchScore: o.dispatchScore ?? 70,
    verdict: o.verdict ?? "book",
    counterOffer: o.counterOffer ?? null,
    backhaulScore: o.backhaulScore ?? 70,
    brokerName: o.brokerName ?? "Acme Logistics",
    brokerMc: o.brokerMc ?? "123456",
    fraudRisk: o.fraudRisk ?? 10,
    pickupFeasibility: o.pickupFeasibility ?? "feasible",
    warnings: o.warnings ?? [],
  };
}

function mkCarrier(o = {}) {
  return {
    name: o.name ?? "Ivan Trucking",
    equipment: o.equipment ?? "open_car_hauler",
    targetPpm: o.targetPpm ?? 2.2,
    minimumPpm: o.minimumPpm ?? 1.9,
    currentLocation: o.currentLocation ?? { city: "Dallas", state: "TX", lat: 32.78, lng: -96.8 },
  };
}

const re = (s) => new RegExp(s, "i");

// --- scenarios ---------------------------------------------------------------
// golden.acceptable = load ids a competent dispatcher could book first.
// golden.mentions   = regexes the reasoning+watchOuts SHOULD contain.
const SCENARIOS = [
  {
    name: "clear winner by net PPM",
    carrier: mkCarrier(),
    loads: [
      mkLoad("L-best", { rate: 2600, netPpmTotal: 2.9, dispatchScore: 92, verdict: "book" }),
      mkLoad("L-mid", { rate: 2000, netPpmTotal: 2.1, dispatchScore: 70 }),
      mkLoad("L-low", { rate: 1600, netPpmTotal: 1.7, dispatchScore: 48, verdict: "skip" }),
    ],
    golden: { acceptable: ["L-best"], mentions: [re("per[- ]?mile|ppm|rpm|rate")] },
  },
  {
    name: "high rate but deadhead trap",
    carrier: mkCarrier(),
    loads: [
      // Higher gross rate, but a huge deadhead crushes the NET per-mile.
      mkLoad("L-gross", { rate: 2800, deadheadMiles: 480, deadheadRatio: 0.62, netPpmTotal: 1.8, dispatchScore: 55, verdict: "negotiate" }),
      // Lower gross, near-zero deadhead → better net.
      mkLoad("L-net", { rate: 2200, deadheadMiles: 20, deadheadRatio: 0.03, netPpmTotal: 2.6, dispatchScore: 88, verdict: "book" }),
    ],
    golden: { acceptable: ["L-net"], mentions: [re("deadhead")] },
  },
  {
    name: "soft backhaul at destination",
    carrier: mkCarrier(),
    loads: [
      mkLoad("L-softbh", { rate: 2500, netPpmTotal: 2.7, dispatchScore: 85, backhaulScore: 22, destinationCity: "Presque Isle", destinationState: "ME" }),
      mkLoad("L-hub", { rate: 2100, netPpmTotal: 2.2, dispatchScore: 74, backhaulScore: 80, destinationCity: "Chicago", destinationState: "IL" }),
    ],
    // Either pick can be defensible; the point is the advisor MUST flag the soft
    // outbound market on the Maine load.
    golden: { acceptable: ["L-softbh", "L-hub"], mentions: [re("backhaul|outbound|soft|next load|market")] },
  },
  {
    name: "risky broker on the best-rate load",
    carrier: mkCarrier(),
    loads: [
      mkLoad("L-risky", { rate: 2700, netPpmTotal: 2.8, dispatchScore: 60, fraudRisk: 82, brokerName: "FlyByNight Freight", warnings: ["Low broker trust score"] }),
      mkLoad("L-safe", { rate: 2200, netPpmTotal: 2.3, dispatchScore: 78, fraudRisk: 8, brokerName: "Established Logistics" }),
    ],
    golden: { acceptable: ["L-safe"], mentions: [re("broker|fraud|risk|trust")] },
  },
  {
    name: "everything below carrier minimum PPM",
    carrier: mkCarrier({ minimumPpm: 2.5, targetPpm: 2.9 }),
    loads: [
      mkLoad("L-a", { netPpmTotal: 1.9, dispatchScore: 45, verdict: "negotiate" }),
      mkLoad("L-b", { netPpmTotal: 2.1, dispatchScore: 52, verdict: "negotiate" }),
    ],
    // No load clears the floor; a good advisor negotiates / warns rather than
    // blessing a below-minimum booking.
    golden: { acceptable: ["L-a", "L-b", null], mentions: [re("below|minimum|low|negotiat")] },
  },
  {
    name: "do not recommend a verdict=skip load",
    carrier: mkCarrier(),
    loads: [
      mkLoad("L-skip", { rate: 3000, netPpmTotal: 3.1, dispatchScore: 30, verdict: "skip", warnings: ["Pickup window already passed"] }),
      mkLoad("L-ok", { rate: 2100, netPpmTotal: 2.2, dispatchScore: 76, verdict: "book" }),
    ],
    golden: { acceptable: ["L-ok"], mentions: [re("pickup|window|skip|feasib|passed")] },
  },
  {
    name: "single load — recommend it",
    carrier: mkCarrier(),
    loads: [mkLoad("L-only", { rate: 2300, netPpmTotal: 2.4, dispatchScore: 80 })],
    golden: { acceptable: ["L-only"], mentions: [] },
  },
  {
    name: "tight race — two strong, one weak",
    carrier: mkCarrier(),
    loads: [
      mkLoad("L-x", { rate: 2400, netPpmTotal: 2.5, dispatchScore: 84 }),
      mkLoad("L-y", { rate: 2450, netPpmTotal: 2.55, dispatchScore: 86 }),
      mkLoad("L-z", { rate: 1500, netPpmTotal: 1.6, dispatchScore: 40, verdict: "skip" }),
    ],
    golden: { acceptable: ["L-x", "L-y"], mentions: [re("per[- ]?mile|ppm|rpm|score|net")] },
  },
  {
    name: "pickup not feasible on the top-score load",
    carrier: mkCarrier(),
    loads: [
      mkLoad("L-far", { rate: 2600, netPpmTotal: 2.7, dispatchScore: 88, pickupFeasibility: "infeasible", warnings: ["Cannot reach pickup in time"] }),
      mkLoad("L-reach", { rate: 2200, netPpmTotal: 2.3, dispatchScore: 75, pickupFeasibility: "feasible" }),
    ],
    golden: { acceptable: ["L-reach"], mentions: [re("pickup|reach|time|feasib")] },
  },
  {
    name: "negotiate opportunity (counter-offer present)",
    carrier: mkCarrier(),
    loads: [
      mkLoad("L-neg", { rate: 1900, netPpmTotal: 2.0, dispatchScore: 66, verdict: "negotiate", counterOffer: 2200 }),
      mkLoad("L-flat", { rate: 2050, netPpmTotal: 2.15, dispatchScore: 72, verdict: "book" }),
    ],
    golden: { acceptable: ["L-neg", "L-flat"], mentions: [re("negotiat|counter|offer|ask")] },
  },
];

// --- scoring -----------------------------------------------------------------
function scoreScenario(rec, golden) {
  const haystack = `${rec.reasoning} ${(rec.watchOuts ?? []).join(" ")}`;
  const pick = golden.acceptable.includes(rec.recommendedLoadId);
  const mentions = (golden.mentions ?? []).every((r) => r.test(haystack));
  return { pick, mentions };
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

// Structural guard on the golden set — runs on EVERY invocation (even without a
// key), so a malformed scenario (an acceptable id absent from the scenario's
// loads, an empty acceptable set, a non-RegExp mention) is caught here instead
// of surfacing as a mysterious ✗ mid-run or silently wasting a keyed call.
function validateScenarios() {
  const errs = [];
  for (const s of SCENARIOS) {
    if (!s.loads || s.loads.length === 0) {
      errs.push(`"${s.name}": no loads`);
      continue;
    }
    const ids = new Set(s.loads.map((l) => l.id));
    const acc = s.golden?.acceptable ?? [];
    if (acc.length === 0) errs.push(`"${s.name}": golden.acceptable is empty`);
    for (const id of acc) {
      if (id !== null && !ids.has(id)) {
        errs.push(`"${s.name}": acceptable "${id}" is not one of this scenario's loads`);
      }
    }
    for (const r of s.golden?.mentions ?? []) {
      if (!(r instanceof RegExp)) errs.push(`"${s.name}": a golden.mentions entry is not a RegExp`);
    }
  }
  return errs;
}

async function main() {
  // Validate the goldens up front — a broken scenario fails loudly here (exit 1)
  // rather than surfacing as a mysterious ✗ mid-run or wasting a keyed call.
  const problems = validateScenarios();
  if (problems.length > 0) {
    console.error("ADVISOR EVAL — scenario definition errors:");
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("─".repeat(72));
    console.log("ADVISOR EVAL — no ANTHROPIC_API_KEY set.");
    console.log(`Scaffold OK: ${SCENARIOS.length} scenarios wired + goldens validated. The advisor returns`);
    console.log("null without a key, so there is nothing to score. Set the key and re-run:");
    console.log("    ANTHROPIC_API_KEY=sk-... npx tsx scripts/eval-advisor.mjs");
    console.log("─".repeat(72));
    process.exit(0);
  }

  console.log(pad("#", 3), pad("scenario", 40), pad("pick", 5), pad("ment", 5), "recommended / conf");
  console.log("─".repeat(90));

  let pickHits = 0;
  let mentionHits = 0;
  let scored = 0;

  for (let i = 0; i < SCENARIOS.length; i++) {
    const s = SCENARIOS[i];
    let rec = null;
    try {
      rec = await getAiRecommendation(s.carrier, s.loads);
    } catch (err) {
      console.log(pad(i + 1, 3), pad(s.name, 40), "ERR", "", String(err?.message ?? err).slice(0, 40));
      continue;
    }
    if (!rec) {
      console.log(pad(i + 1, 3), pad(s.name, 40), pad("—", 5), pad("—", 5), "advisor returned null");
      continue;
    }
    scored++;
    const { pick, mentions } = scoreScenario(rec, s.golden);
    if (pick) pickHits++;
    if (mentions) mentionHits++;
    console.log(
      pad(i + 1, 3),
      pad(s.name, 40),
      pad(pick ? "✓" : "✗", 5),
      pad(mentions ? "✓" : "✗", 5),
      `${rec.recommendedLoadId ?? "none"} @ ${rec.confidence}`,
    );
  }

  console.log("─".repeat(90));
  console.log(
    `SUMMARY  scored ${scored}/${SCENARIOS.length}  |  pick ${pickHits}/${scored}  |  mentions ${mentionHits}/${scored}`,
  );
  // Non-zero exit if the advisor could not be scored at all (misconfig), so a CI
  // wrapper — if you ever add one — notices. Quality thresholds stay a human call.
  process.exit(scored === 0 ? 1 : 0);
}

void main();
