// normalizeNsc unit tests. Run: npx tsx server/lib/nsc.test.ts
//
// Locks the Canadian NSC namespace: an NSC normalizes to "NSC-<digits>", which
// must NEVER equal normalizeMc()'s "MC-<digits>" for the same digits — that
// disjointness is the whole point (no cross-namespace collision in the unique
// mc_account_registry, V4-011).

import { normalizeNsc } from "./nsc";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, got: unknown, want: unknown) =>
  assert(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// Bare digits → NSC-prefixed key.
eq("bare digits", normalizeNsc("1234567"), "NSC-1234567");
// A typed "NSC-" prefix is not doubled.
eq("with NSC- prefix", normalizeNsc("NSC-1234567"), "NSC-1234567");
// Case + spacing insensitive.
eq("lowercase + space", normalizeNsc("nsc 1234567"), "NSC-1234567");
// First contiguous digit run only (mirrors normalizeMc V4-007).
eq("suffix junk dropped", normalizeNsc("NSC-9001-X2"), "NSC-9001");
// A provincial-looking prefix still yields the digit run.
eq("provincial prefix", normalizeNsc("ON-45678"), "NSC-45678");

// The load-bearing property: disjoint from the MC namespace. We reproduce
// normalizeMc's output shape ("MC-<digits>") locally and assert inequality, so
// this test fails loudly if normalizeNsc ever starts emitting an MC-style key.
{
  const digits = "1234567";
  const nsc = normalizeNsc(digits);
  const mcStyle = `MC-${digits}`;
  assert("NSC key is NOT the MC key for the same digits", nsc !== mcStyle, `${nsc} vs ${mcStyle}`);
  assert("NSC key carries the NSC- prefix", nsc.startsWith("NSC-"), nsc);
}

// No digits → non-empty fallback (keeps a claimable key; never returns "").
eq("no digits falls back to raw", normalizeNsc("ABC"), "ABC");
assert("blank stays blank (guarded upstream)", normalizeNsc("") === "");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
