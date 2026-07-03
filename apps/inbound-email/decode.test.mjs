// Standalone tests for the inbound-email worker's pure helpers.
// Run: node apps/inbound-email/decode.test.mjs
//
// Not collected by `npm run smoke:ai` (that globs server/**), because the
// worker is a separately-deployed Cloudflare Worker (deploy-inbound-email.yml).
// Importing worker.js here also syntax-checks the ESM module.

import assert from "node:assert/strict";
import { decodeTransferEncoding, classifyIngestOutcome } from "./src/worker.js";

let pass = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { console.error(`FAIL ${name}${detail ? " — " + detail : ""}`); process.exitCode = 1; }
}

// --- quoted-printable ---
ok(
  "QP: =3D decodes to =",
  decodeTransferEncoding("rate =3D $2=2C400", "quoted-printable") === "rate = $2,400",
);
ok(
  "QP: soft line break =\\r\\n is removed (joins wrapped lines)",
  decodeTransferEncoding("Chicago, IL =\r\nto Dallas, TX", "quoted-printable") ===
    "Chicago, IL to Dallas, TX",
);

// --- base64 ---
const b64 = Buffer.from("Load: Reefer, $3,100, 1200mi", "utf8").toString("base64");
ok(
  "base64 decodes to original text",
  decodeTransferEncoding(b64, "base64") === "Load: Reefer, $3,100, 1200mi",
);
ok(
  "base64 with whitespace/newlines still decodes",
  decodeTransferEncoding(b64.slice(0, 8) + "\r\n" + b64.slice(8), "base64") ===
    "Load: Reefer, $3,100, 1200mi",
);
ok(
  "invalid base64 falls back to raw text (no throw)",
  decodeTransferEncoding("@@@not-base64@@@", "base64") === "@@@not-base64@@@",
);

// --- passthrough ---
ok("7bit passes through unchanged", decodeTransferEncoding("plain body", "7bit") === "plain body");
ok("undefined encoding passes through", decodeTransferEncoding("plain body", undefined) === "plain body");

// --- ingest outcome classification ---
ok("200 → ok", classifyIngestOutcome(200) === "ok");
ok("204 → ok", classifyIngestOutcome(204) === "ok");
ok("null (network throw) → retry", classifyIngestOutcome(null) === "retry");
ok("500 → retry", classifyIngestOutcome(500) === "retry");
ok("503 → retry", classifyIngestOutcome(503) === "retry");
ok("401 secret drift → retry (don't lose mail)", classifyIngestOutcome(401) === "retry");
ok("403 → retry", classifyIngestOutcome(403) === "retry");
ok("400 our bad payload → accept (not retry-fixable)", classifyIngestOutcome(400) === "accept");
ok("404 → accept", classifyIngestOutcome(404) === "accept");

console.log(`\n${pass} checks passed`);
