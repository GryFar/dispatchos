// ===========================================================================
// server/routes/cockpit.ts — Killer #6 Multi-Driver Cockpit (backend)
// ===========================================================================
//
// Single GET that powers the dispatcher's single-screen terminal: every
// assigned carrier (location, HOS, equipment, active loads), the top
// available loads across all of them, and scored carrier↔load pairings.
//
// Reuses scoreLoadForClient (exported from routes.ts) — the same engine the
// dispatch board uses — so suggestions are consistent with the rest of the app.
// No LLM: pairings are deterministic scores. HOS/location live on the client
// (carrier MC#), not the individual driver, in this data model.

import type { Express, Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import type { Client, Load, ScoredLoad } from "@shared/schema";
import { getCurrentUser, requireRole } from "../auth";
import { storage } from "../storage";
import { scoreLoadForClient } from "../routes";
import { createLaneAvgResolver } from "../lib/lane-avg-resolver";
import { getAiRecommendation } from "../lib/ai/dispatch-advisor";
import { chargeAiCreditPack, AI_CREDIT_PACK } from "../lib/stripe";

function ah(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => handler(req, res, next))
      .catch((error: unknown) => {
        if (error instanceof ZodError) {
          return res.status(400).json({ message: "Validation failed", issues: error.issues });
        }
        return next(error);
      });
  };
}

interface CockpitCarrier {
  id: string;
  name: string;
  mc: string;
  equipment: string;
  status: string | null;          // empty | loaded | ... from currentLocation
  locationCity: string | null;
  locationState: string | null;
  locationUpdatedAt: string | null;
  hoursAvailable: number | null;  // HOS hours left, if known
  activeLoadsCount: number;
  activeDriversCount: number;
  alerts: string[];
  // Per-driver card: the driver this card represents (null = carrier has no
  // linked driver yet). Carrier fields above are shared across a carrier's cards.
  driverId: string | null;
  driverName: string | null;
  driverStatus: string | null;
}

interface CockpitSuggestion {
  clientId: string;
  clientName: string;
  loadId: string;
  score: number;
  verdict: string;
  estimatedNet: number;
  lane: string;
  backhaulScore: number;
}

// V5-001 / PERF-034: the AI advisor is an expensive Claude call. Cap per
// dispatcher to prevent runaway token spend (one curious dispatcher hammering
// the button = ~$40/day) and abuse. In-memory per-user hourly budget, mirroring
// the verify-bucket pattern used for Twilio.
const AI_MAX_PER_HOUR = 20;
const AI_WINDOW_MS = 60 * 60 * 1000;
interface AiBudget {
  count: number;
  windowStart: number;
}
const aiBudgets = new Map<string, AiBudget>();
// Evict every entry whose window has fully elapsed, so the Map doesn't retain
// one stale entry per user indefinitely. Cheap O(n) sweep, n bounded by the
// real (authenticated) user count. Behaviour-preserving: an expired entry is
// treated as a fresh window on the next hit anyway, so deleting it changes
// nothing — it only frees memory. Mirrors the sweepExpired pattern in leads.ts.
function aiSweepExpired(now: number): void {
  const toDelete: string[] = [];
  aiBudgets.forEach((entry, key) => {
    if (now - entry.windowStart > AI_WINDOW_MS) toDelete.push(key);
  });
  toDelete.forEach((k) => aiBudgets.delete(k));
}
function aiRateCheck(userId: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const b = aiBudgets.get(userId);
  if (!b || now - b.windowStart > AI_WINDOW_MS) {
    // Opportunistically drop other users' expired windows before inserting.
    aiSweepExpired(now);
    aiBudgets.set(userId, { count: 1, windowStart: now });
    return { allowed: true, retryAfterSec: 0 };
  }
  if (b.count >= AI_MAX_PER_HOUR) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((AI_WINDOW_MS - (now - b.windowStart)) / 1000),
    };
  }
  b.count++;
  return { allowed: true, retryAfterSec: 0 };
}

