// enrichLoad — drop-in helper that fills marketQuality, brokerScore, fraudRisk
// before storing or scoring a load.
//
// Two modes:
//   • enrichLoadSync(load) — pure, no network, fills marketQuality from lanes.
//   • enrichLoadAsync(load, opts) — also calls FMCSA Mobile API for broker.
//
// The existing scoreLoadForClient in server/routes.ts trusts these fields
// blindly. Without enrichment they're hand-typed defaults (often 70/0/70).
// With enrichment they reflect actual market data + verified broker risk.

import type { InsertLoad, Load } from "@shared/schema";
import { marketQualityFor } from "./lanes";
import { fetchByMc, evaluateBroker } from "./fmcsa";

// ---------------------------------------------------------------------------
// Sync enrichment (no I/O — safe in any path)
// ---------------------------------------------------------------------------

export function enrichLoadSync<T extends Pick<InsertLoad,
  "originState" | "destinationState" | "equipment" | "pickupAt" |
  "marketQuality" | "brokerScore" | "fraudRisk">>(
  load: T,
): T & { marketQuality: number } {
  // Always recompute marketQuality (cheap, deterministic)
  const marketQuality = marketQualityFor({
    originState: load.originState,
    destinationState: load.destinationState,
    equipment: load.equipment,
    pickupAt: load.pickupAt,
  });
  return { ...load, marketQuality };
}

// ---------------------------------------------------------------------------
// Async enrichment (FMCSA + lanes)
// ---------------------------------------------------------------------------

export interface EnrichOptions {
  /** FMCSA webKey for broker verification. If absent, broker fields untouched. */
  fmcsaWebKey?: string;
  /** Override fetch (for testing). */
  fetchImpl?: typeof fetch;
  /** Skip FMCSA call (tests / offline). */
  skipFmcsa?: boolean;
}

export interface EnrichResult<T> {
  load: T;
  /** Whether broker fields were updated (fmcsa hit). */
  brokerEnriched: boolean;
  /** marketQuality always recomputed; this is just the value for traceability. */
  marketQuality: number;
}

export async function enrichLoadAsync<T extends Pick<InsertLoad,
  "originState" | "destinationState" | "equipment" | "pickupAt" |
  "brokerMc" | "brokerName" | "marketQuality" | "brokerScore" | "fraudRisk">>(
  load: T,
  options: EnrichOptions = {},
): Promise<EnrichResult<T & { marketQuality: number }>> {
  const enriched = enrichLoadSync(load);
  const result: EnrichResult<typeof enriched> = {
    load: enriched,
    brokerEnriched: false,
    marketQuality: enriched.marketQuality,
  };

  if (options.skipFmcsa || !options.fmcsaWebKey || !load.brokerMc) {
    return result;
  }

  try {
    const carrier = await fetchByMc(load.brokerMc, {
      webKey: options.fmcsaWebKey,
      fetchImpl: options.fetchImpl,
      timeoutMs: 4000,
    });
    if (!carrier) return result;
    const verdict = evaluateBroker(carrier);

    // Only overwrite if the AI verdict gives a non-default-ish value.
    // brokerScore: AI score 0-100 directly.
    // fraudRisk: invert (100 - score), so red brokers have high fraudRisk.
    result.load = {
      ...enriched,
      brokerScore: verdict.score,
      fraudRisk: Math.max(0, 100 - verdict.score),
    };
    result.brokerEnriched = true;
  } catch {
    // Network errors are non-fatal — caller still gets sync-enriched load.
  }

  return result;
}
