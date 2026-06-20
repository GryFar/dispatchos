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
import { planLoadChain, type ChainCandidate } from "../lib/load-chain";

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

  // GET /api/dispatch/load-chain?clientId=...
  // Plan the optimal MULTI-LEG chain for one carrier — keep the truck loaded,
  // minimizing empty miles between consecutive loads over the horizon. Empty
  // miles are pure loss, so this is the trip-level efficiency lever.
  app.get(
    "/api/dispatch/load-chain",
    requireRole("dispatcher"),
    ah((req, res) => {
      const me = getCurrentUser(req);
      if (!me) return res.status(401).json({ message: "Authentication required" });

      const clientId = String(req.query.clientId ?? "");
      if (!clientId) return res.status(400).json({ message: "clientId is required" });
      // Tenant scope: the dispatcher must be assigned to this carrier.
      if (!storage.listAssignedClientsForDispatcher(me.id).some((c) => c.id === clientId)) {
        return res.status(404).json({ message: "Carrier not found for this dispatcher" });
      }
      const carrier = storage.getClient(clientId) as Client | undefined;
      if (!carrier) return res.status(404).json({ message: "Carrier not found" });

      const loc = carrier.currentLocation;
      const available = storage.listLoadsForClientIds([clientId], { status: "available", limit: 200 });
      const candidates: ChainCandidate[] = (available.items as Load[]).map((l) => ({
        id: l.id,
        originCity: l.originCity, originState: l.originState,
        destinationCity: l.destinationCity, destinationState: l.destinationState,
        originLat: l.originLat, originLng: l.originLng,
        destinationLat: l.destinationLat, destinationLng: l.destinationLng,
        pickupAt: l.pickupAt, deliveryAt: l.deliveryAt,
        rate: l.rate, loadedMiles: l.loadedMiles,
      }));

      const chain = planLoadChain(
        { lat: loc.lat, lng: loc.lng, availableAt: loc.availableAt || new Date().toISOString() },
        candidates,
      );

      return res.json({ generatedAt: new Date().toISOString(), clientId, clientName: carrier.name, ...chain });
    }),
  );
}
