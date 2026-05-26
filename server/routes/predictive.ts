// ===========================================================================
// server/routes/predictive.ts — Killer #4 Predictive Load Hunting (backend)
// ===========================================================================
//
// Dispatcher watchlist + lane predictions. A dispatcher watches a lane
// (origin→dest state, optional city/equipment/min-ppm). When a matching load
// lands, the matcher (storage.matchLoadAgainstWatches, called from the load
// create path) bumps match_count + emits a watchlist.matched audit event.
//
// Predictions surface what the dow_distribution on lane_history has
// accumulated so far — honest about low data early on (it grows over time,
// like the broker-trust moat).
//
// Dispatcher-only; a watch can only target a client assigned to the caller.
// Registered before the catch-all /api gate, same as registerDispatchRoutes.

import type { Express, Request, Response, NextFunction } from "express";
import { z, ZodError } from "zod";
import { getCurrentUser, requireRole } from "../auth";
import { storage } from "../storage";

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

const createWatchSchema = z.object({
  clientId: z.string().min(1),
  originState: z.string().length(2),
  originCity: z.string().optional().nullable(),
  destinationState: z.string().length(2),
  destinationCity: z.string().optional().nullable(),
  minPpm: z.number().positive().optional().nullable(),
  equipment: z.string().optional().nullable(),
});

export function registerPredictiveRoutes(app: Express): void {
  // Helper: is this client assigned to the caller?
  function callerOwnsClient(req: Request, clientId: string): boolean {
    const me = getCurrentUser(req);
    if (!me) return false;
    return storage
      .listAssignedClientsForDispatcher(me.id)
      .some((c) => c.id === clientId);
  }

  // -------------------------------------------------------------------------
  // POST /api/dispatch/watchlist — create a watch
  // -------------------------------------------------------------------------
  app.post(
    "/api/dispatch/watchlist",
    requireRole("dispatcher"),
    ah((req, res) => {
      const me = getCurrentUser(req);
      if (!me) return res.status(401).json({ message: "Authentication required" });
      const input = createWatchSchema.parse(req.body);
      if (!callerOwnsClient(req, input.clientId)) {
        return res.status(403).json({ message: "Client not assigned to you" });
      }
      const { id } = storage.createLaneWatch({
        clientId: input.clientId,
        originState: input.originState,
        originCity: input.originCity ?? null,
        destinationState: input.destinationState,
        destinationCity: input.destinationCity ?? null,
        minPpm: input.minPpm ?? null,
        equipment: input.equipment ?? null,
        createdBy: me.id,
      });
      storage.audit("watchlist.created", "lane_watchlist", id, {
        clientId: input.clientId,
        lane: `${input.originState.toUpperCase()}->${input.destinationState.toUpperCase()}`,
        createdBy: me.id,
      });
      return res.status(201).json({ id });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/dispatch/watchlist?clientId=X — list watches for a client
  // -------------------------------------------------------------------------
  app.get(
    "/api/dispatch/watchlist",
    requireRole("dispatcher"),
    ah((req, res) => {
      const clientId = String(req.query.clientId || "");
      if (!clientId) return res.status(400).json({ message: "clientId required" });
      if (!callerOwnsClient(req, clientId)) {
        return res.status(403).json({ message: "Client not assigned to you" });
      }
      const items = storage.listLaneWatchesByClient(clientId).map((w: any) => ({
        id: w.id,
        clientId: w.client_id,
        originState: w.origin_state,
        originCity: w.origin_city,
        destinationState: w.destination_state,
        destinationCity: w.destination_city,
        minPpm: w.min_ppm,
        equipment: w.equipment,
        active: w.active === 1,
        matchCount: w.match_count,
        lastMatchedAt: w.last_matched_at,
        createdAt: w.created_at,
      }));
      return res.json({ items });
    }),
  );

  // -------------------------------------------------------------------------
  // DELETE /api/dispatch/watchlist/:id — remove a watch (must own its client)
  // -------------------------------------------------------------------------
  app.delete(
    "/api/dispatch/watchlist/:id",
    requireRole("dispatcher"),
    ah((req, res) => {
      const id = String(req.params.id);
      // Find the watch's client by listing the caller's clients' watches is
      // overkill; instead delete scoped by ownership: look it up, verify, delete.
      const me = getCurrentUser(req);
      if (!me) return res.status(401).json({ message: "Authentication required" });
      const myClientIds = storage.listAssignedClientsForDispatcher(me.id).map((c) => c.id);
      // Find which of my clients owns this watch.
      let ownerClientId: string | null = null;
      for (const cid of myClientIds) {
        if (storage.listLaneWatchesByClient(cid).some((w: any) => w.id === id)) {
          ownerClientId = cid;
          break;
        }
      }
      if (!ownerClientId) {
        return res.status(404).json({ message: "Watch not found" });
      }
      const { deleted } = storage.deleteLaneWatch(id, ownerClientId);
      storage.audit("watchlist.deleted", "lane_watchlist", id, { clientId: ownerClientId });
      return res.json({ deleted });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/dispatch/predictions?clientId=X — dow predictions for a client's
  // historical lanes. Built from lane_history.dow_distribution; honest about
  // low sample sizes early on.
  // -------------------------------------------------------------------------
  app.get(
    "/api/dispatch/predictions",
    requireRole("dispatcher"),
    ah((req, res) => {
      const clientId = String(req.query.clientId || "");
      if (!clientId) return res.status(400).json({ message: "clientId required" });
      if (!callerOwnsClient(req, clientId)) {
        return res.status(403).json({ message: "Client not assigned to you" });
      }
      // Predictions are lane-level (state→state), drawn from each active watch
      // for this client: show what dow_distribution we've accumulated.
      const watches = storage.listLaneWatchesByClient(clientId) as Array<{
        origin_state: string;
        destination_state: string;
      }>;
      const seen = new Set<string>();
      const predictions = [];
      for (const w of watches) {
        const key = `${w.origin_state}->${w.destination_state}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const pred = storage.getLanePrediction(w.origin_state, w.destination_state);
        predictions.push({
          originState: w.origin_state,
          destinationState: w.destination_state,
          loadsSeen: pred?.loadsSeen ?? 0,
          avgPpm: pred ? Math.round(pred.avgPpm * 100) / 100 : 0,
          dowDistribution: pred?.dowDistribution ?? {},
        });
      }
      return res.json({ generatedAt: new Date().toISOString(), predictions });
    }),
  );
}
