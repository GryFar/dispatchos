// Pure-module smoke harness.
//
// Runs every *.test.ts under server/ (recursively — libs, routes, auth) via
// tsx and aggregates results. Each test file is independent and does its own
// pass/fail counting; we enforce that none exit with a non-zero code.
//
// Used by `npm run smoke:ai` and as part of the full `smoke` flow.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "..", "server");

function collectTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTests(full));
    else if (entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

let total = 0;
let failed = 0;
const startedAt = Date.now();

const testFiles = collectTests(serverDir).sort();

if (testFiles.length === 0) {
  console.error("[FAIL] No test files found under server/");
  process.exit(1);
}

console.log(`[smoke:ai] running ${testFiles.length} test files\n`);

for (const full of testFiles) {
  const label = path.relative(serverDir, full);
  const result = spawnSync("npx", ["tsx", full], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    // On Windows `npx` is `npx.cmd`; spawnSync can't resolve it without a shell.
    shell: process.platform === "win32",
  });

  const stdout = result.stdout ?? "";
  const lastLine = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((l) => /\d+\s+passed/.test(l));

  if (result.status !== 0) {
    failed++;
    console.error(`[FAIL] ${label}`);
    console.error(stdout);
    if (result.stderr) console.error(result.stderr);
  } else {
    total++;
    console.log(`[OK]   ${label.padEnd(28)} ${lastLine ?? "(no summary)"}`);
  }
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\n[smoke:ai] ${total}/${testFiles.length} passed in ${elapsed}s`);
process.exit(failed > 0 ? 1 : 0);
