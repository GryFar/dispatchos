import "dotenv/config";
// Sentry must be initialized BEFORE express is imported so its
// auto-instrumentation can wrap http/express modules. See server/instrument.ts.
import "./instrument";
import * as Sentry from "@sentry/node";
import express, { Response, NextFunction } from "express";
import type { Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import session from "express-session";
import connectSqlite3 from "connect-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { storage, backfillBrokerTrustSignals, closeDatabase } from "./storage";

const app = express();
const isVdsMode = process.env.DISPATCHOS_DEPLOYMENT_MODE === "vds";
const isProdLike =
  process.env.NODE_ENV === "production" ||
  isVdsMode ||
  process.env.FLY_APP_NAME !== undefined;

// -----------------------------------------------------------------------------
// Session secret boot gate (Audit Critical #3).
//
// Any production-like deployment (NODE_ENV=production, VDS mode, or running
// on Fly.io) MUST set DISPATCHOS_SESSION_SECRET to a strong value (≥ 32 chars,
// not the historical placeholders). In local dev a default is allowed so
// developers don't need to wire up env vars to run `npm run dev`.
//
// History: prior to 2026-05-26 only `vds` mode enforced this. Fly deployments
// without DISPATCHOS_DEPLOYMENT_MODE=vds silently fell back to the placeholder
// secret — a known string, trivial session forgery surface.
// -----------------------------------------------------------------------------
const PLACEHOLDER_SECRETS = new Set([
  "change-this-before-real-use",
  "change-this-local-dispatchos-secret-before-production",
]);
const sessionSecretFromEnv = process.env.DISPATCHOS_SESSION_SECRET;
if (isProdLike) {
  if (!sessionSecretFromEnv) {
    throw new Error(
      "DISPATCHOS_SESSION_SECRET must be set in production / Fly / VDS mode (>= 32 chars).",
    );
  }
  if (PLACEHOLDER_SECRETS.has(sessionSecretFromEnv)) {
    throw new Error(
      "DISPATCHOS_SESSION_SECRET is set to a known placeholder. Rotate it before booting.",
    );
  }
  if (sessionSecretFromEnv.length < 32) {
    throw new Error(
      "DISPATCHOS_SESSION_SECRET is too short (must be >= 32 chars in production).",
    );
  }
}
const sessionSecret =
  sessionSecretFromEnv || "change-this-local-dispatchos-secret-before-production";

if (isVdsMode) {
  app.set("trust proxy", Number(process.env.DISPATCHOS_TRUST_PROXY || 1));
}

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    limit: process.env.DISPATCHOS_JSON_LIMIT || "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: process.env.DISPATCHOS_FORM_LIMIT || "1mb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(self), microphone=(), camera=()");
  // Audit V2-5 — add HSTS, COOP, cross-domain policies in production.
  // HSTS only in prod so dev over plain http still works.
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload",
    );
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  }
  next();
});

// Audit V3-4 — Origin / Referer check on every mutating /api request.
// Defense-in-depth on top of SameSite=Strict cookies: even if SameSite is
// bypassed (CRLF, header smuggling, browser bug), the Origin must match an
// allowlist or we reject. GET / HEAD / OPTIONS bypass.
const ALLOWED_ORIGINS = new Set([
  "https://dispatchos.co",
  "https://www.dispatchos.co",
  "https://demo.dispatchos.co",
  "https://app.dispatchos.co",
]);
// Exempt paths that legitimately accept cross-origin POSTs:
//   /api/public/* — landing CTA forms (CORS-controlled in leads.ts)
//   /api/inbound/* — CF email worker forwards (HMAC-protected separately)
//   /api/cron/* — GitHub Actions / external cron (secret-protected)
//   /api/telegram/* — Telegram webhook (signature-protected)
//   /api/integrations/webhook/* — external 3rd-party webhooks
const ORIGIN_CHECK_EXEMPT = (path: string) =>
  path.startsWith("/api/public/") ||
  path.startsWith("/api/inbound/") ||
  path.startsWith("/api/cron/") ||
  path.startsWith("/api/telegram/") ||
  path.startsWith("/api/integrations/webhook/") ||
  path === "/api/billing/webhook"; // Stripe webhook (HMAC-signed)

