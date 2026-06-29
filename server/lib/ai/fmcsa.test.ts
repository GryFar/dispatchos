// Unit tests for FMCSA verification logic.
// Run: npx tsx server/lib/ai/fmcsa.test.ts

import { evaluateBroker, normalizeMcNumber, mcNumberDigits, parseMobileApiResponse, fmcsaCarrierSchema } from "./fmcsa";
import type { FmcsaCarrier } from "./fmcsa";

// Pinned epoch so authority-age math + fetchedAt are deterministic (no Date.now
// flakiness). 2025-06-01T00:00:00Z.
const FIXED_NOW = Date.parse("2025-06-01T00:00:00.000Z");

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

// ---------------------------------------------------------------------------
// MC normalization
// ---------------------------------------------------------------------------
{
  assert("mc: bare digits → MC-470488", normalizeMcNumber("470488") === "MC-470488");
  assert("mc: MC470488 → MC-470488", normalizeMcNumber("MC470488") === "MC-470488");
  assert("mc: MC 470488 → MC-470488", normalizeMcNumber("MC 470488") === "MC-470488");
  assert("mc: MC-470488 → MC-470488", normalizeMcNumber("MC-470488") === "MC-470488");
  assert("mc: lowercase mc → MC-470488", normalizeMcNumber("mc-470488") === "MC-470488");
  assert("mc: junk → null", normalizeMcNumber("ABC123XYZ") === null);
  assert("mc: empty → null", normalizeMcNumber("") === null);
  assert("mc: digits extract", mcNumberDigits("MC-470488") === "470488");
}

// ---------------------------------------------------------------------------
// Broker evaluation — strong fits
// ---------------------------------------------------------------------------
{
  const cleanBroker: FmcsaCarrier = {
    mcNumber: "MC-470488",
    legalName: "Total Quality Logistics LLC",
    address: { city: "Cincinnati", state: "OH" },
    phone: "513-831-2600",
    operatingStatus: "AUTHORIZED",
    authority: { carrier: false, broker: true, freightForwarder: false },
    authorityAgeYears: 25,
    insurance: { bmc84OnFile: true, bmc91OnFile: false, cargoInsuranceFiled: true },
    safetyRating: "SATISFACTORY",
    fetchedAt: new Date().toISOString(),
  };
  const v1 = evaluateBroker(cleanBroker);
  assert("eval: clean broker → green", v1.verdict === "green", `got ${v1.verdict} score ${v1.score}`);
  assert("eval: clean broker score ≥ 95", v1.score >= 95, `got ${v1.score}`);
  assert("eval: clean broker no red flags", v1.redFlags.length === 0);
}

// ---------------------------------------------------------------------------
// OOS = hard red
// ---------------------------------------------------------------------------
{
  const oos: FmcsaCarrier = {
    mcNumber: "MC-9999999",
    legalName: "Sketchy Brokers Inc",
    address: {},
    operatingStatus: "OUT_OF_SERVICE",
    authority: { carrier: false, broker: true, freightForwarder: false },
    authorityAgeYears: 1,
    fetchedAt: new Date().toISOString(),
  };
  const v = evaluateBroker(oos);
  assert("eval: OOS → red", v.verdict === "red");
  assert("eval: OOS score 0", v.score === 0);
  assert("eval: OOS has redFlag", v.redFlags.length > 0);
}

// ---------------------------------------------------------------------------
// New broker (under 6 months) → red flag
// ---------------------------------------------------------------------------
{
  const newBroker: FmcsaCarrier = {
    mcNumber: "MC-1234567",
    legalName: "Brand New Brokers LLC",
    address: { state: "FL" },
    phone: "555-1234567",
    operatingStatus: "AUTHORIZED",
    authority: { carrier: false, broker: true, freightForwarder: false },
    authorityAgeYears: 0.3, // ~3.5 months
    insurance: { bmc84OnFile: true, bmc91OnFile: false, cargoInsuranceFiled: false },
    fetchedAt: new Date().toISOString(),
  };
  const v = evaluateBroker(newBroker);
  assert("eval: new broker has 'verify by phone' flag",
    v.redFlags.some((f) => f.toLowerCase().includes("verify")) ||
    v.redFlags.some((f) => f.includes("<6 months")));
  assert("eval: new broker score < 80", v.score < 80, `got ${v.score}`);
}

