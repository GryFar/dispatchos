// ===========================================================================
// server/lib/ifta.ts — IFTA quarterly report aggregator
// ===========================================================================
//
// IFTA (International Fuel Tax Agreement) — обязательная квартальная отчётность
// для всех carrier'ов с truck > 26k lbs или multi-state operations. Carrier
// должен отчитаться о пройденных милях и купленном топливе ПО КАЖДОМУ ШТАТУ,
// чтобы IFTA jurisdiction (обычно штат регистрации) распределил налоги.
//
// Что мы агрегируем:
//   1) miles_by_state  — из driver_location_pings (haversine между парами
//      пингов в одном штате; скачки > 200km игнорируем как noise)
//   2) gallons_by_state — из fuel_transactions (используем station_lat/lng,
//      fallback на ping rough match если станция без координат)
//
// State lookup — offline, через bounding boxes (US 48 contiguous). Это
// approx (~95% точности) — для production нужен point-in-polygon, но для
// MVP bbox достаточно: квартальный отчёт всё равно подписывает carrier,
// который может скорректировать пограничные случаи.
//
// Quarters (IFTA standard):
//   Q1 Jan-Mar, Q2 Apr-Jun, Q3 Jul-Sep, Q4 Oct-Dec
//
// API:
//   buildIftaQuarterly(clientId, year, quarter) → IftaQuarterReport
// ---------------------------------------------------------------------------

import { storage } from "../storage";

/** US state bounding boxes (approximate, contiguous 48 + AK + HI). */
const US_STATE_BBOX: Record<string, [number, number, number, number]> = {
  // [minLat, maxLat, minLng, maxLng]
  AL: [30.14, 35.01, -88.47, -84.89],
  AK: [51.21, 71.40, -179.15, 179.78],
  AZ: [31.33, 37.00, -114.82, -109.05],
  AR: [33.00, 36.50, -94.62, -89.64],
  CA: [32.53, 42.01, -124.41, -114.13],
  CO: [36.99, 41.00, -109.06, -102.04],
  CT: [40.98, 42.05, -73.73, -71.79],
  DE: [38.45, 39.84, -75.79, -75.05],
  FL: [24.52, 31.00, -87.63, -80.03],
  GA: [30.36, 35.00, -85.61, -80.84],
  HI: [18.91, 28.40, -178.34, -154.81],
  ID: [41.99, 49.00, -117.24, -111.04],
  IL: [36.97, 42.51, -91.51, -87.50],
  IN: [37.77, 41.76, -88.10, -84.78],
  IA: [40.38, 43.50, -96.64, -90.14],
  KS: [36.99, 40.00, -102.05, -94.59],
  KY: [36.50, 39.15, -89.57, -81.96],
  LA: [28.93, 33.02, -94.04, -88.82],
  ME: [43.06, 47.46, -71.08, -66.95],
  MD: [37.91, 39.72, -79.49, -75.05],
  MA: [41.24, 42.89, -73.51, -69.93],
  MI: [41.70, 48.30, -90.42, -82.12],
  MN: [43.50, 49.38, -97.24, -89.49],
  MS: [30.17, 35.00, -91.66, -88.10],
  MO: [35.99, 40.61, -95.77, -89.10],
  MT: [44.36, 49.00, -116.05, -104.04],
  NE: [40.00, 43.00, -104.05, -95.31],
  NV: [35.00, 42.00, -120.01, -114.04],
  NH: [42.70, 45.31, -72.56, -70.61],
  NJ: [38.93, 41.36, -75.56, -73.89],
  NM: [31.33, 37.00, -109.05, -103.00],
  NY: [40.50, 45.02, -79.76, -71.86],
  NC: [33.84, 36.59, -84.32, -75.46],
  ND: [45.94, 49.00, -104.05, -96.55],
  OH: [38.40, 41.98, -84.82, -80.52],
  OK: [33.62, 37.00, -103.00, -94.43],
  OR: [41.99, 46.29, -124.57, -116.46],
  PA: [39.72, 42.27, -80.52, -74.69],
  RI: [41.15, 42.02, -71.91, -71.12],
  SC: [32.03, 35.21, -83.35, -78.54],
  SD: [42.48, 45.95, -104.06, -96.44],
  TN: [34.98, 36.68, -90.31, -81.65],
  TX: [25.84, 36.50, -106.65, -93.51],
  UT: [37.00, 42.00, -114.05, -109.04],
  VT: [42.73, 45.02, -73.44, -71.46],
  VA: [36.54, 39.47, -83.68, -75.24],
  WA: [45.54, 49.00, -124.85, -116.92],
  WV: [37.20, 40.64, -82.64, -77.72],
  WI: [42.49, 47.30, -92.89, -86.25],
  WY: [40.99, 45.01, -111.06, -104.05],
  DC: [38.79, 38.99, -77.12, -76.91],
};

