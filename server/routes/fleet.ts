// ===========================================================================
// server/routes/fleet.ts — network-wide optimal fleet assignment endpoint
// ===========================================================================
//
// GET /api/dispatch/fleet-assignment
//
// Where the cockpit shows the top suggestions per carrier independently, this
// answers the marketplace question: across ALL of a dispatcher's carriers and
// every available load, what single assignment maximizes TOTAL network value
// (each load to <=1 carrier, each carrier to <=1 next load)? That total is the
// booked GMV the platform earns on — so optimizing it IS the revenue engine.
// Read-only (persist=false scoring); dispatcher-scoped.

import type { Express, Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import type { Client, Load } from "@shared/schema";
import { getCurrentUser, requireRole } from "../auth";
import { storage } from "../storage";
import { scoreLoadForClient } from "../routes";
import { assignLoadsToFleet } from "../lib/fleet-assignment";

function ah(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown) {
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

export function registerFleetRoutes(app: Express): void {
  app.get(
    "/api/dispatch/fleet-assignment",
    requireRole("dispatcher"),
    ah((req, res) => {
      const me = getCurrentUser(req);
      if (!me) return res.status(401).json({ message: "Authentication required" });

      const assigned = storage.listAssignedClientsForDispatcher(me.id);
      const carriers: Client[] = assigned
        .map((s) => storage.getClient(s.id))
        .filter((c): c is Client => Boolean(c));
      const clientIds = carriers.map((c) => c.id);

      const available = storage.listLoadsForClientIds(clientIds, { status: "available", limit: 200 });

      const result = assignLoadsToFleet(
        carriers,
        available.items as Load[],
        (c, l) => scoreLoadForClient(c, l, false),
      );

      return res.json({
        generatedAt: new Date().toISOString(),
        carriers: carriers.length,
        availableLoads: available.items.length,
        ...result,
      });
    }),
  );
}
