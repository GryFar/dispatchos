// ===========================================================================
// server/lib/fleet-assignment.ts — network-wide optimal load↔carrier matching
// ===========================================================================
//
// The per-carrier scorer answers "what's the best load for THIS carrier?". A
// marketplace/fleet at scale needs the harder question: "across N carriers and
// M available loads, what assignment maximizes TOTAL network value?" — each load
// to at most one carrier, each carrier to at most one next load. That total is
// the GMV the platform earns a percentage of, so maximizing it is the core
// economic engine, not a nicety.
//
// This is a max-weight bipartite assignment. We use a greedy pass (sort all
// (carrier, load) pairs by score desc, take a pair iff both are still free),
// which is fast (O(P log P)) and near-optimal in practice; a true-optimal
// Hungarian/LP solver is a drop-in upgrade behind the same signature when the
// extra few % of value justifies the cost.
//
// Pure + dependency-injected (scorer passed in) so it has no route/storage
// coupling and is trivially testable.

import type { Client, Load, ScoredLoad } from "@shared/schema";

export interface FleetAssignment {
  clientId: string;
  clientName: string;
  loadId: string;
  lane: string;
  dispatchScore: number;
  verdict: ScoredLoad["verdict"];
  estimatedNet: number;
}

export interface FleetAssignmentResult {
  /** One best non-conflicting load per carrier (carriers with no viable load omitted). */
  assignments: FleetAssignment[];
  /** Carriers that got no load (none viable / all taken). */
  unassignedClientIds: string[];
  /** Loads left on the board after assignment. */
  unassignedLoadIds: string[];
  /** Sum of assigned dispatchScores — the network-value objective being maximized. */
  totalScore: number;
  /** Sum of assigned estimatedNet — the booked-margin proxy the platform fees on. */
  totalEstimatedNet: number;
}

type Scorer = (client: Client, load: Load) => ScoredLoad | null;

/**
 * Assign available loads across a fleet/marketplace to maximize total network
 * value. Only loads the scorer rates as bookable (verdict !== 'skip') are
 * eligible. Deterministic: ties break by loadId then clientId so the result is
 * stable across runs.
 */
export function assignLoadsToFleet(
  carriers: Client[],
  loads: Load[],
  scorer: Scorer,
): FleetAssignmentResult {
  // Score every (carrier, load) pair once; keep only viable (non-skip) pairs.
  interface Pair {
    clientId: string;
    clientName: string;
    loadId: string;
    lane: string;
    score: number;
    verdict: ScoredLoad["verdict"];
    net: number;
  }
  const pairs: Pair[] = [];
  for (const c of carriers) {
    for (const l of loads) {
      let s: ScoredLoad | null;
      try {
        s = scorer(c, l);
      } catch {
        s = null;
      }
      if (!s || s.verdict === "skip") continue;
      pairs.push({
        clientId: c.id,
        clientName: c.name,
        loadId: l.id,
        lane: `${s.originCity}, ${s.originState} → ${s.destinationCity}, ${s.destinationState}`,
        score: s.dispatchScore,
        verdict: s.verdict,
        net: s.estimatedNet,
      });
    }
  }

  // Greedy max-weight matching: highest-value pairs first, take iff both free.
  pairs.sort(
    (a, b) =>
      b.score - a.score ||
      a.loadId.localeCompare(b.loadId) ||
      a.clientId.localeCompare(b.clientId),
  );

  const takenClients = new Set<string>();
  const takenLoads = new Set<string>();
  const assignments: FleetAssignment[] = [];
  for (const p of pairs) {
    if (takenClients.has(p.clientId) || takenLoads.has(p.loadId)) continue;
    takenClients.add(p.clientId);
    takenLoads.add(p.loadId);
    assignments.push({
      clientId: p.clientId,
      clientName: p.clientName,
      loadId: p.loadId,
      lane: p.lane,
      dispatchScore: p.score,
      verdict: p.verdict,
      estimatedNet: p.net,
    });
  }

  return {
    assignments,
    unassignedClientIds: carriers.map((c) => c.id).filter((id) => !takenClients.has(id)),
    unassignedLoadIds: loads.map((l) => l.id).filter((id) => !takenLoads.has(id)),
    totalScore: assignments.reduce((sum, a) => sum + a.dispatchScore, 0),
    totalEstimatedNet: assignments.reduce((sum, a) => sum + a.estimatedNet, 0),
  };
}
