// ===========================================================================
// server/lib/lane-avg-resolver.ts — per-request lane-average lookup dedup
// ===========================================================================
//
// Resolver for the per-lane observed-rate lookup used by scoreLoadForClient.
// Pure read keyed only on the (originState, destState) pair; lane_history is
// stable within a single request. Defaults (at the scorer) to the raw storage
// method so single-load callers behave exactly as before; bulk callers
// (cockpit/board, weekly report, fleet assignment) inject a per-request
// memoized resolver so each distinct lane pair hits SQLite at most once per
// request instead of O(carriers × loads).
//
// Lives in its own tiny module (rather than routes.ts) so the hot-path scorers
// in routes/cockpit.ts and routes/fleet.ts can import it without riding the
// existing routes ↔ route-module import cycle.

import { storage } from "../storage";

export type LaneAvgResolver = (
  originState: string,
  destState: string,
) => ReturnType<typeof storage.getLaneAvgPpm>;

// Per-REQUEST memoization. getLaneAvgPpm is pure for a given (origin, dest) and
// uppercases both states internally, so we key on the uppercased pair to match
// its lookup semantics and maximize cache hits. Returns the EXACT value
// getLaneAvgPpm would (including `undefined`), so scoring is byte-for-byte
// identical — this is purely a query-dedup, not a behavior change. Create one
// fresh per request (never share across requests) so it can't go stale.
export function createLaneAvgResolver(): LaneAvgResolver {
  const cache = new Map<string, ReturnType<typeof storage.getLaneAvgPpm>>();
  return (originState, destState) => {
    const key = `${originState.toUpperCase()}|${destState.toUpperCase()}`;
    if (cache.has(key)) return cache.get(key);
    const value = storage.getLaneAvgPpm(originState, destState);
    cache.set(key, value);
    return value;
  };
}
