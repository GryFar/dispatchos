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
import { getIntegrationValue, getIntegrationValueSource } from "./integration-config";

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

/** Per-env-var hint for the admin setup dialog (label, type, help). */
export interface IntegrationEnvVarMeta {
  /** env var name, e.g. 'FMCSA_WEB_KEY'. */
  envVar: string;
  /** Human label shown in the form, e.g. 'API key'. */
  label: string;
  /** 'secret' = password-masked; 'url' = url; 'text' = plain. */
  type: "secret" | "url" | "text";
  /** Optional hint shown under the field. */
  help?: string;
  /** Optional default if user wants to keep the original env. */
  placeholder?: string;
}

export interface IntegrationDescriptor {
  key: string;
  label: string;
  kind: IntegrationKind;
  envVars: string[];          // env vars required for "ready" status
  envVarMeta?: IntegrationEnvVarMeta[]; // per-var hints for UI; falls back to {label:envVar, type:'secret'}
  activityEvents?: string[];  // audit event_types that count as activity
  notes?: string;
  /** URL with setup instructions (Stripe-style «get your key from…»). */
  docsUrl?: string;
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
    envVarMeta: [
      { envVar: "FMCSA_API_URL", label: "API URL", type: "url", placeholder: "https://mobile.fmcsa.dot.gov/qc/services/carriers", help: "Нажмите «Enter» чтобы вставить стандартный URL" },
      { envVar: "FMCSA_WEB_KEY", label: "Web key", type: "secret", help: "Получить на mobile.fmcsa.dot.gov → Developer Portal" },
    ],
    activityEvents: ["broker.checked"],
    docsUrl: "https://mobile.fmcsa.dot.gov/developer/home.page",
  },
  {
    key: "telegram_driver_bot",
    label: "Telegram Driver Bot",
    kind: "messaging",
    envVars: ["TELEGRAM_DRIVER_BOT_TOKEN", "DISPATCHOS_PUBLIC_URL"],
    envVarMeta: [
      { envVar: "TELEGRAM_DRIVER_BOT_TOKEN", label: "Bot token", type: "secret", help: "Получить у @BotFather в Telegram" },
      { envVar: "DISPATCHOS_PUBLIC_URL", label: "Public URL", type: "url", placeholder: "https://demo.dispatchos.co" },
    ],
    activityEvents: ["telegram.command", "telegram.webhook"],
    docsUrl: "https://core.telegram.org/bots#how-do-i-create-a-bot",
  },
  {
    key: "stripe",
    label: "Stripe (billing)",
    kind: "messaging" as const,
    envVars: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    envVarMeta: [
      {
        envVar: "STRIPE_SECRET_KEY",
        label: "Secret key",
        type: "secret" as const,
        help: "dashboard.stripe.com → Developers → API keys (use restricted key)",
      },
      {
        envVar: "STRIPE_WEBHOOK_SECRET",
        label: "Webhook signing secret",
        type: "secret" as const,
        help: "dashboard.stripe.com → Webhooks → your endpoint → Signing secret (whsec_...)",
      },
    ],
    activityEvents: [
      "billing.checkout_created",
      "billing.subscription_started",
      "billing.subscription_updated",
      "billing.subscription_canceled",
      "billing.payment_succeeded",
      "billing.payment_failed",
    ],
    notes:
      "Trial 14 days on any tier. Webhook endpoint: /api/billing/webhook. Price IDs are env vars per tier (STRIPE_PRICE_OO_BASIC, etc).",
    docsUrl: "https://dashboard.stripe.com/apikeys",
  },
  {
    key: "resend",
    label: "Resend (transactional email)",
    kind: "messaging",
    envVars: ["RESEND_API_KEY"],
    envVarMeta: [
      { envVar: "RESEND_API_KEY", label: "API key", type: "secret", help: "resend.com → API Keys" },
    ],
    activityEvents: ["email.sent", "email.webhook"],
    notes: "Domain talk.dispatchos.co",
    docsUrl: "https://resend.com/api-keys",
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
    envVarMeta: [
      { envVar: "GOOGLE_CLIENT_ID", label: "OAuth Client ID", type: "text", help: "console.cloud.google.com → APIs & Services → Credentials" },
      { envVar: "GOOGLE_CLIENT_SECRET", label: "OAuth Client secret", type: "secret" },
    ],
    activityEvents: ["drive.local_folders_created"],
    notes: "Currently running in local_folder_mode",
    docsUrl: "https://console.cloud.google.com/apis/credentials",
  },
  {
    key: "twilio",
    label: "Twilio (SMS / Voice)",
    kind: "messaging",
    envVars: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"],
    envVarMeta: [
      { envVar: "TWILIO_ACCOUNT_SID", label: "Account SID", type: "text", placeholder: "AC…" },
      { envVar: "TWILIO_AUTH_TOKEN", label: "Auth token", type: "secret" },
      { envVar: "TWILIO_PHONE_NUMBER", label: "Phone number", type: "text", placeholder: "+15551234567", help: "E.164 формат" },
    ],
    notes: "Not wired yet — sandbox",
    docsUrl: "https://console.twilio.com/",
  },
  {
    key: "sentry",
    label: "Sentry (error monitoring)",
    kind: "observability",
    envVars: ["SENTRY_DSN"],
    envVarMeta: [
      { envVar: "SENTRY_DSN", label: "DSN", type: "secret", help: "sentry.io → Project → Settings → Client Keys" },
    ],
    docsUrl: "https://docs.sentry.io/concepts/key-terms/dsn-explainer/",
  },
  {
    key: "eia_fuel",
    label: "EIA (US diesel prices)",
    kind: "enrichment",
    envVars: ["EIA_API_KEY"],
    envVarMeta: [
      { envVar: "EIA_API_KEY", label: "API key", type: "secret", help: "Бесплатный ключ на eia.gov/opendata/register.php" },
    ],
    activityEvents: ["fuel.refreshed", "cron.fuel_refresh"],
    notes: "Weekly cron (Wed 09:00 UTC)",
    docsUrl: "https://www.eia.gov/opendata/register.php",
  },
];

