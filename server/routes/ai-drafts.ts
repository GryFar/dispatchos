// AI broker-reply drafts.
//
//   POST /api/ai/draft-broker-reply   (dispatcher-only)   body: { loadId }
//     -> { draft: string }   a short, professional counter-offer email (EN)
//
// Given a load, we assemble the negotiation context — the broker's offered rate,
// the miles, and our observed average $/mi on that lane (storage.getLaneAvgPpm) —
// and ask claude-haiku to write the reply (server/lib/ai/broker-reply.ts).
//
// Charged against the per-user daily AI quota, scoped to the load's carrier (same
// mechanism as ai-recommend): gate BEFORE the call, consume only AFTER a usable
// draft, so a failed/keyless call never burns a unit. Tenant-safe: the load must
// belong to a carrier the dispatcher is assigned to (else 404, anti-enumeration).
// Graceful: no key / model failure -> 503 ai_unavailable, never a 500.
//
// MOUNT: registerAiDraftRoutes(app) belongs in routes.ts AFTER the shared
// `app.use("/api", ...)` subscription gate (so an expired dispatcher is blocked
// the same as elsewhere) — coordinate the exact line with the routes.ts owner.

import type { Express, Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import type { Load } from "@shared/schema";
import { getCurrentUser, requireRole } from "../auth";
import { storage } from "../storage";
import { generateBrokerReplyDraft } from "../lib/ai/broker-reply";

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

const QUOTA_EXHAUSTED = {
  message: "Дневной лимит AI-запросов исчерпан. Докупите запросы или попробуйте завтра.",
  code: "ai_quota_exceeded",
};

export function registerAiDraftRoutes(app: Express): void {
  app.post(
    "/api/ai/draft-broker-reply",
    requireRole("dispatcher"),
    ah(async (req, res) => {
      const me = getCurrentUser(req);
      if (!me) return res.status(401).json({ message: "Authentication required" });

      const loadId = String((req.body as { loadId?: unknown })?.loadId ?? "").trim();
      if (!loadId) return res.status(400).json({ message: "loadId is required" });

      const load = storage.getLoad(loadId) as
        | (Load & { clientId?: string; brokerName?: string })
        | undefined;
      if (!load) return res.status(404).json({ message: "Load not found" });

      // Tenant gate: only loads on a carrier assigned to this dispatcher (same
      // 404 anti-enumeration policy as the rest of /api/dispatch/*).
      const clientId = load.clientId;
      const assigned = storage.listAssignedClientsForDispatcher(me.id);
      if (!clientId || !assigned.some((c) => c.id === clientId)) {
        return res.status(404).json({ message: "Load not found" });
      }

      // Emergency kill-switch FIRST, so a killed platform surfaces this route's
      // specific 503 ai_unavailable (its established contract) rather than the
      // generic quota 429 below. getAiQuotaStatus now ALSO consults the platform
      // levers centrally (kill + global cap), so either gate prevents the paid
      // call — but the explicit check here keeps the kill response distinct.
      if (process.env.DISPATCHOS_AI_KILL === "1" || process.env.DISPATCHOS_AI_KILL === "true") {
        return res.status(503).json({ message: "AI draft unavailable", code: "ai_unavailable" });
      }

      // Quota gate BEFORE the (paid) call, scoped to the load's carrier. This
      // also enforces the platform global-cap centrally (getAiQuotaStatus reports
      // no capacity when the daily ceiling is reached), so a capped platform 429s
      // here without calling the model.
      const quota = storage.getAiQuotaStatus(me.id, undefined, clientId);
      if (quota.remainingToday <= 0 && quota.credits <= 0) {
        return res.status(429).json(QUOTA_EXHAUSTED);
      }

      const lane = storage.getLaneAvgPpm(load.originState, load.destinationState);
      const draft = await generateBrokerReplyDraft({
        originCity: load.originCity,
        originState: load.originState,
        destinationCity: load.destinationCity,
        destinationState: load.destinationState,
        offeredRate: load.rate,
        loadedMiles: load.loadedMiles,
        brokerName: load.brokerName,
        laneAvgPpm: lane?.avgPpm ?? null,
        laneLoadsSeen: lane?.loadsSeen,
      });
      if (!draft) {
        return res.status(503).json({ message: "AI draft unavailable", code: "ai_unavailable" });
      }

      // Consume only now that we have a usable draft (free daily first, then a
      // purchased credit) — scoped to the carrier being negotiated for. A lost
      // race for the last unit surfaces the same quota-exhausted response.
      const spent = storage.consumeAiQuota(me.id, undefined, clientId);
      if (!spent.ok) return res.status(429).json(QUOTA_EXHAUSTED);

      storage.audit("ai.broker_reply_drafted", "load", loadId, { clientId });
      return res.json({ draft });
    }),
  );
}
