// Integration live-test endpoint.
//
// Companion to /api/admin/integrations (read-only status; see Vlad's
// server/lib/integrations.ts). Where the status endpoint says "configured
// vs not", this one actually fires a network probe at each connector and
// reports the result.
//
// Cache: in-memory, 5 min per integration, to keep us under broker rate
// limits even if a dispatcher mashes the "Test" button.

import type { Express, Request, Response as ExpressResponse } from "express";
import { INTEGRATIONS, type IntegrationDescriptor } from "../lib/integrations";
import { getIntegrationValue } from "../lib/integration-config";
import { storage } from "../storage";
import { assertSafeOutboundUrl } from "../lib/url-guard";
import { getCurrentUser } from "../auth";

// Alias the global Response (undici/fetch) — keeps it visually distinct from
// Express's Response and stops tsc from collapsing both into one type.
type FetchResponse = globalThis.Response;

interface TestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  details?: Record<string, unknown>;
  testedAt: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, TestResult>();

function cached(key: string): TestResult | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - new Date(hit.testedAt).getTime() > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit;
}

function envPresent(envVars: string[]): boolean {
  return envVars.every((k) => {
    const v = process.env[k];
    return typeof v === "string" && v.trim().length > 0;
  });
}

async function timedFetch(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<{ res: FetchResponse | null; ms: number; err?: Error }> {
  // Anti-SSRF: the URL can be admin-set (FMCSA_API_URL); never fetch an
  // internal / cloud-metadata address.
  try {
    assertSafeOutboundUrl(url);
  } catch (err) {
    return { res: null, ms: 0, err: err as Error };
  }
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? 8000);
  const start = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return { res, ms: Date.now() - start };
  } catch (err) {
    return { res: null, ms: Date.now() - start, err: err as Error };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Per-integration test implementations.
// ---------------------------------------------------------------------------

async function testFmcsa(): Promise<TestResult> {
  const key = getIntegrationValue("fmcsa", "FMCSA_WEB_KEY");
  const base = getIntegrationValue("fmcsa", "FMCSA_API_URL") ?? "https://mobile.fmcsa.dot.gov/qc/services";
  if (!key) return mkSkip("FMCSA_WEB_KEY not set");
  // 123456 is a known valid carrier returning a stable response shape.
  const { res, ms, err } = await timedFetch(`${base}/carriers/123456?webKey=${key}`);
  if (err || !res) return mkFail(`network: ${err?.message ?? "no response"}`, ms);
  if (res.status === 401) return mkFail("401 — bad webKey", ms);
  if (!res.ok) return mkFail(`HTTP ${res.status}`, ms);
  const body = (await res.json().catch(() => ({}))) as { content?: { carrier?: { legalName?: string } } };
  const name = body?.content?.carrier?.legalName;
  return mkOk(name ? `Carrier 123456 → ${name}` : "200 OK (no carrier payload)", ms);
}

async function testTelegramBot(): Promise<TestResult> {
  const token = getIntegrationValue("telegram_driver_bot", "TELEGRAM_DRIVER_BOT_TOKEN");
  if (!token) return mkSkip("TELEGRAM_DRIVER_BOT_TOKEN not set");
  // Route both calls through timedFetch so they share the 8s AbortController
  // cap — a stalled api.telegram.org must not hang the admin request forever.
  const start = Date.now();
  try {
    const [meOut, whOut] = await Promise.all([
      timedFetch(`https://api.telegram.org/bot${token}/getMe`),
      timedFetch(`https://api.telegram.org/bot${token}/getWebhookInfo`),
    ]);
    const ms = Date.now() - start;
    if (meOut.err || !meOut.res) return mkFail(`network: ${meOut.err?.message ?? "no response"}`, ms);
    if (whOut.err || !whOut.res) return mkFail(`network: ${whOut.err?.message ?? "no response"}`, ms);
    const meRes = meOut.res;
    const whRes = whOut.res;
    if (!meRes.ok) return mkFail(`getMe HTTP ${meRes.status}`, ms);
    const me = (await meRes.json().catch(() => ({}))) as { ok?: boolean; result?: { username?: string } };
    // getMe already succeeded; don't let a non-2xx / non-JSON getWebhookInfo
    // body throw and get masked as a generic "network:" error in the catch.
    if (!whRes.ok) return mkFail(`getWebhookInfo HTTP ${whRes.status}`, ms);
    const wh = (await whRes.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { url?: string; pending_update_count?: number; last_error_message?: string };
    };
    const details = {
      username: me.result?.username,
      webhookUrl: wh.result?.url || "(none)",
      pendingUpdates: wh.result?.pending_update_count ?? 0,
      lastError: wh.result?.last_error_message ?? null,
    };
    if (wh.result?.last_error_message) {
      return { ok: false, latencyMs: ms, message: `webhook error: ${wh.result.last_error_message}`, details, testedAt: new Date().toISOString() };
    }
    return mkOk(`@${me.result?.username} · webhook OK`, ms, details);
  } catch (err) {
    return mkFail(`network: ${(err as Error).message}`, Date.now() - start);
  }
}

async function testResend(): Promise<TestResult> {
  const key = getIntegrationValue("resend", "RESEND_API_KEY");
  if (!key) return mkSkip("RESEND_API_KEY not set");
  const { res, ms, err } = await timedFetch("https://api.resend.com/domains", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (err || !res) return mkFail(`network: ${err?.message ?? "no response"}`, ms);
  if (res.status === 401) return mkFail("401 — bad API key", ms);
  if (!res.ok) return mkFail(`HTTP ${res.status}`, ms);
  const body = (await res.json().catch(() => ({ data: [] }))) as {
    data?: Array<{ name: string; status: string; region: string }>;
  };
  const domains = body?.data ?? [];
  const verified = domains.filter((d) => d.status === "verified");
  return mkOk(
    `${verified.length}/${domains.length} domain(s) verified`,
    ms,
    { domains: domains.map((d) => `${d.name} (${d.status})`) },
  );
}

async function testEia(): Promise<TestResult> {
  const key = getIntegrationValue("eia_fuel", "EIA_API_KEY");
  if (!key) return mkSkip("EIA_API_KEY not set");
  const url = `https://api.eia.gov/v2/petroleum/pri/gnd/data/?api_key=${key}&frequency=weekly&data[]=value&length=1`;
  const { res, ms, err } = await timedFetch(url);
  if (err || !res) return mkFail(`network: ${err?.message ?? "no response"}`, ms);
  if (res.status === 401 || res.status === 403) return mkFail(`${res.status} — bad API key`, ms);
  if (!res.ok) return mkFail(`HTTP ${res.status}`, ms);
  const body = (await res.json().catch(() => ({}))) as {
    response?: { data?: Array<{ value: number; period: string }> };
  };
  const row = body?.response?.data?.[0];
  return mkOk(row ? `latest diesel $${row.value} (${row.period})` : "200 OK (no rows)", ms);
}

function testSentry(): TestResult {
  const dsn = getIntegrationValue("sentry", "SENTRY_DSN");
  if (!dsn) return mkSkip("SENTRY_DSN not set");
  // No network call — Sentry treats every POST as a real event and burns
  // quota. We just validate the DSN shape locally.
  const valid = /^https:\/\/[a-f0-9]+@o\d+\.ingest(?:\.[a-z-]+)?\.sentry\.io\/\d+$/i.test(dsn);
  return valid
    ? mkOk("DSN format valid (no live ping by design)", 0)
    : mkFail("DSN format invalid", 0);
}

async function testInboundEmail(): Promise<TestResult> {
  const secret = process.env.DISPATCHOS_INBOUND_SECRET;
  const publicUrl = process.env.DISPATCHOS_PUBLIC_URL;
  if (!secret) return mkSkip("DISPATCHOS_INBOUND_SECRET not set");
  if (!publicUrl) return mkSkip("DISPATCHOS_PUBLIC_URL not set");
  // POST to ourselves — proves the route is alive AND the secret is right.
  const { res, ms, err } = await timedFetch(`${publicUrl.replace(/\/$/, "")}/api/inbound/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-inbound-secret": secret,
    },
    body: JSON.stringify({
      from: "ping@dispatchos.co",
      subject: "[admin-test] integration test ping",
      body: "Sent by /api/admin/integrations/test. Ignore.",
    }),
    timeoutMs: 6000,
  });
  if (err || !res) return mkFail(`network: ${err?.message ?? "no response"}`, ms);
  if (res.status === 401) return mkFail("401 — secret mismatch", ms);
  if (res.status !== 201) return mkFail(`HTTP ${res.status}`, ms);
  return mkOk("loop OK (test ping persisted to email_ingest)", ms);
}

async function testTwilio(): Promise<TestResult> {
  // Not wired into app yet. Sentinel test to keep UI consistent.
  return mkSkip("Twilio not configured in code yet");
}

async function testGoogleDrive(): Promise<TestResult> {
  return mkSkip("Google Drive integration uses connector, no env-based test");
}

// ---------------------------------------------------------------------------
// Test dispatch — keys MUST match INTEGRATIONS[].key in lib/integrations.ts.
// ---------------------------------------------------------------------------

type TestFn = () => Promise<TestResult> | TestResult;

const TESTS: Record<string, TestFn> = {
  fmcsa: testFmcsa,
  telegram_driver_bot: testTelegramBot,
  resend: testResend,
  sylectus_inbound: testInboundEmail,
  google_drive: testGoogleDrive,
  twilio: testTwilio,
  sentry: testSentry,
  eia_fuel: testEia,
};

// ---------------------------------------------------------------------------
// Helpers for shaping responses
// ---------------------------------------------------------------------------

function mkOk(message: string, latencyMs: number, details?: Record<string, unknown>): TestResult {
  return { ok: true, message, latencyMs, details, testedAt: new Date().toISOString() };
}
function mkFail(message: string, latencyMs: number): TestResult {
  return { ok: false, message, latencyMs, testedAt: new Date().toISOString() };
}
function mkSkip(message: string): TestResult {
  return { ok: false, message, latencyMs: 0, testedAt: new Date().toISOString(), details: { skipped: true } };
}

// ---------------------------------------------------------------------------
// Route registration.
// Auth: relies on the *caller* (registerAdminIntegrationsRoutes) to gate by
// role. We don't double-gate here so we don't accidentally diverge.
// ---------------------------------------------------------------------------

export function registerAdminIntegrationTestsRoutes(
  app: Express,
  requireAdmin: (req: Request, res: ExpressResponse, next: () => void) => void,
): void {
  // List integrations + the shape of each test (no actual run).
  app.get("/api/admin/integrations/tests", requireAdmin, (_req: Request, res: ExpressResponse) => {
    const list = INTEGRATIONS.map((i: IntegrationDescriptor) => ({
      id: i.key,
      label: i.label,
      kind: i.kind,
      envVars: i.envVars,
      configured: envPresent(i.envVars),
      testable: typeof TESTS[i.key] === "function",
      lastResult: cache.get(i.key) ?? null,
    }));
    return res.json({ integrations: list });
  });

  // Run a specific integration's test, with 5min cache.
  app.post("/api/admin/integrations/test/:id", requireAdmin, async (req: Request, res: ExpressResponse) => {
    const rawId = req.params.id;
    const id = typeof rawId === "string" ? rawId : Array.isArray(rawId) ? String(rawId[0] ?? "") : "";
    if (!id) {
      return res.status(400).json({ message: "missing integration id" });
    }
    const integration = INTEGRATIONS.find((i: IntegrationDescriptor) => i.key === id);
    if (!integration) {
      return res.status(404).json({ message: `Unknown integration: ${id}` });
    }
    const fn = id ? TESTS[id] : undefined;
    if (!fn) {
      return res.status(501).json({ message: `No test implemented for ${id}` });
    }

    // Cache-bust via ?force=1
    const force = req.query.force === "1" || req.query.force === "true";
    if (!force) {
      const hit = cached(id);
      if (hit) return res.json({ ...hit, fromCache: true });
    }

    try {
      const result = await fn();
      cache.set(id, result);
      storage.audit("integration.tested", "integration", id, {
        ok: result.ok,
        latencyMs: result.latencyMs,
        message: result.message,
        actorUserId: getCurrentUser(req)?.id,
      });
      return res.json({ ...result, fromCache: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[admin-integrations] test ${id} threw:`, err);
      return res.status(500).json({ ok: false, message: `runtime: ${msg}`, latencyMs: 0, testedAt: new Date().toISOString() });
    }
  });
}
