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
}

interface CockpitSuggestion {
  clientId: string;
  clientName: string;
  loadId: string;
  score: number;
  verdict: string;
  estimatedNet: number;
  lane: string;
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
      const carriers: CockpitCarrier[] = assigned.map((summary) => {
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
        return {
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
      });

      // Available loads across all carriers.
      const available = storage.listLoadsForClientIds(clientIds, {
        status: "available",
        limit: 200,
      });

      // Score each available load against each carrier; keep the best pairing
      // per load, and surface the strongest suggestions overall.
      const suggestions: CockpitSuggestion[] = [];
      const topLoadIds = new Set<string>();
      for (const summary of assigned) {
        const client = storage.getClient(summary.id) as Client | undefined;
        if (!client) continue;
        const scored = available.items
          .map((load: Load) => scoreLoadForClient(client, load))
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
          });
          topLoadIds.add(s.id);
        }
      }
      suggestions.sort((a, b) => b.score - a.score);

      // Top loads = the available loads that appear in suggestions, by best score.
      const topLoads = available.items
        .filter((l) => topLoadIds.has(l.id))
        .slice(0, 15);

      return res.json({
        generatedAt: new Date().toISOString(),
        carriers,
        topLoads,
        suggestions: suggestions.slice(0, 20),
      });
    }),
  );
}
