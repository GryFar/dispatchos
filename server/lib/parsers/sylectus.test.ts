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

// ---------------------------------------------------------------------------
// pickupAt/postedAt are normalized to ISO (MM/DD/YYYY HH:MM -> ISO) so the
// pickup-reminder window query (ISO-bounded) can actually see them.
// ---------------------------------------------------------------------------
{
  const r = parseSylectusEmail({
    from: "alerts@sylectus.com",
    subject: "New Load Posted - Atlanta, GA to Miami, FL - $1850",
    body: ["Origin: Atlanta, GA", "Destination: Miami, FL", "Pickup: 05/20/2026 09:00", "Posted: 05/20/2026 06:15"].join("\n"),
  });
  assert("pickupAt is ISO", typeof r.pickupAt === "string" && r.pickupAt!.includes("2026-05-20"));
  assert("pickupAt parses as a real date", !Number.isNaN(new Date(r.pickupAt!).getTime()));
  assert("postedAt is ISO", typeof r.postedAt === "string" && r.postedAt!.includes("2026-05-20"));
}

// Unparseable date is preserved raw (interface contract).
{
  const r = parseSylectusEmail({
    from: "alerts@sylectus.com",
    subject: "x",
    body: ["Origin: Atlanta, GA", "Destination: Miami, FL", "Pickup: next Tuesday"].join("\n"),
  });
  eq("unparseable pickup kept raw", r.pickupAt, "next Tuesday");
}

// ---------------------------------------------------------------------------
// parseMoney anchors on the FIRST numeric token — a trailing per-mile / FSC
// figure on the same line must not be concatenated into the rate.
// ---------------------------------------------------------------------------
{
  const r = parseSylectusEmail({
    from: "alerts@sylectus.com",
    subject: "x",
    body: ["Origin: Atlanta, GA", "Destination: Miami, FL", "Rate: $1,850 ($2.80/mi)"].join("\n"),
  });
  eq("rate is first token, not concatenated", r.rate, 1850);
}

// ---------------------------------------------------------------------------
// ReDoS guards: overlong / pathological city values are rejected fast and
// never stall, while a normal multi-word city still parses.
// ---------------------------------------------------------------------------
{
  const evil = "A" + " ".repeat(200_000) + "X";
  const t = Date.now();
  const r = parseSylectusEmail({
    from: "x@example.com",
    subject: "x",
    body: `Origin: ${evil}\nDestination: Miami, FL`,
  });
  const ms = Date.now() - t;
  assert("pathological city body parses fast (<200ms)", ms < 200, `took ${ms}ms`);
  eq("pathological origin rejected", r.origin, undefined);
}
{
  const r = parseSylectusEmail({
    from: "alerts@sylectus.com",
    subject: "x",
    body: ["Origin: Salt Lake City, UT 84101", "Destination: Miami, FL"].join("\n"),
  });
  eq("multi-word city still parses", r.origin?.city, "Salt Lake City");
  eq("multi-word city zip", r.origin?.zip, "84101");
}

// Oversized HTML body does not stall the tag-strip pipeline.
{
  const evilBody = "<" + "a".repeat(300_000);
  const t = Date.now();
  parseSylectusEmail({ from: "x@example.com", subject: "x", body: evilBody });
  const ms = Date.now() - t;
  assert("oversized HTML body parses fast (<200ms)", ms < 200, `took ${ms}ms`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
