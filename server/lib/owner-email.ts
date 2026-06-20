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
  const configured =
    explicitOverride ??
    getIntegrationValue("notifications", "OWNER_EMAIL") ??
    process.env.DISPATCHOS_OWNER_EMAIL ??
    process.env.OWNER_EMAIL ??
    null;
  if (configured) return configured;

  const admin = storage
    .listUsers()
    .find(
      (u) =>
        u.role === "admin" &&
        !u.blocked &&
        !u.deletedAt &&
        typeof u.email === "string" &&
        u.email.includes("@"),
    );
  return admin?.email ?? null;
}
