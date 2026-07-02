// parseLimit tests.
// Run: npx tsx server/lib/query.test.ts

import { parseLimit } from "./query";

let pass = 0;
let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  if (got === want) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.error(`✗ ${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

// Valid numeric strings pass through (floored).
eq("plain number string", parseLimit("50"), 50);
eq("number value", parseLimit(25), 25);
eq("float is floored", parseLimit("12.9"), 12);

// The bug this guards: non-numeric -> undefined (NOT NaN), so storage clamps.
eq("non-numeric -> undefined", parseLimit("abc"), undefined);
eq("empty string -> undefined", parseLimit(""), undefined);
eq("undefined -> undefined", parseLimit(undefined), undefined);
eq("zero -> undefined", parseLimit("0"), undefined);
eq("negative -> undefined", parseLimit("-5"), undefined);
eq("Infinity -> undefined", parseLimit("Infinity"), undefined);
eq("array -> undefined", parseLimit(["1", "2"]), undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
