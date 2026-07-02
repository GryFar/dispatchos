// geocodeCityState unit tests. Run: npx tsx server/lib/geo-coords.test.ts
//
// Email-sourced loads carried lat/lng=0,0, so the scorer's deadhead distance
// (carrier -> origin) was nonsense and those loads were unrankable. This offline
// geocoder resolves city/state so they score. Major metros resolve precisely;
// everything else falls back to the state centroid; unknown state -> null.

import { geocodeCityState } from "./geo-coords";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a: number, b: number, eps = 0.2) => Math.abs(a - b) < eps;

// exact city match
const atl = geocodeCityState("Atlanta", "GA");
assert("Atlanta, GA → ~33.75,-84.39", !!atl && near(atl.lat, 33.75) && near(atl.lng, -84.39), JSON.stringify(atl));
const dal = geocodeCityState("Dallas", "TX");
assert("Dallas, TX → ~32.78,-96.80", !!dal && near(dal.lat, 32.78) && near(dal.lng, -96.80));

// case / punctuation insensitive
const stl = geocodeCityState("St. Louis", "mo");
assert("'St. Louis', 'mo' normalizes to a city hit", !!stl && near(stl.lat, 38.63), JSON.stringify(stl));

// unknown city in a known state → state centroid (not 0,0, not null)
const someTx = geocodeCityState("Tinytown", "TX");
assert("unknown TX city → TX centroid", !!someTx && near(someTx.lat, 31.5) && near(someTx.lng, -99.3), JSON.stringify(someTx));

// blank city but known state → centroid
const blankCity = geocodeCityState("", "FL");
assert("blank city + FL → FL centroid", !!blankCity && near(blankCity.lat, 28.6));

// unknown / blank state → null (caller keeps 0,0 fallback)
assert("unknown state → null", geocodeCityState("Nowhere", "ZZ") === null);
assert("blank state → null", geocodeCityState("Nowhere", "") === null);

// the core property: a real city is NOT at the origin (0,0) — the whole bug
assert("result is never 0,0 for a known place", (() => {
  const c = geocodeCityState("Chicago", "IL")!;
  return c.lat !== 0 && c.lng !== 0;
})());

// returns a fresh object (no shared-ref mutation risk)
const a = geocodeCityState("Miami", "FL")!;
a.lat = 999;
const b = geocodeCityState("Miami", "FL")!;
assert("returns a copy (no mutation leak)", b.lat !== 999);

// ---------------------------------------------------------------------------
// REGRESSION GUARD: the "Ft Worth" abbreviation alias must resolve to the SAME
// precise coords as the fully-spelled "Fort Worth". Email-parsed lanes routinely
// abbreviate "Fort" -> "Ft". Without the "ft worth|TX" alias entry, "Ft Worth"
// misses the city map and falls back to the TX state centroid (31.5,-99.3) —
// i.e. NOT equal to Fort Worth's (32.76,-97.33). These assertions PASS on the
// current (fixed) code and would have FAILED before the alias was added.
// A teammate refactoring CITY_COORDS nearby cannot silently drop the alias.
const fortWorth = geocodeCityState("Fort Worth", "TX");
const ftWorth = geocodeCityState("Ft Worth", "TX");
// Sanity: the canonical spelling resolves to the known Fort Worth metro coords.
assert(
  "Fort Worth, TX → ~32.76,-97.33 (precise metro, not state centroid)",
  !!fortWorth && near(fortWorth.lat, 32.76) && near(fortWorth.lng, -97.33),
  JSON.stringify(fortWorth),
);
// The abbreviation must hit the SAME precise coords (the actual fix being locked).
assert(
  "Ft Worth, TX → ~32.76,-97.33 (alias hits precise metro, not centroid)",
  !!ftWorth && near(ftWorth.lat, 32.76) && near(ftWorth.lng, -97.33),
  JSON.stringify(ftWorth),
);
// Exact-equality cross-check: alias and canonical must return identical coords.
assert(
  "'Ft Worth' resolves to the SAME coords as 'Fort Worth'",
  !!fortWorth && !!ftWorth && ftWorth.lat === fortWorth.lat && ftWorth.lng === fortWorth.lng,
  JSON.stringify({ fortWorth, ftWorth }),
);
// And it must NOT have silently degraded to the TX centroid (the pre-fix miss).
assert(
  "'Ft Worth' is NOT the TX centroid (would mean the alias was lost)",
  !!ftWorth && !(near(ftWorth.lat, 31.5) && near(ftWorth.lng, -99.3)),
  JSON.stringify(ftWorth),
);
// Lowercase + trailing-period variant ("ft. worth") normalizes to the same hit,
// proving normCity strips the period/case rather than re-introducing a miss.
const ftWorthDot = geocodeCityState("ft. worth", "tx");
assert(
  "'ft. worth', 'tx' normalizes to the Fort Worth metro hit",
  !!ftWorthDot && ftWorthDot.lat === fortWorth!.lat && ftWorthDot.lng === fortWorth!.lng,
  JSON.stringify(ftWorthDot),
);

// ---------------------------------------------------------------------------
// REGRESSION GUARD: documented miss behavior for an UNKNOWN city in an UNKNOWN
// state. The contract is: unknown/blank state → null (the caller then keeps its
// 0,0 fallback). This must return exactly `null` (not undefined, not 0,0, not a
// thrown error). Locks the documented null contract against a refactor that
// might start returning {0,0} or undefined.
const unknownCity = geocodeCityState("Nonexistent Burg", "ZZ");
assert(
  "unknown city in unknown state → exactly null (documented miss)",
  unknownCity === null,
  JSON.stringify(unknownCity),
);
// A real-looking but unmapped city in an UNKNOWN state is still a hard null —
// the city map can't rescue it without a valid state.
assert(
  "unmapped city + unknown state → null (not a stray city hit)",
  geocodeCityState("Springfield", "ZZ") === null,
);
// Whitespace-only / null-ish inputs also resolve to the documented null miss.
assert("null city + unknown state → null", geocodeCityState(null, "ZZ") === null);
assert("blank everything → null", geocodeCityState("", "") === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
