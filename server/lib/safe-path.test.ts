// Run: npx tsx server/lib/safe-path.test.ts
import { sanitizePathSegment, isWithinDir } from "./safe-path";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}
const noSep = (s: string) => !s.includes("..") && !s.includes("/") && !s.includes("\\");

assert("normal name unchanged", sanitizePathSegment("MC123_Acme_Trucking") === "MC123_Acme_Trucking");
assert("posix traversal neutralized", noSep(sanitizePathSegment("../../etc/passwd")), sanitizePathSegment("../../etc/passwd"));
assert("windows traversal neutralized", noSep(sanitizePathSegment("MC1_..\\..\\win")), sanitizePathSegment("MC1_..\\..\\win"));
assert("leading dots stripped", !sanitizePathSegment(".hidden").startsWith("."));
assert("empty becomes unnamed", sanitizePathSegment("   ") === "unnamed");
assert("within dir true", isWithinDir("/data/drive", "/data/drive/MC1_Acme") === true);
assert("escape via .. false", isWithinDir("/data/drive", "/data/drive/../etc") === false);
assert("absolute escape false", isWithinDir("/data/drive", "/etc/passwd") === false);
assert("equal dir true", isWithinDir("/data/drive", "/data/drive") === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
