// Real-time diesel fuel price lookup by US state.
//
// Source of truth: U.S. Energy Information Administration (EIA) — Weekly Retail
// On-Highway Diesel Prices, PADD-level breakdown. Their data updates every
// Monday around 5pm ET.
//
// Architecture:
//   • Baseline table (PADD averages, May 2026) is hardcoded as a fallback.
//   • At runtime, optional EIA API integration refreshes the cache (24h TTL).
//   • Per-state values fall back to PADD average if the state-level row is
//     missing.
//
// Why this matters: fuel is ~30% of an owner-operator's variable cost. A
// $0.30/gal swing on a 700-mile trip is ~$23 — enough to flip a load's verdict
// from "book" to "negotiate". We must use fresh, accurate state-level prices,
// not a single national average.

// ---------------------------------------------------------------------------
// PADD assignments (US Petroleum Administration for Defense Districts)
// ---------------------------------------------------------------------------

import { fetchWithTimeout } from "../fetch-timeout";

export type Padd = "PADD1A" | "PADD1B" | "PADD1C" | "PADD2" | "PADD3" | "PADD4" | "PADD5";

// State to PADD mapping. EIA groups states into 5 PADDs (with PADD1 split into
// 3 sub-regions). This is the canonical mapping used by EIA.
const STATE_PADD: Readonly<Record<string, Padd>> = Object.freeze({
  // PADD1A — New England
  CT: "PADD1A", ME: "PADD1A", MA: "PADD1A", NH: "PADD1A", RI: "PADD1A", VT: "PADD1A",
  // PADD1B — Central Atlantic
  DE: "PADD1B", DC: "PADD1B", MD: "PADD1B", NJ: "PADD1B", NY: "PADD1B", PA: "PADD1B",
  // PADD1C — Lower Atlantic
  FL: "PADD1C", GA: "PADD1C", NC: "PADD1C", SC: "PADD1C", VA: "PADD1C", WV: "PADD1C",
  // PADD2 — Midwest
  IL: "PADD2", IN: "PADD2", IA: "PADD2", KS: "PADD2", KY: "PADD2", MI: "PADD2",
  MN: "PADD2", MO: "PADD2", NE: "PADD2", ND: "PADD2", OH: "PADD2", OK: "PADD2",
  SD: "PADD2", TN: "PADD2", WI: "PADD2",
  // PADD3 — Gulf Coast
  AL: "PADD3", AR: "PADD3", LA: "PADD3", MS: "PADD3", NM: "PADD3", TX: "PADD3",
  // PADD4 — Rocky Mountain
  CO: "PADD4", ID: "PADD4", MT: "PADD4", UT: "PADD4", WY: "PADD4",
  // PADD5 — West Coast
  AK: "PADD5", AZ: "PADD5", CA: "PADD5", HI: "PADD5", NV: "PADD5", OR: "PADD5", WA: "PADD5",
});

// ---------------------------------------------------------------------------
// Baseline fallback prices ($/gallon, May 2026 — refresh manually quarterly)
// Source: EIA Weekly Retail On-Highway Diesel, week ending May 12 2026.
// ---------------------------------------------------------------------------

const PADD_BASELINE_USD: Readonly<Record<Padd, number>> = Object.freeze({
  PADD1A: 3.95,
  PADD1B: 3.82,
  PADD1C: 3.66,
  PADD2: 3.68,
  PADD3: 3.55,
  PADD4: 3.91,
  PADD5: 4.62,
});

// State-level overrides where the state systematically differs from its PADD.
// e.g. California pays $0.50+ over PADD5 average due to CARB-required low-sulfur
// blend + state taxes.
const STATE_BASELINE_USD: Readonly<Record<string, number>> = Object.freeze({
  CA: 5.18,
  HI: 5.42,
  NY: 4.05,
  PA: 4.18, // higher than PADD1B due to fuel taxes
  IL: 3.92, // Chicago premium
  WA: 4.95,
  OR: 4.85,
});

