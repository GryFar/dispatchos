// ===========================================================================
// server/lib/dq-files.ts — FMCSA §391 Driver Qualification file compliance
// ===========================================================================
//
// Killer feature #3 (roadmap 2026-05-26). FMCSA §391.51 requires carriers to
// maintain a Driver Qualification (DQ) file for every CDL driver they employ.
// Missing documents = $1,270-$15,876 civil penalties PER violation (2025 rates),
// PLUS roadside OOS for the driver and "unsatisfactory" safety rating risk.
//
// Required documents per §391.51:
//   - Driver application for employment (§391.21) — kept 3 years
//   - Inquiry to previous employers (§391.23) — within 30 days of hire
//   - Inquiry to state agencies (motor vehicle record, §391.25) — annually
//   - Medical examiner's certificate (§391.43) — renewed every 24 months
//   - Road test certificate (§391.31) — or CDL skills test equivalent
//   - Annual review of driving record (§391.25(c))
//   - CDL copy (§391.11) — current and valid
//   - D&A pre-employment query (49 CFR §382.701) — covered by PR #81
//
// Architecture:
//   - We piggyback on `driver_documents` (PR #87) — each DQ requirement maps
//     to a specific `type` enum value.
//   - This module computes per-driver compliance status: which docs are
//     present, which are missing, which are expired.
//   - No DB writes here. Pure compute over storage queries.
//
// Endpoints (registered in server/routes/admin.ts):
//   GET /api/admin/users/:id/dq-status     — single driver
//   GET /api/admin/clients/:id/dq-summary  — fleet view per carrier
// ---------------------------------------------------------------------------

import { storage } from "../storage";
import type { DriverDocument, DriverDocumentType } from "@shared/schema";
import { daysBetween } from "./date-utils";

/** Days an annual document is valid (MVR, annual review). */
const ANNUAL_VALIDITY_DAYS = 365;
/** Days a medical certificate is valid (FMCSA: 24 months max). */
const MEDICAL_VALIDITY_DAYS = 730;
/**
 * If a doc has no expiresAt at all, how do we treat it?
 *   - Application, road test, prior employer inquiries — one-time, no expiry needed
 *   - MVR, medical, annual review — expiry REQUIRED
 */
const REQUIRES_EXPIRY: Set<DriverDocumentType> = new Set<DriverDocumentType>([
  "medical",
  "dq_mvr",
  "dq_annual_review",
  "cdl",
]);

/** All DQ requirements per §391.51, grouped by their CFR section. */
export const DQ_REQUIREMENTS: Array<{
  type: DriverDocumentType;
  label: string;
  cfr: string;
  required: boolean;
  validityDays?: number;
}> = [
  {
    type: "dq_application",
    label: "Driver application for employment",
    cfr: "§391.21",
    required: true,
  },
  {
    type: "dq_inquiry_prev_employer",
    label: "Inquiry to previous employers",
    cfr: "§391.23",
    required: true,
  },
  {
    type: "dq_mvr",
    label: "Motor Vehicle Record (MVR)",
    cfr: "§391.25",
    required: true,
    validityDays: ANNUAL_VALIDITY_DAYS,
  },
  {
    type: "dq_annual_review",
    label: "Annual review of driving record",
    cfr: "§391.25(c)",
    required: true,
    validityDays: ANNUAL_VALIDITY_DAYS,
  },
  {
    type: "medical",
    label: "Medical examiner's certificate",
    cfr: "§391.43",
    required: true,
    validityDays: MEDICAL_VALIDITY_DAYS,
  },
  {
    type: "dq_road_test",
    label: "Road test certificate (or CDL equivalent)",
    cfr: "§391.31",
    required: true,
  },
  {
    type: "cdl",
    label: "Current CDL copy",
    cfr: "§391.11",
    required: true,
    validityDays: ANNUAL_VALIDITY_DAYS, // CDLs renew every 4-8y by state, but we want a fresh copy yearly
  },
];

export type DqRequirementStatus =
  | "present"           // doc on file, not expired
  | "expiring_soon"     // doc on file, < 30 days until expiry
  | "expired"           // doc on file, past expiry
  | "missing";          // no doc of this type on file

export interface DqLineStatus {
  type: DriverDocumentType;
  label: string;
  cfr: string;
  status: DqRequirementStatus;
  docId: string | null;
  docFileName: string | null;
  expiresAt: string | null;
  daysUntilExpiry: number | null;
}

export interface DriverDqStatus {
  driverUserId: string;
  driverName: string | null;
  lines: DqLineStatus[];
  /** "compliant" when every required line is present + not expired. */
  overall: "compliant" | "warnings" | "non_compliant";
  missingCount: number;
  expiredCount: number;
  expiringSoonCount: number;
}

/**
 * Find the latest non-expired doc of a given type for a user, or fall back
 * to the latest expired one (so UI can show "expired" rather than "missing").
 */
