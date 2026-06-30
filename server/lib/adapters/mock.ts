// Deterministic mock adapter — generates fake loads on a configured lane.
// Used to validate the polling pipeline end-to-end without a real broker
// account. Same deterministic seed → same load list (good for testing).

import crypto from "node:crypto";
import type {
  BoardAdapter,
  LoadSourceRow,
  NormalizedLoad,
  RawLoad,
} from "./types";

interface MockConfig {
  mockSeed?: string;
  lane?: { originState?: string; destinationState?: string };
  ratePpmRange?: [number, number];
  count?: number;
}

const STATE_CITIES: Record<string, { city: string; lat: number; lng: number }> = {
  GA: { city: "Atlanta", lat: 33.749, lng: -84.388 },
  FL: { city: "Miami", lat: 25.761, lng: -80.191 },
  TX: { city: "Dallas", lat: 32.776, lng: -96.797 },
  CA: { city: "Los Angeles", lat: 34.052, lng: -118.243 },
  IL: { city: "Chicago", lat: 41.878, lng: -87.629 },
  AZ: { city: "Phoenix", lat: 33.448, lng: -112.074 },
};

function pickCity(state: string) {
  return STATE_CITIES[state.toUpperCase()] ?? STATE_CITIES.GA;
}

function seedRng(seed: string): () => number {
  let h = crypto.createHash("sha256").update(seed).digest();
  let i = 0;
  return () => {
    if (i + 4 > h.length) {
      h = crypto.createHash("sha256").update(h).digest();
      i = 0;
    }
    // Divide by 2^32 (not 2^32-1) so the result is uniform on the half-open
    // [0, 1) range. readUInt32BE returns the inclusive [0, 2^32-1] range, so
    // dividing by 0xffffffff would let rng() return exactly 1.0.
    const n = h.readUInt32BE(i) / 0x100000000;
    i += 4;
    return n;
  };
}

export const mockAdapter: BoardAdapter = {
  key: "mock",
  label: "Mock (development only)",
  requiresCredentials: false,

  async authenticate(_row: LoadSourceRow) {
    // No-op — mock has no upstream to talk to.
  },

  async fetchLoads(row: LoadSourceRow, limit?: number): Promise<RawLoad[]> {
    const cfg = (row.configJson as MockConfig) ?? {};
    const seed = cfg.mockSeed ?? row.id;
    const rng = seedRng(seed);
    const originState = cfg.lane?.originState ?? "GA";
    const destState = cfg.lane?.destinationState ?? "FL";
    const [minPpm, maxPpm] = cfg.ratePpmRange ?? [2.0, 3.5];
    const wantCount = Math.min(limit ?? cfg.count ?? 5, 50);

    const result: RawLoad[] = [];
    for (let i = 0; i < wantCount; i++) {
      const miles = Math.floor(400 + rng() * 1200);
      const ppm = minPpm + rng() * (maxPpm - minPpm);
      const rate = Math.round(miles * ppm);
      result.push({
        externalId: `mock-${seed}-${i}`,
        originState,
        destState,
        miles,
        rate,
        pickupAt: new Date(Date.now() + (i + 1) * 3600_000).toISOString(),
        deliveryAt: new Date(Date.now() + (i + 1) * 3600_000 + miles * 60_000).toISOString(),
        brokerName: `MockBroker-${Math.floor(rng() * 10)}`,
        brokerMc: String(100000 + Math.floor(rng() * 900000)),
      });
    }
    return result;
  },

  normalizeToLoad(raw: RawLoad, row: LoadSourceRow): NormalizedLoad {
    const o = pickCity(String(raw.originState));
    const d = pickCity(String(raw.destState));
    return {
      sourceId: row.id,
      sourceExternalId: String(raw.externalId),
      clientId: row.clientId,
      source: "mock",
      originCity: o.city,
      originState: String(raw.originState).toUpperCase(),
      originLat: o.lat,
      originLng: o.lng,
      destinationCity: d.city,
      destinationState: String(raw.destState).toUpperCase(),
      destinationLat: d.lat,
      destinationLng: d.lng,
      rate: Number(raw.rate),
      loadedMiles: Number(raw.miles),
      pickupAt: String(raw.pickupAt),
      deliveryAt: String(raw.deliveryAt),
      equipment: "sprinter_van",
      brokerName: String(raw.brokerName),
      brokerMc: String(raw.brokerMc),
    };
  },
};
