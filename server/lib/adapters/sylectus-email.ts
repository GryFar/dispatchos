// Sylectus email adapter — pulls from our own email_ingest table.
// Existing pipeline (CF Email Worker -> POST /api/inbound/email) writes raw
// emails to email_ingest. This adapter "subscribes" a load_sources row to a
// specific to-address (loads+ivan@dispatchos.co), so multiple drivers can
// forward into one mailbox without leakage.

import { storage } from "../../storage";
import { parseSylectusEmail } from "../parsers/sylectus";
import { geocodeCityState } from "../geo-coords";
import { mapEquipment } from "../parsers/broker-email";
import type {
  BoardAdapter,
  LoadSourceRow,
  NormalizedLoad,
  RawLoad,
} from "./types";

interface SylectusConfig {
  inboundAddress?: string; // e.g. "loads+ivan@dispatchos.co"
  lookbackMinutes?: number; // default 1440 (24h)
}

export const sylectusEmailAdapter: BoardAdapter = {
  key: "sylectus_email",
  label: "Sylectus (email forwarding)",
  requiresCredentials: false,

  async authenticate(row: LoadSourceRow) {
    const cfg = row.configJson as SylectusConfig;
    if (!cfg.inboundAddress) {
      throw new Error("config.inboundAddress is required (e.g. loads+ivan@dispatchos.co)");
    }
  },

  async fetchLoads(row: LoadSourceRow, limit?: number): Promise<RawLoad[]> {
    const cfg = row.configJson as SylectusConfig;
    const lookback = (cfg.lookbackMinutes ?? 1440) * 60_000;
    const cutoff = Date.now() - lookback;
    const inbox = cfg.inboundAddress?.toLowerCase();
    const cap = Math.min(limit ?? 200, 500);

    const rows = storage.listEmailIngest(cap);
    const out: RawLoad[] = [];
    for (const r of rows) {
      if (new Date(r.createdAt).getTime() < cutoff) continue;
      // listEmailIngest already parses + spreads the email fields onto the row,
      // so the row IS the payload. The old r.payload re-read was always
      // undefined post-spread → every email was silently dropped.
      const payload = r as unknown as Record<string, unknown>;
      if (inbox) {
        const to = String((payload?.to as string) ?? "").toLowerCase();
        if (!to.includes(inbox)) continue;
      }
      out.push({ ingestId: r.id, ...payload } as RawLoad);
    }
    return out;
  },

  normalizeToLoad(raw: RawLoad, row: LoadSourceRow): NormalizedLoad {
    const parsed = parseSylectusEmail({
      from: String(raw.from ?? ""),
      subject: String(raw.subject ?? ""),
      body: String(raw.body ?? ""),
    });

    const og = geocodeCityState(parsed.origin?.city, parsed.origin?.state);
    const dg = geocodeCityState(parsed.destination?.city, parsed.destination?.state);
    return {
      sourceId: row.id,
      sourceExternalId: String(raw.ingestId ?? raw.messageId ?? Date.now()),
      clientId: row.clientId,
      source: "sylectus_email",
      originCity: parsed.origin?.city ?? "",
      originState: parsed.origin?.state ?? "",
      originLat: og?.lat ?? 0,
      originLng: og?.lng ?? 0,
      destinationCity: parsed.destination?.city ?? "",
      destinationState: parsed.destination?.state ?? "",
      destinationLat: dg?.lat ?? 0,
      destinationLng: dg?.lng ?? 0,
      rate: parsed.rate ?? 0,
      loadedMiles: parsed.miles ?? 0,
      pickupAt: parsed.pickupAt ?? "",
      deliveryAt: "",
      equipment: mapEquipment(parsed.equipment) ?? "sprinter_van",
      brokerName: parsed.broker?.name ?? "",
      brokerMc: parsed.broker?.mcNumber ?? "",
      weightLbs: parsed.weightLbs,
      pieces: parsed.pieces,
      reference: parsed.reference,
    };
  },
};
