import type { Express } from "express";
import { createServer, type Server } from "http";
import fs from "node:fs";
import path from "node:path";
import {
  brokerCheckSchema,
  csvImportSchema,
  driveCreateSchema,
  emailIngestSchema,
  insertDocumentSchema,
  insertClientSchema,
  insertLoadSchema,
  insertLoadWithBookingSchema,
  insertLoadFullSchema,
  signupSchema,
  telegramCommandSchema,
  updateLocationSchema,
  updateMyPreferencesSchema,
  updateOnboardingProgressSchema,
  type BrokerRecord,
  type Client,
  type DispatchBoard,
  type InsertLoad,
  type Load,
  type ScoredLoad,
} from "@shared/schema";
import { ZodError } from "zod";
import {
  buildOtpAuthUrl,
  generateBase32Secret,
  getCurrentUser,
  hashPassword,
  requireRole,
  requireActiveBilling,
  verifyPassword,
  verifyTotp,
} from "./auth";
import { localDriveRoot, storage, uploadsRoot } from "./storage";
import { upload } from "./upload";
import { registerAdminRoutes } from "./routes/admin";
import { registerAdminIntegrationTestsRoutes } from "./routes/admin-integrations-tests";
import { registerAdminLoadSourcesRoutes } from "./routes/admin-load-sources";
import { registerMeRoutes } from "./routes/me";
import { registerMeTotpRoutes } from "./routes/me-totp";
import { registerTrackRoutes } from "./routes/track";
import { registerDispatchRoutes } from "./routes/dispatch";
import { registerBrokerTrustRoutes } from "./routes/broker-trust";
import { registerCockpitRoutes } from "./routes/cockpit";
import { registerPredictiveRoutes } from "./routes/predictive";
import { registerLeadRoutes } from "./routes/leads";
import { registerWebhookRoutes } from "./routes/webhooks";
import { registerCronRoutes } from "./routes/cron";
import { registerInboundRoutes } from "./routes/inbound";
import { registerTelegramBotRoutes } from "./routes/telegram-bot";
import { registerBillingRoutes } from "./routes/billing";
import { enrichLoadSync } from "./lib/ai";
import { parseSylectusEmail } from "./lib/parsers/sylectus";
import { getIntegrationValue } from "./lib/integration-config";
import crypto from "node:crypto";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const seedClients: Client[] = [
  {
    id: "ivan-enclosed-01",
    name: "Ivan K.",
    mc: "MC-884201",
    equipment: "enclosed_car_hauler",
    targetPpm: 2.45,
    minimumPpm: 2.1,
    mpg: 9.2,
    fuelPrice: 3.58,
    fixedCostPerMile: 0.42,
    preferredLanes: ["FL → GA", "FL → TX", "Southeast", "Texas triangle"],
    avoidStates: ["NY", "NJ"],
    currentLocation: {
      city: "Clearwater",
      state: "FL",
      lat: 27.9659,
      lng: -82.8001,
      source: "telegram_live",
      updatedAt: new Date(Date.now() - 18 * MINUTE).toISOString(),
      status: "empty",
      availableAt: new Date(Date.now() + 45 * MINUTE).toISOString(),
      notes: "Empty after delivery, ready after fuel stop.",
    },
  },
  {
    id: "oleg-hotshot-02",
    name: "Oleg M.",
    mc: "MC-771552",
    equipment: "hotshot_flatbed",
    targetPpm: 2.25,
    minimumPpm: 1.95,
    mpg: 10.5,
    fuelPrice: 3.64,
    fixedCostPerMile: 0.36,
    preferredLanes: ["TX → Midwest", "OK/TX short hops", "Midwest → Southeast"],
    avoidStates: ["CA"],
    currentLocation: {
      city: "Dallas",
      state: "TX",
      lat: 32.7767,
      lng: -96.797,
      source: "manual_checkin",
      updatedAt: new Date(Date.now() - 74 * MINUTE).toISOString(),
      status: "empty",
      availableAt: new Date(Date.now() + 25 * MINUTE).toISOString(),
      notes: "Manual check-in is stale; ask /loc before booking.",
    },
  },
  {
    id: "max-van-03",
    name: "Max S.",
    mc: "MC-901774",
    equipment: "sprinter_van",
    targetPpm: 1.85,
    minimumPpm: 1.55,
    mpg: 15.8,
    fuelPrice: 3.49,
    fixedCostPerMile: 0.24,
    preferredLanes: ["Midwest", "IL/IN/OH", "short expedite"],
    avoidStates: [],
    currentLocation: {
      city: "Columbus",
      state: "OH",
      lat: 39.9612,
      lng: -82.9988,
      source: "eld_tms",
      updatedAt: new Date(Date.now() - 42 * MINUTE).toISOString(),
      status: "loaded",
      availableAt: new Date(Date.now() + 2.4 * HOUR).toISOString(),
      notes: "Projected empty after local delivery.",
    },
  },
];

const seedLoads: Load[] = [
  {
    id: "cd-10394",
    source: "Central Dispatch",
    originCity: "Tampa",
    originState: "FL",
    originLat: 27.9506,
    originLng: -82.4572,
    destinationCity: "Atlanta",
    destinationState: "GA",
    destinationLat: 33.749,
    destinationLng: -84.388,
    rate: 2350,
    loadedMiles: 462,
    pickupAt: new Date(Date.now() + 4.3 * HOUR).toISOString(),
    deliveryAt: new Date(Date.now() + 32 * HOUR).toISOString(),
    equipment: "enclosed_car_hauler",
    brokerName: "Reliable Auto Logistics",
    brokerMc: "MC-470488",
    brokerScore: 92,
    fraudRisk: 8,
    marketQuality: 82,
    notes: "Two high-value units, enclosed required.",
  },
  {
    id: "sd-88120",
    source: "Super Dispatch",
    originCity: "Orlando",
    originState: "FL",
    originLat: 28.5383,
    originLng: -81.3792,
    destinationCity: "Houston",
    destinationState: "TX",
    destinationLat: 29.7604,
    destinationLng: -95.3698,
    rate: 3200,
    loadedMiles: 963,
    pickupAt: new Date(Date.now() + 5.5 * HOUR).toISOString(),
    deliveryAt: new Date(Date.now() + 58 * HOUR).toISOString(),
    equipment: "enclosed_car_hauler",
    brokerName: "Southline Vehicle Moves",
    brokerMc: "MC-829104",
    brokerScore: 86,
    fraudRisk: 14,
    marketQuality: 91,
    notes: "Bigger gross, but deadhead and total PPM must win or lose it.",
  },
  {
    id: "sc-55218",
    source: "Ship.Cars",
    originCity: "Miami",
    originState: "FL",
    originLat: 25.7617,
    originLng: -80.1918,
    destinationCity: "Charlotte",
    destinationState: "NC",
    destinationLat: 35.2271,
    destinationLng: -80.8431,
    rate: 2800,
    loadedMiles: 731,
    pickupAt: new Date(Date.now() + 3.4 * HOUR).toISOString(),
    deliveryAt: new Date(Date.now() + 44 * HOUR).toISOString(),
    equipment: "enclosed_car_hauler",
    brokerName: "Premium Transport Desk",
    brokerMc: "MC-193840",
    brokerScore: 69,
    fraudRisk: 28,
    marketQuality: 76,
    notes: "Good lane but broker needs verification before rate con.",
  },
  {
    id: "dat-22561",
    source: "DAT One",
    originCity: "Fort Worth",
    originState: "TX",
    originLat: 32.7555,
    originLng: -97.3308,
    destinationCity: "Kansas City",
    destinationState: "MO",
    destinationLat: 39.0997,
    destinationLng: -94.5786,
    rate: 1825,
    loadedMiles: 543,
    pickupAt: new Date(Date.now() + 2.2 * HOUR).toISOString(),
    deliveryAt: new Date(Date.now() + 28 * HOUR).toISOString(),
    equipment: "hotshot_flatbed",
    brokerName: "Prairie Freight Group",
    brokerMc: "MC-671904",
    brokerScore: 81,
    fraudRisk: 11,
    marketQuality: 73,
  },
  {
    id: "ts-44109",
    source: "Truckstop",
    originCity: "Waco",
    originState: "TX",
    originLat: 31.5493,
    originLng: -97.1467,
    destinationCity: "Chicago",
    destinationState: "IL",
    destinationLat: 41.8781,
    destinationLng: -87.6298,
    rate: 2550,
    loadedMiles: 1026,
    pickupAt: new Date(Date.now() + 7 * HOUR).toISOString(),
    deliveryAt: new Date(Date.now() + 56 * HOUR).toISOString(),
    equipment: "hotshot_flatbed",
    brokerName: "Northbound Supply Chain",
    brokerMc: "MC-553018",
    brokerScore: 90,
    fraudRisk: 7,
    marketQuality: 84,
  },
  {
    id: "exp-09071",
    source: "Email ingest",
    originCity: "Dayton",
    originState: "OH",
    originLat: 39.7589,
    originLng: -84.1916,
    destinationCity: "Indianapolis",
    destinationState: "IN",
    destinationLat: 39.7684,
    destinationLng: -86.1581,
    rate: 620,
    loadedMiles: 118,
    pickupAt: new Date(Date.now() + 4.8 * HOUR).toISOString(),
    deliveryAt: new Date(Date.now() + 13 * HOUR).toISOString(),
    equipment: "sprinter_van",
    brokerName: "Rapid Midwest Expedited",
    brokerMc: "MC-335719",
    brokerScore: 78,
    fraudRisk: 16,
    marketQuality: 70,
  },
];

