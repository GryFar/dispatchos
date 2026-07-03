// Sentry initialization — MUST be imported before anything else in server/.
//
// Per @sentry/node v8 docs (https://docs.sentry.io/platforms/javascript/guides/node/),
// Sentry.init has to run before any module that you want auto-instrumented
// (express, http, fetch, etc.) is required. We keep it in its own file so
// `import "./instrument"` at the very top of server/index.ts is enough.
//
// No-op when SENTRY_DSN isn't set, so local dev / unconfigured envs stay
// untouched.

import * as Sentry from "@sentry/node";

/**
 * Scrub an outbound Sentry event. Drops by-design 4xx noise, and — defense in
 * depth, even with sendDefaultPii OFF — strips EVERY credential-bearing surface
 * so a crash event can never exfiltrate a secret to a third-party processor:
 *   - the URL query string (wholesale) + the bot token that rides the Telegram
 *     webhook PATH (/api/telegram/webhook/<token>),
 *   - the request body (holds login passwords, reset tokens, inbound payloads),
 *   - cookies, and any secret/token/api-key/password header (not just
 *     authorization/cookie — also x-cron-secret, x-inbound-secret,
 *     x-telegram-bot-api-secret-token, x-api-key, …).
 * Exported so the scrubbing is unit-testable independently of Sentry.init.
 */
export function scrubSentryEvent<T extends Sentry.Event>(event: T): T | null {
  const status = (event.tags as Record<string, unknown> | undefined)?.status_code;
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 429) {
    return null;
  }
  const req = event.request;
  if (req) {
    if (typeof req.url === "string") {
      req.url = req.url
        .split("?")[0]
        .replace(/(\/telegram\/[^/]*?webhook[^/]*?\/)[^/?#]+/i, "$1<redacted>");
    }
    req.query_string = undefined;
    // Never ship request bodies — they carry passwords / reset tokens / payloads.
    req.data = undefined;
    req.cookies = undefined;
    const headers = req.headers as Record<string, unknown> | undefined;
    if (headers) {
      for (const key of Object.keys(headers)) {
        const k = key.toLowerCase();
        if (
          k === "authorization" ||
          k === "proxy-authorization" ||
          k === "cookie" ||
          k === "set-cookie" ||
          k.includes("secret") ||
          k.includes("token") ||
          k.includes("api-key") ||
          k.includes("apikey") ||
          k.includes("password")
        ) {
          delete headers[key];
        }
      }
    }
  }
  return event;
}

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    // Tag every event with the deployment environment so we can filter
    // "demo vs production vs dev" in the Sentry UI.
    environment: process.env.NODE_ENV || "development",
    release: process.env.DISPATCHOS_RELEASE,

    // 10% of transactions get traced — enough to spot bottlenecks without
    // blowing through Sentry's free 10k tx/month quota.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),

    // Send PII (IP, headers) only when explicitly opted in. Default OFF so we
    // never ship client IPs / request headers / user context to a third-party
    // processor (Sentry) by accident — required posture for EU onboarding and
    // privacy compliance. Set DISPATCHOS_SENTRY_PII=true to re-enable.
    sendDefaultPii: process.env.DISPATCHOS_SENTRY_PII === "true",

    // Drop noisy errors that are by-design (rate limits, validation, 4xx
    // class). Only true unexpected failures land in Sentry.
    // Drop by-design 4xx noise + scrub secrets from every outbound event.
    beforeSend: scrubSentryEvent,
  });

  // eslint-disable-next-line no-console
  console.log(`[sentry] initialized (env=${process.env.NODE_ENV || "development"})`);
} else {
  // eslint-disable-next-line no-console
  console.log("[sentry] SENTRY_DSN not set, skipping init");
}
