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
import { parseBrokerEmail, type BrokerEmailParsed } from "../parsers/broker-email";
import { parseBrokerEmailWithAi } from "../parsers/broker-email-ai";
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
          "Provide config.inboundAddress (e.g. loads+ivan@dispatchos.co) and/or config.senderDomains so emails can be scoped to this source",
        );
      }
    },

    async fetchLoads(row: LoadSourceRow, limit?: number): Promise<RawLoad[]> {
      const cfg = row.configJson as BrokerEmailConfig;
      // Operator JSON config is unvalidated: a string ('1440') or any
      // non-number makes the multiplication NaN, so `cutoff` is NaN and
      // new Date(NaN).toISOString() below would throw, failing the poll. A
      // negative value would push the cutoff into the future and skip
      // everything. Coerce and fall back to the 24h default unless we have a
      // finite, positive number.
      const lm = Number(cfg.lookbackMinutes);
      const lookbackMin = Number.isFinite(lm) && lm > 0 ? lm : 1440;
      const cutoff = Date.now() - lookbackMin * 60_000;
      const inbox = cfg.inboundAddress?.toLowerCase();
      const domains = [...opts.senderDomains, ...(cfg.senderDomains ?? [])];
      // `limit` caps MATCHED offers for explicit callers (source test = 1);
      // the cron poller passes none and gets everything in the window.
      const cap = limit !== undefined ? Math.min(limit, 500) : Infinity;
      // The cron poller (no limit) enriches each offer with the AI-assisted
      // parse so wild formats (HTML tables, forward chains) still yield a load.
      // The admin "test source" probe (limit set) stays regex-only, so a single
      // click can never trigger a paid model call.
      const useAi = limit === undefined;

      // Window-COMPLETE fetch: the per-source filters below run in memory, so
      // the DB scan must cover the whole lookback window. The old code fed a
      // global newest-200 listEmailIngest() page into these filters — >200
      // unrelated emails per poll evicted another source's in-window offers
      // permanently (rows only get older; purged at 180d unprocessed).
      const rows = storage.listEmailIngestInWindow(new Date(cutoff).toISOString());
      const out: RawLoad[] = [];
      for (const r of rows) {
        // storage.listEmailIngestInWindow (like listEmailIngest) JSON-parses
        // the stored payload and SPREADS its fields (from/to/subject/body)
        // onto the row alongside id/createdAt — so the row itself IS the email
        // payload. Earlier code re-read r.payload, which no longer exists
        // after that spread, so `payload` was always undefined and EVERY email
        // was silently dropped (the email source ingested nothing).
        const payload = r as unknown as Record<string, unknown>;
        // Scope to this source's mailbox sub-address (if set) AND to the
        // broker's sender domains (so two broker sources sharing one mailbox
        // don't steal each other's emails).
        if (inbox) {
          const to = String((payload?.to as string) ?? "").toLowerCase();
          if (!to.includes(inbox)) continue;
        }
        if (!senderMatches(String(payload?.from ?? ""), domains)) continue;

        // Parse ONCE here (regex + optional AI fallback) so we can (1) drop
        // genuinely unparseable mail before the poller turns it into an empty
        // $0 "load" the scorer silently discards, and (2) hand the finished
        // parse to normalizeToLoad, which is sync and cannot await the AI path.
        const parsed: BrokerEmailParsed = useAi
          ? await parseBrokerEmailWithAi({
              from: String(payload.from ?? ""),
              subject: String(payload.subject ?? ""),
              body: String(payload.body ?? ""),
            })
          : parseBrokerEmail({
              from: String(payload.from ?? ""),
              subject: String(payload.subject ?? ""),
              body: String(payload.body ?? ""),
            });
        // fix(a): a mail with no usable origin/dest (+ no rate or miles) is not
        // a real offer; skip it so it never becomes an empty $0 load. It remains
        // in email_ingest for the admin inbox.
        if (!parsed.matched) continue;

        out.push({ ingestId: r.id, ...payload, __parsed: parsed } as RawLoad);
      }
      // The window scan is oldest-first, so a plain head-slice would hand
      // limited callers the STALEST matches — the admin "test source" probe
      // (limit=1) must show the latest offer. Cap by keeping the newest.
      return out.length > cap ? out.slice(out.length - cap) : out;
    },

    normalizeToLoad(raw: RawLoad, row: LoadSourceRow): NormalizedLoad {
      // Prefer the parse fetchLoads already computed — it may carry AI-assisted
      // fields this sync re-parse could not recover. Fall back to a fresh regex
      // parse for any caller that builds a raw without going through fetchLoads
      // (e.g. unit tests).
      const parsed =
        (raw as { __parsed?: BrokerEmailParsed }).__parsed ??
        parseBrokerEmail({
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
        // Use `||` (not `??`) so an EMPTY messageId/reference falls through to
        // the stable per-row ingestId. The CF worker always forwards messageId as
        // a string — "" when the Message-ID header is absent — so `??` (which only
        // skips null/undefined) would lock sourceExternalId to "" and collapse
        // every header-less, reference-less email onto a SINGLE load row in
        // upsertLoadFromSource. ingestId (= email_ingest row id) is always a
        // stable, non-empty, per-email string, so it backstops correctly.
        sourceExternalId: String(raw.messageId || parsed.reference || raw.ingestId || ""),
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