// ---------------------------------------------------------------------------
// Broker without BMC-84 surety → red
// ---------------------------------------------------------------------------
{
  const noBond: FmcsaCarrier = {
    mcNumber: "MC-2222222",
    legalName: "No Bond Brokers LLC",
    address: {},
    operatingStatus: "AUTHORIZED",
    authority: { carrier: false, broker: true, freightForwarder: false },
    authorityAgeYears: 3,
    insurance: { bmc84OnFile: false, bmc91OnFile: false, cargoInsuranceFiled: true },
    fetchedAt: new Date().toISOString(),
  };
  const v = evaluateBroker(noBond);
  assert("eval: no BMC-84 has redFlag", v.redFlags.some((f) => f.includes("BMC-84")));
  assert("eval: no BMC-84 score < 70", v.score < 70, `got ${v.score}`);
}

// ---------------------------------------------------------------------------
// UNSATISFACTORY safety rating
// ---------------------------------------------------------------------------
{
  const unsafe: FmcsaCarrier = {
    mcNumber: "MC-3333333",
    legalName: "Risky Carriers Inc",
    address: {},
    phone: "555-0000",
    operatingStatus: "AUTHORIZED",
    authority: { carrier: true, broker: false, freightForwarder: false },
    authorityAgeYears: 5,
    safetyRating: "UNSATISFACTORY",
    fetchedAt: new Date().toISOString(),
  };
  const v = evaluateBroker(unsafe);
  assert("eval: UNSATISFACTORY → red", v.verdict === "red");
  assert("eval: UNSATISFACTORY in flags",
    v.redFlags.some((f) => f.includes("UNSATISFACTORY")));
}

// ---------------------------------------------------------------------------
// Carrier authority only, but solicited as a broker → double-brokering risk.
// Authorized + clean safety, yet must NOT pass clean because it lacks brokerage
// authority (regression for the under-penalized double-brokering case).
// ---------------------------------------------------------------------------
{
  const carrierAsBroker: FmcsaCarrier = {
    mcNumber: "MC-4444444",
    legalName: "Carrier Posing As Broker LLC",
    address: {},
    operatingStatus: "AUTHORIZED",
    authority: { carrier: true, broker: false, freightForwarder: false },
    authorityAgeYears: 8,
    safetyRating: "SATISFACTORY",
    fetchedAt: new Date().toISOString(),
  };
  const v = evaluateBroker(carrierAsBroker);
  assert("eval: carrier-as-broker not green", v.verdict !== "green", `got ${v.verdict} score ${v.score}`);
  assert("eval: carrier-as-broker flags double-brokering",
    v.redFlags.some((f) => f.toLowerCase().includes("double-brokering")));
  assert("eval: carrier-as-broker score penalised", v.score <= 70, `got ${v.score}`);
}

// ---------------------------------------------------------------------------
// Mobile API parsing — content array shape
// ---------------------------------------------------------------------------
{
  const apiPayload = {
    content: [{
      carrier: {
        legalName: "TQL LLC",
        dbaName: "Total Quality Logistics",
        dotNumber: "1638340",
        phyStreet: "4289 Ivy Pointe Blvd",
        phyCity: "Cincinnati",
        phyState: "OH",
        phyZipcode: "45245",
        telephone: "513-831-2600",
        allowedToOperate: "Y",
        carrierOperation: "Interstate Carrier",
        brokerAuthority: "ACTIVE",
        safetyRating: "S",
        totalPowerUnits: 0,
        totalDrivers: 0,
      },
    }],
  };
  const parsed = parseMobileApiResponse("MC-470488", apiPayload);
  assert("parse: returns object", parsed !== null);
  assert("parse: legalName", parsed?.legalName === "TQL LLC");
  assert("parse: city", parsed?.address.city === "Cincinnati");
  assert("parse: phone", parsed?.phone === "513-831-2600");
  assert("parse: AUTHORIZED", parsed?.operatingStatus === "AUTHORIZED");
  assert("parse: broker authority", parsed?.authority.broker === true);
  assert("parse: safetyRating", parsed?.safetyRating === "SATISFACTORY");
  assert("parse: mcNumber normalized", parsed?.mcNumber === "MC-470488");
}

