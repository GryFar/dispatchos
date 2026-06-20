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
    beforeSend(event) {
      const status = (event.tags as Record<string, unknown> | undefined)?.status_code;
      if (status === 400 || status === 401 || status === 403 || status === 404 || status === 429) {
        return null;
      }
      // Defense-in-depth: strip credential-bearing headers before any event
      // leaves the process, even if sendDefaultPii is on.
      const headers = event.request?.headers as Record<string, unknown> | undefined;
      if (headers) {
        for (const key of Object.keys(headers)) {
          const k = key.toLowerCase();
          if (k === "authorization" || k === "cookie" || k === "set-cookie") {
            delete headers[key];
          }
        }
      }
      return event;
    },
  });

  // eslint-disable-next-line no-console
  console.log(`[sentry] initialized (env=${process.env.NODE_ENV || "development"})`);
} else {
  // eslint-disable-next-line no-console
  console.log("[sentry] SENTRY_DSN not set, skipping init");
}
