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
  // Extra sender domains to accept beyond the Sylectus defaults (operator
  // escape hatch when postings arrive from an unexpected/forwarded domain).
  senderDomains?: string[];
  lookbackMinutes?: number; // default 1440 (24h)
}

// Publicly-known Sylectus sender domains. A shared inbound mailbox can receive
// other brokers' offers, spam, and personal mail; without sender scoping this
// adapter would parse and persist all of it as Sylectus loads. Operators can
// add more via config.senderDomains.
const SYLECTUS_SENDER_DOMAINS = ["sylectus.com", "sylectus.net"];

function senderMatches(from: string, domains: string[]): boolean {
  if (domains.length === 0) return true;
  const low = from.toLowerCase();
  return domains.some((d) => low.includes(d.toLowerCase()));
}

// Carriers also FORWARD Sylectus postings from their own address (see module
// header), so the From header may not be a Sylectus domain. In that case the
// Sylectus footer/markers survive in the body. Treat a body marker as a valid
// Sylectus signal so legitimate forwards aren't dropped by sender scoping.
function bodyLooksSylectus(from: string, subject: string, body: string): boolean {
  // Bound the scan so a huge body can't cost more than a fixed window.
  const hay = `${from}\n${subject}\n${body.slice(0, 32_768)}`.toLowerCase();
  return hay.includes("sylectus");
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
    const domains = [...SYLECTUS_SENDER_DOMAINS, ...(cfg.senderDomains ?? [])];
    const cap = Math.min(limit ?? 200, 500);

    const rows = storage.listEmailIngest(cap);
    const out: RawLoad[] = [];
    for (const r of rows) {
      if (new Date(r.createdAt).getTime() < cutoff) continue;
      // listEmailIngest already parses + spreads the email fields onto the row,
      // so the row IS the payload. The old r.payload re-read was always
      // undefined post-spread → every email was silently dropped.
      const payload = r as unknown as Record<string, unknown>;
      // Scope to this source's mailbox sub-address (if set) so two sources
      // sharing one mailbox don't steal each other's emails.
      if (inbox) {
        const to = String((payload?.to as string) ?? "").toLowerCase();
        if (!to.includes(inbox)) continue;
      }
      // Scope to Sylectus so other brokers' offers, spam, and personal mail in
      // a shared mailbox aren't ingested + mis-labeled as Sylectus loads. We
      // accept either a Sylectus sender domain OR a Sylectus marker in the body
      // (carriers forward postings from their own address — see module header).
      const from = String(payload?.from ?? "");
      const subject = String(payload?.subject ?? "");
      const body = String(payload?.body ?? "");
      if (!senderMatches(from, domains) && !bodyLooksSylectus(from, subject, body)) {
        continue;
      }
      // Final gate: the parser flags whether this actually looks like a
      // Sylectus posting (markers or both endpoints + rate/miles). Drop rows
      // that don't so foreign mail that merely passed sender scoping isn't
      // persisted as a load.
      const parsed = parseSylectusEmail({ from, subject, body });
      if (!parsed.matched) continue;
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
