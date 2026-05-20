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

if (
  isVdsMode &&
  (!process.env.DISPATCHOS_SESSION_SECRET ||
    process.env.DISPATCHOS_SESSION_SECRET === "change-this-before-real-use" ||
    process.env.DISPATCHOS_SESSION_SECRET === "change-this-local-dispatchos-secret-before-production")
) {
  throw new Error("VDS mode requires a strong DISPATCHOS_SESSION_SECRET in .env");
}

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
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
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
    secret:
      process.env.DISPATCHOS_SESSION_SECRET || "change-this-local-dispatchos-secret-before-production",
    resave: false,
    saveUninitialized: false,
    store: new (SQLiteStore as any)({
      db: "sessions.db",
      dir: dataRoot,
      table: "sessions",
    }),
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.DISPATCHOS_COOKIE_SECURE === "true",
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