// ---------------------------------------------------------------------------
// Mobile API parsing — letter status codes (real mobile API shape)
// brokerAuthorityStatus is a letter code, NOT a number. "A" = active.
// ---------------------------------------------------------------------------
{
  const activeBroker = parseMobileApiResponse("MC-555", {
    content: [{
      carrier: {
        legalName: "Letter Code Broker LLC",
        allowedToOperate: "Y",
        brokerAuthorityStatus: "A",
        bondInsuranceOnFile: "Y",
      },
    }],
  });
  assert("parse: brokerAuthorityStatus 'A' → broker true", activeBroker?.authority.broker === true);
  assert("parse: bondInsuranceOnFile 'Y' → bmc84OnFile true",
    activeBroker?.insurance?.bmc84OnFile === true);

  const inactiveBroker = parseMobileApiResponse("MC-556", {
    content: [{
      carrier: {
        legalName: "Inactive Broker LLC",
        allowedToOperate: "Y",
        brokerAuthorityStatus: "N",
        carrierOperation: "Interstate Carrier",
      },
    }],
  });
  assert("parse: brokerAuthorityStatus 'N' → broker false", inactiveBroker?.authority.broker === false);
}

// ---------------------------------------------------------------------------
// Mobile API parsing — carrier authority.
// Real mobile API: carrierOperation is a nested object (interstate/intrastate),
// NOT a carrier-authority flag. Carrier authority comes from common/contract
// authority status codes. Legacy string fixtures emit carrierOperation as text.
// ---------------------------------------------------------------------------
{
  // Live shape: carrierOperation nested object + active common authority.
  const liveCarrier = parseMobileApiResponse("MC-700", {
    content: [{
      carrier: {
        legalName: "Real Motor Carrier LLC",
        allowedToOperate: "Y",
        carrierOperation: { carrierOperationCode: "A", carrierOperationDesc: "Interstate" },
        commonAuthorityStatus: "A",
      },
    }],
  });
  assert("parse: common authority 'A' → carrier true", liveCarrier?.authority.carrier === true);
  assert("parse: nested carrierOperation does not falsely set broker",
    liveCarrier?.authority.broker === false);

  // Contract authority alone also grants carrier authority.
  const contractCarrier = parseMobileApiResponse("MC-701", {
    content: [{
      carrier: { legalName: "Contract Carrier LLC", allowedToOperate: "Y", contractAuthorityStatus: "A" },
    }],
  });
  assert("parse: contract authority 'A' → carrier true", contractCarrier?.authority.carrier === true);

  // No carrier authority codes → carrier false.
  const noCarrier = parseMobileApiResponse("MC-702", {
    content: [{
      carrier: { legalName: "Broker Only LLC", allowedToOperate: "Y", brokerAuthorityStatus: "A" },
    }],
  });
  assert("parse: no common/contract authority → carrier false", noCarrier?.authority.carrier === false);

  // Legacy string fixture: carrierOperation as text still detects carrier.
  const legacyCarrier = parseMobileApiResponse("MC-703", {
    content: [{
      carrier: { legalName: "Legacy Carrier LLC", allowedToOperate: "Y", carrierOperation: "Interstate Carrier" },
    }],
  });
  assert("parse: legacy carrierOperation string 'Interstate Carrier' → carrier true",
    legacyCarrier?.authority.carrier === true);
}

// ---------------------------------------------------------------------------
// Mobile API parsing — schema validation gate.
// The hand-built object must satisfy fmcsaCarrierSchema; a candidate that would
// produce an out-of-contract record is skipped rather than returned.
// ---------------------------------------------------------------------------
{
  // Valid record still returns and is schema-shaped.
  const valid = parseMobileApiResponse("MC-800", {
    content: [{
      carrier: { legalName: "Schema OK LLC", allowedToOperate: "Y", brokerAuthorityStatus: "A" },
    }],
  });
  assert("parse: schema-valid record returned", valid !== null && valid.legalName === "Schema OK LLC");
  assert("parse: returned record has fetchedAt string", typeof valid?.fetchedAt === "string");
}

// ---------------------------------------------------------------------------
// Mobile API parsing — BMC-84 bond filing flows into the surety guard.
// A broker with no bond on file must now be penalised (was dead code before).
// ---------------------------------------------------------------------------
{
  const noBond = parseMobileApiResponse("MC-557", {
    content: [{
      carrier: {
        legalName: "Unbonded Broker LLC",
        allowedToOperate: "Y",
        brokerAuthorityStatus: "A",
        bondInsuranceOnFile: "N",
      },
    }],
  });
  assert("parse: bondInsuranceOnFile 'N' populates insurance", noBond?.insurance !== undefined);
  assert("parse: bondInsuranceOnFile 'N' → bmc84OnFile false", noBond?.insurance?.bmc84OnFile === false);
  const verdict = noBond ? evaluateBroker(noBond) : null;
  assert("parse+eval: unbonded broker flagged for missing BMC-84",
    !!verdict && verdict.redFlags.some((f) => f.includes("BMC-84")));
}