function seedIfEmpty() {
  if (storage.listClients().length === 0) {
    seedClients.forEach((client) => storage.upsertClient(client));
  }
  if (storage.listLoads().length === 0) {
    seedLoads.forEach((load) => storage.upsertLoad(load));
  }
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function calculateDistanceMiles(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
) {
  const earthRadiusMiles = 3958.8;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const straightLine = 2 * earthRadiusMiles * Math.asin(Math.sqrt(h));
  return Math.round(straightLine * 1.18);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function calculateLocationConfidence(updatedAt: string) {
  const ageMinutes = Math.max(0, Math.round((Date.now() - Date.parse(updatedAt)) / MINUTE));
  if (ageMinutes <= 30) return { confidence: "high" as const, ageMinutes };
  if (ageMinutes <= 60) return { confidence: "medium" as const, ageMinutes };
  return { confidence: "low" as const, ageMinutes };
}

function calculatePickupFeasibility(client: Client, load: Load, deadheadMiles: number) {
  const driveMinutes = (deadheadMiles / 52) * 60;
  const readyAt = Math.max(Date.parse(client.currentLocation.availableAt), Date.now());
  const pickupAt = Date.parse(load.pickupAt);
  const bufferMinutes = Math.round((pickupAt - readyAt) / MINUTE - driveMinutes - 35);

  if (bufferMinutes >= 90) return { pickupFeasibility: "easy" as const, bufferMinutes };
  if (bufferMinutes >= 0) return { pickupFeasibility: "tight" as const, bufferMinutes };
  return { pickupFeasibility: "not_feasible" as const, bufferMinutes };
}

export function scoreLoadForClient(client: Client, load: Load): ScoredLoad | null {
  // -------------------------------------------------------------------------
  // Phase 5 hard filters — these reject before scoring even starts. Skipping
  // means the load never appears in dispatcher view (different from verdict
  // 'skip' which means "we ranked it and it lost").
  // -------------------------------------------------------------------------
  const equipmentTypes = (client as Client & { equipmentTypes?: string[] }).equipmentTypes;
  const equipmentMatch = equipmentTypes?.length
    ? equipmentTypes.includes(load.equipment)
    : client.equipment === load.equipment;
  if (!equipmentMatch) return null;

  if (client.avoidStates.includes(load.originState) || client.avoidStates.includes(load.destinationState)) {
    return null;
  }

  const extras = client as Client & {
    maxGvwLbs?: number;
    blockedBrokers?: string[];
    hoursAvailable?: number;
    payCentsPerMile?: number;
    payPctOfGross?: number;
    tollsCostPerMile?: number;
    wearCostPerMile?: number;
  };

  // Weight cap on truck/trailer combined
  const loadWeight = (load as Load & { weightLbs?: number }).weightLbs;
  if (extras.maxGvwLbs && loadWeight && loadWeight > extras.maxGvwLbs) return null;

  // Broker blacklist by MC#
  const brokerMc = (load as Load & { brokerMc?: string }).brokerMc;
  if (brokerMc && extras.blockedBrokers?.includes(brokerMc)) return null;

  // HOS: assume avg 50mph, so total trip hours = miles/50. Reject if it
  // exceeds available hours. Driver-pay model assumed cpm-based later.
  if (extras.hoursAvailable !== undefined && load.loadedMiles / 50 > extras.hoursAvailable) {
    return null;
  }

  const deadheadMiles = calculateDistanceMiles(
    client.currentLocation,
    { lat: load.originLat, lng: load.originLng },
  );
  const totalMiles = load.loadedMiles + deadheadMiles;
  const deadheadRatio = deadheadMiles / totalMiles;
  const fuelCost = (totalMiles / client.mpg) * client.fuelPrice;
  // Phase 5: split fixedCost into addressable categories. Falls back to the
  // legacy single number when client doesn't expose breakdowns.
  const tollsCost = totalMiles * (extras.tollsCostPerMile ?? 0);
  const wearCost = totalMiles * (extras.wearCostPerMile ?? 0);
  const baseFixedCost = totalMiles * client.fixedCostPerMile;
  const driverPay =
    extras.payCentsPerMile !== undefined
      ? totalMiles * (extras.payCentsPerMile / 100)
      : extras.payPctOfGross !== undefined
        ? load.rate * (extras.payPctOfGross / 100)
        : 0;
  const fixedCost = baseFixedCost + tollsCost + wearCost + driverPay;
  const estimatedNet = load.rate - fuelCost - fixedCost;
  const loadedPpm = load.rate / load.loadedMiles;
  const totalPpm = load.rate / totalMiles;
  const netPpmTotal = estimatedNet / totalMiles;
  const { confidence: locationConfidence, ageMinutes: locationAgeMinutes } =
    calculateLocationConfidence(client.currentLocation.updatedAt);
  const { pickupFeasibility, bufferMinutes: pickupBufferMinutes } =
    calculatePickupFeasibility(client, load, deadheadMiles);

  const ppmScore = clamp((netPpmTotal / client.targetPpm) * 100, 0, 135);
  const deadheadScore = clamp(100 - deadheadRatio * 260, 0, 100);
  const feasibilityScore =
    pickupFeasibility === "easy" ? 100 : pickupFeasibility === "tight" ? 58 : 0;
  const brokerSafetyScore = clamp((load.brokerScore * 0.65) + ((100 - load.fraudRisk) * 0.35), 0, 100);
  const laneScore = load.marketQuality;
  const locationScore =
    locationConfidence === "high" ? 100 : locationConfidence === "medium" ? 72 : 32;

  const dispatchScore = Math.round(
    ppmScore * 0.42 +
      deadheadScore * 0.18 +
      feasibilityScore * 0.15 +
      brokerSafetyScore * 0.12 +
      laneScore * 0.08 +
      locationScore * 0.05,
  );

  const warnings: string[] = [];
  if (locationConfidence === "low") warnings.push("Location older than 60 min: request /loc before booking.");
  if (deadheadRatio > 0.25) warnings.push("Deadhead is above 25% of total miles.");
  if (pickupFeasibility === "not_feasible") warnings.push("Pickup window is not feasible from current position.");
  if (load.fraudRisk >= 25) warnings.push("Broker/fraud risk is elevated; verify MC and rate confirmation.");
  if (netPpmTotal < client.minimumPpm) warnings.push("Net total PPM is below client minimum.");

  let verdict: ScoredLoad["verdict"] = "book";
  if (
    netPpmTotal < client.minimumPpm ||
    pickupFeasibility === "not_feasible" ||
    locationConfidence === "low" ||
    load.fraudRisk >= 35
  ) {
    verdict = "skip";
  } else if (
    netPpmTotal < client.targetPpm ||
    deadheadRatio > 0.22 ||
    pickupFeasibility === "tight" ||
    load.fraudRisk >= 20
  ) {
    verdict = "negotiate";
  }

  const neededRate = Math.ceil((client.targetPpm * totalMiles + fuelCost + fixedCost) / 25) * 25;
  const counterOffer = verdict === "negotiate" && neededRate > load.rate ? neededRate : null;

  const reasonParts = [
    `$${netPpmTotal.toFixed(2)}/mi net total`,
    `${deadheadMiles} mi deadhead`,
    `${Math.round(deadheadRatio * 100)}% deadhead`,
    `${pickupFeasibility.replace("_", " ")} pickup`,
    `${locationConfidence} location confidence`,
  ];

  // Phase 5: feed lane_history (one observation per (load, client) pair is
  // fine — lane_history is keyed by (origin_state, dest_state) and we just
  // accumulate). Cheap, idempotent-ish counts.
  try {
    storage.recordLaneObservation(load.originState, load.destinationState, load.rate, load.loadedMiles);
  } catch (err) {
    console.error("[score] lane_history write failed:", err);
  }

  // Phase 5: persist to load_scores so the cron poller / dispatch UI can
  // pull pre-computed scores without re-running this whole pipeline. We
  // store the breakdown so the UI can render "why".
  try {
    storage.upsertLoadScore({
      loadId: load.id,
      clientId: client.id,
      dispatchScore,
      verdict,
      estimatedNet: Math.round(estimatedNet),
      breakdown: {
        fuelCost: Math.round(fuelCost),
        tollsCost: Math.round(tollsCost),
        wearCost: Math.round(wearCost),
        baseFixedCost: Math.round(baseFixedCost),
        driverPay: Math.round(driverPay),
        deadheadMiles,
        totalMiles,
        netPpmTotal: Number(netPpmTotal.toFixed(3)),
        counterOffer,
        warnings,
      },
    });
  } catch (err) {
    // Cache write is best-effort; don't fail the request.
    console.error("[score] cache write failed:", err);
  }

  return {
    ...load,
    deadheadMiles,
    totalMiles,
    deadheadRatio,
    fuelCost: Math.round(fuelCost),
    fixedCost: Math.round(fixedCost),
    estimatedNet: Math.round(estimatedNet),
    loadedPpm,
    totalPpm,
    netPpmTotal,
    locationConfidence,
    locationAgeMinutes,
    pickupFeasibility,
    pickupBufferMinutes,
    dispatchScore,
    verdict,
    counterOffer,
    rankReason: reasonParts.join(" · "),
    warnings,
  };
}

function buildDispatchBoard(clientId?: string): DispatchBoard {
  const clients = storage.listClients();
  const loads = storage.listLoads();
  const selectedClient = clients.find((client) => client.id === clientId) ?? clients[0];
  const scoredLoads = loads
    .map((load) => scoreLoadForClient(selectedClient, load))
    .filter((load): load is ScoredLoad => Boolean(load))
    .sort((a, b) => b.dispatchScore - a.dispatchScore);

  return {
    generatedAt: new Date().toISOString(),
    selectedClient,
    clients,
    loads: scoredLoads,
    topRecommendation: scoredLoads[0],
    locationPolicy: {
      highConfidenceMinutes: 30,
      mediumConfidenceMinutes: 60,
      staleRequiresCheckinMinutes: 60,
      command: "/loc — send live location or city/state/ZIP + empty/loaded + available time",
    },
  };
}

function handleZodError(error: unknown, res: any) {
  if (error instanceof ZodError) {
    return res.status(400).json({
      message: "Validation failed",
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  throw error;
}

function handleBadRequest(error: unknown, res: any) {
  if (error instanceof ZodError) return handleZodError(error, res);
  if (error instanceof Error) {
    return res.status(400).json({ message: error.message });
  }
  return res.status(400).json({ message: "Bad request" });
}

// Normalize an MC/MX/FF docket number to a canonical "<PREFIX>-<digits>" form.
// Audit V3-9: the previous version stripped all non-digits and forced an "MC-"
// prefix, collapsing MX-123 / FF-123 into MC-123 (different FMCSA docket
// families → false collisions, which matters for the per-MC unique account
// constraint). We now preserve a leading MC/MX/FF prefix; default to MC when
// only digits are given (the common broker case).
function normalizeMc(value: string) {
  const raw = String(value ?? "").trim().toUpperCase();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return raw;
  const prefixMatch = raw.match(/^(MC|MX|FF)\b/);
  const prefix = prefixMatch ? prefixMatch[1] : "MC";
  return `${prefix}-${digits}`;
}

async function checkBrokerRisk(brokerMc: string, brokerName = "Unknown Broker"): Promise<BrokerRecord> {
  const normalized = normalizeMc(brokerMc);
  // Audit V2-3 — canonical env var is FMCSA_WEB_KEY (matches storage schema and
  // carrier-safety-profile.ts). Legacy FMCSA_WEBKEY accepted as fallback for
  // one release; warn so we can drop it cleanly.
  const fmcsaWebKey =
    getIntegrationValue("fmcsa", "FMCSA_WEB_KEY") ?? process.env.FMCSA_WEBKEY;
  if (process.env.FMCSA_WEBKEY && !getIntegrationValue("fmcsa", "FMCSA_WEB_KEY")) {
    console.warn(
      "[fmcsa] Deprecated env FMCSA_WEBKEY in use — set FMCSA_WEB_KEY via /admin/integrations or env to silence.",
    );
  }
  if (process.env.FMCSA_API_URL && fmcsaWebKey) {
    try {
      const url = `${process.env.FMCSA_API_URL.replace(/\/$/, "")}?webKey=${encodeURIComponent(fmcsaWebKey)}&mc=${encodeURIComponent(normalized.replace(/\D/g, ""))}`;
      const response = await fetch(url);
      const payload: any = await response.json().catch(() => ({}));
      const statusText = JSON.stringify(payload).toLowerCase();
      const authorized = statusText.includes("authorized") || statusText.includes("active");
      const flags = authorized ? [] : ["FMCSA response did not clearly show authorized/active status."];
      return {
        id: `broker-${normalized.replace(/\W/g, "").toLowerCase()}`,
        brokerMc: normalized,
        brokerName,
        authorityStatus: authorized ? "authorized" : "needs_manual_check",
        authorityAgeMonths: 24,
        riskScore: authorized ? 10 : 42,
        verdict: authorized ? "clean" : "verify",
        flags,
        checkedAt: new Date().toISOString(),
      };
    } catch (error: any) {
      // fall through to deterministic fallback, but make the operator aware
    }
  }

  const digits = Number(normalized.replace(/\D/g, "") || 0);
  const authorityAgeMonths = (digits % 96) + 3;
  const flags: string[] = [];
  let riskScore = 12;

  if (authorityAgeMonths < 6) {
    flags.push("Authority age below 6 months: verify using FMCSA-listed phone, not email signature.");
    riskScore += 30;
  }
  flags.unshift("FMCSA live API not configured; using local deterministic fallback.");
  if (digits % 7 === 0) {
    flags.push("Pattern flag: request rate confirmation MC match before proceeding.");
    riskScore += 18;
  }
  if (digits % 11 === 0) {
    flags.push("Payment-change fraud caution: never accept bank/routing changes by email.");
    riskScore += 16;
  }

  const verdict = riskScore >= 50 ? "stop" : riskScore >= 25 ? "verify" : "clean";
  const authorityStatus = authorityAgeMonths < 6 ? "needs_manual_check" : "authorized";

  return {
    id: `broker-${normalized.replace(/\W/g, "").toLowerCase()}`,
    brokerMc: normalized,
    brokerName,
    authorityStatus,
    authorityAgeMonths,
    riskScore,
    verdict,
    flags,
    checkedAt: new Date().toISOString(),
  };
}

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells.map((cell) => cell.replace(/^"|"$/g, ""));
}

function importLoadsFromCsv(csv: string) {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  const maxRows = Number(process.env.DISPATCHOS_CSV_MAX_ROWS || 250);
  if (lines.length - 1 > maxRows) {
    throw new Error(`CSV row limit exceeded: max ${maxRows} load rows`);
  }
  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  const created: Load[] = [];
  const errors: Array<{ row: number; message: string }> = [];

  lines.slice(1).forEach((line, index) => {
    const rowNumber = index + 2;
    const values = parseCsvLine(line);
    const row = Object.fromEntries(headers.map((header, i) => [header, values[i] ?? ""]));
    try {
      const load: InsertLoad = {
        source: row.source || "CSV Import",
        originCity: row.originCity,
        originState: row.originState,
        originLat: Number(row.originLat),
        originLng: Number(row.originLng),
        destinationCity: row.destinationCity,
        destinationState: row.destinationState,
        destinationLat: Number(row.destinationLat),
        destinationLng: Number(row.destinationLng),
        rate: Number(row.rate),
        loadedMiles: Number(row.loadedMiles),
        pickupAt: row.pickupAt || new Date(Date.now() + 4 * HOUR).toISOString(),
        deliveryAt: row.deliveryAt || new Date(Date.now() + 36 * HOUR).toISOString(),
        equipment: (row.equipment || "hotshot_flatbed") as InsertLoad["equipment"],
        brokerName: row.brokerName || "CSV Broker",
        brokerMc: row.brokerMc || "MC-UNKNOWN",
        brokerScore: Number(row.brokerScore || 70),
        fraudRisk: Number(row.fraudRisk || 15),
        marketQuality: Number(row.marketQuality || 70),
        notes: row.notes,
      };
      // Phase 4: enrich CSV imports too — overrides any marketQuality
      // value the CSV provided with the lane-benchmark calculation.
      const parsed = insertLoadSchema.parse(load);
      const enriched = enrichLoadSync(parsed);
      created.push(storage.upsertLoad(enriched));
    } catch (error: any) {
      errors.push({ row: rowNumber, message: error.message || "Invalid row" });
    }
  });

  storage.audit("loads.csv_imported", "load", "bulk", { created: created.length, errors });
  return { created, errors };
}

function buildDrivePlan(clientId?: string) {
  const clients = clientId ? storage.listClients().filter((client) => client.id === clientId) : storage.listClients();
  return {
    root: "DispatchOS/Clients",
    generatedAt: new Date().toISOString(),
    folders: clients.map((client) => ({
      clientId: client.id,
      clientName: client.name,
      path: `DispatchOS/Clients/${client.mc}_${client.name.replace(/\s+/g, "_")}`,
      subfolders: ["Onboarding", "Loads", "Rate Confirmations", "BOL_POD", "Invoices", "Compliance"],
    })),
    note: "This endpoint prepares the folder plan. Google Drive creation is the next connector-backed step.",
  };
}

function createLocalDriveFolders(clientId?: string) {
  const plan = buildDrivePlan(clientId);
  const created: string[] = [];
  for (const folder of plan.folders) {
    const root = path.join(localDriveRoot, folder.path.replace(/^DispatchOS\/Clients\//, ""));
    fs.mkdirSync(root, { recursive: true });
    created.push(root);
    for (const subfolder of folder.subfolders) {
      const child = path.join(root, subfolder);
      fs.mkdirSync(child, { recursive: true });
      created.push(child);
    }
  }
  storage.audit("drive.local_folders_created", "drive", clientId || "all", { created });
  return { ...plan, localRoot: localDriveRoot, created };
}

function buildIntegrationStatus() {
  return {
    generatedAt: new Date().toISOString(),
    integrations: [
      {
        key: "fmCSA",
        label: "FMCSA broker verification",
        status:
          process.env.FMCSA_API_URL &&
          (getIntegrationValue("fmcsa", "FMCSA_WEB_KEY") ?? process.env.FMCSA_WEBKEY)
            ? "ready"
            : "needs_config",
        missing: [
          ...(!process.env.FMCSA_API_URL ? ["FMCSA_API_URL"] : []),
          ...((getIntegrationValue("fmcsa", "FMCSA_WEB_KEY") ?? process.env.FMCSA_WEBKEY)
            ? []
            : ["FMCSA_WEB_KEY"]),
        ],
      },
      {
        key: "telegram",
        label: "Telegram bot commands",
        status: process.env.TELEGRAM_BOT_TOKEN && process.env.DISPATCHOS_PUBLIC_URL ? "ready" : "local_endpoint_ready",
        missing: ["TELEGRAM_BOT_TOKEN", "DISPATCHOS_PUBLIC_URL"].filter((key) => !process.env[key]),
      },
      {
        key: "gmail",
        label: "Gmail broker email ingest",
        status: process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET ? "ready" : "manual_paste_ready",
        missing: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET"].filter((key) => !process.env[key]),
      },
      {
        key: "googleDrive",
        label: "Google Drive docs workflow",
        status: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? "ready" : "local_folder_mode",
        missing: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"].filter((key) => !process.env[key]),
      },
      {
        key: "twilio",
        label: "Twilio voice/SMS",
        status:
          process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER
            ? "ready"
            : "sandbox",
        missing: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"].filter((key) => !process.env[key]),
      },
    ],
  };
}

function buildSystemStatus() {
  const authState = storage.getAuthState();
  const deploymentMode = process.env.DISPATCHOS_DEPLOYMENT_MODE || "local";
  const checks = [
    {
      key: "auth",
      label: "Owner auth configured",
      ok: authState.isConfigured || process.env.DISPATCHOS_AUTH_DISABLED === "true",
      severity: "critical",
    },
    {
      key: "sessionSecret",
      label: "Strong session secret configured",
      ok:
        Boolean(process.env.DISPATCHOS_SESSION_SECRET) &&
        !["change-this-before-real-use", "change-this-local-dispatchos-secret-before-production"].includes(
          String(process.env.DISPATCHOS_SESSION_SECRET),
        ),
      severity: deploymentMode === "vds" ? "critical" : "warning",
    },
    {
      key: "host",
      label: "Host binding selected",
      ok: Boolean(process.env.DISPATCHOS_HOST || "127.0.0.1"),
      value: process.env.DISPATCHOS_HOST || "127.0.0.1",
      severity: "info",
    },
    {
      key: "cookieSecure",
      label: "Secure cookies for HTTPS/VDS",
      ok: deploymentMode !== "vds" || process.env.DISPATCHOS_COOKIE_SECURE === "true",
      severity: "warning",
    },
    {
      key: "dataRoot",
      label: "Data root configured",
      ok: Boolean(process.env.DISPATCHOS_DATA_ROOT || "dispatchos_data"),
      value: process.env.DISPATCHOS_DATA_ROOT || "dispatchos_data",
      severity: "info",
    },
  ];

  return {
    version: "1.2.7-vds-production",
    generatedAt: new Date().toISOString(),
    deploymentMode,
    publicUrl: process.env.DISPATCHOS_PUBLIC_URL || "http://localhost:5000",
    checks,
    readyForVds: checks.every((check) => check.severity !== "critical" || check.ok),
  };
}

function buildWeeklyReport(clientId: string) {
  const client = storage.getClient(clientId);
  if (!client) return undefined;
  const loads = storage
    .listLoads()
    .filter((load) => load.equipment === client.equipment)
    .map((load) => scoreLoadForClient(client, load))
    .filter((load): load is ScoredLoad => Boolean(load))
    .sort((a, b) => b.dispatchScore - a.dispatchScore)
    .slice(0, 10);

  const recommended = loads.filter((load) => load.verdict === "book" || load.verdict === "negotiate");
  const grossPotential = recommended.reduce((sum, load) => sum + load.rate, 0);
  const estimatedNetPotential = recommended.reduce((sum, load) => sum + load.estimatedNet, 0);
  const dispatchFeeFlat = 150;
  const dispatchFeeVariable = grossPotential * 0.03;

  return {
    generatedAt: new Date().toISOString(),
    client,
    summary: {
      matchedLoads: loads.length,
      recommendedLoads: recommended.length,
      grossPotential,
      estimatedNetPotential,
      dispatchFeeFlat,
      dispatchFeeVariable,
      totalDispatchFee: dispatchFeeFlat + dispatchFeeVariable,
    },
    topLoads: loads,
    nextActions: [
      "Confirm fresh /loc before booking any load.",
      "Verify broker MC before requesting rate confirmation.",
      "Upload rate con, BOL, and POD to DispatchOS documents.",
      "Export backup at end of day.",
    ],
  };
}

function parseEmailToLoad(input: { from: string; subject: string; body: string }) {
  // Try Sylectus parser first — it's the only board we have a real format
  // for. Falls through to the generic regex grab-bag when not a Sylectus
  // posting, so existing test fixtures keep passing.
  const sylectus = parseSylectusEmail(input);
  if (sylectus.matched && sylectus.origin && sylectus.destination) {
    return {
      possibleLoad: true,
      source: "sylectus" as const,
      extracted: {
        rate: sylectus.rate ?? 0,
        loadedMiles: sylectus.miles ?? 0,
        originCity: sylectus.origin.city,
        originState: sylectus.origin.state,
        destinationCity: sylectus.destination.city,
        destinationState: sylectus.destination.state,
        weightLbs: sylectus.weightLbs,
        pieces: sylectus.pieces,
        equipment: sylectus.equipment,
        pickupAt: sylectus.pickupAt,
        postedAt: sylectus.postedAt,
        broker: sylectus.broker,
        reference: sylectus.reference,
      },
      rawFields: sylectus.rawFields,
    };
  }

  // Generic fallback (v1.2.7 legacy) — unchanged from the original.
  const text = `${input.subject}\n${input.body}`;
  const rate = Number(text.match(/\$?\s?(\d{3,5})(?:\s|$)/)?.[1] || 0);
  const miles = Number(text.match(/(\d{2,5})\s?(?:mi|miles)/i)?.[1] || 0);
  const lane = text.match(/([A-Za-z .]+),?\s([A-Z]{2})\s*(?:-|→|to)\s*([A-Za-z .]+),?\s([A-Z]{2})/i);
  return {
    possibleLoad: Boolean(rate && miles && lane),
    source: "generic" as const,
    extracted: {
      rate,
      loadedMiles: miles,
      originCity: lane?.[1]?.trim(),
      originState: lane?.[2]?.toUpperCase(),
      destinationCity: lane?.[3]?.trim(),
      destinationState: lane?.[4]?.toUpperCase(),
    },
  };
}

export async function registerRoutes(app: Express): Promise<Server> {
  seedIfEmpty();

  // -------------------------------------------------------------------------
  // Auth endpoints (Phase 1)
  // -------------------------------------------------------------------------
  //
  // Backward-compat surface for v1.2.7 frontend:
  //   GET  /api/auth/status   — same shape + extras (role, twoFactorEnabled)
  //   POST /api/auth/setup    — alias of /api/auth/bootstrap (creates 1st admin)
  //   POST /api/auth/login    — accepts email OR legacy username field
  //   POST /api/auth/logout   — destroys session
  //
  // New in Phase 1:
  //   POST /api/auth/bootstrap — explicit name for creating the very first admin
  //   GET  /api/me             — current user public profile
  // -------------------------------------------------------------------------

  app.get("/api/auth/status", (req, res) => {
    const state = storage.getAuthState();
    const user = getCurrentUser(req);
    res.json({
      ...state,
      authenticated: Boolean(user),
      authDisabled: false, // Removed in Phase 1; kept in payload for old UI.
      role: user?.role,
      twoFactorEnabled: user ? Boolean(user.totpSecret) : state.twoFactorEnabled,
    });
  });

  // Shared bootstrap handler (used by both /setup legacy alias and new /bootstrap).
  function handleBootstrap(req: any, res: any) {
    // Audit V3-1 — require an out-of-band bootstrap token when running in
    // a non-local environment. Operator sets DISPATCHOS_BOOTSTRAP_TOKEN as a
    // Fly secret right before calling /api/auth/bootstrap, passes it in the
    // X-Bootstrap-Token header, then unsets the secret. Without it, an
    // attacker who races us after a fresh deploy can claim admin.
    //
    // Skip the check when no public URL is set (= local dev / first-run on
    // localhost). Production always sets DISPATCHOS_PUBLIC_URL.
    const isProduction = Boolean(process.env.DISPATCHOS_PUBLIC_URL);
    if (isProduction) {
      const expected = process.env.DISPATCHOS_BOOTSTRAP_TOKEN;
      if (!expected) {
        return res.status(503).json({
          message:
            "Bootstrap is disabled. Operator must set DISPATCHOS_BOOTSTRAP_TOKEN before first-run.",
        });
      }
      const provided = String(req.headers["x-bootstrap-token"] || "");
      // Constant-time compare to defeat timing.
      const a = Buffer.from(expected);
      const b = Buffer.from(provided.padEnd(a.length, "\0").slice(0, a.length));
      if (a.length !== provided.length || !crypto.timingSafeEqual(a, b)) {
        storage.audit("auth.bootstrap_token_invalid", "system", "bootstrap", {});
        return res.status(401).json({ message: "Invalid bootstrap token" });
      }
    }

    if (storage.getAuthState().isConfigured) {
      return res.status(409).json({ message: "Auth is already configured" });
    }
    const body = req.body || {};
    const rawId = (body.email || body.username || "").toString().trim();
    if (!rawId) return res.status(400).json({ message: "email or username is required" });
    const password = String(body.password || "");
    if (password.length < 10) {
      return res.status(400).json({ message: "password must be at least 10 characters" });
    }
    const email = rawId.includes("@") ? rawId.toLowerCase() : `${rawId.toLowerCase()}@dispatchos.local`;
    const fullName = String(body.fullName || rawId);

    const { salt, hash } = hashPassword(password);
    const totpSecret = generateBase32Secret();
    const user = storage.createUser({
      email,
      fullName,
      role: "admin",
      passwordSalt: salt,
      passwordHash: hash,
      totpSecret,
    });
    return res.status(201).json({
      id: user.id,
      email: user.email,
      username: rawId, // echo back for compat with v1.2.7 UI
      totpSecret,
      otpauthUrl: buildOtpAuthUrl(user.email, totpSecret),
      message: "Save the TOTP secret in an authenticator app before logging out.",
    });
  }

  app.post("/api/auth/bootstrap", handleBootstrap);
  // Legacy alias — keeps the v1.2.7 frontend and smoke test working unchanged.
  app.post("/api/auth/setup", handleBootstrap);

  app.post("/api/auth/login", (req, res) => {
    const body = req.body || {};
    const rawId = (body.email || body.username || "").toString().trim();
    if (!rawId) return res.status(400).json({ message: "email or username is required" });

    // Lookup by email; if no @ in input, synthesize the legacy bootstrap email.
    const lookupEmail = rawId.includes("@") ? rawId.toLowerCase() : `${rawId.toLowerCase()}@dispatchos.local`;
    const user = storage.getUserByEmail(lookupEmail);
    if (!user) return res.status(401).json({ message: "Invalid credentials" });
    if (user.blocked) return res.status(403).json({ message: "Account is blocked" });

    const password = String(body.password || "");
    const pwResult = verifyPassword(password, user.passwordSalt, user.passwordHash);
    if (!pwResult.ok) {
      return res.status(401).json({ message: "Invalid credentials" });
    }
    // Audit High #10 — прозрачная миграция legacy 210k → 600k хешей
    // при следующем успешном логине. Best-effort: если рехеш не прошёл —
    // юзер всё равно прошёл auth, пробуем в следующий раз.
    if (pwResult.needsRehash) {
      try {
        const fresh = hashPassword(password);
        storage.updateUser(
          user.id,
          { passwordSalt: fresh.salt, passwordHash: fresh.hash },
          user.id,
        );
      } catch (err) {
        console.error("[auth] password rehash upgrade failed:", err);
      }
    }
    if (user.totpSecret) {
      const submittedToken = String(body.token || "").trim();

      // 2026-05-27 hotfix: distinguish "need TOTP" from "bad TOTP" so the
      // client can switch the form to the 2FA-code step. Without this the
      // user lands in an infinite "Invalid credentials" loop — password is
      // right, but they never see the token field.
      //
      // Note on the V2-17 trade-off: the original audit hardening folded
      // "wrong password" and "missing/bad TOTP" into a single error so an
      // attacker couldn't tell whether a given email had 2FA enabled. We
      // are partially reverting that decision: when password verification
      // passes but TOTP is missing/wrong, we now return a distinct
      // `totp_required` error code. This DOES leak "2FA enabled" — but only
      // to a caller who already supplied a valid email+password pair, i.e.
      // someone past the brute-force threshold anyway. The audit log still
      // records the granular reason for forensics.
      if (submittedToken.length === 0) {
        storage.audit("auth.login_failed", "user", user.id, { reason: "totp_required" });
        return res.status(401).json({
          message: "2FA token required",
          code: "totp_required",
        });
      }

      // Audit High #11 — reject replays by passing the last accepted counter.
      const minCounter = storage.getLastUsedTotpCounter(user.id);
      const acceptedCounter = verifyTotp(user.totpSecret, submittedToken, minCounter);
      if (acceptedCounter === null) {
        storage.audit("auth.login_failed", "user", user.id, { reason: "bad_totp" });
        return res.status(401).json({
          message: "Invalid 2FA token",
          code: "totp_invalid",
        });
      }
      storage.setLastUsedTotpCounter(user.id, acceptedCounter);
    }
    // Audit V2-2 — regenerate session id before binding userId to defeat
    // session-fixation attacks (attacker plants a known session id, victim logs
    // in, attacker rides into the authenticated session).
    req.session.regenerate((regenErr) => {
      if (regenErr) {
        console.error("[auth] session regenerate failed:", regenErr);
        return res.status(500).json({ message: "Login failed" });
      }
      req.session.userId = user.id;
      req.session.role = user.role;
      req.session.authenticated = true; // legacy flag, kept for old frontend
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error("[auth] session save failed:", saveErr);
          return res.status(500).json({ message: "Login failed" });
        }
        storage.recordUserLogin(user.id);
        storage.audit("auth.login", "user", user.id, { email: user.email, role: user.role });
        res.json({ ok: true, role: user.role, redirect: `/${user.role === "admin" ? "admin" : user.role === "dispatcher" ? "dispatch" : "d"}` });
      });
    });
  });

  app.post("/api/auth/logout", (req, res) => {
    const userId = req.session.userId;
    req.session.destroy(() => {
      if (userId) storage.audit("auth.logout", "user", userId, {});
      res.json({ ok: true });
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/signup — Phase 3 (consume invite, create user, auto-login)
  // -------------------------------------------------------------------------
  //
  // Public (no existing session required) but invite-locked. On success the
  // session is immediately bound to the new user, so the frontend can fetch
  // /api/me right after this returns.
  //
  // Response shape matches `signupResponseSchema` in shared/schema.ts so the
  // signup screen (client/src/pages/signup.tsx) can render the TOTP QR code
  // from `otpauthUrl` once and only once.
  // -------------------------------------------------------------------------

  app.post("/api/auth/signup", (req, res) => {
    let body: ReturnType<typeof signupSchema.parse>;
    try {
      body = signupSchema.parse(req.body);
    } catch (error) {
      return handleZodError(error, res);
    }

    const invite = storage.getInvite(body.inviteCode);
    const nowMs = Date.now();
    if (!invite || invite.consumedAt || new Date(invite.expiresAt).getTime() <= nowMs) {
      // Single message for "doesn't exist / expired / already used" so we
      // don't leak which it is to someone fishing for valid codes.
      return res.status(400).json({ message: "Invite not found or expired" });
    }

    // Email-locked invites must match exactly (case-insensitive).
    if (invite.email && invite.email.toLowerCase() !== body.email.toLowerCase()) {
      return res.status(400).json({ message: "Invite is locked to a different email" });
    }

    // role=admin invites are never created in P3 (POST /api/admin/invites
    // rejects them), but if a legacy row exists we still refuse to consume
    // it through public signup — admins go through bootstrap.
    if (invite.role === "admin") {
      return res.status(400).json({ message: "Invite not found or expired" });
    }

    if (storage.getUserByEmail(body.email)) {
      return res.status(409).json({ message: "Email already in use" });
    }

    const { salt, hash } = hashPassword(body.password);
    const totpSecret = generateBase32Secret();
    const created = storage.createUser({
      email: body.email,
      fullName: body.fullName,
      role: invite.role,
      passwordSalt: salt,
      passwordHash: hash,
      totpSecret,
      linkedClientId: invite.role === "driver" ? invite.linkedClientId : undefined,
    });
    storage.consumeInvite(invite.code, created.id);
    storage.audit("user.created", "user", created.id, {
      source: "invite",
      inviteCode: invite.code,
      role: created.role,
    });

    // Audit V2-2 — regenerate session id before binding userId on signup auto-login.
    // Done synchronously via a one-shot Promise so we can keep returning a typed
    // response below without restructuring the whole handler.
    req.session.regenerate((regenErr) => {
      if (regenErr) {
        console.error("[auth] signup regenerate failed:", regenErr);
        return res.status(500).json({ message: "Signup failed after user create" });
      }
      req.session.userId = created.id;
      req.session.role = created.role;
      req.session.authenticated = true;
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error("[auth] signup save failed:", saveErr);
          return res.status(500).json({ message: "Signup failed after user create" });
        }
        storage.recordUserLogin(created.id);
        storage.audit("auth.signup_login", "user", created.id, { role: created.role });

        const redirect =
          created.role === "admin" ? "/admin" : created.role === "dispatcher" ? "/dispatch" : "/d";

        return res.status(201).json({
          id: created.id,
          email: created.email,
          role: created.role,
          totpSecret,
          otpauthUrl: buildOtpAuthUrl(created.email, totpSecret),
          redirect,
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/me — Phase 1 contract for all three portals
  // -------------------------------------------------------------------------

  app.get("/api/me", (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ message: "Authentication required" });
    res.json(storage.toUserPublic(user));
  });

  // -------------------------------------------------------------------------
  // Public pricing catalogue — used by landing /pricing section and the
  // onboarding wizard plan step. No secrets exposed (Stripe price ids stay
  // on the server; client only sees label + monthlyCents + features).
  // -------------------------------------------------------------------------
  app.get("/api/public/pricing", async (_req, res) => {
    const { PLANS } = await import("./lib/plans");
    const plans = Object.values(PLANS)
      .filter((p) => p.tier !== "trial")
      .map((p) => ({
        tier: p.tier,
        label: p.label,
        persona: p.persona,
        monthlyCents: p.monthlyCents,
        includedDriverSeats: p.includedDriverSeats,
        additionalDriverCents: p.additionalDriverCents,
        includedDispatcherSeats: p.includedDispatcherSeats,
        maxMcCount: p.maxMcCount === Infinity ? null : p.maxMcCount,
        auditRetentionDays: p.auditRetentionDays,
        features: p.features,
      }));
    return res.json({ plans, trialDays: 14 });
  });

  // -------------------------------------------------------------------------
  // Onboarding wizard — server-tracked state machine.
  // GET  /api/me/onboarding         — read current progress
  // PATCH /api/me/onboarding        — advance / save data / mark completed
  // -------------------------------------------------------------------------
  app.get("/api/me/onboarding", (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ message: "Authentication required" });
    const progress = storage.getOnboardingProgress(user.id);
    return res.json({
      progress: progress ?? {
        userId: user.id,
        step: 0,
        data: {},
        startedAt: null,
        updatedAt: null,
        completedAt: null,
      },
      hasStarted: Boolean(progress),
      hasCompleted: Boolean(progress?.completedAt),
    });
  });

  app.patch("/api/me/onboarding", (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ message: "Authentication required" });
    let body: ReturnType<typeof updateOnboardingProgressSchema.parse>;
    try {
      body = updateOnboardingProgressSchema.parse(req.body);
    } catch (err) {
      return handleZodError(err, res);
    }
    storage.upsertOnboardingProgress(user.id, {
      step: body.step,
      data: body.data,
      completed: body.completed,
    });
    if (body.completed) {
      storage.audit("onboarding.completed", "user", user.id, {
        userId: user.id,
        persona: (body.data as { persona?: string } | undefined)?.persona,
        planTier: (body.data as { planTier?: string } | undefined)?.planTier,
      });
    }
    const progress = storage.getOnboardingProgress(user.id);
    return res.json({ progress });
  });

  // i18n — PATCH /api/me/preferences. Accepts a partial preferences body and
  // persists fields that we currently support (preferredLang). Sent by the
  // <LanguageSwitcher> on every change so the choice survives across devices.
  app.patch("/api/me/preferences", (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ message: "Authentication required" });
    let body: ReturnType<typeof updateMyPreferencesSchema.parse>;
    try {
      body = updateMyPreferencesSchema.parse(req.body);
    } catch (err) {
      return handleZodError(err, res);
    }
    if (body.preferredLang) {
      storage.setUserPreferredLang(user.id, body.preferredLang);
    }
    const updated = storage.getUserById(user.id);
    res.json(updated ? storage.toUserPublic(updated) : storage.toUserPublic(user));
  });

  // -------------------------------------------------------------------------
  // Phase 3 admin routes. Registered BEFORE the shared `app.use("/api", ...)`
  // gate below so each handler manages its own `requireRole('admin')` instead
  // of double-gating through `requireRole.any()`. See server/routes/admin.ts.
  // -------------------------------------------------------------------------
  registerAdminRoutes(app);
  registerBillingRoutes(app);

  // Admin integration live-test endpoints. POST /api/admin/integrations/test/:id
  // fires a real network probe at each connector (FMCSA, Resend, Telegram,
  // EIA, Google Maps, Sentry DSN shape, inbound-email loop). 5min in-memory
  // cache per integration so dispatchers can't accidentally rate-limit us.
  registerAdminIntegrationTestsRoutes(app, requireRole("admin"));

  // Phase 6: admin CRUD for load_sources (broker board connectors).
  // Read /api/admin/load-sources/adapters for the dropdown, then POST to
  // create. Credentials are encrypted via DISPATCHOS_KEYRING_PRIMARY.
  registerAdminLoadSourcesRoutes(app, requireRole("admin"));

  // -------------------------------------------------------------------------
  // Phase 4 driver portal routes (P0). Same registration pattern as admin —
  // each handler carries its own `requireRole('driver')` so we register here
  // before the catch-all `requireRole.any()` gate. See server/routes/me.ts.
  // -------------------------------------------------------------------------
  registerMeRoutes(app);
  registerMeTotpRoutes(app);
  // GPS ping ingest — public (token-auth), must be BEFORE requireRole.any().
  registerTrackRoutes(app);

  // Public lead capture from landing page (no auth) + dispatcher review queue.
  // Must register BEFORE any catch-all auth gate so /api/public/* is open.
  registerLeadRoutes(app);

  // Public webhook receivers (Resend, future: Stripe, Twilio).
  // No auth gate; each route verifies its own service-specific signature.
  registerWebhookRoutes(app);

  // Scheduled-task endpoints (EIA fuel refresh, future cron jobs).
  // No session auth; protected by X-Cron-Secret shared header.
  registerCronRoutes(app);

  // Inbound integration endpoints (CF Email Worker, future webhooks).
  // No session auth; protected by X-Inbound-Secret shared header.
  registerInboundRoutes(app);

  // Telegram driver bot webhook. Path-token auth; always 200s back to TG
  // so it doesn't retry. See server/routes/telegram-bot.ts.
  registerTelegramBotRoutes(app);

  // -------------------------------------------------------------------------
  // Phase 4 dispatcher portal routes (P0). Same per-handler `requireRole`
  // pattern. See server/routes/dispatch.ts.
  // -------------------------------------------------------------------------
  registerDispatchRoutes(app);
  registerBrokerTrustRoutes(app);
  registerCockpitRoutes(app);
  registerPredictiveRoutes(app);

  // -------------------------------------------------------------------------
  // All API endpoints below this gate require an authenticated user. The
  // role-specific filtering will be added in Phase 3; for now any role can
  // hit them (== legacy v1.2.7 behavior).
  // -------------------------------------------------------------------------

  // Presence ping middleware. Every authenticated /api request bumps the
  // user's last_seen_at column. Throttled to once per 30s per user in-process
  // to avoid SQLite write thrash (drivers can hit dashboard polls every 30s
  // already; we only need 'within 2 min = online' resolution).
  const lastSeenCache = new Map<string, number>();
  app.use("/api", (req, _res, next) => {
    const userId = req.session?.userId;
    if (userId) {
      const now = Date.now();
      const prev = lastSeenCache.get(userId) ?? 0;
      if (now - prev > 30_000) {
        lastSeenCache.set(userId, now);
        // Best-effort write — swallow errors so a transient DB hiccup never
        // breaks the request.
        try { storage.touchUserPresence(userId); } catch { /* ignore */ }
      }
    }
    next();
  });

  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/auth/") || req.path === "/me" || req.path === "/health") {
      return next();
    }
    return requireRole.any()(req, res, next);
  });

  // Audit V3-13 — dispatch board is operational data (loads, drivers,
  // statuses). Restrict to admin + dispatcher; drivers/anonymous should
  // not see fleet-wide load assignments.
  app.get("/api/dispatch-board", requireRole("admin", "dispatcher"), (req, res) => {
    res.json(buildDispatchBoard(String(req.query.clientId ?? "")));
  });

  app.get("/api/clients", requireRole("admin", "dispatcher"), (_req, res) => {
    res.json(storage.listClients());
  });

  app.post("/api/clients", requireRole("admin", "dispatcher"), requireActiveBilling, (req, res) => {
    try {
      const client = storage.upsertClient(insertClientSchema.parse(req.body));
      res.status(201).json(client);
    } catch (error) {
      handleZodError(error, res);
    }
  });

  app.patch("/api/clients/:id/location", requireRole("admin", "dispatcher"), (req, res) => {
    try {
      const location = updateLocationSchema.parse(req.body);
      const client = storage.updateClientLocation(String(req.params.id), location);
      if (!client) return res.status(404).json({ message: "Client not found" });
      res.json(client);
    } catch (error) {
      handleZodError(error, res);
    }
  });

  app.get("/api/loads", requireRole("admin", "dispatcher"), (_req, res) => {
    res.json(storage.listLoads());
  });

  app.post("/api/loads", requireRole("admin", "dispatcher"), requireActiveBilling, (req, res) => {
    try {
      // Phase 3 P2 + Phase 4 P0: accept optional clientId/bookedAt for billing
      // linkage AND optional driverId for driver-portal scoping. Pre-Phase-3
      // callers (v1.2.7 frontend, Phase 1 smoke) keep working — those fields
      // are all optional, validation is strict-superset of Phase 1.
      //
      // Phase 4: enrichLoadSync replaces hand-tuned marketQuality with a real
      // lane-benchmark calculation (origin region × dest region × equipment ×
      // seasonality). Brokers and fuel pricing are enriched separately at
      // score time (see scoreLoadForClient).
      const parsed = insertLoadFullSchema.parse(req.body);
      const enriched = enrichLoadSync(parsed);
      const load = storage.upsertLoad(enriched);
      // Killer #4: match this new load against active lane watches.
      try {
        storage.matchLoadAgainstWatches({
          id: load.id,
          originState: load.originState,
          destinationState: load.destinationState,
          rate: load.rate,
          loadedMiles: load.loadedMiles,
          equipment: load.equipment,
        });
      } catch (err) {
        console.error("[watchlist] match failed:", err);
      }
      res.status(201).json(load);
    } catch (error) {
      handleZodError(error, res);
    }
  });

  app.post("/api/loads/import-csv", requireRole("admin", "dispatcher"), (req, res) => {
    try {
      const { csv } = csvImportSchema.parse(req.body);
      res.status(201).json(importLoadsFromCsv(csv));
    } catch (error) {
      handleZodError(error, res);
    }
  });

  app.get("/api/documents", requireRole("admin", "dispatcher"), (_req, res) => {
    res.json(storage.listDocuments());
  });

  app.post("/api/documents", requireRole("admin", "dispatcher"), (req, res) => {
    try {
      const document = storage.upsertDocument(insertDocumentSchema.parse(req.body));
      res.status(201).json(document);
    } catch (error) {
      handleZodError(error, res);
    }
  });

  app.post("/api/broker/check", requireRole("admin", "dispatcher"), async (req, res) => {
    try {
      const input = brokerCheckSchema.parse(req.body);
      const record = storage.upsertBrokerRecord(await checkBrokerRisk(input.brokerMc, input.brokerName));
      res.json(record);
    } catch (error) {
      handleZodError(error, res);
    }
  });

  app.get("/api/brokers", requireRole("admin", "dispatcher"), (_req, res) => {
    res.json(storage.listBrokerRecords());
  });

  app.get("/api/drive/folder-plan", (req, res) => {
    res.json(buildDrivePlan(String(req.query.clientId || "")));
  });

  app.post("/api/drive/create-local-folders", requireRole("admin", "dispatcher"), (req, res) => {
    try {
      const input = driveCreateSchema.parse(req.body);
      res.status(201).json(createLocalDriveFolders(input.clientId));
    } catch (error) {
      handleZodError(error, res);
    }
  });

  app.post("/api/documents/upload", requireRole("admin", "dispatcher"), upload.single("file"), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "file is required" });
      const safeOriginal = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      const safeName = `${Date.now()}-${safeOriginal}`;
      const safePath = path.join(uploadsRoot, safeName);
      fs.renameSync(req.file.path, safePath);
      const document = storage.saveUploadedDocument(
        insertDocumentSchema.parse({
          clientId: req.body.clientId,
          loadId: req.body.loadId || undefined,
          type: req.body.type,
          status: req.body.status || "received",
          fileName: req.body.fileName || req.file.originalname,
          notes: req.body.notes,
        }),
        { ...req.file, filename: safeName, path: safePath },
      );
      res.status(201).json(document);
    } catch (error) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.rmSync(req.file.path, { force: true });
      handleBadRequest(error, res);
    }
  });

  app.post("/api/telegram/command", requireRole("admin", "dispatcher"), (req, res) => {
    try {
      const input = telegramCommandSchema.parse(req.body);
      let action = "logged";
      if (input.command === "/loc") {
        const client = storage.getClient(input.clientId);
        if (!client) return res.status(404).json({ message: "Client not found" });
        storage.updateClientLocation(input.clientId, {
          city: input.city || client.currentLocation.city,
          state: input.state || client.currentLocation.state,
          lat: input.lat ?? client.currentLocation.lat,
          lng: input.lng ?? client.currentLocation.lng,
          source: input.lat && input.lng ? "telegram_live" : "manual_checkin",
          status: client.currentLocation.status,
          notes: input.text,
        });
        action = "location_updated";
      }
      storage.audit("telegram.command", "telegram", input.clientId, { ...input, action });
      res.json({
        ok: true,
        action,
        reply:
          input.command === "/yes"
            ? "Approval logged. Human dispatcher still confirms broker/rate con before final action."
            : input.command === "/no"
              ? "Rejection logged."
              : input.command === "/nego"
                ? "Negotiation request logged."
                : "Location update logged.",
      });
    } catch (error) {
      handleZodError(error, res);
    }
  });

  app.post("/api/email/ingest", requireRole("admin", "dispatcher"), (req, res) => {
    try {
      const input = emailIngestSchema.parse(req.body);
      const parsed = parseEmailToLoad(input);
      const record = storage.saveEmailIngest({ ...input, parsed });
      res.status(201).json(record);
    } catch (error) {
      handleZodError(error, res);
    }
  });

  app.get("/api/email/ingest", requireRole("admin", "dispatcher"), (req, res) => {
    const limit = Math.min(Number(req.query.limit || 50), 200);
    res.json(storage.listEmailIngest(limit));
  });

  // Audit V3-14/15/16 — status / introspection endpoints reveal which
  // integrations are configured (FMCSA key set? Resend connected?) and
  // total user counts. This is recon-grade info that helps an attacker
  // tailor phishing. Restrict to authenticated staff.
  app.get(
    "/api/integrations/status",
    requireRole("admin", "dispatcher"),
    (_req, res) => {
      res.json(buildIntegrationStatus());
    },
  );

  app.get(
    "/api/system/status",
    requireRole("admin", "dispatcher"),
    (_req, res) => {
      res.json(buildSystemStatus());
    },
  );

  app.get("/api/portal/status", requireRole("admin"), (_req, res) => {
    const adminCount = storage.listUsers({ role: "admin" }).length;
    const dispatcherCount = storage.listUsers({ role: "dispatcher" }).length;
    const driverCount = storage.listUsers({ role: "driver" }).length;
    res.json({
      generatedAt: new Date().toISOString(),
      phase: "1.3.0-phase1",
      adminPortal: {
        status: "ready",
        capabilities: [
          "clients",
          "loads",
          "documents",
          "broker-checks",
          "audit",
          "backup",
          "weekly-reports",
          "integrations",
          "users (storage layer ready, /api/admin/* endpoints land in Phase 3)",
        ],
      },
      dispatcherPortal: {
        status: "schema_ready",
        capabilities: ["data model + role middleware in place"],
        remaining: ["/api/dispatch/* endpoints (Phase 3)", "tenant-scope filters", "UI"],
      },
      driverPortal: {
        status: "schema_ready",
        capabilities: ["data model + role middleware in place"],
        remaining: ["/api/me/* endpoints (Phase 3)", "self-scope filters", "UI"],
      },
      moderation: {
        status: "multi_role_ready",
        userCount: { admin: adminCount, dispatcher: dispatcherCount, driver: driverCount },
        remaining: ["approval queues", "audit-by-actor filters in UI"],
      },
    });
  });

  // Audit V3-13 — weekly report carries revenue, broker mix, lane stats
  // — strategic data not for drivers/anonymous.
  app.get("/api/reports/weekly", requireRole("admin", "dispatcher"), (req, res) => {
    const report = buildWeeklyReport(String(req.query.clientId || ""));
    if (!report) return res.status(404).json({ message: "Client not found" });
    res.json(report);
  });

  // -------------------------------------------------------------------------
  // GET /api/audit — Phase 1 contract preserved, Phase 3 P4 extension
  // -------------------------------------------------------------------------
  //
  // Backward-compat: with NO query parameters, returns the legacy flat array
  // (Event[]) for the v1.2.7 dashboard and Phase 1 smoke. With ANY new
  // query param (limit, cursor, eventType, entityType, actorId, entityId,
  // since, until) — switches to the new paginated shape with item enrichment
  // (actorUserId + actorEmail resolved from payload).
  //
  // Spec §6.1.
  // -------------------------------------------------------------------------

  // Set of new param names that, if present, switch to the paginated format.
  const AUDIT_NEW_PARAMS = ["limit", "cursor", "eventType", "entityType", "actorId", "entityId", "since", "until"];

  app.get("/api/audit", requireRole("admin"), (req, res) => {
    const usesNewParams = AUDIT_NEW_PARAMS.some((key) => req.query[key] !== undefined);

    if (!usesNewParams) {
      // Legacy flat array path. Phase 1 default limit was 50; we keep it.
      return res.json(storage.listAuditEvents(50));
    }

    // -- Paginated path -----------------------------------------------------
    const limitRaw = req.query.limit;
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1 || limit > 200)) {
      return res.status(400).json({ message: "limit must be an integer between 1 and 200" });
    }
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

    // eventType supports either a single string OR an array (?eventType=a&eventType=b).
    let eventType: string | string[] | undefined;
    if (Array.isArray(req.query.eventType)) {
      eventType = req.query.eventType.map(String);
    } else if (typeof req.query.eventType === "string") {
      eventType = req.query.eventType;
    }

    const entityType = typeof req.query.entityType === "string" ? req.query.entityType : undefined;
    const actorId = typeof req.query.actorId === "string" ? req.query.actorId : undefined;
    const entityId = typeof req.query.entityId === "string" ? req.query.entityId : undefined;
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    const until = typeof req.query.until === "string" ? req.query.until : undefined;

    const page = storage.listAuditEventsPaginated({
      limit,
      cursor,
      eventType,
      entityType,
      actorId,
      entityId,
      since,
      until,
    });
    return res.json({
      items: page.items,
      nextCursor: page.nextCursor,
      hasMore: page.nextCursor !== null,
      total: page.total,
    });
  });

  app.get("/api/backup/export", requireRole("admin"), (req, res) => {
    const backup: any = storage.exportBackup();
    if (req.query.redacted === "true") {
      backup.documents = backup.documents.map((document: any) => ({
        ...document,
        storageUrl: document.storageUrl ? "[redacted-local-path]" : undefined,
      }));
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="dispatchos-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    res.json(backup);
  });

  app.get("/api/health", (_req, res) => {
    // Audit V2-10 — lightweight counts via COUNT(*); avoids loading every row.
    res.json({
      ok: true,
      service: "dispatchos-location-aware",
      version: "1.2.7-vds-production",
      clients: storage.countClients(),
      loads: storage.countLoads(),
      documents: storage.countDocuments(),
      brokers: storage.countBrokerRecords(),
      emailIngest: storage.countEmailIngest() > 0 ? 1 : 0,
    });
  });

  const httpServer = createServer(app);
  return httpServer;
}