export function registerCockpitRoutes(app: Express): void {
  app.get(
    "/api/dispatch/cockpit",
    requireRole("dispatcher"),
    ah((req, res) => {
      const me = getCurrentUser(req);
      if (!me) return res.status(401).json({ message: "Authentication required" });

      const assigned = storage.listAssignedClientsForDispatcher(me.id);
      const clientIds = assigned.map((c) => c.id);

      // Full client records (location, HOS, equipment live in the payload).
      const carriers: CockpitCarrier[] = assigned.flatMap((summary): CockpitCarrier[] => {
        const client = storage.getClient(summary.id) as Client | undefined;
        const loc = client?.currentLocation;
        const alerts: string[] = [];
        if (loc?.status === "empty") alerts.push("Пустой — ищет груз");
        if (typeof client?.hoursAvailable === "number" && client.hoursAvailable <= 2) {
          alerts.push(`HOS на исходе: ${client.hoursAvailable}ч`);
        }
        if (loc?.updatedAt) {
          const ageMin = (Date.now() - new Date(loc.updatedAt).getTime()) / 60000;
          if (ageMin > 60) alerts.push("Локация устарела (>1ч)");
        }
        const carrierFields = {
          id: summary.id,
          name: summary.name,
          mc: client?.mc ?? "",
          equipment: client?.equipment ?? "",
          status: loc?.status ?? null,
          locationCity: loc?.city ?? null,
          locationState: loc?.state ?? null,
          locationUpdatedAt: loc?.updatedAt ?? null,
          hoursAvailable: typeof client?.hoursAvailable === "number" ? client.hoursAvailable : null,
          activeLoadsCount: summary.activeLoadsCount,
          activeDriversCount: summary.activeDriversCount,
          alerts,
        };
        // Killer #6: one card PER DRIVER. Multiple drivers -> multiple cards;
        // a carrier with no driver still shows one (driverless) card.
        const drivers = storage.listDriversForClient(summary.id);
        if (drivers.length === 0) {
          return [{ ...carrierFields, driverId: null, driverName: null, driverStatus: null }];
        }
        return drivers.map((d) => ({
          ...carrierFields,
          driverId: d.id,
          driverName: d.fullName,
          driverStatus: d.driverStatus,
        }));
      });

      // Available loads across all carriers.
      const available = storage.listLoadsForClientIds(clientIds, {
        status: "available",
        limit: 200,
      });

      // Score each available load against each carrier; keep the best pairing
      // per load, and surface the strongest suggestions overall.
      const suggestions: CockpitSuggestion[] = [];
      // Track the best score each load earned across carriers, so topLoads can be
      // ordered by relevance (not just board recency).
      const bestScoreByLoadId = new Map<string, number>();
      // PERF (N+1 fix): one memoized lane-average resolver for this whole request,
      // shared across every (carrier × load) scoring call below, so getLaneAvgPpm
      // hits SQLite at most once per distinct lane pair instead of once per pair.
      // Behaviour-preserving: returns the exact value the default resolver would.
      const laneAvg = createLaneAvgResolver();
      for (const summary of assigned) {
        const client = storage.getClient(summary.id) as Client | undefined;
        if (!client) continue;
        const scored = available.items
          // persist=false: this is a read-only (auto-refreshing) view — don't fire
          // a synchronous lane_history + load_scores write per (carrier, load) pair.
          .map((load: Load) => scoreLoadForClient(client, load, false, laneAvg))
          .filter((l): l is ScoredLoad => Boolean(l))
          .sort((a, b) => b.dispatchScore - a.dispatchScore)
          .slice(0, 3);
        for (const s of scored) {
          suggestions.push({
            clientId: client.id,
            clientName: summary.name,
            loadId: s.id,
            score: s.dispatchScore,
            verdict: s.verdict,
            estimatedNet: s.estimatedNet,
            lane: `${s.originCity}, ${s.originState} → ${s.destinationCity}, ${s.destinationState}`,
            backhaulScore: s.backhaulScore ?? 0,
          });
          const prev = bestScoreByLoadId.get(s.id) ?? -Infinity;
          if (s.dispatchScore > prev) bestScoreByLoadId.set(s.id, s.dispatchScore);
        }
      }
      suggestions.sort((a, b) => b.score - a.score);

      // Top loads = the loads that appear in suggestions, ordered by best score
      // (desc), projected to UI-safe fields only (no internal/raw payload leak).
      const topLoads = available.items
        .filter((l) => bestScoreByLoadId.has(l.id))
        .sort((a, b) => (bestScoreByLoadId.get(b.id) ?? 0) - (bestScoreByLoadId.get(a.id) ?? 0))
        .slice(0, 15)
        .map((l) => ({
          id: l.id,
          originCity: l.originCity,
          originState: l.originState,
          destinationCity: l.destinationCity,
          destinationState: l.destinationState,
          rate: l.rate,
          loadedMiles: l.loadedMiles,
          equipment: l.equipment,
          pickupAt: l.pickupAt,
          deliveryAt: l.deliveryAt,
          brokerName: (l as Load & { brokerName?: string }).brokerName ?? null,
          score: bestScoreByLoadId.get(l.id) ?? 0,
        }));

      return res.json({
        generatedAt: new Date().toISOString(),
        carriers,
        topLoads,
        suggestions: suggestions.slice(0, 20),
      });
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/dispatch/ai-recommend   body: { clientId }
  //
  // F2 AI Dispatcher: on-demand Claude reasoning over the deterministic
  // scorer's top loads for one assigned carrier. Returns a plain-language
  // booking recommendation. Tenant-safe: clientId must be assigned to this
  // dispatcher (cross-tenant => 404, same anti-enumeration policy as the rest
  // of /api/dispatch/*). Graceful: no ANTHROPIC_API_KEY / API error => 503
  // ai_unavailable, so the board keeps working without the AI layer.
  // -------------------------------------------------------------------------
  app.post(
    "/api/dispatch/ai-recommend",
    requireRole("dispatcher"),
    ah(async (req, res) => {
      const me = getCurrentUser(req);
      if (!me) return res.status(401).json({ message: "Authentication required" });

      const clientId = String((req.body as { clientId?: unknown })?.clientId ?? "").trim();
      if (!clientId) return res.status(400).json({ message: "clientId is required" });


      // Tenant gate: only carriers assigned to this dispatcher.
      const assigned = storage.listAssignedClientsForDispatcher(me.id);
      if (!assigned.some((c) => c.id === clientId)) {
        return res.status(404).json({ message: "Client not found" });
      }
      const client = storage.getClient(clientId) as Client | undefined;
      if (!client) return res.status(404).json({ message: "Client not found" });

      const available = storage.listLoadsForClientIds([clientId], {
        status: "available",
        limit: 200,
      });
      // PERF (N+1 fix): one memoized lane-average resolver for this request so the
      // per-load scoring below dedups getLaneAvgPpm across the carrier's loads.
      // persist defaults to true here (single carrier, on-demand) — unchanged.
      const laneAvg = createLaneAvgResolver();
      const top = available.items
        .map((load: Load) => scoreLoadForClient(client, load, true, laneAvg))
        .filter((l): l is ScoredLoad => Boolean(l))
        .sort((a, b) => b.dispatchScore - a.dispatchScore)
        .slice(0, 5);

      if (!top.length) {
        return res.status(404).json({ message: "No scored loads available for this carrier" });
      }

      // V5-001 / PERF-034: cap expensive AI calls per dispatcher. Checked only
      // after the cheap validation gates above, so invalid/cross-tenant/no-load
      // requests (which never reach Claude) don't consume the hourly budget.
      const budget = aiRateCheck(me.id);
      if (!budget.allowed) {
        return res.status(429).json({
          message: "AI-анализ временно ограничен (слишком много запросов). Попробуйте позже.",
          code: "ai_rate_limit",
          retryAfterSec: budget.retryAfterSec,
        });
      }

      // Persistent per-user daily AI quota (50/day) + purchased credits, on top
      // of the in-memory hourly burst guard above. MONEY-FIX: gate on the quota
      // BEFORE the AI call but only DECREMENT it AFTER a usable result. Previously
      // consumeAiQuota ran first and a failed getAiRecommendation (no API key /
      // fetch error / timeout / non-2xx like 529 / unparseable JSON) returned 503
      // without restoring the spent unit — silently burning a free daily slot or,
      // worse, a PURCHASED credit for zero value. Consuming only on success keeps
      // the happy path identical (exactly one unit per successful rec) while never
      // charging the dispatcher for an unavailable advisor.
      const quotaStatus = storage.getAiQuotaStatus(me.id);
      if (quotaStatus.remainingToday <= 0 && quotaStatus.credits <= 0) {
        return res.status(429).json({
          message: "Дневной лимит AI-запросов исчерпан. Докупите запросы или попробуйте завтра.",
          code: "ai_quota_exceeded",
        });
      }

      const rec = await getAiRecommendation(client, top);
      if (!rec) {
        return res.status(503).json({ message: "AI advisor unavailable", code: "ai_unavailable" });
      }

      // Only now that we have a usable recommendation do we spend a unit (free
      // daily slot first, then a purchased credit) — atomically inside storage.
      const quota = storage.consumeAiQuota(me.id);
      if (!quota.ok) {
        // Lost the tiny race against a concurrent request that drained the last
        // unit between the gate above and here. Don't hand back a result we can't
        // bill; surface the same quota-exhausted response.
        return res.status(429).json({
          message: "Дневной лимит AI-запросов исчерпан. Докупите запросы или попробуйте завтра.",
          code: "ai_quota_exceeded",
        });
      }

      storage.audit("dispatch.ai_recommend", "client", clientId, {
        dispatcherId: me.id,
        recommendedLoadId: rec.recommendedLoadId,
        confidence: rec.confidence,
        loadsConsidered: top.length,
      });
      return res.json(rec);
    }),
  );

  // Variant 2 (dispatcher): buy an AI-credit pack billed to ONE of the
  // dispatcher's assigned carriers (they serve several — clientId picks which).
  // Credits land on the invoice.payment_succeeded webhook (see stripe.ts).
  app.post(
    "/api/dispatch/ai-credits/purchase",
    requireRole("dispatcher"),
    ah(async (req, res) => {
      const me = getCurrentUser(req);
      if (!me) return res.status(401).json({ message: "Authentication required" });
      const clientId = String((req.body as { clientId?: unknown })?.clientId ?? "").trim();
      if (!clientId) return res.status(400).json({ message: "clientId is required" });
      // Tenant gate: only carriers assigned to this dispatcher can be billed.
      const assigned = storage.listAssignedClientsForDispatcher(me.id);
      if (!assigned.some((c) => c.id === clientId)) {
        return res.status(404).json({ message: "Client not found" });
      }
      const result = await chargeAiCreditPack(me.id, clientId);
      if (!result.ok) {
        return res.status(402).json({ message: "Оплата не оформлена.", code: result.reason });
      }
      return res.json({ ok: true, pack: AI_CREDIT_PACK.credits, priceCents: AI_CREDIT_PACK.priceCents });
    }),
  );
}