app.use("/api", (req, res, next) => {
  // Read-only methods don't need CSRF protection.
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }
  if (ORIGIN_CHECK_EXEMPT(req.path)) return next();

  const origin = req.headers.origin;
  const referer = req.headers.referer;

  // Prefer Origin (set by all modern browsers on cross-origin). Fall back
  // to Referer for legacy clients. If both missing AND not a browser (curl/
  // server-to-server), we let it through — the session cookie wouldn't ship
  // from a non-browser origin anyway.
  const candidate = typeof origin === "string" ? origin : typeof referer === "string" ? new URL(referer).origin : null;

  // No origin header at all + no session cookie = treat as legit server-side or curl.
  // No origin + session cookie present = suspicious (browser dropped Origin); reject.
  const hasSessionCookie = req.headers.cookie?.includes("dispatchos.sid");
  if (!candidate) {
    if (hasSessionCookie) {
      return res.status(403).json({ message: "Missing Origin header for authenticated request" });
    }
    return next();
  }

  // Localhost dev passes (any port).
  if (candidate.startsWith("http://localhost") || candidate.startsWith("http://127.")) return next();

  if (!ALLOWED_ORIGINS.has(candidate)) {
    console.warn(`[csrf] rejected Origin="${candidate}" on ${req.method} ${req.path}`);
    return res.status(403).json({ message: "Cross-origin request rejected" });
  }
  next();
});

// ---------------------------------------------------------------------------
// Rate limiting (Audit v4 V4-001 — re-enabling by default).
//
// History:
//   - #75 (v1 Critical #4) introduced auth brute-force limiter.
//   - #97/#98 flipped both limiters to opt-in because the design-partner
//     office NAT was tripping limits with legitimate admin activity.
//   - V4-001: that flip left production completely unprotected against
//     login bombing / TOTP brute-force. We must re-enable by default.
//
// Fix: limiters are ON by default. Office NAT problem is solved via an
// IP allow-list (DISPATCHOS_RATE_LIMIT_TRUSTED_IPS) rather than disabling
// the whole protection. Trusted IPs (the team's office, Vlad's home,
// etc.) are listed in env, comma-separated; their requests skip both
// limiters but still go through every other security check.
//
// Backward compat: setting DISPATCHOS_RATE_LIMIT=off / DISPATCHOS_AUTH_RATE_LIMIT=off
// explicitly is still honoured, in case ops needs to disable in a hurry
// during an incident. Default is now "on".
// ---------------------------------------------------------------------------

const TRUSTED_IPS = new Set(
  (process.env.DISPATCHOS_RATE_LIMIT_TRUSTED_IPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
if (TRUSTED_IPS.size > 0) {
  console.log(
    `[ratelimit] ${TRUSTED_IPS.size} trusted IP(s) will skip rate limits ` +
      "(office NAT, dev machines)",
  );
}

// V5-007: the IP-based trusted-skip was a spoofable OFF-switch for the rate
// limiter. req.ip is derived from X-Forwarded-For, and with Cloudflare in
// front of Fly the XFF chain has multiple hops an attacker can partly control
// — so a request could present the documented office IP (it's in the runbook)
// and skip rate limiting entirely, re-opening V4-001. We remove the bypass
// rather than trying to out-guess the XFF chain: it's unnecessary because the
// auth limiter keys on (IP, email), so a shared office NAT is NOT locked out
// (each user gets their own bucket), and the global /api limiter (240/min) is
// generous for legitimate office traffic. TRUSTED_IPS is retained but no
// longer grants a bypass; re-introduce only with a non-spoofable signal.
function skipTrusted(_req: import("express").Request): boolean {
  return false;
}

const GLOBAL_RATE_LIMIT_ENABLED =
  (process.env.DISPATCHOS_RATE_LIMIT || "on").toLowerCase() === "on";
if (GLOBAL_RATE_LIMIT_ENABLED) {
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      limit: Number(process.env.DISPATCHOS_RATE_LIMIT_PER_MINUTE || 240),
      standardHeaders: true,
      legacyHeaders: false,
      skip: skipTrusted,
    }),
  );
  console.log(
    `[ratelimit] global /api limiter ENABLED (per-IP, ` +
      `${process.env.DISPATCHOS_RATE_LIMIT_PER_MINUTE || 240}/min)`,
  );
} else {
  console.log(
    "[ratelimit] global /api limiter DISABLED (set DISPATCHOS_RATE_LIMIT=on to re-enable).",
  );
}

// Per-IP brute-force limiter on credential endpoints.
// 15-minute window, 20 attempts per (IP, email) tuple. Tuple is important
// because raw per-IP would lock out an entire office NAT if any one user
// mistyped their password.
const AUTH_RATE_LIMIT_ENABLED =
  (process.env.DISPATCHOS_AUTH_RATE_LIMIT || "on").toLowerCase() === "on";

