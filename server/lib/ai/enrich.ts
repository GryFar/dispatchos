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

// ---------------------------------------------------------------------------
// Best-effort enrichment (ingest paths)
// ---------------------------------------------------------------------------
//
// The ingest paths (CSV import, POST /api/loads, self-dispatch) historically
// called enrichLoadSync only, leaving the FMCSA double-brokering defense as
// dead code. enrichLoadBestEffort wires it in WITHOUT making ingest depend on
// a slow/down FMCSA service:
//   • No configured FMCSA_WEB_KEY  → pure no-op, returns the sync result with
//     zero network (owner enables the feature by setting the key).
//   • Key present → attempts the FMCSA broker lookup, but bounded by a hard
//     timeout and a try/catch so a slow or failing lookup NEVER blocks or
//     fails ingest. On timeout/error it falls back to the sync result.
//
// The result has the SAME shape as enrichLoadSync (the load object), so call
// sites can `const enriched = await enrichLoadBestEffort(load)` as a drop-in.

/** Default per-load FMCSA budget. Kept short so a large import can't hang. */
const FMCSA_BEST_EFFORT_TIMEOUT_MS = 4000;

export interface BestEffortOptions {
  /** Override key resolution (tests). When undefined, read from integration config / env. */
  fmcsaWebKey?: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Hard timeout for the FMCSA lookup. */
  timeoutMs?: number;
}

/**
 * Resolve the FMCSA web key from the integration store (falling back to env),
 * without statically importing the storage layer into this pure-lib module.
 * Returns undefined on any resolution error so ingest never breaks.
 */
async function resolveFmcsaWebKey(): Promise<string | undefined> {
  try {
    // Lazy dynamic import keeps enrich.ts importable in pure/offline contexts
    // and avoids a hard dependency cycle with the storage-backed config module
    // (same pattern as lib/email.ts).
    const { getIntegrationValue } = await import("../integration-config");
    return getIntegrationValue("fmcsa", "FMCSA_WEB_KEY") ?? process.env.FMCSA_WEB_KEY;
  } catch {
    return process.env.FMCSA_WEB_KEY;
  }
}

export async function enrichLoadBestEffort<T extends Pick<InsertLoad,
  "originState" | "destinationState" | "equipment" | "pickupAt" |
  "brokerMc" | "brokerName" | "marketQuality" | "brokerScore" | "fraudRisk">>(
  load: T,
  options: BestEffortOptions = {},
): Promise<T & { marketQuality: number }> {
  // Sync result is the guaranteed floor — computed up front, returned on any
  // miss/timeout/error so ingest is never worse off than the legacy path.
  const sync = enrichLoadSync(load);

  const webKey = options.fmcsaWebKey ?? (await resolveFmcsaWebKey());
  // No key configured, or no broker MC to look up → pure no-op (no network).
  if (!webKey || !load.brokerMc) return sync;

  const timeoutMs = options.timeoutMs ?? FMCSA_BEST_EFFORT_TIMEOUT_MS;
  try {
    // Race the FMCSA enrichment against a hard timeout. The timeout resolves
    // to the sync result (never rejects) so a slow lookup degrades to the
    // sync floor instead of hanging or throwing into the ingest path.
    const enriched = await Promise.race([
      enrichLoadAsync(load, {
        fmcsaWebKey: webKey,
        fetchImpl: options.fetchImpl,
      }).then((r) => r.load),
      new Promise<typeof sync>((resolve) => {
        setTimeout(() => resolve(sync), timeoutMs).unref?.();
      }),
    ]);
    return enriched;
  } catch {
    // Defensive: enrichLoadAsync already swallows network errors, but never
    // let an unexpected throw escape into ingest.
    return sync;
  }
}
