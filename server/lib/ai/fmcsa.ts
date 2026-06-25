// FMCSA SAFER (Safety and Fitness Electronic Records) verification.
//
// We hit FMCSA's public APIs to verify brokers/carriers before booking a load.
// This is the FIRST line of defense against double-brokering, identity theft,
// and shell companies.
//
// Two FMCSA data sources:
//   1. Mobile API: https://mobile.fmcsa.dot.gov/qc/services/carriers/{MC}?webKey={KEY}
//      Returns clean JSON. Requires free webKey signup. Best for production.
//   2. SAFER scrape: https://safer.fmcsa.dot.gov/query.asp
//      HTML-only, slower, but no key. Fallback only.
//
// We deliberately keep this module pure-function so it can be tested with
// canned fixtures — never hit network in unit tests.

import { z } from "zod";

// ---------------------------------------------------------------------------
// FMCSA response schema (our normalized internal shape)
// ---------------------------------------------------------------------------

export const fmcsaCarrierSchema = z.object({
  /** MC number, e.g. "MC-470488" (always normalized with hyphen). */
  mcNumber: z.string(),
  /** USDOT number if known. */
  dotNumber: z.string().optional(),
  /** Legal name on FMCSA record. */
  legalName: z.string(),
  /** DBA name if different. */
  dbaName: z.string().optional(),
  /** Physical address. */
  address: z.object({
    street: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zip: z.string().optional(),
  }),
  /** Phone listed on FMCSA. NEVER trust phone from broker email — call this. */
  phone: z.string().optional(),
  /**
   * Operating authority status:
   *   "AUTHORIZED" — active, can broker/carry
   *   "NOT AUTHORIZED" — registered but no current authority
   *   "OUT OF SERVICE" — flagged by FMCSA, do not work with
   *   "PENDING" — application in review
   *   "UNKNOWN" — record found but status unclear
   */
  operatingStatus: z.enum(["AUTHORIZED", "NOT_AUTHORIZED", "OUT_OF_SERVICE", "PENDING", "UNKNOWN"]),
  /** Carrier / broker / freight forwarder type — at least one must be true. */
  authority: z.object({
    carrier: z.boolean(),
    broker: z.boolean(),
    freightForwarder: z.boolean(),
  }),
  /** Years since authority was granted. NULL if unknown. */
  authorityAgeYears: z.number().nullable(),
  /** Insurance type required for the authority (BMC-91 carrier / BMC-84 broker). */
  insurance: z.object({
    bmc84OnFile: z.boolean(),
    bmc91OnFile: z.boolean(),
    cargoInsuranceFiled: z.boolean(),
  }).optional(),
  /** Safety rating if scored. */
  safetyRating: z.enum(["SATISFACTORY", "CONDITIONAL", "UNSATISFACTORY", "NONE"]).optional(),
  /** Total power units (trucks). 0 for pure brokers. */
  powerUnits: z.number().optional(),
  /** Total drivers. 0 for pure brokers. */
  drivers: z.number().optional(),
  /** ISO timestamp when this record was fetched. */
  fetchedAt: z.string(),
});

export type FmcsaCarrier = z.infer<typeof fmcsaCarrierSchema>;

// ---------------------------------------------------------------------------
// Risk verdict computed from FMCSA record
// ---------------------------------------------------------------------------

export interface FmcsaVerdict {
  /** Overall verdict: green=safe, yellow=caution, red=do not book. */
  verdict: "green" | "yellow" | "red";
  /** Score 0-100 — higher = safer. */
  score: number;
  /** Human-readable reasons. */
  reasons: string[];
  /** Specific red flags requiring voice verification before booking. */
  redFlags: string[];
}

/**
 * Compute risk verdict from an FMCSA carrier record.
 *
 * Conservative rules — when uncertain, return yellow not green.
 */
