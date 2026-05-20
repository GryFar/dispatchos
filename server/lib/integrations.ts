// ===========================================================================
// server/lib/integrations.ts — Integrations registry + status enrichment
// ===========================================================================
//
// Single source of truth for "what connectors does DispatchOS have, what's
// their config status, and what's their recent activity". Used by:
//   - GET /api/integrations/status (legacy, public-ish, returns dumb status)
//   - GET /api/admin/integrations  (admin-only, returns status + stats24h)
//
// Adding a new integration:
//   1. Add an entry to INTEGRATIONS below.
//   2. If it has activity events, list event_type prefixes in `activityEvents`.
//   3. Done. Both endpoints pick it up automatically.

import { storage } from "../storage";

export type IntegrationKind =
  | "feeder"        // brings loads INTO the system (Sylectus, load boards)
  | "enrichment"   // enriches data we have (FMCSA, Google Maps, EIA)
  | "messaging"    // outbound comms (Resend, Telegram bot, Twilio)
  | "observability" // monitoring & alerts (Sentry, GH health-monitor)
  | "infra";       // hosting & storage (Fly, CF Workers)

export type IntegrationStatus =
  | "ready"             // env configured AND active
  | "active"            // env configured AND we've seen events recently
  | "needs_config"      // env vars missing
  | "local_endpoint_ready" // endpoint exists locally, just missing webhook hookup
  | "local_folder_mode" // running on local fallback
  | "sandbox"           // no creds, sandbox-only
  | "error";            // misconfigured / failing

export interface IntegrationDescriptor {
  key: string;
  label: string;
  kind: IntegrationKind;
  envVars: string[];          // env vars required for "ready" status
  activityEvents?: string[];  // audit event_types that count as activity
  notes?: string;
}

/**
 * Registry of every integration DispatchOS knows about. Drives both the
 * legacy /api/integrations/status and the admin-grade /api/admin/integrations.
 */
export const INTEGRATIONS: IntegrationDescriptor[] = [
  {
    key: "fmcsa",
    label: "FMCSA SAFER (broker verification)",
    kind: "enrichment",
    envVars: ["FMCSA_API_URL", "FMCSA_WEB_KEY"],
    activityEvents: ["broker.checked"],
  },
  {
    key: "telegram_driver_bot",
    label: "Telegram Driver Bot",
    kind: "messaging",
    envVars: ["TELEGRAM_DRIVER_BOT_TOKEN", "DISPATCHOS_PUBLIC_URL"],
    activityEvents: ["telegram.command", "telegram.webhook"],
  },
  {
    key: "resend",
    label: "Resend (transactional email)",
    kind: "messaging",
    envVars: ["RESEND_API_KEY"],
    activityEvents: ["email.sent", "email.webhook"],
    notes: "Domain talk.dispatchos.co",
  },
  {
    key: "sylectus_inbound",
    label: "Sylectus Inbound Email",
    kind: "feeder",
    envVars: [], // works via CF Email Worker, no env on server side
    activityEvents: ["email.ingested"],
    notes: "loads@dispatchos.co → CF Worker → /api/inbound/email",
  },
  {
    key: "google_drive",
    label: "Google Drive (client folders)",
    kind: "infra",
    envVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    activityEvents: ["drive.local_folders_created"],
    notes: "Currently running in local_folder_mode",
  },
  {
    key: "twilio",
    label: "Twilio (SMS / Voice)",
    kind: "messaging",
    envVars: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"],
    notes: "Not wired yet — sandbox",
  },
  {
    key: "sentry",
    label: "Sentry (error monitoring)",
    kind: "observability",
    envVars: ["SENTRY_DSN"],
  },
  {
    key: "eia_fuel",
    label: "EIA (US diesel prices)",
    kind: "enrichment",
    envVars: ["EIA_API_KEY"],
    activityEvents: ["fuel.refreshed", "cron.fuel_refresh"],
    notes: "Weekly cron (Wed 09:00 UTC)",
  },
];

/**
 * Map env vars to status.
 *
 *   No env vars defined         → "ready" (works without config, e.g. Sylectus)
 *   All env vars present        → "ready"
 *   Any env var missing         → "needs_config"
 */
function envStatus(envVars: string[]): {
  status: IntegrationStatus;
  missing: string[];
} {
  if (envVars.length === 0) {
    return { status: "ready", missing: [] };
  }
  const missing = envVars.filter((key) => !process.env[key]);
  return {
    status: missing.length === 0 ? "ready" : "needs_config",
    missing,
  };
}

/**
 * Status enriched with 24h activity counters. Used by /api/admin/integrations.
 *
 * Status logic:
 *   - envStatus is the baseline
 *   - If envStatus = "ready" AND we've seen >=1 activity event in last 24h
 *     → upgrade to "active"
 *   - If envStatus = "needs_config" but we still see activity (e.g. Sylectus
 *     where there's no env var) → leave as "ready"
 */
export interface EnrichedIntegrationStatus {
  key: string;
  label: string;
  kind: IntegrationKind;
  status: IntegrationStatus;
  missing: string[];
  stats24h: {
    eventCount: number;
    lastEventAt: string | null;
  };
  notes?: string;
}

export function getEnrichedIntegrationStatus(): {
  generatedAt: string;
  integrations: EnrichedIntegrationStatus[];
} {
  const integrations = INTEGRATIONS.map((desc): EnrichedIntegrationStatus => {
    const { status: baseStatus, missing } = envStatus(desc.envVars);

    let eventCount = 0;
    let lastEventAt: string | null = null;
    if (desc.activityEvents && desc.activityEvents.length > 0) {
      const summary = storage.countAuditEventsByTypesIn24h(desc.activityEvents);
      eventCount = summary.count;
      lastEventAt = summary.lastAt;
    }

    // Upgrade ready → active if we've seen activity
    const status: IntegrationStatus =
      baseStatus === "ready" && eventCount > 0 ? "active" : baseStatus;

    return {
      key: desc.key,
      label: desc.label,
      kind: desc.kind,
      status,
      missing,
      stats24h: { eventCount, lastEventAt },
      notes: desc.notes,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    integrations,
  };
}

/**
 * Legacy/public shape — used by GET /api/integrations/status.
 * Drops admin-only stats, mirrors the original buildIntegrationStatus()
 * shape so any UI checking this endpoint keeps working.
 */
export function getLegacyIntegrationStatus(): {
  generatedAt: string;
  integrations: Array<{
    key: string;
    label: string;
    status: IntegrationStatus;
    missing: string[];
  }>;
} {
  return {
    generatedAt: new Date().toISOString(),
    integrations: INTEGRATIONS.map((desc) => {
      const { status, missing } = envStatus(desc.envVars);
      return { key: desc.key, label: desc.label, status, missing };
    }),
  };
}