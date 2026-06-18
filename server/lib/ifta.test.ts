// IFTA pure-helper tests.
// Run: npx tsx server/lib/ifta.test.ts
//
// Covers the deterministic, DB-free parts of the IFTA quarterly aggregator:
//   - lookupState: coordinate -> US state via bbox (interior points only;
//     borders are intentionally approximate per the module header).
//   - renderIftaCsv: report object -> CSV text.
// buildIftaQuarterly itself reads the DB and is exercised by smoke separately.

import { lookupState, renderIftaCsv, type IftaQuarterReport } from "./ifta";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(name: string, got: unknown, want: unknown) {
  assert(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ---------------------------------------------------------------------------
// lookupState — interior points of a few states + a non-US point
// ---------------------------------------------------------------------------
eq("Dallas TX", lookupState(32.78, -96.80), "TX");
eq("Atlanta GA", lookupState(33.75, -84.39), "GA");
eq("Denver CO", lookupState(39.74, -104.99), "CO");
eq("Miami FL", lookupState(25.95, -80.20), "FL");
eq("mid-Atlantic ocean -> null", lookupState(30.0, -45.0), null);
eq("Antarctica -> null", lookupState(-70.0, 0.0), null);

// ---------------------------------------------------------------------------
// renderIftaCsv — structure + numbers + unattributed footer
// ---------------------------------------------------------------------------
{
  const report: IftaQuarterReport = {
    clientId: "carrier-1",
    year: 2026,
    quarter: 2,
    periodStart: "2026-04-01T00:00:00.000Z",
    periodEnd: "2026-07-01T00:00:00.000Z",
    rows: [
      { state: "TX", miles: 1200.5, gallons: 180.25, fuelCostUsd: 720.5 },
      { state: "OK", miles: 300, gallons: 45, fuelCostUsd: 180 },
    ],
    totals: { miles: 1500.5, gallons: 225.25, fuelCostUsd: 900.5, avgMpg: 6.66 },
    unknownStateMiles: 12.3,
    unknownStateGallons: 2.1,
    generatedAt: "2026-07-02T10:00:00.000Z",
  };
  const csv = renderIftaCsv(report);
  const lines = csv.split("\n");

  assert("header names client + quarter", lines[0].includes("carrier-1") && lines[0].includes("2026 Q2"));
  assert("has column header row", csv.includes("State,Miles,Gallons,Fuel Cost (USD)"));
  assert("TX row present", csv.includes("TX,1200.5,180.25,720.50"));
  assert("OK row present", csv.includes("OK,300,45,180.00"));
  assert("TOTAL row present", csv.includes("TOTAL,1500.5,225.25,900.50"));
  assert("avg mpg row present", csv.includes("Avg MPG,6.66"));
  assert("unattributed footer present", csv.includes("Unattributed (no state match),12.3 mi,2.1 gal"));
}

// avgMpg null → no Avg MPG line; no unattributed when both zero.
{
  const report: IftaQuarterReport = {
    clientId: "c2",
    year: 2026,
    quarter: 1,
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: "2026-04-01T00:00:00.000Z",
    rows: [],
    totals: { miles: 0, gallons: 0, fuelCostUsd: 0, avgMpg: null },
    unknownStateMiles: 0,
    unknownStateGallons: 0,
    generatedAt: "2026-04-02T10:00:00.000Z",
  };
  const csv = renderIftaCsv(report);
  assert("no Avg MPG line when null", !csv.includes("Avg MPG"));
  assert("no unattributed line when zero", !csv.includes("Unattributed"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