const NATIONAL_FALLBACK_USD = 3.85;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface FuelCacheEntry {
  prices: Record<string, number>; // state -> price
  fetchedAt: number; // epoch ms
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let cache: FuelCacheEntry | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FuelLookupOptions {
  /** Override "now" for testing. */
  now?: number;
  /** Skip cache and force a fresh lookup. */
  forceRefresh?: boolean;
  /** Allow network calls. Default false — pure baseline. */
  allowNetwork?: boolean;
}

export interface FuelPriceResult {
  state: string;
  price: number;
  padd: Padd;
  source: "state_override" | "padd_baseline" | "national_fallback" | "cache" | "eia_api";
  asOf: string; // ISO timestamp
}

/**
 * Get current diesel price for a US state.
 *
 * Returns price in $/gallon along with the source used (for auditability).
 * Never throws — falls back to national average if everything else fails.
 */
export function getDieselPrice(stateCode: string, options: FuelLookupOptions = {}): FuelPriceResult {
  const state = stateCode.toUpperCase();
  const now = options.now ?? Date.now();

  // Cache hit (skip on forceRefresh)
  if (!options.forceRefresh && cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    const cached = cache.prices[state];
    if (cached !== undefined) {
      return {
        state,
        price: cached,
        padd: STATE_PADD[state] ?? "PADD3",
        source: "cache",
        asOf: new Date(cache.fetchedAt).toISOString(),
      };
    }
  }

  // State-level override (highest precision)
  const override = STATE_BASELINE_USD[state];
  if (override !== undefined) {
    return {
      state,
      price: override,
      padd: STATE_PADD[state] ?? "PADD3",
      source: "state_override",
      asOf: baselineAsOf(),
    };
  }

  // PADD baseline
  const padd = STATE_PADD[state];
  if (padd !== undefined) {
    return {
      state,
      price: PADD_BASELINE_USD[padd],
      padd,
      source: "padd_baseline",
      asOf: baselineAsOf(),
    };
  }

  // National fallback for unknown / territory codes
  return {
    state,
    price: NATIONAL_FALLBACK_USD,
    padd: "PADD3",
    source: "national_fallback",
    asOf: baselineAsOf(),
  };
}

/**
 * Batch lookup for many states at once. Useful for computing a route price
 * (avg origin/destination).
 */
export function getDieselPrices(stateCodes: string[], options: FuelLookupOptions = {}): Record<string, FuelPriceResult> {
  const out: Record<string, FuelPriceResult> = {};
  for (const code of stateCodes) {
    out[code.toUpperCase()] = getDieselPrice(code, options);
  }
  return out;
}

/**
 * Compute the effective fuel price for a route given origin + destination
 * states. Uses simple average — accurate enough for OTR planning, where the
 * driver fuels at the cheaper of either end + truckstop chains along the way.
 */
export function getRouteFuelPrice(
  originState: string,
  destState: string,
  options: FuelLookupOptions = {},
): { price: number; breakdown: FuelPriceResult[] } {
  const origin = getDieselPrice(originState, options);
  const dest = getDieselPrice(destState, options);
  return {
    price: Math.round(((origin.price + dest.price) / 2) * 100) / 100,
    breakdown: [origin, dest],
  };
}

/**
 * Refresh the in-memory cache from EIA's public weekly retail diesel API.
 *
 * The EIA v2 API is free and key-less for public series. Schema docs:
 *   https://www.eia.gov/opendata/v1/qb.php?category=240680
 *
 * We use series `PET.EMD_EPD2D_PTE_NUS_DPG.W` (national) and PADD-level
 * series for each region. State-level diesel retail prices are NOT published
 * by EIA — only PADD-level. So this refresh primarily updates PADD baselines
 * and the small state-override table is reviewed manually quarterly.
 */
export async function refreshFromEia(apiKey?: string, fetchImpl?: typeof fetch): Promise<{
  refreshed: boolean;
  fetchedAt: number;
  changes: Array<{ padd: Padd; before: number; after: number }>;
}> {
  // Default to the timeout-wrapped fetch so a stalled EIA socket can't hang the
  // cron (this loops 7 series sequentially). Tests can still inject fetchImpl.
  const fetcher =
    fetchImpl ?? (typeof fetch !== "undefined" ? (u: string) => fetchWithTimeout(u, {}, 8000) : null);
  if (!fetcher) {
    return { refreshed: false, fetchedAt: Date.now(), changes: [] };
  }
  if (!apiKey) {
    return { refreshed: false, fetchedAt: Date.now(), changes: [] };
  }

  // EIA series IDs for weekly retail diesel by PADD.
  const series: Array<{ padd: Padd; id: string }> = [
    { padd: "PADD1A", id: "PET.EMD_EPD2D_PTE_R1X_DPG.W" },
    { padd: "PADD1B", id: "PET.EMD_EPD2D_PTE_R1Y_DPG.W" },
    { padd: "PADD1C", id: "PET.EMD_EPD2D_PTE_R1Z_DPG.W" },
    { padd: "PADD2", id: "PET.EMD_EPD2D_PTE_R20_DPG.W" },
    { padd: "PADD3", id: "PET.EMD_EPD2D_PTE_R30_DPG.W" },
    { padd: "PADD4", id: "PET.EMD_EPD2D_PTE_R40_DPG.W" },
    { padd: "PADD5", id: "PET.EMD_EPD2D_PTE_R50_DPG.W" },
  ];

  const changes: Array<{ padd: Padd; before: number; after: number }> = [];
  const updated = { ...PADD_BASELINE_USD } as Record<Padd, number>;

  for (const { padd, id } of series) {
    try {
      const url = `https://api.eia.gov/v2/seriesid/${id}?api_key=${encodeURIComponent(apiKey)}&length=1`;
      const r = await fetcher(url);
      if (!r.ok) continue;
      const data = (await r.json()) as { response?: { data?: Array<{ value: number }> } };
      const latest = data.response?.data?.[0]?.value;
      if (typeof latest === "number" && Number.isFinite(latest) && latest > 0) {
        if (Math.abs(updated[padd] - latest) > 0.01) {
          changes.push({ padd, before: updated[padd], after: latest });
          updated[padd] = latest;
        }
      }
    } catch {
      // Network errors are non-fatal — we keep the baseline.
    }
  }

  // Populate cache.prices for every state we know about.
  const prices: Record<string, number> = {};
  for (const [state, padd] of Object.entries(STATE_PADD)) {
    prices[state] = STATE_BASELINE_USD[state] ?? updated[padd];
  }
  cache = { prices, fetchedAt: Date.now() };

  return { refreshed: true, fetchedAt: cache.fetchedAt, changes };
}

/** Clear cache — for testing. */
export function clearFuelCache(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baselineAsOf(): string {
  // The hardcoded baseline is for week ending May 12, 2026.
  return "2026-05-12T00:00:00Z";
}

// Re-export internals for tests
export const __test_only = { STATE_PADD, PADD_BASELINE_USD, STATE_BASELINE_USD };
