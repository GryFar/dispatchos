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

// Oversized body rejected (DoS guard).
assert(
  "1MB+1 body rejected",
  !emailIngestSchema.safeParse({ from: "a@b.com", subject: "x", body: "x".repeat(1_000_001) }).success,
);
assert(
  "1MB body accepted (at the cap)",
  emailIngestSchema.safeParse({ from: "a@b.com", subject: "x", body: "x".repeat(1_000_000) }).success,
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
