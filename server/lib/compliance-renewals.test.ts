// compliance-renewals.readRenewalsFromClient tests (pure).
// Run: npx tsx server/lib/compliance-renewals.test.ts
//
// Reads the UCR / IRP renewal dates out of a client's JSON payload. Only dates
// that are present and non-empty produce a line. listUpcomingRenewals (the DB
// query) is exercised separately; this covers the extraction contract.

import { readRenewalsFromClient } from "./compliance-renewals";

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

// Both kinds present (payload-wrapped).
{
  const lines = readRenewalsFromClient({
    payload: {
      ucrExpiresAt: "2026-12-31",
      ucrBaseState: "TX",
      irpExpiresAt: "2027-03-31",
      irpBaseJurisdiction: "TX",
    },
  });
  assert("two lines", lines.length === 2);
  const ucr = lines.find((l) => l.kind === "ucr");
  const irp = lines.find((l) => l.kind === "irp");
  assert("ucr expiry + base", ucr?.expiresAt === "2026-12-31" && ucr?.baseStateOrJurisdiction === "TX");
  assert("irp expiry + jurisdiction", irp?.expiresAt === "2027-03-31" && irp?.baseStateOrJurisdiction === "TX");
}

// Only one kind present.
{
  const lines = readRenewalsFromClient({ payload: { ucrExpiresAt: "2026-06-30" } });
  assert("one line (ucr only)", lines.length === 1 && lines[0].kind === "ucr");
}

// None present -> empty.
{
  assert("no renewal fields -> []", readRenewalsFromClient({ payload: {} }).length === 0);
}

// Empty-string date is ignored (not a valid renewal).
{
  const lines = readRenewalsFromClient({ payload: { ucrExpiresAt: "", irpExpiresAt: "2026-09-30" } });
  assert("empty ucr ignored, irp kept", lines.length === 1 && lines[0].kind === "irp");
}

// Flat client (no payload wrapper) is read directly via the `?? client` fallback.
{
  const lines = readRenewalsFromClient({ ucrExpiresAt: "2026-01-15" } as Record<string, unknown>);
  assert("flat client fallback reads fields", lines.length === 1 && lines[0].expiresAt === "2026-01-15");
}

// Non-empty but unparseable date ("TBD") is skipped, not treated as a deadline.
// Otherwise daysBetween() would return 0 and fire a spurious "expires TODAY" alert.
{
  const lines = readRenewalsFromClient({ payload: { ucrExpiresAt: "TBD", irpExpiresAt: "2026-09-30" } });
  assert("garbage ucr skipped, valid irp kept", lines.length === 1 && lines[0].kind === "irp");
}

// Out-of-range date pieces ("2026-13-40") are rejected.
{
  const lines = readRenewalsFromClient({ payload: { ucrExpiresAt: "2026-13-40" } });
  assert("out-of-range date rejected", lines.length === 0);
}

// A full datetime string is accepted via the YYYY-MM-DD prefix.
{
  const lines = readRenewalsFromClient({ payload: { ucrExpiresAt: "2026-09-30T00:00:00.000Z" } });
  assert("datetime prefix accepted", lines.length === 1 && lines[0].kind === "ucr");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