if (AUTH_RATE_LIMIT_ENABLED) {
  const authBruteLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: Number(process.env.DISPATCHOS_AUTH_RATE_LIMIT_PER_15MIN || 20),
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipTrusted,
    keyGenerator: (req) => {
      // Normalize the IP via ipKeyGenerator so IPv6 clients are grouped by
      // their /64 subnet. Without it (raw req.ip), an attacker on IPv6 can vary
      // the address suffix within their allocation to mint unlimited distinct
      // keys and bypass this brute-force limit (express-rate-limit v8 flags this
      // as ERR_ERL_KEY_GEN_IPV6).
      const ipKey = ipKeyGenerator(req.ip || "unknown");
      const body = (req.body || {}) as { email?: string; username?: string; token?: string };
      const ident = (body.email || body.username || "").toString().toLowerCase().trim();
      return ident ? `${ipKey}|${ident}` : ipKey;
    },
    message: { message: "Too many attempts. Try again in 15 minutes." },
  });
  // Cover ALL credential / 2FA / bootstrap paths, not just login.
  // V4-001 noted that signup/bootstrap/setup were quietly uncovered after #98.
  app.use("/api/auth/login", authBruteLimiter);
  app.use("/api/auth/signup", authBruteLimiter);
  app.use("/api/auth/bootstrap", authBruteLimiter);
  app.use("/api/auth/setup", authBruteLimiter);
  app.use("/api/me/totp/confirm", authBruteLimiter);
  // H2: resume-setup is a password->TOTP-secret oracle and confirm-signup verifies
  // a TOTP code — both were uncovered. Rate-limit them like the rest.
  app.use("/api/auth/totp/resume-setup", authBruteLimiter);
  app.use("/api/auth/totp/confirm-signup", authBruteLimiter);
  console.log(
    "[auth] brute-force limiter ENABLED (15min / 20 attempts per IP+email)",
  );

  // M1: public GPS ingest (/api/track/*) is token-only auth. A real device pings
  // every ~30-60s, so 60/min PER TRACKING TOKEN is generous — this caps GPS
  // spoofing / flooding even when an attacker holds a valid token.
  const trackLimiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipTrusted,
    keyGenerator: (req) => {
      const q = req.query as Record<string, unknown>;
      const hdr = req.headers["x-limit-u"];
      const tok = String(q?.id ?? q?.token ?? (Array.isArray(hdr) ? hdr[0] : hdr) ?? "").trim();
      return tok || req.ip || "track-anon";
    },
    message: { message: "Too many tracking pings." },
  });
  app.use("/api/track", trackLimiter);
  console.log("[track] per-token GPS rate limiter ENABLED (60/min)");
} else {
  console.log(
    "[auth] brute-force limiter DISABLED (set DISPATCHOS_AUTH_RATE_LIMIT=on to re-enable).",
  );
}

// ---------------------------------------------------------------------------
// Persistent session store (SQLite). Sessions live in their own file alongside
// uploads + drive under DISPATCHOS_DATA_ROOT, so a bizdata backup doesn't drag
// ephemeral sessions with it. Replaces the v1.2.7 in-process MemoryStore.
// ---------------------------------------------------------------------------

const SQLiteStore = connectSqlite3(session);
const dataRoot = path.resolve(process.env.DISPATCHOS_DATA_ROOT || "dispatchos_data");
fs.mkdirSync(dataRoot, { recursive: true });

