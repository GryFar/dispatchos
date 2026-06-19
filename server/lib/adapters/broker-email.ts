// Broker email-forwarding adapters (RXO, TQL, Coyote, Echo, Landstar).
//
// These brokers email load offers to the carrier; the carrier forwards them
// into our inbound mailbox (CF Email Worker -> POST /api/inbound/email writes
// the raw email to email_ingest). A load_sources row subscribes to a specific
// inbound sub-address and/or the broker's sender domains, then we parse every
// matching email with the generic broker-email parser.
//
// One factory powers all five — they differ only in key/label, which sender
// domains identify them, and a default equipment bucket. Pure: no DB writes,
// no Telegram; the cron poller persists results.

import { storage } from "../../storage";
import { parseBrokerEmail } from "../parsers/broker-email";
import type { Equipment } from "../../../shared/schema";
import type {
  AdapterKey,
  BoardAdapter,
  LoadSourceRow,
  NormalizedLoad,
  RawLoad,
} from "./types";

interface BrokerEmailConfig {
  // Sub-addressed mailbox this source listens on, e.g. "loads+ivan@dispatchos.co".
  inboundAddress?: string;
  // Extra sender domains to accept beyond the broker defaults (operator escape
  // hatch when a broker sends from an unexpected domain).
  senderDomains?: string[];
  lookbackMinutes?: number; // default 1440 (24h)
}

function senderMatches(from: string, domains: string[]): boolean {
  if (domains.length === 0) return true;
  const low = from.toLowerCase();
  return domains.some((d) => low.includes(d.toLowerCase()));
}

export function makeBrokerEmailAdapter(opts: {
  key: AdapterKey;
  label: string;
  source: string; // value written to loads.source (legacy human field)
  senderDomains: string[];
  defaultEquipment: Equipment;
}): BoardAdapter {
  return {
    key: opts.key,
    label: opts.label,
    requiresCredentials: false,

    async authenticate(row: LoadSourceRow) {
      const cfg = row.configJson as BrokerEmailConfig;
      // Need at least one way to scope which emails belong to this source,
      // otherwise it would ingest every broker's mail from the shared store.
      if (!cfg.inboundAddress && opts.senderDomains.length === 0 && !cfg.senderDomains?.length) {
        throw new Error(
          "config.inboundAddress is required (e.g. loads+ivan@dispatchos.co)",
        );
      }
    },

    async fetchLoads(row: LoadSourceRow, limit?: number): Promise<RawLoad[]> {
      const cfg = row.configJson as BrokerEmailConfig;
      const lookback = (cfg.lookbackMinutes ?? 1440) * 60_000;
      const cutoff = Date.now() - lookback;
      const inbox = cfg.inboundAddress?.toLowerCase();
      const domains = [...opts.senderDomains, ...(cfg.senderDomains ?? [])];
      const cap = Math.min(limit ?? 200, 500);

      const rows = storage.listEmailIngest(cap);
      const out: RawLoad[] = [];
      for (const r of rows) {
        if (new Date(r.createdAt).getTime() < cutoff) continue;
        // Parse once, guarded: a single corrupted email_ingest.payload must not
        // abort the whole ingest pass (it would drop every load from this source).
        let payload: Record<string, unknown>;
        try {
          payload = typeof r.payload === "string" ? JSON.parse(r.payload) : (r.payload as Record<string, unknown>);
        } catch {
          continue;
        }
        // Scope to this source's mailbox sub-address (if set) AND to the
        // broker's sender domains (so two broker sources sharing one mailbox
        // don't steal each other's emails).
        if (inbox) {
          const to = String((payload?.to as string) ?? "").toLowerCase();
          if (!to.includes(inbox)) continue;
        }
        if (!senderMatches(String(payload?.from ?? ""), domains)) continue;
        out.push({ ingestId: r.id, ...payload } as RawLoad);
      }
      return out;
    },

    normalizeToLoad(raw: RawLoad, row: LoadSourceRow): NormalizedLoad {
      const parsed = parseBrokerEmail({
        from: String(raw.from ?? ""),
        subject: String(raw.subject ?? ""),
        body: String(raw.body ?? ""),
      });

      return {
        sourceId: row.id,
        sourceExternalId: String(raw.ingestId ?? raw.messageId ?? parsed.reference ?? ""),
        clientId: row.clientId,
        source: opts.source,
        originCity: parsed.origin?.city ?? "",
        originState: parsed.origin?.state ?? "",
        originLat: 0,
        originLng: 0,
        destinationCity: parsed.destination?.city ?? "",
        destinationState: parsed.destination?.state ?? "",
        destinationLat: 0,
        destinationLng: 0,
        rate: parsed.rate ?? 0,
        loadedMiles: parsed.miles ?? 0,
        pickupAt: parsed.pickupAt ?? "",
        deliveryAt: parsed.deliveryAt ?? "",
        equipment: parsed.equipment ?? opts.defaultEquipment,
        brokerName: parsed.broker?.name ?? opts.label,
        brokerMc: parsed.broker?.mcNumber ?? "",
        weightLbs: parsed.weightLbs,
        pieces: parsed.pieces,
        reference: parsed.reference,
      };
    },
  };
}

// Concrete broker adapters. Sender domains are the publicly-known broker
// domains; operators can add more via config.senderDomains. Default equipment
// is the bucket most of that broker's car-hauler freight falls into when the
// email omits an explicit equipment line.
export const rxoEmailAdapter = makeBrokerEmailAdapter({
  key: "rxo_email",
  label: "RXO",
  source: "rxo_email",
  senderDomains: ["rxo.com"],
  defaultEquipment: "open_car_hauler",
});

export const tqlEmailAdapter = makeBrokerEmailAdapter({
  key: "tql_email",
  label: "TQL",
  source: "tql_email",
  senderDomains: ["tql.com", "totalquality.com"],
  defaultEquipment: "open_car_hauler",
});

export const coyoteEmailAdapter = makeBrokerEmailAdapter({
  key: "coyote_email",
  label: "Coyote Logistics",
  source: "coyote_email",
  senderDomains: ["coyote.com"],
  defaultEquipment: "open_car_hauler",
});

export const echoEmailAdapter = makeBrokerEmailAdapter({
  key: "echo_email",
  label: "Echo Global",
  source: "echo_email",
  senderDomains: ["echo.com"],
  defaultEquipment: "open_car_hauler",
});

export const landstarEmailAdapter = makeBrokerEmailAdapter({
  key: "landstar_email",
  label: "Landstar agent",
  source: "landstar_email",
  senderDomains: ["landstar.com", "landstarmail.com"],
  defaultEquipment: "open_car_hauler",
});

export const brokerEmailAdapters: BoardAdapter[] = [
  rxoEmailAdapter,
  tqlEmailAdapter,
  coyoteEmailAdapter,
  echoEmailAdapter,
  landstarEmailAdapter,
];
