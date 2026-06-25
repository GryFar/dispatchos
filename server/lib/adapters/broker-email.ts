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
import { geocodeCityState } from "../geo-coords";
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

// Pull the domain out of a From header. Handles a bare address
// ("loadoffers@rxo.com") and the display-name form ('"RXO" <loadoffers@rxo.com>'):
// prefer the address inside the LAST angle-bracket pair, else the whole string,
// then take the part after the final '@'. Returns "" when no '@' is present.
function fromDomain(from: string): string {
  let addr = from.trim();
  const lt = addr.lastIndexOf("<");
  const gt = addr.lastIndexOf(">");
  if (lt !== -1 && gt > lt) addr = addr.slice(lt + 1, gt).trim();
  const at = addr.lastIndexOf("@");
  if (at === -1) return "";
  return addr.slice(at + 1).trim().toLowerCase();
}

function senderMatches(from: string, domains: string[]): boolean {
  if (domains.length === 0) return true;
  // Compare against the address domain with exact-or-subdomain matching, not a
  // raw substring of the whole header. An unanchored includes() would treat
  // "dispatch@rxo.com.attacker.example", a display name '"RXO rxo.com" <x@evil.com>',
  // or any address merely CONTAINING the domain (e.g. notecho.com vs echo.com)
  // as a legitimate broker, letting a spoofed sender inject trusted-looking loads.
  const addrDomain = fromDomain(from);
  if (!addrDomain) return false;
  return domains.some((d) => {
    const dom = d.toLowerCase().trim();
    return addrDomain === dom || addrDomain.endsWith("." + dom);
  });
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
      // Operator JSON config is unvalidated: a string ('1440') or any
      // non-number makes the multiplication NaN, so `cutoff` is NaN and the
      // `< cutoff` per-row guard (x < NaN === false) never skips anything —
      // every email in the scan passes regardless of age. A negative value
      // would push the cutoff into the future and skip everything. Coerce and
      // fall back to the 24h default unless we have a finite, positive number.
      const lm = Number(cfg.lookbackMinutes);
      const lookbackMin = Number.isFinite(lm) && lm > 0 ? lm : 1440;
      const cutoff = Date.now() - lookbackMin * 60_000;
      const inbox = cfg.inboundAddress?.toLowerCase();
      const domains = [...opts.senderDomains, ...(cfg.senderDomains ?? [])];
      const cap = Math.min(limit ?? 200, 500);

      const rows = storage.listEmailIngest(cap);
      const out: RawLoad[] = [];
      for (const r of rows) {
        // Skip rows whose timestamp can't be parsed: an unparseable createdAt
        // yields NaN, and `NaN < cutoff` is false, which would otherwise let a
        // bad-timestamp row slip past the age window.
        const createdMs = new Date(r.createdAt).getTime();
        if (!Number.isFinite(createdMs) || createdMs < cutoff) continue;
        // storage.listEmailIngest already JSON-parses the stored payload and
        // SPREADS its fields (from/to/subject/body) onto the row alongside
        // id/createdAt — so the row itself IS the email payload. The previous
        // code re-read r.payload, which no longer exists after that spread, so
        // `payload` was always undefined and EVERY email was silently dropped
        // (the email source ingested nothing). Use the row directly.
        const payload = r as unknown as Record<string, unknown>;
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

      // Geocode city/state offline so the scorer can compute a real deadhead.
      // Without this the load carried lat/lng=0,0 and ranked as nonsense.
      const og = geocodeCityState(parsed.origin?.city, parsed.origin?.state);
      const dg = geocodeCityState(parsed.destination?.city, parsed.destination?.state);
      return {
        sourceId: row.id,
        // Prefer the email's stable Message-ID (or broker reference) over the
        // per-row ingestId so the downstream load dedup (loads_source_external_uq)
        // keys on the stable message identity — a re-ingest of the same email
        // under a new ingestId then maps back to the same load instead of a dup.
        sourceExternalId: String(raw.messageId ?? parsed.reference ?? raw.ingestId ?? ""),
        clientId: row.clientId,
        source: opts.source,
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

// Generic email source for ANY broker not covered by a named adapter above.
// Ships with no sender domains, so the carrier MUST scope it via config —
// inboundAddress (a unique forwarding sub-address) and/or senderDomains — which
// the shared authenticate() guard enforces. Reuses the same generic parser +
// offline geocoding, so a carrier whose broker isn't one of the five named ones
// can still ingest load-offer emails.
export const genericEmailAdapter = makeBrokerEmailAdapter({
  key: "email_generic",
  label: "Generic broker email (set inboundAddress / sender domains)",
  source: "email_generic",
  senderDomains: [],
  defaultEquipment: "open_car_hauler",
});

export const brokerEmailAdapters: BoardAdapter[] = [
  rxoEmailAdapter,
  tqlEmailAdapter,
  coyoteEmailAdapter,
  echoEmailAdapter,
  landstarEmailAdapter,
  genericEmailAdapter,
];
