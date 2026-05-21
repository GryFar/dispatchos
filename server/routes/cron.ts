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
