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
  totpConfirmSignupSchema,
  totpResumeSetupSchema,
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
import { assertSafeOutboundUrl } from "./lib/url-guard";
import { sanitizePathSegment, isWithinDir } from "./lib/safe-path";
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
import { registerFleetRoutes } from "./routes/fleet";
import { registerPredictiveRoutes } from "./routes/predictive";
import { registerLeadRoutes } from "./routes/leads";
import { registerWebhookRoutes } from "./routes/webhooks";
import { registerCronRoutes } from "./routes/cron";
import { registerInboundRoutes } from "./routes/inbound";
import { registerTelegramBotRoutes } from "./routes/telegram-bot";
import { registerBillingRoutes } from "./routes/billing";
import { enrichLoadSync, outboundMarketScore, getRouteFuelPrice, observedLaneQualityAdjustment } from "./lib/ai";
import { resolveScoreWeights } from "./lib/score-weights";
import { parseSylectusEmail } from "./lib/parsers/sylectus";
import { getIntegrationValue } from "./lib/integration-config";
import { parseLimit } from "./lib/query";
import { fetchByMc } from "./lib/ai/fmcsa";
import { isDisposableEmail } from "./lib/disposable-domains";
import {
  TWILIO_VERIFY_CONFIGURED,
  sendVerificationCode,
  checkVerificationCode,
  sendEmailVerificationCode,
  checkEmailVerificationCode,
  lookupLineType,
} from "./lib/twilio/verify";
import crypto from "node:crypto";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

// ---------------------------------------------------------------------------
// fix/totp-onboarding-verify — pending-confirmation token helpers
// ---------------------------------------------------------------------------
// Short-lived (10 min) HMAC-SHA256-signed tokens used during TOTP onboarding.
// Issued by POST /api/auth/signup (instead of a full session), consumed by
// POST /api/auth/totp/confirm-signup once the user verifies their first code.
// Derives from the session secret — the real env var is DISPATCHOS_SESSION_SECRET
// (server/index.ts boot gate guarantees it is strong in prod). The unprefixed
// SESSION_SECRET is kept only as a documented alias; the hardcoded fallback is
// dev-only (prod can never reach it because the boot gate requires the prefixed var).
const PENDING_TOKEN_SECRET = crypto
  .createHash("sha256")
  .update(
    `pending-totp-${process.env.DISPATCHOS_SESSION_SECRET || process.env.SESSION_SECRET || "dispatchos-dev-secret"}`,
  )
  .digest();

function makePendingConfirmationToken(userId: string): string {
  const expiresAt = Date.now() + 10 * MINUTE;
  const payload = `${userId}:${expiresAt}`;
  const sig = crypto
    .createHmac("sha256", PENDING_TOKEN_SECRET)
    .update(payload)
    .digest("base64url");
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

function verifyPendingConfirmationToken(token: string): { userId: string } | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const lastDot = decoded.lastIndexOf(".");
    if (lastDot < 0) return null;
    const payload = decoded.slice(0, lastDot);
    const sig = decoded.slice(lastDot + 1);
    const expectedSig = crypto
      .createHmac("sha256", PENDING_TOKEN_SECRET)
      .update(payload)
      .digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
    const [userId, expiresAtStr] = payload.split(":");
    if (!userId || !expiresAtStr) return null;
    const expiresAt = Number(expiresAtStr);
    if (Date.now() > expiresAt) return null;
    return { userId };
  } catch {
    return null;
  }
}

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

