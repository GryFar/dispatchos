// Invite-code generator tests.
// Run: npx tsx server/lib/invite-code.test.ts
//
// V5-006 replaced two weak ad-hoc generators with one CSPRNG source of truth.
// Locks in the format, the look-alike-free alphabet, and practical uniqueness.

import { generateInviteCode } from "./invite-code";

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

const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no I O L U 0 1
const FORMAT = /^DOS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

const sample = generateInviteCode();
assert("matches DOS-XXXX-...x5 format", FORMAT.test(sample), sample);
assert("total length 28", sample.length === 28, String(sample.length));

// Every payload char is in the look-alike-free alphabet (no I/O/L/U/0/1).
{
  const body = generateInviteCode().replace(/^DOS-/, "").replace(/-/g, "");
  assert("20 payload chars", body.length === 20, String(body.length));
  assert(
    "all chars in safe alphabet",
    [...body].every((c) => ALPHABET.includes(c)),
    body,
  );
  assert("no look-alike chars", !/[IOLU01]/.test(body), body);
}

// Practical uniqueness: 2000 codes, no collision (98 bits of entropy).
{
  const seen = new Set<string>();
  let dupes = 0;
  for (let i = 0; i < 2000; i += 1) {
    const code = generateInviteCode();
    if (seen.has(code)) dupes += 1;
    seen.add(code);
    if (!FORMAT.test(code)) {
      assert("every generated code matches format", false, code);
      break;
    }
  }
  assert("2000 codes, zero collisions", dupes === 0, `dupes=${dupes}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
