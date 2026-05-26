// ===========================================================================
// server/routes/broker-trust.ts — Killer #1 Broker Trust Score API
// ===========================================================================
//
// Behavioural broker signals reported by dispatchers (or auto-collected) and
// the aggregated 0..100 trust score. Distinct from the FMCSA/legal layer
// (broker_safety_audit_snapshots). Score math lives in server/lib/ai/broker-trust.ts.
//
//   POST /api/broker-trust/signal   — report a signal (dispatcher|admin)
//   GET  /api/broker-trust/top      — leaderboard (dispatcher|admin)
//   GET  /api/broker-trust/:mc      — aggregated score for one MC (dispatcher|admin)
//
// NOTE: /top is registered BEFORE /:mc so "top" isn't captured as an :mc param.
// ---------------------------------------------------------------------------

import type { Express, Request, Response, NextFunction } from "express";
import { ZodError, z } from "zod";
import { getCurrentUser } from "../auth";
import { storage } from "../storage";
import {
  computeTrustScore,
  computeBreakdown,
  trustTier,
  TRUST_SIGNAL_TYPES,
  type TrustSignalLike,
} from "../lib/ai/broker-trust";

function ah(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => handler(req, res, next))
      .catch((error: unknown) => {
        if (error instanceof ZodError) {
          return res
            .status(400)
            .json({ message: "Validation failed", issues: error.issues });
        }
        return next(error);
      });
  };
}

// Allow dispatcher OR admin. (requireRole in this codebase gates a single
// role; we check inside the handler to permit both cleanly.)
function requireDispatcherOrAdmin(req: Request, res: Response): { id: string; role: string } | null {
  const user = getCurrentUser(req);
  if (!user) {
    res.status(401).json({ message: "Authentication required" });
    return null;
  }
  if (user.role !== "dispatcher" && user.role !== "admin") {
    res.status(403).json({ message: "Role not allowed. Required: dispatcher or admin." });
    return null;
  }
  return { id: user.id, role: user.role };
}

const reportSignalSchema = z.object({
  brokerMc: z.string().min(1),
  loadId: z.string().nullable().optional(),
  signalType: z.enum(TRUST_SIGNAL_TYPES as [string, ...string[]]),
  positive: z.boolean(),
  valueJson: z.unknown().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

// Normalize a stored signal row (snake_case) into the camelCase the UI wants.
function shapeSignal(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    brokerMc: row.broker_mc as string,
    loadId: (row.load_id as string) ?? null,
    clientId: (row.client_id as string) ?? null,
    signalType: row.signal_type as string,
    positive: Boolean(row.positive),
    valueJson: row.value_json ? safeParse(row.value_json as string) : null,
    notes: (row.notes as string) ?? null,
    reportedByUserId: (row.reported_by_user_id as string) ?? null,
    reportedAt: row.reported_at as string,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function registerBrokerTrustRoutes(app: Express): void {
  // -------------------------------------------------------------------------
  // POST /api/broker-trust/signal — report a behavioural signal.
  // -------------------------------------------------------------------------
  app.post(
    "/api/broker-trust/signal",
    ah((req, res) => {
      const actor = requireDispatcherOrAdmin(req, res);
      if (!actor) return;

      const body = reportSignalSchema.parse(req.body);

      // If a loadId is given, try to inherit clientId from the load.
      let clientId: string | null = null;
      if (body.loadId) {
        const load = storage.getLoad?.(body.loadId) as
          | { clientId?: string | null }
          | undefined;
        clientId = load?.clientId ?? null;
      }

      const id = storage.recordBrokerTrustSignal({
        brokerMc: body.brokerMc,
        loadId: body.loadId ?? null,
        clientId,
        signalType: body.signalType,
        positive: body.positive,
        valueJson: body.valueJson,
        notes: body.notes ?? null,
        reportedByUserId: actor.id,
      });

      storage.audit?.("broker_trust.signal_reported", "broker", body.brokerMc, {
        signalType: body.signalType,
        positive: body.positive,
        loadId: body.loadId ?? null,
      });

      return res.status(201).json({ id });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/broker-trust/top?direction=positive|negative&limit=20
  // Registered BEFORE /:mc so "top" isn't swallowed as an MC.
  // -------------------------------------------------------------------------
  app.get(
    "/api/broker-trust/top",
    ah((req, res) => {
      const actor = requireDispatcherOrAdmin(req, res);
      if (!actor) return;

      const direction = req.query.direction === "negative" ? "negative" : "positive";
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

      const summaries = storage.listBrokerTrustMcSummaries();
      // Score each MC from its full signal history.
      const scored = summaries.map((s) => {
        const signals = storage
          .listBrokerTrustSignalsByMc(s.broker_mc)
          .map((r) => ({ signalType: r.signal_type as string })) as TrustSignalLike[];
        const score = computeTrustScore(signals);
        return {
          mc: s.broker_mc,
          score,
          tier: trustTier(score),
          totalSignals: s.total,
        };
      });
      scored.sort((a, b) => (direction === "positive" ? b.score - a.score : a.score - b.score));

      return res.json({ direction, items: scored.slice(0, limit) });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/broker-trust/:mc — aggregated score + breakdown + recent signals.
  // -------------------------------------------------------------------------
  app.get(
    "/api/broker-trust/:mc",
    ah((req, res) => {
      const actor = requireDispatcherOrAdmin(req, res);
      if (!actor) return;

      const mc = String(req.params.mc ?? "");
      const rows = storage.listBrokerTrustSignalsByMc(mc);
      const signals: TrustSignalLike[] = rows.map((r) => ({
        signalType: r.signal_type as string,
      }));

      const score = computeTrustScore(signals);
      const breakdown = computeBreakdown(signals);
      const positiveCount = rows.filter((r) => Boolean(r.positive)).length;

      return res.json({
        mc,
        totalSignals: rows.length,
        positiveCount,
        negativeCount: rows.length - positiveCount,
        score,
        tier: trustTier(score),
        breakdown,
        recentSignals: rows.slice(0, 10).map(shapeSignal),
      });
    }),
  );
}