// persist=false skips the two synchronous DB writes below (lane_history +
// load_scores). Read-only callers that score many (client, load) pairs per
// request — e.g. the auto-refreshing cockpit — must pass false, or each page
// render fires N×loads synchronous SQLite writes that block the event loop.
export function scoreLoadForClient(client: Client, load: Load, persist = true): ScoredLoad | null {
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

  // Reject zero/negative/NaN loadedMiles BEFORE any division. Otherwise
  // totalPpm = rate/0 = Infinity and deadheadRatio = 0/0 = NaN propagate into
  // dispatchScore and the verdict, ranking a garbage load as a confident
  // "book" with Infinity PPM. (lanes.classifyOffer guards this same case.)
  if (!(load.loadedMiles > 0)) return null;

  const deadheadMiles = calculateDistanceMiles(
    client.currentLocation,
    { lat: load.originLat, lng: load.originLng },
  );
  const totalMiles = load.loadedMiles + deadheadMiles;
  const deadheadRatio = deadheadMiles / totalMiles;
  // Real per-route diesel price (EIA cache → PADD regional baseline → national
  // fallback) instead of the static placeholder client.fuelPrice, which is set
  // once at onboarding and never updated. getRouteFuelPrice was computed and
  // EIA-refreshed by cron but NEVER read by the scorer — so fuel cost (and thus
  // net PPM / dispatchScore) ignored real regional diesel entirely. Falls back
  // to the client's price only if the lookup is somehow non-positive.
  const routeFuelPrice = getRouteFuelPrice(load.originState, load.destinationState).price;
  const fuelPricePerGallon = routeFuelPrice > 0 ? routeFuelPrice : client.fuelPrice;
  const fuelCost = (totalMiles / client.mpg) * fuelPricePerGallon;
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
  // Refine lane quality with REAL observed rates (lane_history) when a lane has
  // enough data — completes the recordLaneObservation -> getLaneAvgPpm pipeline
  // that previously wrote observations but never read them. Cold-start safe
  // (no data -> 0 adjustment, so launch/sparse lanes are unchanged) and
  // env-tunable: DISPATCHOS_LANE_OBSERVED_WEIGHT (default 1; set 0 to disable).
  const laneObsWeightRaw = Number.parseFloat(process.env.DISPATCHOS_LANE_OBSERVED_WEIGHT ?? "");
  const laneObsWeight = Number.isFinite(laneObsWeightRaw) ? clamp(laneObsWeightRaw, 0, 2) : 1;
  let laneScore = load.marketQuality;
  if (laneObsWeight > 0) {
    const observed = storage.getLaneAvgPpm(load.originState, load.destinationState);
    const adj = observedLaneQualityAdjustment(
      load.originState, load.destinationState, load.equipment, observed, load.pickupAt,
    );
    laneScore = clamp(load.marketQuality + laneObsWeight * adj, 0, 100);
  }
  const locationScore =
    locationConfidence === "high" ? 100 : locationConfidence === "medium" ? 72 : 32;

  // Backhaul / outbound-market awareness: how strong is the freight market
  // LEAVING this load's destination? A great-paying load into a dead market is
  // a trap — you deadhead far or sit waiting for the next load. We always
  // compute + surface this (field + warning); it only changes the rank when
  // DISPATCHOS_BACKHAUL_WEIGHT > 0, so default behavior is byte-for-byte the
  // same (fully backward-compatible).
  const backhaulScore = outboundMarketScore(load.destinationState, load.equipment, load.pickupAt);

  // Per-client weight tuning (clientSchema.scoreWeights). Resolves to the
  // defaults — which sum to 1.0 — when a carrier has no overrides, so existing
  // carriers' scores are unchanged. Normalized, so any magnitudes are safe.
  const w = resolveScoreWeights((client as Client & { scoreWeights?: unknown }).scoreWeights as any);
  const baseScore =
    ppmScore * w.ppm +
    deadheadScore * w.deadhead +
    feasibilityScore * w.feasibility +
    brokerSafetyScore * w.broker +
    laneScore * w.lane +
    locationScore * w.location;
  const wRaw = Number.parseFloat(process.env.DISPATCHOS_BACKHAUL_WEIGHT ?? "");
  const backhaulWeight = Number.isFinite(wRaw) ? clamp(wRaw, 0, 0.4) : 0;
  const dispatchScore = Math.round(
    (1 - backhaulWeight) * baseScore + backhaulWeight * backhaulScore,
  );

  const warnings: string[] = [];
  if (locationConfidence === "low") warnings.push("Location older than 60 min: request /loc before booking.");
  if (deadheadRatio > 0.25) warnings.push("Deadhead is above 25% of total miles.");
  if (pickupFeasibility === "not_feasible") warnings.push("Pickup window is not feasible from current position.");
  if (load.fraudRisk >= 25) warnings.push("Broker/fraud risk is elevated; verify MC and rate confirmation.");
  if (netPpmTotal < client.minimumPpm) warnings.push("Net total PPM is below client minimum.");
  // Relative backhaul flag: hauling from a strong inbound lane into a notably
  // weaker outbound market means a likely deadhead / wait for the next load.
  // Relative (vs the inbound laneScore) rather than absolute, so it stays
  // meaningful without hand-calibrating to the benchmark's compressed range.
  if (laneScore - backhaulScore >= 12) {
    warnings.push(
      `Outbound market at destination (${backhaulScore}/100) is weaker than the inbound lane (${Math.round(laneScore)}/100): line up the next load before booking.`,
    );
  }

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

  if (persist) {
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
        backhaulScore,
      },
    });
  } catch (err) {
    // Cache write is best-effort; don't fail the request.
    console.error("[score] cache write failed:", err);
  }
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
    backhaulScore,
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
  
  const prefixMatch = raw.match(/^(MC|MX|FF)\b/);
  const prefix = prefixMatch ? prefixMatch[1] : "MC";
  // V4-007: use only the FIRST contiguous run of digits — the actual docket
  // number — not every digit in the string. Taking all digits meant
  // "MC-9001" and "MC-9001-X2" (-> 90012) normalized to different keys for the
  // same docket, letting one MC be registered twice with junk suffixes and
  // bypassing the uniqueness gate. We read digits AFTER the prefix so the
  // prefix's own letters never interfere.
  const afterPrefix = prefixMatch ? raw.slice(prefixMatch[0].length) : raw;
  const docketMatch = afterPrefix.match(/\d+/);
  const digits = docketMatch ? docketMatch[0] : "";
  if (!digits) return raw;
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
      assertSafeOutboundUrl(url);
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
    // Anti-traversal: client.name / client.mc are operator-controlled; a name
    // like "../../etc" must never escape localDriveRoot (buildDrivePlan only
    // stripped whitespace).
    const rel = sanitizePathSegment(folder.path.replace(/^DispatchOS\/Clients\//, ""));
    const root = path.join(localDriveRoot, rel);
    if (!isWithinDir(localDriveRoot, root)) continue;
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
        // Canonical var is TELEGRAM_DRIVER_BOT_TOKEN (the only telegram entry in
        // the INTEGRATIONS registry; may be set via the admin UI / DB). The old
        // TELEGRAM_BOT_TOKEN check showed "needs config" even when configured.
        status:
          (getIntegrationValue("telegram_driver_bot", "TELEGRAM_DRIVER_BOT_TOKEN") ??
            process.env.TELEGRAM_DRIVER_BOT_TOKEN) && process.env.DISPATCHOS_PUBLIC_URL
            ? "ready"
            : "local_endpoint_ready",
        missing: [
          ...(getIntegrationValue("telegram_driver_bot", "TELEGRAM_DRIVER_BOT_TOKEN") ??
          process.env.TELEGRAM_DRIVER_BOT_TOKEN
            ? []
            : ["TELEGRAM_DRIVER_BOT_TOKEN"]),
          ...(process.env.DISPATCHOS_PUBLIC_URL ? [] : ["DISPATCHOS_PUBLIC_URL"]),
        ],
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
    // Skip the check only for genuine local dev / first-run on localhost.
    // M4 fix: previously this keyed solely on DISPATCHOS_PUBLIC_URL, so a prod
    // deploy that forgot to set PUBLIC_URL would silently fall into open
    // bootstrap mode (first caller becomes admin, no token). Treat any of the
    // production signals as "locked": NODE_ENV, the VDS deployment mode flag,
    // or an explicit public URL.
    const isProduction =
      process.env.NODE_ENV === "production" ||
      process.env.DISPATCHOS_DEPLOYMENT_MODE === "vds" ||
      Boolean(process.env.DISPATCHOS_PUBLIC_URL);
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
    // fix/totp-onboarding-verify — block login if TOTP secret exists but was
    // never verified during signup. The user skipped the verification step,
    // so their authenticator may not be set up correctly. Direct them to the
    // resume-setup flow which re-shows the QR + requires a valid code.
    if (user.totpSecret && !user.totpConfirmedAt) {
      storage.audit("auth.login_failed", "user", user.id, { reason: "totp_setup_required" });
      return res.status(401).json({
        message: "Завершите настройку 2FA — отсканируйте QR и подтвердите код.",
        code: "totp_setup_required",
      });
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
      // Reject a replay: if a concurrent login already consumed this counter,
      // the conditional update changes nothing and we must not issue a session.
      if (!storage.setLastUsedTotpCounter(user.id, acceptedCounter)) {
        return res.status(401).json({ message: "Invalid 2FA token", code: "totp_invalid" });
      }
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
      req.session.epoch = user.sessionEpoch ?? 0; // for session invalidation on reset
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

    // Anti-fraud: reject throwaway/disposable email providers before consuming
    // the invite, so a temp inbox can't be used to farm free trials.
    if (isDisposableEmail(body.email)) {
      storage.audit("auth.signup_blocked_disposable", "user", "signup", {
        emailDomain: body.email.slice(body.email.lastIndexOf("@") + 1).toLowerCase(),
      });
      return res.status(400).json({
        message: "Пожалуйста, используйте постоянный рабочий email (временные адреса не принимаются).",
        code: "disposable_email",
      });
    }

    const { salt, hash } = hashPassword(body.password);
    const totpSecret = generateBase32Secret();

    let created: ReturnType<typeof storage.createUser>;
    if (body.inviteCode) {
      // ---------------- Invite-based signup (team member) ----------------
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
      // role=admin invites are never created in P3, but if a legacy row exists
      // we still refuse to consume it through public signup.
      if (invite.role === "admin") {
        return res.status(400).json({ message: "Invite not found or expired" });
      }
      // Enumeration: check email-taken only AFTER the invite is validated, so a
      // probe without a valid code gets the generic "Invite not found or
      // expired" first and can't distinguish registered emails. The invite is
      // not consumed yet here, so a 409 does not burn it.
      if (storage.getUserByEmail(body.email)) {
        return res.status(409).json({ message: "Email already in use" });
      }
      // Atomic: create the user and consume the invite together. A concurrent
      // signup on the same code rolls back — a single-use invite can't mint two.
      const result = storage.createUserConsumingInvite(
        {
          email: body.email,
          fullName: body.fullName,
          role: invite.role,
          passwordSalt: salt,
          passwordHash: hash,
          totpSecret,
          linkedClientId: invite.role === "driver" ? invite.linkedClientId : undefined,
        },
        invite.code,
      );
      if ("alreadyConsumed" in result) {
        return res.status(409).json({ message: "Invite not found or expired" });
      }
      created = result;
      storage.audit("user.created", "user", created.id, {
        source: "invite",
        inviteCode: invite.code,
        role: created.role,
      });
      // Invited users (driver/dispatcher) are not carrier owners -- the
      // persona/MC/plan onboarding wizard does not apply. Mark it complete so
      // they never land in it. Empty data => the GET /api/me/onboarding
      // self-heal never provisions a carrier (it requires a persona).
      storage.upsertOnboardingProgress(created.id, { step: 4, data: {}, completed: true });
    } else {
      // ---------------- Self-serve carrier signup (no invite) ----------------
      // Anti-fraud is carried by the MC + FMCSA gate in onboarding (one MC =
      // one account, FMCSA-active authority required for a trial) — NOT the
      // invite. The account starts as a driver with NO carrier and NO trial;
      // load access / trial only unlock after a valid, unclaimed, FMCSA-active
      // MC is claimed during onboarding (which then provisions the carrier).
      // Self-serve has no invite secret to protect; an email-taken 409 here is
      // inherent to open registration (the auth brute-force limiter throttles
      // probing). Without this check a duplicate email hits the users UNIQUE
      // index and throws a 500 instead of returning a clean 409.
      if (storage.getUserByEmail(body.email)) {
        return res.status(409).json({ message: "Email already in use" });
      }
      created = storage.createUser({
        email: body.email,
        fullName: body.fullName,
        role: "driver",
        passwordSalt: salt,
        passwordHash: hash,
        totpSecret,
      });
      storage.audit("user.created", "user", created.id, {
        source: "self_serve",
        role: created.role,
      });
    }

    // fix/totp-onboarding-verify (2026-05-27) — do NOT log the user in yet.
    // Instead, issue a short-lived pending-confirmation token (10 min).
    // The frontend will show the QR + a 6-digit verification input.
    // Only after the user successfully enters a valid TOTP code does
    // POST /api/auth/totp/confirm-signup stamp totp_confirmed_at and
    // create the real session. This prevents the "scanned the QR but
    // skipped verification" lockout that Henry (QA) hit.
    const pendingConfirmationToken = makePendingConfirmationToken(created.id);
    const redirect =
      created.role === "admin" ? "/admin" : created.role === "dispatcher" ? "/dispatch" : "/d";
    storage.audit("auth.signup_pending_totp", "user", created.id, { role: created.role });
    return res.status(201).json({
      id: created.id,
      email: created.email,
      role: created.role,
      totpSecret,
      otpauthUrl: buildOtpAuthUrl(created.email, totpSecret),
      redirect,
      needsOnboarding: !body.inviteCode,
      pendingConfirmationToken,
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/totp/confirm-signup — fix/totp-onboarding-verify
  // -------------------------------------------------------------------------
  // Called by the PostSignupTotp component after the user enters a valid
  // 6-digit code for the first time. Validates the pending-confirmation token
  // (10-min HMAC), verifies the TOTP code, stamps totp_confirmed_at, then
  // creates a full session just like login does.
  // -------------------------------------------------------------------------
  app.post("/api/auth/totp/confirm-signup", (req, res) => {
    let body: { pendingConfirmationToken: string; token: string };
    try {
      body = totpConfirmSignupSchema.parse(req.body);
    } catch (error) {
      return handleZodError(error, res);
    }

    const claimed = verifyPendingConfirmationToken(body.pendingConfirmationToken);
    if (!claimed) {
      return res.status(401).json({
        message: "Ссылка истекла — повторите регистрацию.",
        code: "token_expired",
      });
    }

    const user = storage.getUserById(claimed.userId);
    if (!user || !user.totpSecret) {
      return res.status(404).json({ message: "User not found or 2FA not configured" });
    }

    // A blocked user must not be able to finish signup and get a session via a
    // still-valid pending token (the token is a stateless 10-min HMAC minted
    // before the block). Reject before confirming / regenerating the session.
    if (user.blocked) {
      storage.audit("auth.confirm_signup_blocked", "user", user.id, {});
      return res.status(403).json({ message: "Account is blocked.", code: "blocked" });
    }

    // Single-use guard (hardening): a pending-confirmation token is a stateless
    // 10-min HMAC, so on its own it could be replayed within the window. If this
    // user already confirmed, reject before re-verifying — the confirmation is
    // one-shot. (The atomic check below in confirmTotpSetup closes the race.)
    if (user.totpConfirmedAt) {
      storage.audit("auth.confirm_signup_replayed", "user", user.id, {});
      return res.status(409).json({
        message: "2FA already confirmed for this account. Please sign in.",
        code: "already_confirmed",
      });
    }

    const minCounter = storage.getLastUsedTotpCounter(user.id);
    const acceptedCounter = verifyTotp(user.totpSecret, body.token.trim(), minCounter);
    if (acceptedCounter === null) {
      storage.audit("auth.confirm_signup_failed", "user", user.id, { reason: "bad_totp" });
      return res.status(401).json({
        message: "Неверный код — проверьте цифры в приложении и повторите.",
        code: "totp_invalid",
      });
    }

    if (!storage.setLastUsedTotpCounter(user.id, acceptedCounter)) {
      return res.status(401).json({ message: "Неверный код — проверьте цифры в приложении и повторите.", code: "totp_invalid" });
    }
    const { firstConfirm } = storage.confirmTotpSetup(user.id);
    if (!firstConfirm) {
      // Lost a concurrent race past the guard above — another request confirmed
      // first. Don't issue a session for a replayed token.
      storage.audit("auth.confirm_signup_replayed", "user", user.id, { race: true });
      return res.status(409).json({
        message: "2FA already confirmed for this account. Please sign in.",
        code: "already_confirmed",
      });
    }
    storage.audit("auth.totp_confirmed", "user", user.id, {});

    req.session.regenerate((regenErr) => {
      if (regenErr) {
        console.error("[auth] confirm-signup regenerate failed:", regenErr);
        return res.status(500).json({ message: "Session create failed" });
      }
      req.session.userId = user.id;
      req.session.role = user.role;
      req.session.epoch = user.sessionEpoch ?? 0; // for session invalidation on reset
      req.session.authenticated = true;
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error("[auth] confirm-signup save failed:", saveErr);
          return res.status(500).json({ message: "Session create failed" });
        }
        storage.recordUserLogin(user.id);
        storage.audit("auth.signup_login", "user", user.id, { role: user.role });
        const redirect =
          user.role === "admin" ? "/admin" : user.role === "dispatcher" ? "/dispatch" : "/d";
        return res.json({ ok: true, role: user.role, redirect });
      });
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/totp/resume-setup — fix/totp-onboarding-verify
  // -------------------------------------------------------------------------
  // For users who signed up but never completed TOTP verification and are now
  // locked out (totp_setup_required). They call this with email + password to
  // re-fetch their QR code / TOTP URI and a fresh pending-confirmation token.
  // The same confirm-signup endpoint is then used to verify and create a session.
  // -------------------------------------------------------------------------
  app.post("/api/auth/totp/resume-setup", (req, res) => {
    let body: { email: string; password: string };
    try {
      body = totpResumeSetupSchema.parse(req.body);
    } catch (error) {
      return handleZodError(error, res);
    }

    const lookupEmail = body.email.toLowerCase();
    const user = storage.getUserByEmail(lookupEmail);
    if (!user) return res.status(401).json({ message: "Invalid credentials" });
    if (user.blocked) return res.status(403).json({ message: "Account is blocked" });

    const pwResult = verifyPassword(body.password, user.passwordSalt, user.passwordHash);
    if (!pwResult.ok) return res.status(401).json({ message: "Invalid credentials" });

    // Only allow resume if they genuinely haven't confirmed yet.
    if (user.totpConfirmedAt) {
      return res.status(409).json({
        message: "2FA is already confirmed. Please log in normally.",
        code: "already_confirmed",
      });
    }

    if (!user.totpSecret) {
      return res.status(409).json({ message: "No TOTP configured for this account" });
    }

    const pendingConfirmationToken = makePendingConfirmationToken(user.id);
    storage.audit("auth.totp_resume_setup", "user", user.id, {});
    return res.json({
      otpauthUrl: buildOtpAuthUrl(user.email, user.totpSecret),
      totpSecret: user.totpSecret,
      pendingConfirmationToken,
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
  // GET /api/onboarding/mc-lookup?mc=MC-123456
  //
  // FMCSA SAFER proxy for the onboarding MC field: confirms the docket exists,
  // surfaces legalName / dotNumber / state for autofill, flags
  // OUT_OF_SERVICE / NOT_AUTHORIZED, and reports whether the MC is already
  // claimed by another account. Graceful: missing key / FMCSA down / docket not
  // found => { found: false } (never 5xx). MC uniqueness is the hard gate;
  // FMCSA is a best-effort enhancement layered on top.
  // -------------------------------------------------------------------------
  app.get("/api/onboarding/mc-lookup", async (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ message: "Authentication required" });

    const rawMc = String(req.query.mc ?? "").trim();
    if (!rawMc) return res.status(400).json({ message: "mc query param required" });
    const normalized = normalizeMc(rawMc);

    const owner = storage.getMcRegistryOwner(normalized);
    const claimedByOther = !!owner && owner.userId !== user.id;

    const webKey = getIntegrationValue("fmcsa", "FMCSA_WEB_KEY") ?? process.env.FMCSA_WEBKEY;
    if (!webKey) {
      return res.json({ mc: normalized, found: false, claimedByOther, fmcsaConfigured: false });
    }

    const carrier = await fetchByMc(normalized, { webKey });
    if (!carrier) {
      return res.json({ mc: normalized, found: false, claimedByOther, fmcsaConfigured: true });
    }

    const blocked =
      carrier.operatingStatus === "OUT_OF_SERVICE" || carrier.operatingStatus === "NOT_AUTHORIZED";

    // Broker Trust Signal: log FMCSA authority status from broker-check.
    storage.appendBrokerTrustSignal({
      brokerMc: normalized, brokerName: carrier.legalName ?? null,
      signalType: blocked ? "authority_revoked" : "authority_restored",
      positive: !blocked, source: "fmcsa",
      notes: `operatingStatus=${carrier.operatingStatus} (broker-check)`,
    });

    return res.json({
      mc: normalized,
      found: true,
      claimedByOther,
      fmcsaConfigured: true,
      blocked,
      legalName: carrier.legalName,
      dotNumber: carrier.dotNumber ?? null,
      state: carrier.address?.state ?? null,
      operatingStatus: carrier.operatingStatus,
      authority: carrier.authority,
    });
  });

  // -------------------------------------------------------------------------
  // Onboarding wizard — server-tracked state machine.
  // GET  /api/me/onboarding         — read current progress
  // PATCH /api/me/onboarding        — advance / save data / mark completed
  // -------------------------------------------------------------------------
  app.get("/api/me/onboarding", (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ message: "Authentication required" });
    let progress = storage.getOnboardingProgress(user.id);

    // Self-heal: a user "completed" but with no linked carrier (provision that
    // failed after completedAt was stamped under the old order, or a legacy
    // account from before this fix). If the saved data still carries a valid
    // persona, re-provision now. provisionCarrierFromOnboarding is idempotent
    // (no-ops once linked, skips with no_mc if no docket was ever claimed).
    if (progress?.completedAt && !user.linkedClientId) {
      const persona = (progress.data as { persona?: unknown })?.persona;
      if (persona === "owner_operator" || persona === "fleet" || persona === "enterprise") {
        const d = progress.data as { companyName?: string; planTier?: string };
        const result = storage.provisionCarrierFromOnboarding(user.id, {
          persona,
          companyName: d.companyName,
          planTier: d.planTier,
        });
        if ("id" in result) {
          storage.audit("onboarding.carrier_self_healed", "user", user.id, {
            clientId: result.id,
          });
        }
        progress = storage.getOnboardingProgress(user.id);
      }
    }

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

  app.patch("/api/me/onboarding", async (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ message: "Authentication required" });
    let body: ReturnType<typeof updateOnboardingProgressSchema.parse>;
    try {
      body = updateOnboardingProgressSchema.parse(req.body);
    } catch (err) {
      return handleZodError(err, res);
    }

    // Anti-fraud: one MC docket = one account. If this onboarding step carries
    // a company MC, normalize it (V3-9) and claim it for this user. A claim
    // held by a different account blocks the save — stops a single carrier
    // from spinning up unlimited free trials under the same MC.
    const incomingMc = (body.data as { mc?: unknown } | undefined)?.mc;
    if (typeof incomingMc === "string" && incomingMc.trim()) {
      const normalized = normalizeMc(incomingMc);

      // Hard reject: if FMCSA is configured and reports this docket has no
      // active operating authority, block the save even for a free MC — a
      // REVOKED / OUT_OF_SERVICE / NOT_AUTHORIZED carrier shouldn't get a
      // trial. Graceful: no key / FMCSA down / docket not found => skip the
      // check (the uniqueness claim below still applies).
      const fmcsaKey = getIntegrationValue("fmcsa", "FMCSA_WEB_KEY") ?? process.env.FMCSA_WEBKEY;
      if (fmcsaKey) {
        const carrier = await fetchByMc(normalized, { webKey: fmcsaKey });
        if (
          carrier &&
          (carrier.operatingStatus === "OUT_OF_SERVICE" ||
            carrier.operatingStatus === "NOT_AUTHORIZED")
        ) {
          storage.audit("onboarding.mc_rejected_authority", "user", user.id, {
            mc: normalized,
            operatingStatus: carrier.operatingStatus,
          });
          // Broker Trust Signal: authority_revoked (onboarding hard-reject).
          storage.appendBrokerTrustSignal({
            brokerMc: normalized, brokerName: carrier.legalName ?? null,
            signalType: "authority_revoked", positive: false, source: "fmcsa",
            notes: `operatingStatus=${carrier.operatingStatus} (onboarding hard-reject)`,
          });
          return res.status(422).json({
            message: `У этого MC# нет действующей FMCSA authority (${carrier.operatingStatus}). Trial недоступен.`,
            code: "mc_not_authorized",
          });
        }
      }

      // Re-claim is idempotent for the same user; release any prior MC first so
      // a user correcting a typo isn't permanently bound to the wrong docket.
      const owner = storage.getMcRegistryOwner(normalized);
      if (owner && owner.userId !== user.id) {
        return res.status(409).json({
          message: "Этот MC# уже привязан к другому аккаунту. Если это ошибка — свяжитесь с поддержкой.",
          code: "mc_already_claimed",
        });
      }
      if (!owner) {
        storage.releaseMcForUser(user.id); // drop a previously-claimed (mistyped) MC
        storage.claimMc(normalized, user.id);
        storage.audit("onboarding.mc_claimed", "user", user.id, { mc: normalized });
      }
    }

// ---- Completion gates: run BEFORE we persist completedAt ----
    // The carrier must exist before onboarding is marked done. Previously
    // completedAt was stamped first and provision ran (unchecked) after, so a
    // missing/typo'd persona stamped "completed" while the carrier was silently
    // skipped — stranding the user in a portal with no client and no trial, and
    // with no way back into the wizard (hasCompleted bounces them out).
    let provisioned = false;
    if (body.completed) {
      // V4-003 hard gate: cannot complete without a claimed MC docket. The MC
      // can arrive in THIS request (handled above) or from an earlier PATCH.
      const claimedMc = storage.findMcByUserId(user.id);
      if (!claimedMc) {
        storage.audit("onboarding.completion_rejected_no_mc", "user", user.id, {
          step: body.step,
        });
        return res.status(422).json({
          message:
            "Нельзя завершить onboarding без MC#. Введите ваш MC номер и дождитесь FMCSA SAFER верификации.",
          code: "mc_required_to_complete",
        });
      }

      // Persona gate: provisioning requires a valid persona. Reject explicitly
      // instead of silently skipping provision (the old failure mode).
      const dPersona = (body.data as { persona?: unknown } | undefined)?.persona;
      if (
        dPersona !== "owner_operator" &&
        dPersona !== "fleet" &&
        dPersona !== "enterprise"
      ) {
        storage.audit("onboarding.completion_rejected_no_persona", "user", user.id, {
          step: body.step,
        });
        return res.status(422).json({
          message:
            "Не выбран тип аккаунта (owner-operator / fleet / enterprise). Вернитесь на шаг «Тип аккаунта».",
          code: "persona_required_to_complete",
        });
      }

      // Provision the carrier. If it fails, do NOT mark onboarding complete.
      if (!user.linkedClientId) {
        const d = (body.data ?? {}) as { companyName?: string; planTier?: string };
        const result = storage.provisionCarrierFromOnboarding(user.id, {
          persona: dPersona,
          companyName: d.companyName,
          planTier: d.planTier,
        });
        if (!("id" in result) && result.skipped !== "already_linked") {
          storage.audit("onboarding.provision_failed", "user", user.id, {
            reason: result.skipped,
            step: body.step,
          });
          return res.status(500).json({
            message: "Не удалось создать carrier. Попробуйте ещё раз или напишите в поддержку.",
            code: "provision_failed",
          });
        }
        provisioned = true;
      }
    }

    // Persist progress (and completedAt) only after gates + provision succeeded.
    storage.upsertOnboardingProgress(user.id, {
      step: body.step,
      data: body.data,
      completed: body.completed,
    });

    if (body.completed) {
      const d = (body.data ?? {}) as { persona?: string; planTier?: string };
      storage.audit("onboarding.completed", "user", user.id, {
        userId: user.id,
        persona: d.persona,
        planTier: d.planTier,
        provisioned,
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
  registerFleetRoutes(app);
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

  // Per-user subscription enforcement -- read-only mode on expiry.
  // Expired driver/dispatcher: block MUTATING requests (402), keep reads working
  // so the user still sees the app + the "subscription expired" badge, can log
  // out, switch language, and reach billing to renew. Admins and accounts with
  // no per-user subscription (subscriptionEndsAt = NULL) are never gated.
  app.use("/api", (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (
      req.path.startsWith("/auth/") ||
      req.path.startsWith("/billing") ||
      req.path === "/me/preferences" ||
      req.path === "/logout"
    ) {
      return next();
    }
    const subUser = getCurrentUser(req);
    if (!subUser || subUser.role === "admin") return next();
    const subEndsAt = subUser.subscriptionEndsAt;
    if (!subEndsAt || new Date(subEndsAt).getTime() > Date.now()) return next();
    return res.status(402).json({
      message: "Подписка истекла. Обратитесь к администратору для продления.",
      code: "subscription_expired",
    });
  });

  // Audit V3-13 — dispatch board is operational data (loads, drivers,
  // statuses). Restrict to admin + dispatcher; drivers/anonymous should
  // not see fleet-wide load assignments.
  app.get("/api/dispatch-board", requireRole("admin"), (req, res) => {
    res.json(buildDispatchBoard(String(req.query.clientId ?? "")));
  });

  app.get("/api/clients", requireRole("admin"), (req, res) => {
    // ?includeDeleted=1 returns archived clients too (admin "show archive" view).
    const includeDeleted = req.query.includeDeleted === "1" || req.query.includeDeleted === "true";
    res.json(storage.listClients({ includeDeleted }));
  });

  app.post("/api/clients", requireRole("admin"), requireActiveBilling, (req, res) => {
    try {
      const client = storage.upsertClient(insertClientSchema.parse(req.body));
      res.status(201).json(client);
    } catch (error) {
      handleZodError(error, res);
    }
  });
  // Soft-delete (archive) a client. Admin-only — archiving a carrier is
  // destructive (hides it from listings) so dispatchers can't do it. The row,
  // its loads, assignments and billing history are kept; listClients() simply
  // stops returning it. Idempotent: archiving an already archived client 200s.
  app.delete("/api/clients/:id", requireRole("admin"), (req, res) => {
    const me = getCurrentUser(req);
    const archived = storage.softDeleteClient(String(req.params.id), me?.id);
    if (!archived) return res.status(404).json({ message: "Client not found" });
    res.json({ ok: true, id: archived.id, archivedAt: archived.deletedAt ?? null });
  });
  // Restore an archived client (clears deletedAt). Admin-only, mirrors DELETE.
  app.post("/api/clients/:id/restore", requireRole("admin"), (req, res) => {
    const me = getCurrentUser(req);
    const restored = storage.restoreClient(String(req.params.id), me?.id);
    if (!restored) return res.status(404).json({ message: "Client not found" });
    res.json({ ok: true, id: restored.id });
  });

  app.patch("/api/clients/:id/location", requireRole("admin"), (req, res) => {
    try {
      const location = updateLocationSchema.parse(req.body);
      const client = storage.updateClientLocation(String(req.params.id), location);
      if (!client) return res.status(404).json({ message: "Client not found" });
      res.json(client);
    } catch (error) {
      handleZodError(error, res);
    }
  });

  app.get("/api/loads", requireRole("admin"), (_req, res) => {
    res.json(storage.listLoads());
  });

  app.post("/api/loads", requireRole("admin"), requireActiveBilling, (req, res) => {
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

  app.post("/api/loads/import-csv", requireRole("admin"), requireActiveBilling, (req, res) => {
    try {
      const { csv } = csvImportSchema.parse(req.body);
      res.status(201).json(importLoadsFromCsv(csv));
    } catch (error) {
      handleZodError(error, res);
    }
  });

  app.get("/api/documents", requireRole("admin"), (_req, res) => {
    res.json(storage.listDocuments());
  });

  app.post("/api/documents", requireRole("admin"), requireActiveBilling, (req, res) => {
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

  app.get("/api/brokers", requireRole("admin"), (_req, res) => {
    res.json(storage.listBrokerRecords());
  });

  app.get("/api/drive/folder-plan", requireRole("admin", "dispatcher"), (req, res) => {
    res.json(buildDrivePlan(String(req.query.clientId || "")));
  });

  app.post("/api/drive/create-local-folders", requireRole("admin", "dispatcher"), requireActiveBilling, (req, res) => {
    try {
      const input = driveCreateSchema.parse(req.body);
      res.status(201).json(createLocalDriveFolders(input.clientId));
    } catch (error) {
      handleZodError(error, res);
    }
  });

  app.post("/api/documents/upload", requireRole("admin"), requireActiveBilling, upload.single("file"), (req, res) => {
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

  app.post("/api/telegram/command", requireRole("admin"), (req, res) => {
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
    // parseLimit guards against ?limit=abc -> NaN -> SQLite LIMIT NaN (returns
    // every row / unbounded read).
    const limit = Math.min(parseLimit(req.query.limit) ?? 50, 200);
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
  app.get("/api/reports/weekly", requireRole("admin"), (req, res) => {
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

  // =========================================================================
  // feat/twilio-verify-phone-email — in-memory rate-limit buckets
  // =========================================================================
  // 1 send per phone/email per 60 s; max 5 per phone/email per 24 h.
  // Keyed by E.164 number or email address — not by IP (so the same number
  // can't be throttled by a different user on a shared IP).
  // =========================================================================
  const VERIFY_COOLDOWN_MS   = 60_000;
  const VERIFY_MAX_PER_24H   = 5;
  const VERIFY_WINDOW_24H_MS = 24 * 60 * 60 * 1_000;

  interface VerifyBucket { lastSentAt: number; count24h: number; windowStart: number }
  const verifyBuckets = new Map<string, VerifyBucket>();

  function verifyRateCheck(key: string): { allowed: boolean; cooldownSec: number } {
    const now = Date.now();
    let b = verifyBuckets.get(key);
    if (!b) {
      verifyBuckets.set(key, { lastSentAt: now, count24h: 1, windowStart: now });
      return { allowed: true, cooldownSec: 0 };
    }
    if (now - b.windowStart > VERIFY_WINDOW_24H_MS) {
      b.count24h = 0;
      b.windowStart = now;
    }
    if (b.count24h >= VERIFY_MAX_PER_24H) {
      return { allowed: false, cooldownSec: Math.ceil((VERIFY_WINDOW_24H_MS - (now - b.windowStart)) / 1000) };
    }
    const remaining = VERIFY_COOLDOWN_MS - (now - b.lastSentAt);
    if (remaining > 0) {
      return { allowed: false, cooldownSec: Math.ceil(remaining / 1000) };
    }
    b.lastSentAt = now;
    b.count24h++;
    return { allowed: true, cooldownSec: 0 };
  }

  function undoVerifyRateBucket(key: string) {
    const b = verifyBuckets.get(key);
    if (b) { b.count24h = Math.max(0, b.count24h - 1); b.lastSentAt = 0; }
  }

  const E164_RE = /^\+\d{8,15}$/;

  // -------------------------------------------------------------------------
  // POST /api/auth/phone/send-code — send SMS verification code
  // -------------------------------------------------------------------------
  app.post("/api/auth/phone/send-code", async (req, res) => {
    if (!TWILIO_VERIFY_CONFIGURED) {
      return res.status(503).json({ ok: false, error: "twilio_not_configured" });
    }
    const phone = String((req.body as { phone?: unknown })?.phone ?? "").trim();
    if (!E164_RE.test(phone)) {
      return res.status(400).json({ ok: false, error: "invalid_phone" });
    }
    const { allowed, cooldownSec } = verifyRateCheck(phone);
    if (!allowed) {
      return res.status(429).json({ ok: false, cooldownSec });
    }
    const lineType = await lookupLineType(phone);
    if (lineType === "voip" || lineType === "landline") {
      undoVerifyRateBucket(phone);
      return res.status(422).json({ ok: false, error: "phone_type_not_allowed", lineType });
    }
    const result = await sendVerificationCode(phone);
    if (!result.ok) {
      undoVerifyRateBucket(phone);
      return res.status(502).json({ ok: false, error: result.error });
    }
    try {
      const user = getCurrentUser(req);
      if (user) storage.audit("phone.code_sent", "user", user.id, { phone });
    } catch { /* no session yet during signup flow */ }
    return res.json({ ok: true, cooldownSec: Math.ceil(VERIFY_COOLDOWN_MS / 1000) });
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/phone/check-code — verify SMS code + mark verified
  // -------------------------------------------------------------------------
  app.post("/api/auth/phone/check-code", async (req, res) => {
    if (!TWILIO_VERIFY_CONFIGURED) {
      return res.status(503).json({ ok: false, error: "twilio_not_configured" });
    }
    const phone = String((req.body as { phone?: unknown })?.phone ?? "").trim();
    const code  = String((req.body as { code?: unknown })?.code  ?? "").trim();
    if (!E164_RE.test(phone)) return res.status(400).json({ ok: false, error: "invalid_phone" });
    if (!/^\d{6}$/.test(code))  return res.status(400).json({ ok: false, error: "invalid_code" });

    const result = await checkVerificationCode(phone, code);
    if (!result.ok) {
      try {
        const user = getCurrentUser(req);
        if (user) storage.audit("phone.code_failed", "user", user.id, { phone });
      } catch { /* ok */ }
      return res.status(401).json({ ok: false, verified: false, error: result.error });
    }
    try {
      const user = getCurrentUser(req);
      if (user) {
        // Don't let the verify flow silently swap an already-set phone: a number
        // change must go through the proper change-phone path. First-time set
        // during onboarding (no phone yet) is allowed.
        if (user.phone && user.phone !== phone) {
          storage.audit("phone.verify_mismatch", "user", user.id, { phone, accountPhone: user.phone });
          return res.status(403).json({ ok: false, error: "phone_mismatch" });
        }
        storage.markPhoneVerified(user.id, phone);
        storage.audit("phone.verified", "user", user.id, { phone });
      }
    } catch { /* session may not exist during signup — UI will persist on next auth */ }
    return res.json({ ok: true, verified: true });
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/email/send-code — send email verification code via Twilio
  // -------------------------------------------------------------------------
  // Requires SendGrid integration on the Twilio Verify Service.
  // If absent, Twilio returns error 60220 → we return 503 email_channel_not_configured.
  // Frontend shows "verify later" banner instead of hard-blocking signup.
  // -------------------------------------------------------------------------
  app.post("/api/auth/email/send-code", async (req, res) => {
    if (!TWILIO_VERIFY_CONFIGURED) {
      return res.status(503).json({ ok: false, error: "twilio_not_configured" });
    }
    const email = String((req.body as { email?: unknown })?.email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      return res.status(400).json({ ok: false, error: "invalid_email" });
    }
    const { allowed, cooldownSec } = verifyRateCheck(`email:${email}`);
    if (!allowed) {
      return res.status(429).json({ ok: false, cooldownSec });
    }
    const result = await sendEmailVerificationCode(email);
    if (!result.ok) {
      undoVerifyRateBucket(`email:${email}`);
      if (result.error === "email_channel_not_configured") {
        return res.status(503).json({ ok: false, error: "email_channel_not_configured" });
      }
      return res.status(502).json({ ok: false, error: result.error });
    }
    try {
      const user = getCurrentUser(req);
      if (user) storage.audit("email.code_sent", "user", user.id, { email });
    } catch { /* no session yet during signup flow */ }
    return res.json({ ok: true, cooldownSec: Math.ceil(VERIFY_COOLDOWN_MS / 1000) });
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/email/check-code — verify email code + mark verified
  // -------------------------------------------------------------------------
  app.post("/api/auth/email/check-code", async (req, res) => {
    if (!TWILIO_VERIFY_CONFIGURED) {
      return res.status(503).json({ ok: false, error: "twilio_not_configured" });
    }
    const email = String((req.body as { email?: unknown })?.email ?? "").trim().toLowerCase();
    const code  = String((req.body as { code?: unknown })?.code  ?? "").trim();
    if (!email || !email.includes("@")) return res.status(400).json({ ok: false, error: "invalid_email" });
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: "invalid_code" });

    const result = await checkEmailVerificationCode(email, code);
    if (!result.ok) {
      if (result.error === "email_channel_not_configured") {
        return res.status(503).json({ ok: false, error: "email_channel_not_configured" });
      }
      try {
        const user = getCurrentUser(req);
        if (user) storage.audit("email.code_failed", "user", user.id, { email });
      } catch { /* ok */ }
      return res.status(401).json({ ok: false, verified: false, error: result.error });
    }
    try {
      const user = getCurrentUser(req);
      if (user) {
        // Bind verification to the account's OWN email: proving control of some
        // other address must not mark this account's email verified
        // (markEmailVerified ignores which email was checked).
        if ((user.email || "").toLowerCase() !== email) {
          storage.audit("email.verify_mismatch", "user", user.id, { email, accountEmail: user.email });
          return res.status(403).json({ ok: false, error: "email_mismatch" });
        }
        storage.markEmailVerified(user.id);
        storage.audit("email.verified", "user", user.id, { email });
      }
    } catch { /* session may not exist during signup */ }
    return res.json({ ok: true, verified: true });
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