/**
 * Returns 2-letter state code for (lat, lng), or null if not in any US bbox.
 *
 * Bounding boxes overlap (e.g. DC sits fully inside MD; the Four-Corners and
 * Northeast states share edges/corners), so a naive first-match would attribute
 * a point to whichever box happens to be declared first. To make attribution
 * order-independent we collect EVERY containing box and return the smallest
 * (most-specific) one — the nested/narrower jurisdiction wins (DC over MD).
 */
export function lookupState(lat: number, lng: number): string | null {
  let best: string | null = null;
  let bestArea = Infinity;
  for (const [code, [minLat, maxLat, minLng, maxLng]] of Object.entries(US_STATE_BBOX)) {
    if (lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng) {
      const area = (maxLat - minLat) * (maxLng - minLng);
      if (area < bestArea) {
        bestArea = area;
        best = code;
      }
    }
  }
  return best;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface IftaStateRow {
  state: string;
  miles: number;          // total miles driven in this state
  gallons: number;        // total gallons purchased in this state
  fuelCostUsd: number;    // total fuel spend (USD) in this state
}

export interface IftaQuarterReport {
  clientId: string;
  year: number;
  quarter: 1 | 2 | 3 | 4;
  periodStart: string;    // ISO
  periodEnd: string;      // ISO
  rows: IftaStateRow[];
  totals: {
    miles: number;
    gallons: number;
    fuelCostUsd: number;
    avgMpg: number | null;
  };
  unknownStateMiles: number;   // pings outside any bbox (foreign / offshore noise)
  unknownStateGallons: number; // fuel transactions without state match
  generatedAt: string;
}

function quarterBounds(year: number, q: 1 | 2 | 3 | 4) {
  const startMonth = (q - 1) * 3; // 0,3,6,9
  const start = new Date(Date.UTC(year, startMonth, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, startMonth + 3, 1, 0, 0, 0));
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Build an IFTA quarterly report for one carrier (client). Aggregates miles
 * per state from GPS pings of drivers linked to this client, and gallons /
 * cost from fuel_transactions. State is inferred from coordinates.
 */
export function buildIftaQuarterly(
  clientId: string,
  year: number,
  quarter: 1 | 2 | 3 | 4,
): IftaQuarterReport {
  const { start, end } = quarterBounds(year, quarter);
  const byState: Record<string, IftaStateRow> = {};
  let unknownMiles = 0;
  let unknownGallons = 0;

  // ---- 1) Find all drivers linked to this client ----------------------------
  const allDrivers = storage.listUsers({ role: "driver", includeBlocked: true });
  const drivers = allDrivers.filter((u) => u.linkedClientId === clientId);

  // ---- 2) Miles per state — from location pings ----------------------------
  for (const drv of drivers) {
    // Paginate over the FULL quarter window — listLocationPings caps at 5000,
    // which silently truncates high-frequency pingers (~26k pings/quarter at a
    // 5-min cadence) and under-reports taxable miles in this legal filing.
    const pings = storage.listLocationPingsInWindow(drv.id, start, end);

    for (let i = 1; i < pings.length; i++) {
      const a = pings[i - 1];
      const b = pings[i];
      const stepKm = haversineKm(a.lat, a.lng, b.lat, b.lng);
      if (stepKm > 200) continue; // GPS jump / flight noise — ignore
      const miles = stepKm * 0.621371;
      // Attribute step to state of the *latter* ping (movement INTO a state).
      const state = lookupState(b.lat, b.lng);
      if (!state) {
        unknownMiles += miles;
        continue;
      }
      if (!byState[state]) {
        byState[state] = { state, miles: 0, gallons: 0, fuelCostUsd: 0 };
      }
      byState[state].miles += miles;
    }
  }

  // ---- 3) Gallons + cost per state — from fuel_transactions ----------------
  const fuelTxs = storage
    .listFuelTransactionsForClient(clientId, start)
    .filter((tx) => (tx.occurred_at as string) < end);

  for (const tx of fuelTxs) {
    const lat = tx.station_lat as number | null;
    const lng = tx.station_lng as number | null;
    const gallons = tx.gallons as number;
    const totalCents = tx.total_cents as number;
    const state = lat != null && lng != null ? lookupState(lat, lng) : null;
    if (!state) {
      unknownGallons += gallons;
      continue;
    }
    if (!byState[state]) {
      byState[state] = { state, miles: 0, gallons: 0, fuelCostUsd: 0 };
    }
    byState[state].gallons += gallons;
    byState[state].fuelCostUsd += totalCents / 100;
  }

  // ---- 4) Round + sort -----------------------------------------------------
  const rows = Object.values(byState)
    .map((r) => ({
      state: r.state,
      miles: Math.round(r.miles * 10) / 10,
      gallons: Math.round(r.gallons * 100) / 100,
      fuelCostUsd: Math.round(r.fuelCostUsd * 100) / 100,
    }))
    .sort((a, b) => b.miles - a.miles);

  const totalMiles = rows.reduce((s, r) => s + r.miles, 0);
  const totalGallons = rows.reduce((s, r) => s + r.gallons, 0);
  const totalCost = rows.reduce((s, r) => s + r.fuelCostUsd, 0);

  return {
    clientId,
    year,
    quarter,
    periodStart: start,
    periodEnd: end,
    rows,
    totals: {
      miles: Math.round(totalMiles * 10) / 10,
      gallons: Math.round(totalGallons * 100) / 100,
      fuelCostUsd: Math.round(totalCost * 100) / 100,
      avgMpg: totalGallons > 0 ? Math.round((totalMiles / totalGallons) * 100) / 100 : null,
    },
    unknownStateMiles: Math.round(unknownMiles * 10) / 10,
    unknownStateGallons: Math.round(unknownGallons * 100) / 100,
    generatedAt: new Date().toISOString(),
  };
}

/** Render an IFTA report as CSV for download. */
export function renderIftaCsv(report: IftaQuarterReport): string {
  const lines: string[] = [];
  lines.push(`IFTA Quarterly Report,Client: ${report.clientId},${report.year} Q${report.quarter}`);
  lines.push(`Period,${report.periodStart},${report.periodEnd}`);
  lines.push("");
  lines.push("State,Miles,Gallons,Fuel Cost (USD)");
  for (const r of report.rows) {
    lines.push(`${r.state},${r.miles},${r.gallons},${r.fuelCostUsd.toFixed(2)}`);
  }
  lines.push("");
  lines.push(`TOTAL,${report.totals.miles},${report.totals.gallons},${report.totals.fuelCostUsd.toFixed(2)}`);
  if (report.totals.avgMpg !== null) {
    lines.push(`Avg MPG,${report.totals.avgMpg}`);
  }
  if (report.unknownStateMiles > 0 || report.unknownStateGallons > 0) {
    lines.push("");
    lines.push(`Unattributed (no state match),${report.unknownStateMiles} mi,${report.unknownStateGallons} gal`);
  }
  lines.push(`Generated,${report.generatedAt}`);
  return lines.join("\n");
}
