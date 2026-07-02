// emailIngestSchema size-bound tests.
// Run: npx tsx server/lib/email-ingest-bounds.test.ts
//
// Locks in the DoS guard: email-ingest fields must be length-bounded so a
// malicious/buggy sender can't write multi-MB blobs into email_ingest.

import { emailIngestSchema } from "../../shared/schema";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

// Valid payload passes.
assert(
  "normal email passes",
  emailIngestSchema.safeParse({ from: "a@b.com", subject: "Load", body: "hello world" }).success,
);

// Oversized body rejected (DoS / ReDoS guard). The cap was lowered from 1 MB to
// 64 KB so an attacker can't feed a huge '<'-bomb / all-letter body into the
// synchronous O(n^2) HTML-strip + greedy lane regex in the email parsers.
const BODY_MAX = 64 * 1024; // keep in sync with EMAIL_BODY_MAX in shared/schema.ts
assert(
  "64KB+1 body rejected",
  !emailIngestSchema.safeParse({ from: "a@b.com", subject: "x", body: "x".repeat(BODY_MAX + 1) }).success,
);
assert(
  "64KB body accepted (at the cap)",
  emailIngestSchema.safeParse({ from: "a@b.com", subject: "x", body: "x".repeat(BODY_MAX) }).success,
);
assert(
  "1MB body now rejected (was the old cap)",
  !emailIngestSchema.safeParse({ from: "a@b.com", subject: "x", body: "x".repeat(1_000_000) }).success,
);
// The inbound worker truncates to 32 KB and appends a ~33-char marker; that
// worker-forwarded body must still pass.
assert(
  "worker-truncated body (32KB + marker) accepted",
  emailIngestSchema.safeParse({
    from: "a@b.com",
    subject: "x",
    body: "x".repeat(32 * 1024) + "\n\n[...truncated by ingest worker]",
  }).success,
);

// Oversized from / subject rejected.
assert(
  "999-char from rejected",
  !emailIngestSchema.safeParse({ from: "x".repeat(999), subject: "x", body: "hello" }).success,
);
assert(
  "999-char subject rejected",
  !emailIngestSchema.safeParse({ from: "a@b.com", subject: "x".repeat(999), body: "hello" }).success,
);

// Too-short body still rejected (existing min(5)).
assert(
  "body under 5 chars rejected",
  !emailIngestSchema.safeParse({ from: "a@b.com", subject: "x", body: "hi" }).success,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
