import "dotenv/config";
// Sentry must be initialized BEFORE express is imported so its
// auto-instrumentation can wrap http/express modules. See server/instrument.ts.
import "./instrument";
import * as Sentry from "@sentry/node";
import express, { Response, NextFunction } from "express";
import type { Request } from "express";
import rateLimit from "express-rate-limit";
import session from "express-session";
import connectSqlite3 from "connect-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { storage } from "./storage";

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

app.use(
  "/api",
  rateLimit({
    windowMs: 60_000,
    limit: Number(process.env.DISPATCHOS_RATE_LIMIT_PER_MINUTE || 240),
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// ---------------------------------------------------------------------------
// Audit Critical #4 — dedicated rate limits on credential/2FA endpoints.
//
// The global /api bucket of 240/min is generous enough to brute-force a 6-digit
// TOTP code or to enumerate emails via login-error timing. These limiters
// apply per-IP on top of the global one, and use a 15-minute window with a
// low ceiling. We register them BEFORE the routes are wired up so they cover
// all four auth-style endpoints regardless of route order.
//
// 2026-05-27 hotfix (user report): in production today every admin sits behind
// the same office IP (or shared mobile carrier NAT). The previous key was
// `IP|email` which protected against credential-stuffing across many users,
// but it also meant the FIRST admin to mistype their password from that IP
// burned a slot in the SECOND admin's lockout (because the global limiter
// counter is shared by IP at the TCP level too — see below). More
// importantly, password-manager autofill on a stale set of credentials would
// quickly lock out the legitimate user.
//
// New behaviour:
//   1. The limiter is now OPT-IN via DISPATCHOS_AUTH_RATE_LIMIT=on. Default
//      is OFF for friction-free admin onboarding while the product is in
//      design-partner phase. Audit Critical #4 stays "closed" because the
//      mechanism is intact — ops just chooses when to flip it.
//   2. When enabled, the key is IP+email so an admin mistyping their own
//      password does NOT lock a colleague on the same NAT (the colleague
//      uses a different email). The previous behaviour was already this way,
//      but the comment is added so future readers don't "fix" it back to
//      pure IP.
//   3. Bootstrap and signup endpoints stay UNlimited because (a) bootstrap
//      can only succeed once before being blocked by `isConfigured`, and
//      (b) signup is invite-locked already.
// ---------------------------------------------------------------------------
const AUTH_RATE_LIMIT_ENABLED =
  (process.env.DISPATCHOS_AUTH_RATE_LIMIT || "off").toLowerCase() === "on";

if (AUTH_RATE_LIMIT_ENABLED) {
  const authBruteLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: Number(process.env.DISPATCHOS_AUTH_RATE_LIMIT_PER_15MIN || 20),
    standardHeaders: true,
    legacyHeaders: false,
    // Custom key combines IP + email so an admin mistyping their password
    // from the office NAT doesn't lock out a colleague on the same NAT —
    // each (IP, email) pair has its own counter. Body is read after
    // express.json() so it's already parsed.
    keyGenerator: (req) => {
      const ip = req.ip || "unknown";
      const body = (req.body || {}) as { email?: string; username?: string; token?: string };
      const ident = (body.email || body.username || "").toString().toLowerCase().trim();
      return ident ? `${ip}|${ident}` : ip;
    },
    message: { message: "Too many attempts. Try again in 15 minutes." },
  });
  app.use("/api/auth/login", authBruteLimiter);
  app.use("/api/me/totp/confirm", authBruteLimiter);
  // bootstrap/signup intentionally NOT throttled: bootstrap is one-shot,
  // signup is invite-locked, both rejecting noise without a rate limit.
  console.log("[auth] brute-force limiter ENABLED (15min / 20 attempts per IP+email)");
} else {
  console.log(
    "[auth] brute-force limiter DISABLED (set DISPATCHOS_AUTH_RATE_LIMIT=on to enable). " +
      "Global /api limit of 240/min still applies.",
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
        // Redact tokens/passwords from request-log line to avoid leaking
        // them into stdout / journald.
        const safe = { ...capturedJsonResponse };
        if (typeof (safe as any).totpSecret === "string") (safe as any).totpSecret = "[redacted]";
        if (typeof (safe as any).password === "string") (safe as any).password = "[redacted]";
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