app.use(
  session({
    name: "dispatchos.sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: new (SQLiteStore as any)({
      db: "sessions.db",
      dir: dataRoot,
      table: "sessions",
    }),
    cookie: {
      httpOnly: true,
      // Audit V3-4 — SameSite=Strict for the session cookie. We don't have
      // a cross-site auth flow (signup is same-site), so this is safe. Strict
      // is significantly stronger than Lax against CSRF: form-POSTs from
      // attacker sites won't ship the cookie at all (Lax only protects POST,
      // not GET; and not sibling subdomains).
      sameSite: "strict",
      // Default to secure cookies in any production-like deployment. Explicit
      // opt-out only via DISPATCHOS_COOKIE_SECURE=false (e.g. local HTTPS proxy).
      secure:
        process.env.DISPATCHOS_COOKIE_SECURE === "false"
          ? false
          : process.env.DISPATCHOS_COOKIE_SECURE === "true" || isProdLike,
      maxAge: 12 * 60 * 60 * 1000,
    },
  }),
);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        // Redact tokens/passwords/secrets from request-log line to avoid
        // leaking them into stdout / journald. Several endpoints legitimately
        // return one-time secrets in their body (TOTP setup → {secret}, admin
        // reset-password → {temporaryPassword}, tracking-token → {token},
        // signup/bootstrap → {totpSecret, otpauthUrl}); without redaction the
        // per-request logger below would print them verbatim.
        const safe = { ...capturedJsonResponse } as Record<string, unknown>;
        const SECRET_RESPONSE_KEYS = [
          "totpSecret",
          "secret",
          "password",
          "temporaryPassword",
          "token",
          "owntracksUserId",
          "otpauthUrl",
          "osmandUrl",
          "pendingConfirmationToken",
        ];
        for (const key of SECRET_RESPONSE_KEYS) {
          if (typeof safe[key] === "string") safe[key] = "[redacted]";
        }
        logLine += ` :: ${JSON.stringify(safe)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // One-shot migration: if a legacy v1.2.7 auth_config.owner row exists and
  // the users table is empty, copy it into users as role=admin.
  const migrationResult = storage.migrateLegacyOwnerIfNeeded();
  if (migrationResult.migrated) {
    log(
      `migrated legacy owner -> admin user (id=${migrationResult.userId}, email=${migrationResult.email})`,
      "migration",
    );
  }

  // Broker Trust #1: one-shot backfill from existing loads.
  try {
    const bf = backfillBrokerTrustSignals();
    if (bf.backfilled > 0) log(`[broker-trust] backfilled ${bf.backfilled} signals`, "migration");
  } catch (err) { log(`[broker-trust] backfill error: ${String(err)}`, "migration"); }

  const httpServer = await registerRoutes(app);

  // Sentry error handler installs only when DSN is configured; otherwise the
  // call is a cheap no-op. Must come BEFORE the user-facing handler so the
  // error reaches Sentry before we mask it for the API response.
  Sentry.setupExpressErrorHandler(app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  const host = process.env.DISPATCHOS_HOST || "127.0.0.1";
  // reusePort removed: not supported on Windows under Node 20+ and Node 24
  // throws ENOTSUP on listen. Single-process production runs don't need it.
  // -------------------------------------------------------------------------
  // Audit High #16 — graceful shutdown + global error guards.
  //
  // Fly.io rolling deploys send SIGTERM and then SIGKILL ~5s later. Without
  // a handler in-flight HTTP responses are silently dropped, and any unhandled
  // promise rejection (e.g. a cron failure) kills the process. We:
  //   • forward unhandledRejection/uncaughtException to Sentry + log
  //   • on SIGTERM/SIGINT, stop accepting new connections, drain existing
  //     requests for up to 10s, then exit. Sessions live in SQLite (WAL),
  //     so we don't need to flush an in-process store.
  // -------------------------------------------------------------------------
  process.on("unhandledRejection", (reason: unknown) => {
    console.error("[fatal] unhandledRejection:", reason);
    try {
      Sentry.captureException(reason);
    } catch {
      /* sentry unavailable */
    }
  });
  process.on("uncaughtException", (err: Error) => {
    console.error("[fatal] uncaughtException:", err);
    try {
      Sentry.captureException(err);
    } catch {
      /* sentry unavailable */
    }
    // Keep the process alive — a single bad cron path shouldn't take down
    // everything. Node will still surface the original error on the stack.
  });

  let shuttingDown = false;
  function gracefulShutdown(signal: NodeJS.Signals): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down on ${signal} — draining in-flight requests`);
    httpServer.close((err) => {
      if (err) console.error("[shutdown] httpServer.close error:", err);
      // Checkpoint + close the DB so the WAL is truncated and we don't leave a
      // dirty -wal across the deploy.
      closeDatabase();
      log("shutdown complete");
      process.exit(0);
    });
    // Hard exit if drain takes too long. 10s is well within Fly's 30s SIGKILL
    // grace period.
    setTimeout(() => {
      console.error("[shutdown] drain timed out after 10s — forcing exit");
      process.exit(1);
    }, 10_000).unref();
  }
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  httpServer.listen(
    {
      port,
      host,
    },
    () => {
      log(`serving on http://${host}:${port}`);
      // Best-effort Telegram setWebhook — fires once on boot, doesn't block.
      // No-op unless both TELEGRAM_DRIVER_BOT_TOKEN and DISPATCHOS_PUBLIC_URL
      // are set. Failures are logged but never crash the server.
      void registerTelegramWebhookOnBoot();
    },
  );
})();

async function registerTelegramWebhookOnBoot(): Promise<void> {
  const token = process.env.TELEGRAM_DRIVER_BOT_TOKEN;
  const publicUrl = process.env.DISPATCHOS_PUBLIC_URL;
  if (!token || !publicUrl) {
    if (!token) log("telegram bot: TELEGRAM_DRIVER_BOT_TOKEN not set, skipping setWebhook", "telegram");
    else log("telegram bot: DISPATCHOS_PUBLIC_URL not set, skipping setWebhook", "telegram");
    return;
  }
  const webhookUrl = `${publicUrl.replace(/\/$/, "")}/api/telegram/webhook/${token}`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ["message", "edited_message"],
        max_connections: 10,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (body.ok) {
      log(`telegram bot: webhook registered → ${publicUrl}/api/telegram/webhook/<token>`, "telegram");
    } else {
      log(`telegram bot: setWebhook failed: ${body.description ?? res.status}`, "telegram");
    }
  } catch (err) {
    log(`telegram bot: setWebhook threw: ${err instanceof Error ? err.message : String(err)}`, "telegram");
  }
}
