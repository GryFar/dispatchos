// ===========================================================================
// server/lib/ai/fuel-gasbuddy.ts — GasBuddy diesel price scraper (best-effort)
// ===========================================================================
//
// fetchGasBuddyDieselNear(lat, lng, radiusKm) → FuelObs[] shaped EXACTLY as the
// input to storage.recordFuelPriceObservation, so the caller can do:
//   const obs = await fetchGasBuddyDieselNear(lat, lng);
//   for (const o of obs) storage.recordFuelPriceObservation(o);
//
// ⚠️ REALITY CHECK (read before relying on this): GasBuddy is heavily protected
// (Cloudflare, JS-rendered prices, aggressive bot bans). A plain fetch + cheerio
// will OFTEN get a 403 / Cloudflare challenge page instead of price HTML. This
// module is written defensively — Chrome UA, throttle, cache, and a clean null/
// empty fallback on any block — but it is BEST-EFFORT, not a guarantee. For
// production reliability you likely need a headless browser (playwright) or a
// paid fuel API. The owner is layering an EIA fallback on top; this is the
// opportunistic crowdsource-grade source, not the source of truth.

import { fetchWithTimeout } from "../fetch-timeout";
import * as cheerio from "cheerio";

// Output type = exact input to storage.recordFuelPriceObservation.
export interface FuelObs {
  stationPlaceId?: string | null;
  stationName?: string | null;
  stationBrand?: string | null;
  stationLat: number;
  stationLng: number;
  address?: string | null;
  state?: string | null;
  fuelType: "diesel";
  priceCents: number;
  source: "gasbuddy";
  sourceConfidence: number;
  observedAt: string;
  reporterUserId?: null;
  rawPayload?: unknown;
}

// ---- throttle: at most one outbound request per 10s, process-wide -----------
let lastRequestAt = 0;
const MIN_REQUEST_GAP_MS = 10_000;

async function throttle(): Promise<void> {
  // Reserve the next slot atomically (synchronously, before any await) so
  // overlapping callers each get a distinct, spaced slot instead of all
  // reading the same lastRequestAt and firing together.
  const slot = Math.max(Date.now(), lastRequestAt + MIN_REQUEST_GAP_MS);
  lastRequestAt = slot;
  const wait = slot - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

// ---- in-memory cache: 30 min per rounded (lat,lng,radius) key ---------------
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; data: FuelObs[] }>();

function cacheKey(lat: number, lng: number, radiusKm: number): string {
  // Round to ~1km grid so nearby calls share a cache entry.
  return `${lat.toFixed(2)}:${lng.toFixed(2)}:${radiusKm}`;
}

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function dollarsToCents(text: string): number | null {
  // "$4.199" / "4.19" / "4.199" → integer cents (round to nearest cent).
  const m = text.replace(/[^0-9.]/g, "");
  if (!m) return null;
  const dollars = Number.parseFloat(m);
  if (!Number.isFinite(dollars) || dollars <= 0 || dollars > 20) return null;
  return Math.round(dollars * 100);
}

/**
 * Fetch diesel prices near a coordinate from GasBuddy.
 *
 * Returns [] (never throws) on any block / parse failure, so callers can treat
 * an empty result as "no data this cycle" and fall through to other sources.
 */
