// Sylectus email parser tests.
// Run: npx tsx server/lib/parsers/sylectus.test.ts
//
// parseSylectusEmail is a REAL production load source (sylectus_email adapter)
// but had no test. Locks in the "Field: value" body + subject-lane extraction
// and the from/body sender detection.

import { parseSylectusEmail } from "./sylectus";

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
function eq(name: string, got: unknown, want: unknown) {
  assert(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ---------------------------------------------------------------------------
// Canonical "Field: value" posting (the reference shape in the parser header)
// ---------------------------------------------------------------------------
{
  const r = parseSylectusEmail({
    from: "alerts@sylectus.com",
    subject: "New Load Posted - Atlanta, GA to Miami, FL - $1850",
    body: [
      "Pickup: 05/20/2026 09:00",
      "Origin: Atlanta, GA 30303",
      "Destination: Miami, FL 33101",
      "Miles: 661",
      "Weight: 28000 lbs",
      "Pieces: 12",
      "Equipment: Van",
      "Rate: $1,850",
      "Broker: ACME Logistics (MC# 123456)",
    ].join("\n"),
  });
  assert("matched", r.matched);
  eq("source tag", r.source, "sylectus");
  eq("origin city", r.origin?.city, "Atlanta");
  eq("origin state", r.origin?.state, "GA");
  eq("origin zip", r.origin?.zip, "30303");
  eq("dest city", r.destination?.city, "Miami");
  eq("dest state", r.destination?.state, "FL");
  eq("miles", r.miles, 661);
  eq("rate", r.rate, 1850);
  eq("weight", r.weightLbs, 28000);
  eq("pieces", r.pieces, 12);
  eq("broker mc extracted from broker line", r.broker?.mcNumber, "123456");
  assert("broker name present", (r.broker?.name ?? "").includes("ACME"));
}

// ---------------------------------------------------------------------------
// Sender detection: a sylectus.com From makes matched true even with no fields
// ---------------------------------------------------------------------------
{
  const r = parseSylectusEmail({
    from: "noreply@sylectus.com",
    subject: "Sylectus notification",
    body: "Please log in to view this posting.",
  });
  assert("matched via sender even without fields", r.matched);
  eq("no origin parsed", r.origin, undefined);
}

// ---------------------------------------------------------------------------
// Subject-lane fallback when the body omits origin/destination
// ---------------------------------------------------------------------------
{
  const r = parseSylectusEmail({
    from: "broker@example.com",
    subject: "Dallas, TX to Phoenix, AZ - $2100",
    body: ["Miles: 887", "Equipment: Reefer"].join("\n"),
  });
  assert("matched via subject lane + fields", r.matched);
  eq("origin from subject", r.origin?.city, "Dallas");
  eq("dest from subject", r.destination?.state, "AZ");
  eq("rate from subject", r.rate, 2100);
}

// ---------------------------------------------------------------------------
// Non-sylectus, non-load noise does not match
// ---------------------------------------------------------------------------
{
  const r = parseSylectusEmail({
    from: "newsletter@example.com",
    subject: "Weekly digest",
    body: "Thanks for reading our updates.",
  });
  assert("noise not matched", !r.matched);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
