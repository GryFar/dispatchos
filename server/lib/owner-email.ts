// ===========================================================================
// server/lib/owner-email.ts — single source of truth for the owner alert email
// ===========================================================================
//
// Alert senders (insurance-monitor, trial-expiry, compliance-renewals) each
// resolved the owner's email differently — some read DISPATCHOS_OWNER_EMAIL,
// others OWNER_EMAIL or a "notifications" integration key, and only insurance
// fell back to the first admin. So depending on which env var the operator set,
// some alert channels silently had no recipient. This unifies the lookup:
// every configured source is checked, then the first active admin as a fallback.

import { storage } from "../storage";
import { getIntegrationValue } from "./integration-config";

/**
 * Resolve the owner/operator email for system alerts. Priority:
 *   1. notifications integration (DB-configured, future-proof)
 *   2. DISPATCHOS_OWNER_EMAIL env (used by insurance + legacy migration)
 *   3. OWNER_EMAIL env (used by trial/compliance)
 *   4. first active admin user
 * Returns null only if none of the above yields a usable address.
 */
export function resolveOwnerEmail(explicitOverride?: string | null): string | null {
  // Each configured source is checked in priority order; the first one that
  // yields a usable address wins. We apply the SAME minimal validation as the
  // admin-fallback path (trim + must contain '@') so a stray-whitespace or
  // non-address env value falls through instead of being returned verbatim and
  // bouncing at SMTP.
  const sources = [
    explicitOverride,
    getIntegrationValue("notifications", "OWNER_EMAIL"),
    process.env.DISPATCHOS_OWNER_EMAIL,
    process.env.OWNER_EMAIL,
  ];
  for (const source of sources) {
    if (typeof source !== "string") continue;
    const candidate = source.trim();
    if (candidate.includes("@")) return candidate;
  }

  // Role filter is pushed into SQL (and blocked/soft-deleted are already
  // excluded by listUsers' defaults) so we don't materialize the full user
  // list just to pick the first active admin. created_at ASC ordering is part
  // of listUsers' contract, so this deterministically picks the oldest admin.
  const admin = storage
    .listUsers({ role: "admin" })
    .find((u) => typeof u.email === "string" && u.email.includes("@"));
  return admin?.email ?? null;
}