// ---------------------------------------------------------------------------
// Mobile API parsing — empty response
// ---------------------------------------------------------------------------
{
  assert("parse: null input", parseMobileApiResponse("MC-1", null) === null);
  assert("parse: empty content", parseMobileApiResponse("MC-1", { content: [] }) === null);
  assert("parse: missing legalName", parseMobileApiResponse("MC-1", { content: [{ carrier: { dotNumber: "1" } }] }) === null);
}

// ===========================================================================
// REGRESSION GUARDS (appended) — lock in FMCSA letter-status authority parsing
// and the fmcsaCarrierSchema validation gate. A teammate is refactoring nearby;
// these must keep passing.
// ===========================================================================

// ---------------------------------------------------------------------------
// Carrier (motor) authority from common/contract status LETTER codes.
//
// FMCSA mobile API returns single-letter codes ("A" active, "I" inactive,
// "N" none) on commonAuthorityStatus / contractAuthorityStatus — NOT numbers.
// PRE-FIX BUG: these fields were read with a numeric coercion, so "A" became
// NaN (falsy) and every real motor carrier was silently classified as having
// NO carrier authority. These guards FAIL on that pre-fix behavior and PASS now.
// They also lock the "I"/"N"/absent cases (only "A" counts as active), which
// the existing suite only covered for "A"/"N".
// ---------------------------------------------------------------------------
{
  // commonAuthorityStatus "A" → carrier authority granted (NOT NaN/false).
  const commonActive = parseMobileApiResponse("MC-1100", {
    content: [{ carrier: { legalName: "Common A Carrier LLC", allowedToOperate: "Y", commonAuthorityStatus: "A" } }],
  }, FIXED_NOW);
  assert("regress: commonAuthorityStatus 'A' (letter, not number) → carrier true",
    commonActive?.authority.carrier === true,
    `got ${commonActive?.authority.carrier}`);

  // contractAuthorityStatus "A" alone also grants carrier authority.
  const contractActive = parseMobileApiResponse("MC-1101", {
    content: [{ carrier: { legalName: "Contract A Carrier LLC", allowedToOperate: "Y", contractAuthorityStatus: "A" } }],
  }, FIXED_NOW);
  assert("regress: contractAuthorityStatus 'A' → carrier true",
    contractActive?.authority.carrier === true);

  // "I" = INACTIVE authority → carrier false (only "A" is active). Record is
  // still returned (not null) — the carrier exists, just without live authority.
  // PRE-FIX risk: an "anything-but-N" check would have wrongly treated "I" as active.
  const commonInactive = parseMobileApiResponse("MC-1102", {
    content: [{ carrier: { legalName: "Inactive Common Carrier LLC", allowedToOperate: "Y", commonAuthorityStatus: "I" } }],
  }, FIXED_NOW);
  assert("regress: commonAuthorityStatus 'I' (inactive) → carrier false",
    commonInactive?.authority.carrier === false,
    `got ${commonInactive?.authority.carrier}`);
  assert("regress: inactive carrier record is still returned (not null)",
    commonInactive !== null);

  const contractInactive = parseMobileApiResponse("MC-1103", {
    content: [{ carrier: { legalName: "Inactive Contract Carrier LLC", allowedToOperate: "Y", contractAuthorityStatus: "I" } }],
  }, FIXED_NOW);
  assert("regress: contractAuthorityStatus 'I' (inactive) → carrier false",
    contractInactive?.authority.carrier === false);

  // "N" = NONE → carrier false.
  const commonNone = parseMobileApiResponse("MC-1104", {
    content: [{ carrier: { legalName: "No-Authority Carrier LLC", allowedToOperate: "Y", commonAuthorityStatus: "N" } }],
  }, FIXED_NOW);
  assert("regress: commonAuthorityStatus 'N' (none) → carrier false",
    commonNone?.authority.carrier === false);

  // Absent authority codes entirely → carrier false (no false-positive default).
  const noAuthorityKeys = parseMobileApiResponse("MC-1105", {
    content: [{ carrier: { legalName: "Broker-Only LLC", allowedToOperate: "Y", brokerAuthorityStatus: "A" } }],
  }, FIXED_NOW);
  assert("regress: no common/contract authority keys → carrier false",
    noAuthorityKeys?.authority.carrier === false);

  // contractAuthorityStatus "A" must NOT leak into broker/freightForwarder.
  assert("regress: carrier authority does not falsely set broker",
    contractActive?.authority.broker === false && contractActive?.authority.freightForwarder === false);
}

