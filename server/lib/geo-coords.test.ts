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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
