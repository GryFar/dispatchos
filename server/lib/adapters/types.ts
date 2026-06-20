// BoardAdapter contract — load source polling.
//
// Every external "place loads come from" (DAT, Sylectus, SuperDispatch,
// individual broker email blasts) implements this. The cron poller calls
// authenticate() → fetchLoads() → normalizeToLoad() per source row.
//
// Adapters MUST be pure: no DB writes, no Telegram calls. The poller in
// server/routes/cron.ts is the only thing that persists results.

import type { Equipment } from "../../../shared/schema";

export interface LoadSourceRow {
  id: string;
  clientId: string;
  adapterKey: AdapterKey;
  label: string;
  status: LoadSourceStatus;
  configJson: Record<string, unknown>;
  // Only resolved at runtime when we actually need to call the broker. UI
  // never gets it — see /api/admin/load-sources output redaction.
  credentialsPlaintext?: Record<string, string>;
  pollIntervalMin: number;
}

export type LoadSourceStatus =
  | "active"
  | "paused"
  | "error"
  | "needs_credentials";

export type AdapterKey =
  | "mock"
  | "sylectus_email"
  | "super_dispatch"
  | "one23_loadboard"
  | "dat_scraper"
  | "rxo_email"
  | "tql_email"
  | "chr_navisphere"
  | "coyote_email"
  | "echo_email"
  | "landstar_email"
  | "email_generic";

/** Raw item returned by fetchLoads(); shape is adapter-specific. */
export type RawLoad = Record<string, unknown>;

/** Normalized load suitable for storage.upsertLoad(). */
export interface NormalizedLoad {
  sourceId: string;          // load_sources.id
  sourceExternalId: string;  // unique-per-source id from upstream; dedup key
  clientId: string;          // load_sources.client_id
  source: string;            // human-readable for loads.source legacy field
  originCity: string;
  originState: string;
  originLat: number;
  originLng: number;
  destinationCity: string;
  destinationState: string;
  destinationLat: number;
  destinationLng: number;
  rate: number;
  loadedMiles: number;
  pickupAt: string;
  deliveryAt: string;
  equipment: Equipment;
  brokerName: string;
  brokerMc: string;
  brokerScore?: number;
  fraudRisk?: number;
  marketQuality?: number;
  notes?: string;
  // Pass-through extras some adapters surface; the poller ignores them on
  // upsert but the audit trail keeps the raw payload.
  weightLbs?: number;
  pieces?: number;
  reference?: string;
}

export interface BoardAdapter {
  key: AdapterKey;
  label: string;
  /** Does this adapter need credentials_enc populated to run? */
  requiresCredentials: boolean;
  /** Validate config + credentials. Throws on failure. */
  authenticate(row: LoadSourceRow): Promise<void>;
  /**
   * Pull current postings from the source.
   * @param limit optional cap, used by "Test" button to fetch 1 item.
   */
  fetchLoads(row: LoadSourceRow, limit?: number): Promise<RawLoad[]>;
  /** Map raw to our schema; called once per fetched item. */
  normalizeToLoad(raw: RawLoad, row: LoadSourceRow): NormalizedLoad;
}
