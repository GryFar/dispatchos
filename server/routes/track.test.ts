// Unit tests for parseTimestamp freshness clamp (audit #13).
// Run: npx tsx server/routes/track.test.ts
//
// A device (or anyone holding a tracking_token) can send an arbitrary
// timestamp. We must clamp to [now-5min, now+1min] so forged stamps can't be
// attributed to another IFTA quarter; out-of-window input falls back to now().

import { parseTimestamp } from "./track";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed += 1;
    console.log(`  \u2713 ${msg}`);
  } else {
    failed += 1;
    console.log(`  \u2717 ${msg}`);
  }
}

function withinSecondsOfNow(iso: string, seconds: number): boolean {
  return Math.abs(Date.parse(iso) - Date.now()) <= seconds * 1000;
}

console.log("parseTimestamp — freshness clamp (#13)");

// 1. Empty / missing → now()
assert(withinSecondsOfNow(parseTimestamp(undefined), 2), "undefined → now()");
assert(withinSecondsOfNow(parseTimestamp(""), 2), "empty string → now()");

// 2. Non-numeric → now()
assert(withinSecondsOfNow(parseTimestamp("not-a-number"), 2), "garbage → now()");

// 3. A timestamp a year in the past (forged) → clamped to now()
const oneYearAgoSec = Math.floor((Date.now() - 365 * 24 * 3600 * 1000) / 1000);
assert(
  withinSecondsOfNow(parseTimestamp(oneYearAgoSec), 2),
  "1-year-old unix-seconds → clamped to now()",
);

// 4. A timestamp far in the future (forged) → clamped to now()
const farFutureSec = Math.floor((Date.now() + 10 * 24 * 3600 * 1000) / 1000);
assert(
  withinSecondsOfNow(parseTimestamp(farFutureSec), 2),
  "10-days-future unix-seconds → clamped to now()",
);

// 5. A fresh timestamp (2 min ago) → preserved, NOT overwritten
const twoMinAgoMs = Date.now() - 2 * 60 * 1000;
const preserved = parseTimestamp(twoMinAgoMs);
assert(
  Math.abs(Date.parse(preserved) - twoMinAgoMs) < 1500,
  "2-min-ago millis → preserved (within window)",
);

// 6. Just inside the past edge (~4.5 min ago) → preserved
const fourishMinAgoMs = Date.now() - 4.5 * 60 * 1000;
assert(
  Math.abs(Date.parse(parseTimestamp(fourishMinAgoMs)) - fourishMinAgoMs) < 1500,
  "4.5-min-ago → preserved (inside 5-min window)",
);

// 7. Just outside the past edge (~6 min ago) → clamped to now()
const sixMinAgoMs = Date.now() - 6 * 60 * 1000;
assert(
  withinSecondsOfNow(parseTimestamp(sixMinAgoMs), 2),
  "6-min-ago → clamped to now() (outside window)",
);

// 8. Unix-seconds vs millis heuristic: a fresh seconds value is upscaled.
const nowSec = Math.floor(Date.now() / 1000);
assert(
  withinSecondsOfNow(parseTimestamp(nowSec), 2),
  "fresh unix-seconds → parsed as seconds, preserved",
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
