// Cron / scheduled-task endpoints.
//
// These run unauthenticated (no session) but require a shared secret in the
// X-Cron-Secret header that matches process.env.DISPATCHOS_CRON_SECRET.
//
// Triggered by external schedulers (GitHub Actions weekly, fly cron, etc.)
// rather than a user-facing UI.

import type { Express, Request, Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createDbSnapshot } from "../lib/backup";
import { refreshFromEia } from "../lib/ai/fuel";
import { fetchGasBuddyDieselNear } from "../lib/ai/fuel-gasbuddy";
import { storage } from "../storage";
import { getAdapter } from "../lib/adapters";
import { decryptCredentials } from "../lib/crypto/keyring";
import { scoreLoadForClient } from "../routes";
import {
  shouldAlertLoad,
  notifyMatchedLoadsBatch,
  notifyPickupReminder,
  pickupReminderLeadHours,
} from "../lib/load-alerts";
import type { ScoredLoad } from "@shared/schema";

// Exported for unit tests (cron.test.ts) — the auth gate guards ~9
// unauthenticated cron endpoints, so its 503/401/length-mismatch behavior is
// covered directly rather than only through the lib jobs it fronts.
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function requireCronSecret(req: Request, res: Response): boolean {
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

// P0.4/P0.5 — score freshly-ingested loads for the owning carrier and push the
// strong ones to that carrier's linked Telegram recipients. Returns the count
// of recipients actually messaged. Entirely best-effort: any error is logged
// and swallowed so a notify problem never breaks the poll.
async function pushMatchedLoadAlerts(clientId: string, newLoadIds: string[]): Promise<number> {
  if (!newLoadIds.length) return 0;
  const client = storage.getClient(clientId);
  if (!client) return 0;
  // Score all new loads first, then send ONE digest per recipient instead of a
  // ping per load — a poll that ingests many strong loads must not spam the
  // carrier into muting the bot (which would kill the whole alert promise).
  const scoredLoads: ScoredLoad[] = [];
  for (const loadId of newLoadIds) {
    try {
      const load = storage.getLoad(loadId);
      if (!load) continue;
      const scored = scoreLoadForClient(client, load);
      if (scored && shouldAlertLoad(scored)) scoredLoads.push(scored);
    } catch (err) {
      console.error(`[cron/load-alerts] score ${loadId} failed:`, (err as Error).message);
    }
  }
  if (!scoredLoads.length) return 0;
  try {
    const res = await notifyMatchedLoadsBatch(client, scoredLoads);
    if (res.errors.length) {
      console.error(`[cron/load-alerts] client ${clientId}: ${res.errors.join("; ")}`);
    }
    return res.sent;
  } catch (err) {
    console.error(`[cron/load-alerts] client ${clientId} failed:`, (err as Error).message);
    return 0;
  }
}

// A load source just flipped active->paused after repeated failures: its feed
// is now dark with no further polling. There is no reusable, config-free
// owner-alert sender in the codebase (the existing TG notifiers require
// per-client chat config / private ctx), so we DO NOT invent one here — we log
// a clear, greppable warning and surface pausedCount/degraded in the cron
// response (read by load-sources-poll.yml). Wiring an actual push alert is left
// to the owner once an alert channel/token is configured.
function warnAutoPaused(rec: { sourceId: string; clientId: string | null; label: string | null }): void {
  const name = rec.label || rec.sourceId;
  console.warn(
    `[cron/load-sources] ALERT: Load source ${name} (id=${rec.sourceId}, client=${rec.clientId ?? "?"}) ` +
      `auto-paused after repeated failures — its load feed is now dark.`,
  );
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

    type PollResult =
      | { id: string; ok: true; loadsFound: number; loadsNew: number; alertsSent: number }
      | { id: string; ok: false; error: string; skipped?: true; justPaused?: true };

    const pollSource = async (src: (typeof sources)[number]): Promise<PollResult> => {
      // Atomic lease: bump last_polled_at NOW iff the row is still due, so two
      // overlapping cron runs can't both poll (and double-alert) the same
      // source. The loser of the race skips without any network I/O.
      if (!storage.leaseLoadSourceForPoll(src.id)) {
        return { id: src.id, ok: false, error: "skipped_not_leased", skipped: true };
      }
      const t0 = Date.now();
      const adapter = getAdapter(src.adapterKey);
      if (!adapter) {
        const rec = storage.recordLoadSourcePoll(src.id, { loadsFound: 0, errorMessage: `Unknown adapter: ${src.adapterKey}` });
        if (rec.justPaused) warnAutoPaused(rec);
        return { id: src.id, ok: false, error: "unknown_adapter", ...(rec.justPaused ? { justPaused: true as const } : {}) };
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
        const newLoadIds: string[] = [];
        for (const raw of raws) {
          const norm = adapter.normalizeToLoad(raw, rowForAdapter);
          const { id, inserted: wasNew } = storage.upsertLoadFromSource({
            sourceId: src.id,
            sourceExternalId: norm.sourceExternalId,
            clientId: src.clientId,
            payload: norm as unknown as Record<string, unknown>,
          });
          if (wasNew) {
            inserted += 1;
            newLoadIds.push(id);
          }
        }
        // P0.4/P0.5 — push high-score new loads to the carrier's linked Telegram
        // recipients. Best-effort: a notify failure must not fail the poll.
        const pushed = await pushMatchedLoadAlerts(src.clientId, newLoadIds);
        storage.recordLoadSourcePoll(src.id, { loadsFound: raws.length });
        storage.audit("load_source.polled", "load_source", src.id, {
          loadsFound: raws.length,
          loadsNew: inserted,
          alertsSent: pushed,
          durationMs: Date.now() - t0,
        });
        return { id: src.id, ok: true, loadsFound: raws.length, loadsNew: inserted, alertsSent: pushed };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const rec = storage.recordLoadSourcePoll(src.id, { loadsFound: 0, errorMessage: msg });
        if (rec.justPaused) warnAutoPaused(rec);
        storage.audit("load_source.poll_failed", "load_source", src.id, {
          error: msg,
          durationMs: Date.now() - t0,
          justPaused: rec.justPaused,
        });
        return { id: src.id, ok: false, error: msg, ...(rec.justPaused ? { justPaused: true as const } : {}) };
      }
    };

    // Bound fan-out: each source runs authenticate + fetchLoads + alert pushes,
    // so polling every due source at once can exhaust sockets / hit vendor
    // rate limits. Process sources through a small fixed-size worker pool.
    const CONCURRENCY = Math.max(
      1,
      Number(process.env.DISPATCHOS_LOAD_SOURCE_CONCURRENCY) || 4,
    );
    const results: PollResult[] = new Array(sources.length);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= sources.length) return;
        results[i] = await pollSource(sources[i]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, sources.length) }, () => worker()),
    );

    // Surface auto-pause transitions so the GitHub Actions poller
    // (load-sources-poll.yml) and any external monitor can see a feed went
    // dark this run, even though the per-source HTTP call itself "succeeded".
    const pausedCount = results.filter(
      (r) => r.ok === false && r.justPaused === true,
    ).length;
    return res.json({
      ok: true,
      polled: sources.length,
      leased: results.filter((r) => !(r.ok === false && r.skipped)).length,
      pausedCount,
      degraded: pausedCount > 0,
      results,
    });
  });

  // POST /api/cron/pickup-reminders
  // Ping the assigned driver's Telegram for loads whose pickup window is within
  // the lead-time (default 3h, DISPATCHOS_PICKUP_REMINDER_LEAD_HOURS). Deduped
  // per (load, driver) so re-runs don't re-ping. Best-effort; safe to call often.
  app.post("/api/cron/pickup-reminders", async (req: Request, res: Response) => {
    if (!requireCronSecret(req, res)) return;
    try {
      const nowMs = Date.now();
      const fromIso = new Date(nowMs).toISOString();
      const toIso = new Date(nowMs + pickupReminderLeadHours() * 3600_000).toISOString();
      const due = storage.listLoadsDueForPickupReminder(fromIso, toIso);
      let sent = 0;
      let skipped = 0;
      const errors: string[] = [];
      for (const { load, driverId, pickupAt } of due) {
        const driver = storage.getUserById(driverId);
        const chatId = driver?.telegramChatId;
        if (!driver || driver.blocked || !chatId) continue;
        const outcome = await notifyPickupReminder(load, driverId, chatId, pickupAt, nowMs);
        if (outcome === "sent") sent += 1;
        else if (outcome === "skipped") skipped += 1;
        else errors.push(load.id);
      }
      return res.json({ ok: true, candidates: due.length, sent, skipped, errors });
    } catch (err) {
      console.error("[cron/pickup-reminders] failed:", err);
      return res.status(500).json({
        message: "Pickup reminder check failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /api/cron/check-insurance
  // Daily check for upcoming insurance expirations. Anti-spam via
  // insurance_alerts_sent. Idempotent within a day; safe to call manually.
  app.post("/api/cron/check-insurance", async (req: Request, res: Response) => {
    if (!requireCronSecret(req, res)) return;
    const { runInsuranceCheck } = await import("../lib/insurance-monitor");
    try {
      const result = await runInsuranceCheck();
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[cron/check-insurance] failed:", err);
      return res.status(500).json({
        message: "Insurance check failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /api/cron/check-trial-expiry
  // Daily check for trial expirations + reminders at T-7/3/1 days.
  // Transitions billingStatus=trial → expired when trialEndsAt has passed
  // AND no active Stripe subscription. Anti-spam via compliance_alerts_sent.
  app.post("/api/cron/check-trial-expiry", async (req: Request, res: Response) => {
    if (!requireCronSecret(req, res)) return;
    const { runTrialExpiryCheck } = await import("../lib/trial-expiry");
    try {
      const outcomes = await runTrialExpiryCheck();
      return res.json({
        ok: true,
        evaluated: outcomes.length,
        reminders: outcomes.filter((o) => o.kind === "reminder").length,
        expired: outcomes.filter((o) => o.kind === "expired").length,
        outcomes,
      });
    } catch (err) {
      console.error("[cron/check-trial-expiry] failed:", err);
      return res.status(500).json({
        message: "Trial expiry check failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /api/cron/check-renewals
  // Killer feature #5 — UCR/IRP renewal alerts. Same anti-spam pattern as
  // insurance. Schedule alongside check-insurance (daily 09:00 ET via GH Actions).
  app.post("/api/cron/check-renewals", async (req: Request, res: Response) => {
    if (!requireCronSecret(req, res)) return;
    const { runComplianceRenewalsCheck } = await import("../lib/compliance-renewals");
    try {
      const outcomes = await runComplianceRenewalsCheck();
      const dispatched = outcomes.filter((o) => o.sentChannels.length > 0);
      return res.json({
        ok: true,
        evaluated: outcomes.length,
        dispatched: dispatched.length,
        outcomes,
      });
    } catch (err) {
      console.error("[cron/check-renewals] failed:", err);
      return res.status(500).json({
        message: "Compliance renewals check failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /api/cron/purge-old-data
  // Audit V2-7 / V2-29 — expanded purge:
  //   • GPS pings older than 15 days (existing).
  //   • Fuel observations older than 90 days (was promised by schema, never run).
  //   • Audit events older than 180 days (PII retention).
  //   • Email ingest older than 180 days.
  // Safe to call hourly; idempotent and bounded.
  app.post("/api/cron/purge-old-data", (req: Request, res: Response) => {
    if (!requireCronSecret(req, res)) return;
    const pingsDeleted = storage.purgeOldLocationPings(15);
    const fuelDeleted = storage.purgeOldFuelObservations(90);
    const auditDeleted = storage.purgeOldAuditEvents(180);
    const emailDeleted = storage.purgeOldEmailIngest(180);
    return res.json({
      ok: true,
      pingsDeleted,
      fuelDeleted,
      auditDeleted,
      emailDeleted,
    });
  });

  app.post("/api/cron/refresh-fuel", async (req: Request, res: Response) => {
    if (!requireCronSecret(req, res)) return;

    const { getIntegrationValue } = await import("../lib/integration-config");
    const apiKey = getIntegrationValue("eia_fuel", "EIA_API_KEY");
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

  // -------------------------------------------------------------------------
  // POST /api/cron/refresh-gasbuddy
  //
  // Best-effort GasBuddy diesel scrape for a set of coordinates. Body:
  //   { points: [{ lat, lng, radiusKm? }, ...] }
  // For each point, scrape nearby diesel prices and persist as
  // source="gasbuddy" fuel_price_observations. GasBuddy is bot-protected, so
  // any point may yield 0 rows (blocked / JS-rendered); that's expected and
  // non-fatal. Nikita wires the EIA fallback on top.
  //
  // Auth: X-Cron-Secret. Response: { ok, points, totalObserved, perPoint[] }
  // -------------------------------------------------------------------------
  app.post("/api/cron/refresh-gasbuddy", async (req: Request, res: Response) => {
    if (!requireCronSecret(req, res)) return;

    const points = Array.isArray(req.body?.points) ? req.body.points : [];
    if (points.length === 0) {
      return res.status(400).json({ message: "Body must include points: [{lat, lng, radiusKm?}]" });
    }
    // Cap fan-out so a single call can't trigger thousands of sequential vendor
    // scrapes (rate-limit burn / long-running request).
    if (points.length > 100) {
      return res.status(413).json({ message: "Too many points (max 100 per call)" });
    }

    const perPoint: Array<{ lat: number; lng: number; observed: number; error?: string }> = [];
    let totalObserved = 0;

    for (const p of points) {
      const lat = Number(p?.lat);
      const lng = Number(p?.lng);
      const rawRadius = typeof p?.radiusKm === "number" ? p.radiusKm : 8;
      const radiusKm = Number.isFinite(rawRadius) ? Math.min(Math.max(rawRadius, 0.5), 100) : 8;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        perPoint.push({ lat, lng, observed: 0, error: "invalid_coords" });
        continue;
      }
      try {
        const obs = await fetchGasBuddyDieselNear(lat, lng, radiusKm);
        for (const o of obs) storage.recordFuelPriceObservation(o);
        totalObserved += obs.length;
        perPoint.push({ lat, lng, observed: obs.length });
      } catch (err) {
        perPoint.push({ lat, lng, observed: 0, error: err instanceof Error ? err.message : String(err) });
      }
    }

    storage.audit("fuel.gasbuddy_refresh", "fuel_price_observations", "batch", {
      points: points.length,
      totalObserved,
    });

    return res.json({ ok: true, points: points.length, totalObserved, perPoint });
  });

  // -------------------------------------------------------------------------
  // GET|POST /api/cron/backup
  //
  // Audit H5 — restore-grade offsite DB backup. Takes a CONSISTENT online
  // snapshot of the live SQLite file (no app lock) and STREAMS it back as the
  // response body so the caller (GitHub Actions, see backup-cron.yml) can store
  // it as an artifact — the zero-config offsite copy, no S3 creds required.
  //
  // The snapshot itself is retained locally per DISPATCHOS_BACKUP_KEEP; we do
  // NOT delete the file we just streamed (retention prunes older ones).
  //
  // Auth: X-Cron-Secret header must equal env DISPATCHOS_CRON_SECRET. The DB is
  // never exposed without that secret. Body: none.
  // Response: application/octet-stream attachment + X-Backup-Sha256 header.
  // -------------------------------------------------------------------------
  const handleBackup = async (req: Request, res: Response): Promise<void> => {
    if (!requireCronSecret(req, res)) return;
    let snap: { path: string; bytes: number; sha256: string };
    try {
      snap = await createDbSnapshot();
    } catch (err) {
      console.error("[cron/backup] snapshot failed:", err);
      res.status(500).json({
        message: "Backup failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const filename = path.basename(snap.path);
    storage.audit("backup.created", "database", filename, {
      bytes: snap.bytes,
      sha256: snap.sha256,
      filename,
    });

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(snap.bytes));
    res.setHeader("X-Backup-Sha256", snap.sha256);

    const stream = fs.createReadStream(snap.path);
    stream.on("error", (err) => {
      console.error("[cron/backup] stream failed:", err);
      // Headers may already be sent; only set status if we can.
      if (!res.headersSent) res.status(500).json({ message: "Backup stream failed" });
      else res.destroy();
    });
    stream.pipe(res);
  };
  app.get("/api/cron/backup", handleBackup);
  app.post("/api/cron/backup", handleBackup);
}
