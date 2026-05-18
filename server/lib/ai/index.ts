// AI engine for DispatchOS — central export point.
//
// All AI-driven decision logic lives under `server/lib/ai/`. The route layer
// imports from this module (not individual files) so we can refactor internals
// without breaking consumers.

// Load scoring — the core ranking engine
export {
  scoreLoadForClient,
  rankLoadsForClient,
  computeEconomics,
  computeFeasibility,
  computeDispatchScore,
  haversineMiles,
} from "./scoring";
export type { ScoreLoadInput, RankOptions } from "./scoring";

// Fuel pricing
export {
  getDieselPrice,
  getDieselPrices,
  getRouteFuelPrice,
  refreshFromEia,
  clearFuelCache,
} from "./fuel";
export type { FuelPriceResult, FuelLookupOptions, Padd } from "./fuel";

// FMCSA broker verification
export {
  evaluateBroker,
  normalizeMcNumber,
  mcNumberDigits,
  fetchByMc,
  parseMobileApiResponse,
  fmcsaCarrierSchema,
} from "./fmcsa";
export type { FmcsaCarrier, FmcsaVerdict } from "./fmcsa";

// Lane intelligence
export {
  regionFor,
  quoteLane,
  classifyOffer,
} from "./lanes";
export type { Region, LaneQuery, LaneQuote, OfferClassification } from "./lanes";

// Broker history & combined trust
export {
  buildHistory,
  combineVerdicts,
  brokerEventSchema,
  brokerHistorySchema,
  brokerEventTypeSchema,
} from "./brokers";
export type {
  BrokerEvent,
  BrokerHistory,
  BrokerEventType,
  CombinedBrokerVerdict,
} from "./brokers";