/**
 * Map env vars to status.
 *
 *   No env vars defined         → "ready" (works without config, e.g. Sylectus)
 *   All env vars present        → "ready"
 *   Any env var missing         → "needs_config"
 */
/**
 * Whether each env var is satisfied — either via Fly secret or via the
 * UI-editable integration_configs row. Both sources are equivalent at
 * runtime (DB wins, env is fallback). The UI uses the per-var detail to
 * show «set by Fly» vs «set by you 5 min ago».
 */
function envStatus(integrationKey: string, envVars: string[]): {
  status: IntegrationStatus;
  missing: string[];
} {
  if (envVars.length === 0) {
    return { status: "ready", missing: [] };
  }
  const missing = envVars.filter((key) => !getIntegrationValue(integrationKey, key));
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
  /** Per-env-var meta (label/type/help) for the setup dialog. */
  envVarMeta: IntegrationEnvVarMeta[];
  /** Per-env-var source so the UI can show «set via UI» vs «set via Fly». */
  envVarSources: Array<{ envVar: string; source: "db" | "env" | "missing" }>;
  stats24h: {
    eventCount: number;
    lastEventAt: string | null;
  };
  notes?: string;
  docsUrl?: string;
}

export function getEnrichedIntegrationStatus(): {
  generatedAt: string;
  integrations: EnrichedIntegrationStatus[];
} {
  const integrations = INTEGRATIONS.map((desc): EnrichedIntegrationStatus => {
    const { status: baseStatus, missing } = envStatus(desc.key, desc.envVars);

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

    // Build per-var meta + source info for the UI. If no envVarMeta was
    // declared, synthesize a sensible default (treat as secret).
    const envVarMeta: IntegrationEnvVarMeta[] = desc.envVars.map((v) => {
      const declared = desc.envVarMeta?.find((m) => m.envVar === v);
      return declared ?? { envVar: v, label: v, type: "secret" };
    });
    const envVarSources = desc.envVars.map((v) => ({
      envVar: v,
      source: getIntegrationValueSource(desc.key, v),
    }));

    return {
      key: desc.key,
      label: desc.label,
      kind: desc.kind,
      status,
      missing,
      envVarMeta,
      envVarSources,
      stats24h: { eventCount, lastEventAt },
      notes: desc.notes,
      docsUrl: desc.docsUrl,
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
      const { status, missing } = envStatus(desc.key, desc.envVars);
      return { key: desc.key, label: desc.label, status, missing };
    }),
  };
}