export function evaluateBroker(carrier: FmcsaCarrier): FmcsaVerdict {
  const reasons: string[] = [];
  const redFlags: string[] = [];
  let score = 100;

  // Hard fails
  if (carrier.operatingStatus === "OUT_OF_SERVICE") {
    return {
      verdict: "red",
      score: 0,
      reasons: ["Carrier is OUT OF SERVICE per FMCSA"],
      redFlags: ["FMCSA OOS — federal violation flag, do not book"],
    };
  }
  if (carrier.operatingStatus === "NOT_AUTHORIZED") {
    return {
      verdict: "red",
      score: 5,
      reasons: ["No current operating authority on file"],
      redFlags: ["No authority — they cannot legally arrange transportation"],
    };
  }

  // Pending or unknown — caution
  if (carrier.operatingStatus === "PENDING") {
    score -= 25;
    reasons.push("Authority application is PENDING — not yet active");
    redFlags.push("Authority pending — request copy of confirmation letter");
  }
  if (carrier.operatingStatus === "UNKNOWN") {
    score -= 35;
    reasons.push("FMCSA status field is UNKNOWN");
  }

  // Broker authority required for brokerage activity. evaluateBroker means we
  // EXPECT the entity to be authorized to arrange transportation as a broker, so
  // the *absence* of broker/freight-forwarder authority is always a problem —
  // distinguish the two shapes it takes:
  const isBrokering = carrier.authority.broker || carrier.authority.freightForwarder;
  if (!isBrokering) {
    if (carrier.authority.carrier) {
      // Carrier authority only, but soliciting freight as a broker — the classic
      // double-brokering / re-brokering setup (no BMC-84 bond, no brokerage
      // license). Previously this passed clean because carrier authority existed.
      score -= 40;
      reasons.push("Carrier authority only — not authorized to broker freight");
      redFlags.push("Acting as a broker without brokerage authority — double-brokering risk");
    } else {
      score -= 40;
      reasons.push("No broker, carrier, or freight forwarder authority");
      redFlags.push("No transport authority of any kind");
    }
  }

  // Age of authority — fresh < 6 months is high risk
  if (carrier.authorityAgeYears !== null) {
    if (carrier.authorityAgeYears < 0.5) {
      score -= 30;
      reasons.push(`Authority is only ${formatAge(carrier.authorityAgeYears)} old`);
      redFlags.push("MC <6 months — verify by calling FMCSA-listed phone");
    } else if (carrier.authorityAgeYears < 1) {
      score -= 15;
      reasons.push(`Authority is ${formatAge(carrier.authorityAgeYears)} old`);
    } else if (carrier.authorityAgeYears < 2) {
      score -= 5;
      reasons.push(`Authority is ${formatAge(carrier.authorityAgeYears)} — still relatively new`);
    } else {
      reasons.push(`Authority is established (${formatAge(carrier.authorityAgeYears)})`);
    }
  } else {
    score -= 10;
    reasons.push("Authority age unknown");
  }

  // Insurance — BMC-84 ($75K surety) required for brokers
  if (isBrokering && carrier.insurance) {
    if (!carrier.insurance.bmc84OnFile) {
      score -= 35;
      reasons.push("No BMC-84 surety bond on file");
      redFlags.push("Broker without BMC-84 surety — federal violation");
    }
  }

  // Safety rating — UNSATISFACTORY is auto-red, no exceptions
  if (carrier.safetyRating === "UNSATISFACTORY") {
    return {
      verdict: "red",
      score: 10,
      reasons: [...reasons, "FMCSA safety rating UNSATISFACTORY"],
      redFlags: [...redFlags, "UNSATISFACTORY safety rating — federal red flag"],
    };
  } else if (carrier.safetyRating === "CONDITIONAL") {
    score -= 20;
    reasons.push("FMCSA safety rating CONDITIONAL");
  } else if (carrier.safetyRating === "SATISFACTORY") {
    reasons.push("FMCSA safety rating SATISFACTORY");
  }

  // Phone present?
  if (!carrier.phone) {
    score -= 10;
    reasons.push("No phone listed on FMCSA record");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let verdict: "green" | "yellow" | "red";
  if (score >= 75) verdict = "green";
  else if (score >= 40) verdict = "yellow";
  else verdict = "red";

  return { verdict, score, reasons, redFlags };
}

function formatAge(years: number): string {
  if (years < 1) {
    const months = Math.round(years * 12);
    return `${months} month${months === 1 ? "" : "s"}`;
  }
  const rounded = Math.round(years * 10) / 10;
  return `${rounded} year${rounded === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// MC number normalization
// ---------------------------------------------------------------------------

const MC_PATTERN = /^(?:MC[-\s]?)?(\d+)$/i;

/**
 * Normalize various MC-number formats to canonical "MC-XXXXXX".
 * Returns null if input doesn't match.
 */
export function normalizeMcNumber(input: string): string | null {
  const trimmed = input.trim();
  const m = MC_PATTERN.exec(trimmed);
  if (!m) return null;
  return `MC-${m[1]}`;
}

/**
 * Extract just the digit portion of an MC number (for API calls).
 */
export function mcNumberDigits(input: string): string | null {
  const normalized = normalizeMcNumber(input);
  if (!normalized) return null;
  return normalized.replace("MC-", "");
}

// ---------------------------------------------------------------------------
// FMCSA Mobile API client
// ---------------------------------------------------------------------------

interface FmcsaApiOptions {
  /** FMCSA webKey from free registration. */
  webKey: string;
  /** Custom fetch implementation (for testing). */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms. Default 5000. */
  timeoutMs?: number;
}

/**
 * Fetch carrier record from FMCSA Mobile API by MC number.
 *
 * Returns null if not found or on network error — caller must handle.
 */
export async function fetchByMc(mcNumber: string, options: FmcsaApiOptions): Promise<FmcsaCarrier | null> {
  const digits = mcNumberDigits(mcNumber);
  if (!digits) return null;
  const fetcher = options.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : null);
  if (!fetcher) return null;

  const url = `https://mobile.fmcsa.dot.gov/qc/services/carriers/docket-number/${digits}?webKey=${encodeURIComponent(options.webKey)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);

  try {
    const r = await fetcher(url, { signal: controller.signal });
    if (!r.ok) return null;
    const raw = await r.json();
    return parseMobileApiResponse(mcNumber, raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse FMCSA Mobile API response into our normalized shape.
 *
 * The API wraps the carrier in `{ content: [{ carrier: {...} }] }`. We extract
 * the first match and normalize fields.
 */
export function parseMobileApiResponse(mcNumber: string, raw: unknown): FmcsaCarrier | null {
  if (!raw || typeof raw !== "object") return null;
  // The API has multiple possible shapes — handle both `content: [...]` and
  // direct carrier object.
  const root = raw as Record<string, unknown>;
  const candidates: unknown[] = Array.isArray(root.content)
    ? (root.content as unknown[])
    : root.carrier
    ? [root]
    : [];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const obj = c as Record<string, unknown>;
    const carrier = (obj.carrier ?? obj) as Record<string, unknown>;
    if (!carrier || typeof carrier !== "object") continue;

    const legalName = pickString(carrier, "legalName");
    if (!legalName) continue;

    const allowedToOperate = pickString(carrier, "allowedToOperate");
    const oosDate = pickString(carrier, "oosDate");
    const statusCode = pickString(carrier, "statusCode");

    let operatingStatus: FmcsaCarrier["operatingStatus"] = "UNKNOWN";
    if (oosDate) operatingStatus = "OUT_OF_SERVICE";
    else if (allowedToOperate === "N") operatingStatus = "NOT_AUTHORIZED";
    else if (allowedToOperate === "Y") operatingStatus = "AUTHORIZED";
    else if (statusCode === "P") operatingStatus = "PENDING";

    const authority = {
      carrier: pickString(carrier, "carrierOperation")?.toLowerCase().includes("carrier") ?? false,
      // FMCSA mobile API returns letter status codes ("A" active, "I" inactive,
      // "N" none) for *AuthorityStatus fields — NOT numbers. Reading them with a
      // numeric coercion turned every "A" into NaN and silently classified real
      // brokers as non-brokers. Treat "A" (active) as authority granted. The
      // legacy "brokerAuthority"/"freightForwarder" string keys are kept as a
      // fallback for older shapes / fixtures that emit a free-text value.
      broker: hasActiveAuthority(carrier, "brokerAuthorityStatus", "brokerAuthority"),
      freightForwarder: hasActiveAuthority(carrier, "freightForwarderStatus", "freightForwarder"),
    };

    const authorityAgeYears = parseAuthorityAge(carrier);

    const safetyRatingRaw = pickString(carrier, "safetyRating") ?? "";
    let safetyRating: FmcsaCarrier["safetyRating"] = "NONE";
    if (safetyRatingRaw === "S") safetyRating = "SATISFACTORY";
    else if (safetyRatingRaw === "C") safetyRating = "CONDITIONAL";
    else if (safetyRatingRaw === "U") safetyRating = "UNSATISFACTORY";

    return {
      mcNumber: normalizeMcNumber(mcNumber) ?? mcNumber,
      dotNumber: pickString(carrier, "dotNumber") ?? undefined,
      legalName,
      dbaName: pickString(carrier, "dbaName") ?? undefined,
      address: {
        street: pickString(carrier, "phyStreet") ?? undefined,
        city: pickString(carrier, "phyCity") ?? undefined,
        state: pickString(carrier, "phyState") ?? undefined,
        zip: pickString(carrier, "phyZipcode") ?? undefined,
      },
      phone: pickString(carrier, "telephone") ?? undefined,
      operatingStatus,
      authority,
      insurance: parseInsurance(carrier),
      authorityAgeYears,
      safetyRating: safetyRating === "NONE" ? undefined : safetyRating,
      powerUnits: pickNumber(carrier, "totalPowerUnits") ?? undefined,
      drivers: pickNumber(carrier, "totalDrivers") ?? undefined,
      fetchedAt: new Date().toISOString(),
    };
  }
  return null;
}

function pickString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Decide whether an FMCSA authority field signals active authority.
 *
 * The mobile API exposes single-letter status codes:
 *   "A" — active / authorized
 *   "I" — inactive
 *   "N" — none / never granted
 * The canonical `statusKey` (e.g. "brokerAuthorityStatus") carries these codes.
 * `legacyKey` (e.g. "brokerAuthority") is a free-text fallback some shapes /
 * fixtures emit (e.g. "ACTIVE"); any non-empty value there that isn't an
 * explicit inactive/none marker counts as authority granted.
 */
function hasActiveAuthority(
  obj: Record<string, unknown>,
  statusKey: string,
  legacyKey: string,
): boolean {
  const status = pickString(obj, statusKey)?.trim().toUpperCase();
  if (status) {
    // Single-letter code path: only "A" is active.
    return status.startsWith("A");
  }
  const legacy = pickString(obj, legacyKey)?.trim().toUpperCase();
  if (legacy) {
    return legacy !== "I" && legacy !== "N" && legacy !== "NONE" && legacy !== "INACTIVE";
  }
  return false;
}

function pickNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Parse FMCSA insurance-filing flags into our normalized insurance shape.
 *
 * The mobile API exposes filing indicators such as `bondInsuranceOnFile`
 * (BMC-84 broker surety bond), `bipdInsuranceOnFile` (BMC-91 carrier liability)
 * and `cargoInsuranceOnFile`. Values come through as "Y"/"N" strings or numeric
 * filing counts. Previously this object was never populated, so the BMC-84
 * surety-bond guard in evaluateBroker() was dead code and a broker with no bond
 * passed clean. We only return an object when at least one indicator is present
 * so that fixtures/shapes that omit insurance data keep insurance === undefined
 * (matching the optional schema) rather than asserting "no bond on file".
 */
function parseInsurance(carrier: Record<string, unknown>): FmcsaCarrier["insurance"] {
  const bmc84 = pickFlag(carrier, "bondInsuranceOnFile", "brokerBondOnFile", "bmc84OnFile");
  const bmc91 = pickFlag(carrier, "bipdInsuranceOnFile", "bipdRequired", "bmc91OnFile");
  const cargo = pickFlag(carrier, "cargoInsuranceOnFile", "cargoInsuranceRequired", "cargoInsuranceFiled");
  if (bmc84 === undefined && bmc91 === undefined && cargo === undefined) {
    return undefined;
  }
  return {
    bmc84OnFile: bmc84 ?? false,
    bmc91OnFile: bmc91 ?? false,
    cargoInsuranceFiled: cargo ?? false,
  };
}

/**
 * Read a boolean filing indicator from the first present key. Returns undefined
 * when none of the keys are present (so callers can tell "absent" from "false").
 * Accepts "Y"/"N" strings, true/false, and numeric filing counts (>0 = on file).
 */
function pickFlag(obj: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined || v === null) continue;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v > 0;
    if (typeof v === "string") {
      const s = v.trim().toUpperCase();
      if (s === "") continue;
      if (s === "Y" || s === "YES" || s === "T" || s === "TRUE") return true;
      if (s === "N" || s === "NO" || s === "F" || s === "FALSE") return false;
      const n = Number(s);
      if (Number.isFinite(n)) return n > 0;
      return true; // non-empty unknown free-text → treat as present/on-file
    }
  }
  return undefined;
}

function parseAuthorityAge(carrier: Record<string, unknown>): number | null {
  // The mobile API exposes "mcs150Date" which is the last MCS-150 update — not
  // the original authority date. The original authority date is in "carrier"
  // SAFER scrape but missing from the JSON API. We approximate using the
  // earliest "snapshotDate" or fall back to null.
  const snapshot = pickString(carrier, "snapshotDate");
  if (snapshot) {
    const date = Date.parse(snapshot);
    if (!Number.isNaN(date)) {
      return Math.round(((Date.now() - date) / (365.25 * 24 * 60 * 60 * 1000)) * 10) / 10;
    }
  }
  return null;
}