function pickLatestDoc(
  docs: DriverDocument[],
  type: DriverDocumentType,
  today: string,
): DriverDocument | null {
  const matching = docs.filter((d) => d.type === type);
  if (matching.length === 0) return null;
  // docs arrive newest-first (ORDER BY created_at DESC). Prefer the newest doc
  // that is still VALID; only fall back to the newest-overall (so the UI can
  // show "expired") when none are valid. Without this, a newer expired (or
  // expiry-less, for a type that requires expiry) upload masked an older
  // still-valid doc and falsely flagged the driver non-compliant — and this
  // drives FMCSA compliance status, so it's penalty-sensitive.
  const isValid = (d: DriverDocument): boolean => {
    if (d.expiresAt) return daysBetween(today, d.expiresAt) >= 0;
    // No expiry recorded: valid only for types that don't require one.
    return !REQUIRES_EXPIRY.has(type);
  };
  return matching.find(isValid) ?? matching[0]!;
}

/**
 * Compute a single driver's DQ file compliance.
 *
 * Reads driver_documents owned by this user. Owner-operator self-files
 * also live there (uploaded via /api/me/documents).
 */
export function computeDqStatusForDriver(userId: string): DriverDqStatus {
  const user = storage.getUserById(userId);
  const driverName = user?.fullName ?? null;

  const docs = storage.listDriverDocumentsForUser(userId, { limit: 200 }).items;
  const today = new Date().toISOString();

  const lines: DqLineStatus[] = DQ_REQUIREMENTS.map((req) => {
    const doc = pickLatestDoc(docs, req.type, today);
    if (!doc) {
      return {
        type: req.type,
        label: req.label,
        cfr: req.cfr,
        status: "missing" as DqRequirementStatus,
        docId: null,
        docFileName: null,
        expiresAt: null,
        daysUntilExpiry: null,
      };
    }
    let status: DqRequirementStatus = "present";
    let daysUntilExpiry: number | null = null;
    if (doc.expiresAt) {
      daysUntilExpiry = daysBetween(today, doc.expiresAt);
      if (daysUntilExpiry < 0) status = "expired";
      else if (daysUntilExpiry <= 30) status = "expiring_soon";
    } else if (REQUIRES_EXPIRY.has(req.type)) {
      // Doc is on file but no expiry recorded — for types that REQUIRE it,
      // treat as expired (we can't audit without the date).
      status = "expired";
    }
    return {
      type: req.type,
      label: req.label,
      cfr: req.cfr,
      status,
      docId: doc.id,
      docFileName: doc.fileName,
      expiresAt: doc.expiresAt,
      daysUntilExpiry,
    };
  });

  const missingCount = lines.filter((l) => l.status === "missing").length;
  const expiredCount = lines.filter((l) => l.status === "expired").length;
  const expiringSoonCount = lines.filter((l) => l.status === "expiring_soon").length;

  let overall: DriverDqStatus["overall"] = "compliant";
  if (missingCount > 0 || expiredCount > 0) overall = "non_compliant";
  else if (expiringSoonCount > 0) overall = "warnings";

  return {
    driverUserId: userId,
    driverName,
    lines,
    overall,
    missingCount,
    expiredCount,
    expiringSoonCount,
  };
}

export interface FleetDqSummary {
  clientId: string;
  clientName: string;
  drivers: Array<{
    userId: string;
    fullName: string;
    overall: DriverDqStatus["overall"];
    missingCount: number;
    expiredCount: number;
    expiringSoonCount: number;
  }>;
  totals: {
    drivers: number;
    compliant: number;
    warnings: number;
    nonCompliant: number;
  };
}

/**
 * Roll-up of DQ status across every driver linked to a carrier. Powers
 * the "DQ files" tab on /admin/clients/:id and the next-renewal dashboard.
 */
export function computeFleetDqSummary(clientId: string): FleetDqSummary | null {
  const client = storage.getClient(clientId);
  if (!client) return null;

  // Find all driver users linked to this carrier. We avoid a JOIN by listing
  // users with role=driver + linkedClientId; the page size cap (200) is fine
  // for our target market (< 50 trucks per carrier).
  const allDrivers = storage.listUsers({ role: "driver" });
  const fleetDrivers = allDrivers.filter(
    (u) => u.linkedClientId === clientId && !u.deletedAt,
  );

  const rows = fleetDrivers.map((d) => {
    const s = computeDqStatusForDriver(d.id);
    return {
      userId: d.id,
      fullName: d.fullName,
      overall: s.overall,
      missingCount: s.missingCount,
      expiredCount: s.expiredCount,
      expiringSoonCount: s.expiringSoonCount,
    };
  });

  return {
    clientId,
    clientName: client.name,
    drivers: rows,
    totals: {
      drivers: rows.length,
      compliant: rows.filter((r) => r.overall === "compliant").length,
      warnings: rows.filter((r) => r.overall === "warnings").length,
      nonCompliant: rows.filter((r) => r.overall === "non_compliant").length,
    },
  };
}
