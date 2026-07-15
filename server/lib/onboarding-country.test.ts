// Canada support: carrier country passthrough + NSC namespace (temp DB).
// Run: npx tsx server/lib/onboarding-country.test.ts
//
// Locks two Phase-2 guarantees:
//   1. provisionCarrierFromOnboarding threads `country` onto the carrier and
//      defaults to US when absent — every existing US onboarding is unchanged.
//   2. The V4-003 "carrier needs a claimed docket" invariant holds for Canadian
//      carriers (no claim => skipped:no_mc), and the NSC key lives in a namespace
//      disjoint from MC so an NSC and the same-digit MC coexist without tripping
//      the V4-011 uniqueness gate.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-onboarding-country-${Date.now()}.db`);
const { storage } = await import("../storage");
import type { Client } from "@shared/schema";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const rnd = () => Math.random().toString(36).slice(2, 10);
function newOwner() {
  return storage.createUser({
    email: `owner-${rnd()}@example.com`, fullName: "Owner", role: "driver",
    passwordSalt: "s", passwordHash: "h",
  });
}

// 1) country: "CA" flows onto the carrier.
{
  const owner = newOwner();
  storage.claimMc(`NSC-${1000000 + Math.floor(Math.random() * 8000000)}`, owner.id);
  const carrier = storage.provisionCarrierFromOnboarding(owner.id, {
    persona: "owner_operator", companyName: "Maple Hauling", country: "CA",
  }) as Client;
  assert("CA onboarding → client.country === 'CA'", carrier.country === "CA", JSON.stringify(carrier.country));
}

// 2) absent country defaults to US (existing US path byte-for-byte unchanged).
{
  const owner = newOwner();
  storage.claimMc(`MC-${100000 + Math.floor(Math.random() * 800000)}`, owner.id);
  const carrier = storage.provisionCarrierFromOnboarding(owner.id, {
    persona: "owner_operator", companyName: "US Freight",
  }) as Client;
  assert("US onboarding (no country) → client.country === 'US'", carrier.country === "US", JSON.stringify(carrier.country));
}

// 3) V4-003 invariant preserved: no claimed docket => skipped no_mc (even for CA).
{
  const owner = newOwner();
  const res = storage.provisionCarrierFromOnboarding(owner.id, {
    persona: "owner_operator", country: "CA",
  });
  assert(
    "no claimed identifier → skipped no_mc (invariant holds for CA too)",
    !("id" in res) && (res as { skipped?: string }).skipped === "no_mc",
    JSON.stringify(res),
  );
}

// 4) V4-011 namespace: an NSC key and the SAME-digit MC key are distinct
//    registry entries — both claim successfully, no cross-namespace collision.
{
  const digits = String(1000000 + Math.floor(Math.random() * 8000000));
  const us = newOwner();
  const ca = newOwner();
  const usClaim = storage.claimMc(`MC-${digits}`, us.id);
  const caClaim = storage.claimMc(`NSC-${digits}`, ca.id);
  assert("US MC-<digits> claims ok", usClaim.ok, JSON.stringify(usClaim));
  assert(
    "CA NSC-<digits> claims ok alongside the same-digit MC (namespaces disjoint)",
    caClaim.ok,
    JSON.stringify(caClaim),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