// ---------------------------------------------------------------------------
// fmcsaCarrierSchema validation GATE.
//
// parseMobileApiResponse hand-builds the carrier and then runs it through
// fmcsaCarrierSchema.safeParse() before returning. PRE-FIX: there was no gate,
// so a drifted/out-of-contract record could be returned unvalidated. These
// guards lock the contract:
//   (a) every returned record conforms to fmcsaCarrierSchema;
//   (b) the operatingStatus is a real enum member (never a raw passthrough);
//   (c) authorityAgeYears is always a number|null (never NaN/undefined);
//   (d) a candidate the loop must reject is SKIPPED in favor of a later valid
//       one (proves the gate path uses `continue`, returning validated data
//       rather than the first raw candidate or null).
// ---------------------------------------------------------------------------
{
  const parsed = parseMobileApiResponse("MC-1200", {
    content: [{
      carrier: {
        legalName: "Schema Gate LLC",
        allowedToOperate: "Y",
        brokerAuthorityStatus: "A",
        snapshotDate: "2018-01-01",
        safetyRating: "S",
      },
    }],
  }, FIXED_NOW);

  // (a) The returned record re-validates cleanly through the SAME exported
  // schema the parser gates on — i.e. the parser never returns un-validated data.
  assert("regress: returned record re-validates through fmcsaCarrierSchema",
    parsed !== null && fmcsaCarrierSchema.safeParse(parsed).success === true);

  // (b) operatingStatus is a real enum member, not a raw string passthrough.
  const okStatuses: FmcsaCarrier["operatingStatus"][] = ["AUTHORIZED", "NOT_AUTHORIZED", "OUT_OF_SERVICE", "PENDING", "UNKNOWN"];
  assert("regress: operatingStatus is a schema enum member",
    parsed !== null && okStatuses.includes(parsed.operatingStatus));

  // (c) authorityAgeYears is number|null and (here, from a fixed snapshot) a
  // finite number — never NaN. With FIXED_NOW=2025-06-01 and snapshot 2018-01-01
  // the age is deterministic (~7.4y), proving the injected clock is honored.
  assert("regress: authorityAgeYears is a finite number for a parseable snapshot",
    typeof parsed?.authorityAgeYears === "number" && Number.isFinite(parsed.authorityAgeYears as number));
  assert("regress: authorityAgeYears deterministic with injected clock (~7.4y)",
    parsed?.authorityAgeYears === 7.4, `got ${parsed?.authorityAgeYears}`);

  // A NaN authorityAgeYears must be rejected by the gate — assert the schema the
  // parser uses actually rejects it (so a future mapping drift that emits NaN
  // can't slip through). This is the precise property the gate enforces.
  assert("regress: fmcsaCarrierSchema rejects NaN authorityAgeYears (gate is real)",
    fmcsaCarrierSchema.safeParse({
      mcNumber: "MC-1", legalName: "x", address: {}, operatingStatus: "AUTHORIZED",
      authority: { carrier: false, broker: true, freightForwarder: false },
      authorityAgeYears: NaN, fetchedAt: "x",
    }).success === false);

  // ...and rejects an out-of-enum operatingStatus (the other drift the gate guards).
  assert("regress: fmcsaCarrierSchema rejects out-of-enum operatingStatus (gate is real)",
    fmcsaCarrierSchema.safeParse({
      mcNumber: "MC-1", legalName: "x", address: {}, operatingStatus: "ACTIVE",
      authority: { carrier: false, broker: true, freightForwarder: false },
      authorityAgeYears: 1, fetchedAt: "x",
    }).success === false);

  // (d) The loop SKIPS a candidate it cannot build a valid record from and
  // returns the next valid one (rather than returning null on the first miss or
  // emitting the raw first candidate). Pre-fix-style early-return would yield
  // null here; a non-skipping/unvalidated path would surface the bad candidate.
  const skipped = parseMobileApiResponse("MC-1201", {
    content: [
      { carrier: { dotNumber: "1" } },                          // no legalName → must be skipped
      { carrier: { legalName: "Second Valid LLC", allowedToOperate: "Y", brokerAuthorityStatus: "A" } },
    ],
  }, FIXED_NOW);
  assert("regress: malformed first candidate skipped, valid second returned",
    skipped?.legalName === "Second Valid LLC");
  assert("regress: skipped-then-valid result still schema-valid",
    skipped !== null && fmcsaCarrierSchema.safeParse(skipped).success === true);
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
