// Cron / scheduled-task endpoints.
//
// These run unauthenticated (no session) but require a shared secret in the
// X-Cron-Secret header that matches process.env.DISPATCHOS_CRON_SECRET.
//
// Triggered by external schedulers (GitHub Actions weekly, fly cron, etc.)
// rather than a user-facing UI.

import type { Express, Request, Response } from "express";
import crypto from "node:crypto";
import { refreshFromEia } from "../lib/ai/fuel";
import { storage } from "../storage";
import { getAdapter } from "../lib/adapters";
import { decryptCredentials } from "../lib/crypto/keyring";

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireCronSecret(req: Request, res: Response): boolean {
  const expected = process.env.DISPATCHOS_CRON_SECRET;
  if (!expected) {
    res.status(503).json({ message: "Cron disabled: DISPATCHOS_CRON_SECRET not set" });
    return false;
  }
  const header = req.headers["x-cron-secret"];
  const provided = Array.isArray(header) ? header[0] : header;
  if (typeof provided !== "string" || !timingSafeEqual(provided, expected)) {
    res.status(401).json({ message: "Unauthorized" });
    return false;
  }
  return true;
}

export function registerCronRoutes(app: Express): void {
  // -------------------------------------------------------------------------
  // POST /api/cron/refresh-fuel
  //
  // Pulls latest PADD-level diesel prices from EIA, warms the in-process
  // fuel cache. Should be called ~weekly (EIA publishes Mondays).
  //
  // Auth: X-Cron-Secret header must equal env DISPATCHOS_CRON_SECRET.
  // Body: none.
  // Response: { refreshed, fetchedAt, changes: [{padd, before, after}] }
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // POST /api/cron/rescore
  //
  // Drops all cached load_scores so the next /api/dispatch/board call (or any
  // scoreLoadForClient invocation) recomputes from scratch with current
  // fuel/location/broker_history/lane_history state.
  //
  // Should run AFTER /api/cron/refresh-fuel (fuel prices changed → net_profit
  // changed) or when a driver's location was updated significantly.
  // -------------------------------------------------------------------------
  app.post("/api/cron/rescore", (req: Request, res: Response) => {
    if (!requireCronSecret(req, res)) return;
    try {
      storage.invalidateLoadScores();
      return res.json({ ok: true, invalidatedAt: new Date().toISOString() });
    } catch (err) {
      console.error("[cron/rescore] failed:", err);
      return res.status(500).json({
        message: "Rescore failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/cron/run-load-sources
  //
  // For each active load_sources row whose last_polled_at is older than its
  // poll_interval_min: authenticate → fetchLoads → normalize → upsert.
  // New rows fire a TG alert (handled by Vlad's existing notify path or
  // future smart-matching push). Failures auto-pause after 3 in a row.
  // -------------------------------------------------------------------------
  app.post("/api/cron/run-load-sources", async (req: Request, res: Response) => {
    if (!requireCronSecret(req, res)) return;

    const sources = storage.listLoadSourcesDueForPoll();
    const results = await Promise.allSettled(sources.map(async (src) => {
      const t0 = Date.now();
      const adapter = getAdapter(src.adapterKey);
      if (!adapter) {
        storage.recordLoadSourcePoll(src.id, { loadsFound: 0, errorMessage: `Unknown adapter: ${src.adapterKey}` });
        return { id: src.id, ok: false, error: "unknown_adapter" };
      }
      try {
        let credsPlain: Record<string, string> | undefined;
        if (adapter.requiresCredentials && src.credentialsEnc && src.credentialsIv && src.credentialsKeyId) {
          credsPlain = decryptCredentials({
            ciphertext: src.credentialsEnc,
            iv: src.credentialsIv,
            keyId: src.credentialsKeyId as "primary" | "secondary",
          });
        }
        const rowForAdapter = { ...src, credentialsPlaintext: credsPlain } as any;
        await adapter.authenticate(rowForAdapter);
        const raws = await adapter.fetchLoads(rowForAdapter);
        let inserted = 0;
        for (const raw of raws) {
          const norm = adapter.normalizeToLoad(raw, rowForAdapter);
          const { inserted: wasNew } = storage.upsertLoadFromSource({
            sourceId: src.id,
            sourceExternalId: norm.sourceExternalId,
            clientId: src.clientId,
            payload: norm as unknown as Record<string, unknown>,
          });
          if (wasNew) inserted += 1;
        }
        storage.recordLoadSourcePoll(src.id, { loadsFound: raws.length });
        storage.audit("load_source.polled", "load_source", src.id, {
          loadsFound: raws.length,
          loadsNew: inserted,
          durationMs: Date.now() - t0,
        });
        return { id: src.id, ok: true, loadsFound: raws.length, loadsNew: inserted };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        storage.recordLoadSourcePoll(src.id, { loadsFound: 0, errorMessage: msg });
        storage.audit("load_source.poll_failed", "load_source", src.id, {
          error: msg,
          durationMs: Date.now() - t0,
        });
        return { id: src.id, ok: false, error: msg };
      }
    }));

    return res.json({
      ok: true,
      polled: sources.length,
      results: results.map((r) => r.status === "fulfilled" ? r.value : { ok: false, error: String(r.reason) }),
    });
  });

  app.post("/api/cron/refresh-fuel", async (req: Request, res: Response) => {
    if (!requireCronSecret(req, res)) return;

    const apiKey = process.env.EIA_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ message: "EIA_API_KEY not configured" });
    }

    try {
      const result = await refreshFromEia(apiKey);
      return res.json({
        ok: true,
        refreshed: result.refreshed,
        fetchedAt: new Date(result.fetchedAt).toISOString(),
        changes: result.changes,
      });
    } catch (err) {
      console.error("[cron/refresh-fuel] failed:", err);
      return res.status(500).json({
        message: "Refresh failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
