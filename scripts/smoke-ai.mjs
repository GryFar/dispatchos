// AI module smoke harness.
//
// Runs every *.test.ts under server/lib/ai/ via tsx and aggregates results.
// Each test file is independent and does its own pass/fail counting.
// We just enforce that none exit with a non-zero code.
//
// Used by `npm run smoke:ai` and as part of the full `smoke` flow.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const aiDir = path.resolve(here, "..", "server", "lib", "ai");

let total = 0;
let failed = 0;
const startedAt = Date.now();

const testFiles = readdirSync(aiDir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort();

if (testFiles.length === 0) {
  console.error("[FAIL] No AI test files found in server/lib/ai/");
  process.exit(1);
}

console.log(`[smoke:ai] running ${testFiles.length} AI test files\n`);

for (const file of testFiles) {
  const full = path.join(aiDir, file);
  const result = spawnSync("npx", ["tsx", full], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  const stdout = result.stdout ?? "";
  const lastLine = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((l) => /\d+\s+passed/.test(l));

  if (result.status !== 0) {
    failed++;
    console.error(`[FAIL] ${file}`);
    console.error(stdout);
    if (result.stderr) console.error(result.stderr);
  } else {
    total++;
    console.log(`[OK]   ${file.padEnd(28)} ${lastLine ?? "(no summary)"}`);
  }
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\n[smoke:ai] ${total}/${testFiles.length} passed in ${elapsed}s`);
process.exit(failed > 0 ? 1 : 0);