export async function fetchGasBuddyDieselNear(
  lat: number,
  lng: number,
  radiusKm = 8,
): Promise<FuelObs[]> {
  // Defensive: the function is exported/reusable, so don't rely on caller
  // coordinate discipline. Invalid coords would otherwise reach toFixed()
  // (→ "NaN" cache keys) and the query URL (→ search=NaN,NaN).
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return [];
  }

  const key = cacheKey(lat, lng, radiusKm);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.data;
  }

  let html: string;
  try {
    await throttle();
    // GasBuddy's lat/lng station finder. Endpoint/markup can change without
    // notice — failures degrade to [] rather than crashing the cron.
    const url = `https://www.gasbuddy.com/home?search=${lat},${lng}&fuel=4`; // fuel=4 ≈ diesel
    const res = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": CHROME_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    if (res.status === 403 || res.status === 429) {
      console.warn(`[gasbuddy] blocked (${res.status}) near ${lat},${lng} — returning []`);
      cache.set(key, { at: Date.now(), data: [] });
      return [];
    }
    if (!res.ok) {
      console.warn(`[gasbuddy] HTTP ${res.status} near ${lat},${lng} — returning []`);
      // Negative-cache so a failing host (5xx/outage) is backed off like the
      // 403/429 path, instead of re-fetching every cron point.
      cache.set(key, { at: Date.now(), data: [] });
      return [];
    }
    html = await res.text();
  } catch (err) {
    console.warn(`[gasbuddy] fetch failed near ${lat},${lng}:`, (err as Error).message);
    // Negative-cache network/timeout failures too (same rationale as above).
    cache.set(key, { at: Date.now(), data: [] });
    return [];
  }

  // Cloudflare interstitials don't contain station markup — detect & bail.
  if (/just a moment|cf-browser-verification|attention required/i.test(html)) {
    console.warn(`[gasbuddy] Cloudflare challenge near ${lat},${lng} — returning []`);
    cache.set(key, { at: Date.now(), data: [] });
    return [];
  }

  const observations = parseGasBuddyHtml(html, lat, lng);
  cache.set(key, { at: Date.now(), data: observations });
  return observations;
}

/**
 * Parse station cards out of GasBuddy HTML. Selectors are best-effort against
 * the current markup and are the most fragile part of this module — isolated
 * here so they're easy to re-tune when the site changes. Returns [] if nothing
 * recognizable is found (e.g. JS-rendered prices not present in initial HTML).
 */
function parseGasBuddyHtml(html: string, fallbackLat: number, fallbackLng: number): FuelObs[] {
  const $ = cheerio.load(html);
  const out: FuelObs[] = [];
  const observedAt = new Date().toISOString();

  // GasBuddy station cards have historically used class names containing
  // "StationDisplay" / "Station". We scan for elements that contain both a
  // price-looking token and a station name. This is intentionally loose.
  $('[class*="StationDisplay"], [class*="Station__"], [class*="station"]').each((_: number, el: any) => {
    const node = $(el);
    const priceText = node
      .find('[class*="Price"], [class*="price"]')
      .first()
      .text()
      .trim();
    const cents = dollarsToCents(priceText);
    if (cents === null) return;

    const name =
      node.find('[class*="StationDisplay__Header"], [class*="name"], h3, h4').first().text().trim() ||
      null;
    const address =
      node.find('[class*="address"], [class*="Address"]').first().text().trim() || null;

    out.push({
      stationName: name,
      stationBrand: name ? normalizeBrand(name) : null,
      // Without per-station geocoding in the initial HTML we attribute the
      // query coordinate; the caller can geocode via place lookup downstream.
      stationLat: fallbackLat,
      stationLng: fallbackLng,
      address,
      state: null,
      fuelType: "diesel",
      priceCents: cents,
      source: "gasbuddy",
      // Lower confidence: scraped, coordinate is approximate.
      sourceConfidence: 0.5,
      observedAt,
      reporterUserId: null,
      rawPayload: { priceText, name, address },
    });
  });

  return out;
}

function normalizeBrand(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("pilot") || n.includes("flying j")) return "Pilot";
  if (n.includes("love")) return "Loves";
  if (n.includes("ta ") || n.includes("travelcenters")) return "TA";
  if (n.includes("petro")) return "Petro";
  if (n.includes("shell")) return "Shell";
  if (n.includes("chevron")) return "Chevron";
  if (n.includes("exxon") || n.includes("mobil")) return "ExxonMobil";
  if (n.includes("bp")) return "BP";
  if (n.includes("speedway")) return "Speedway";
  if (n.includes("7-eleven") || n.includes("7 eleven")) return "7-Eleven";
  return name.split(/\s+/)[0] ?? name;
}
