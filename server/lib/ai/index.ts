// AI engine for DispatchOS — central export point.
//
// Pure-function decision support for the existing dispatch-board / suggestions
// flow. The core scoreLoadForClient lives in server/routes.ts and is owned by
// the Phase 1 codebase. The modules here ENRICH that scorer's inputs:
//   • fuel.ts   → real diesel prices by state (replaces static client.fuelPrice)
//   • fmcsa.ts  → FMCSA verdict on broker (feeds load.brokerScore + .fraudRisk)
//   • lanes.ts  → lane benchmark PPM + dynamic market quality
//   • brokers.ts → internal performance history + combined trust score
//
// Import from this index, never the individual files.

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
  marketQualityFor,
} from "./lanes";
export type { Region, LaneQuery, LaneQuote, OfferClassification } from "./lanes";

// Load enrichment (drop-in for ingest path)
export {
  enrichLoadSync,
  enrichLoadAsync,
} from "./enrich";
export type { EnrichOptions, EnrichResult } from "./enrich";

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
