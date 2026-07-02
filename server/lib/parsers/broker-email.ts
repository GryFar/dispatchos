// Generic broker rate-con / load-offer email parser.
//
// Brokers that email load offers (RXO, TQL, Coyote, Echo, Landstar, plus the
// Sylectus board) share a common shape: a subject line that names the lane and
// often the rate, and a body of "Field: value" lines — either plain text or a
// simple HTML table. This parser pulls the structured load fields out of that
// shape so every email-forwarding adapter can normalize without per-broker code.
//
// It mirrors the proven extraction in parsers/sylectus.ts but is broker-agnostic
// and adds raw-equipment-label -> Equipment enum mapping (the piece the older
// adapter cast away with `as never`). The first real forwarded email from a new
// broker may need an extra field alias (see `get(...)` below) or a sender-domain
// entry in the adapter — both are one-line additions. Until then the generic
// "Field: value" + subject-lane shape already covers the common rate-con layout.
//
// Pure: no DB, no network. Callers persist.

import type { Equipment } from "../../../shared/schema";

export interface BrokerEmailParsed {
  matched: boolean; // true when we extracted both endpoints + (rate or miles)
  origin?: { city: string; state: string; zip?: string };
  destination?: { city: string; state: string; zip?: string };
  miles?: number;
  rate?: number; // USD, integer
  weightLbs?: number;
  pieces?: number;
  equipment?: Equipment; // mapped to our enum
  equipmentRaw?: string; // label as it appeared in the email
  pickupAt?: string; // ISO if parseable, otherwise raw
  deliveryAt?: string; // ISO if parseable, otherwise raw
  postedAt?: string;
  broker?: { name?: string; mcNumber?: string; phone?: string; email?: string };
  reference?: string; // broker load reference
  rawFields: Record<string, string>; // every field: value we extracted
}

const FIELD_LINE = /^\s*([A-Za-z][A-Za-z \\/.#-]{1,30}?)\s*[:#-]\s*(.+?)\s*$/;

// A real field label: starts with a letter and stays within FIELD_LINE's label
// class and length cap. Used to reject prose/URL/time lines (e.g. "http", "12")
// that merely happen to contain a colon, which would otherwise mint a spurious
// field and — with first-occurrence-wins — shadow a genuine later value.
const LABEL = /^\s*[A-Za-z][A-Za-z \\/.#-]{0,30}\s*$/;

// Split a body line into [label, value]. Prefer the first colon (the dominant
// separator) so labels that themselves contain '#' or '-' — e.g. "Load #" —
// aren't mis-split; fall back to FIELD_LINE for '-'/'#'-delimited lines.
function splitField(line: string): [string, string] | null {
  const colon = line.indexOf(":");
  if (colon > 0) {
    const label = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();
    if (value && LABEL.test(label)) return [label, value];
  }
  const m = line.match(FIELD_LINE);
  return m ? [m[1], m[2].trim()] : null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?(tr|td|th|p|div|li|br)[^>]*>/gi, "\n")
    .replace(/<[^<>]{0,2000}>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\r/g, "");
}

// Collapse HTML table rows into "label: value" lines before the generic tag
// strip, so a <tr><td>Label</td><td>Value</td></tr> layout (common in broker
// HTML emails) becomes a single field line the body walker can read. Without
// this, stripHtml drops each cell onto its own line and the pairing is lost.
function htmlTableToLines(html: string): string {
  return html.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_m, rowInner: string) => {
    const cells = Array.from(rowInner.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi))
      .map((c) =>
        c[1]
          .replace(/<[^<>]{0,2000}>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .trim(),
      )
      .filter(Boolean);
    if (cells.length >= 2) return `\n${cells[0]}: ${cells.slice(1).join(" ")}\n`;
    if (cells.length === 1) return `\n${cells[0]}\n`;
    return "\n";
  });
}

function bodyToText(raw: string): string {
  // ReDoS guard: inbound email bodies are attacker-controllable and the
  // strip/parse runs synchronously on the event loop, so cap before any regex.
  let s = raw.length > 65_536 ? raw.slice(0, 65_536) : raw;
  if (/<tr[\s>]/i.test(s)) s = htmlTableToLines(s);
  if (/<[a-z][\s\S]*>/i.test(s)) s = stripHtml(s);
  return s;
}

function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseCityState(value: string): { city: string; state: string; zip?: string } | undefined {
  // "Atlanta, GA" | "Atlanta, GA 30303" | "Atlanta GA 30303"
  if (value.length > 80) return undefined; // ReDoS guard: city/state lines are short
  const m = value.match(/^\s*([A-Za-z][A-Za-z.'-]{0,38}(?: [A-Za-z.'-]+){0,5})[,\s]+([A-Z]{2})(?:\s+(\d{5}))?\s*$/);
  if (!m) return undefined;
  return { city: m[1].trim(), state: m[2].toUpperCase(), zip: m[3] };
}

function parseMoney(value: string): number | undefined {
  // "$1,850" | "1850" | "USD 1,850.00" | "$2,400 all-in"
  const m = value.match(/\$?\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return undefined;
  const n = Math.round(Number(m[1].replace(/,/g, "")));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseInt0(value: string): number | undefined {
  // Used for miles/weight/pieces — all physical quantities where zero or a
  // dash-captured negative is garbage. Match unsigned digits and reject
  // non-positive results, mirroring parseMoney's `n > 0` guard.
  const m = value.match(/\d[\d,]*/);
  if (!m) return undefined;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Like parseDate, but rejects values that don't resolve to a real calendar
// date. Used for the bare 'pickup' field, which the origin parser also reads
// for a LOCATION ("Pickup: Atlanta, GA"): a city string must NOT be stored as
// pickupAt (downstream Date.parse -> NaN would drop/garble the load). Returns
// undefined unless parseDate produced a value Date.parse can read.
function parseDateStrict(value?: string): string | undefined {
  const parsed = parseDate(value);
  if (parsed === undefined) return undefined;
  return Number.isNaN(Date.parse(parsed)) ? undefined : parsed;
}

function parseDate(value?: string): string | undefined {
  if (!value) return undefined;
  const raw = value.trim();
  // Already ISO-ish.
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? raw : d.toISOString();
  }
  // US "MM/DD/YYYY[ HH:MM]" — the common broker format.
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) {
    const [, mm, dd, yyRaw, hh, min] = m;
    const yy = yyRaw.length === 2 ? `20${yyRaw}` : yyRaw;
    const d = new Date(
      Number(yy),
      Number(mm) - 1,
      Number(dd),
      hh ? Number(hh) : 0,
      min ? Number(min) : 0,
    );
    return Number.isNaN(d.getTime()) ? raw : d.toISOString();
  }
  // Keep raw for anything else — callers tolerate non-ISO strings.
  return raw;
}

/**
 * Raw broker equipment label -> our Equipment enum. The product is car-hauler /
 * hotshot focused (enclosed/open haulers, flatbed/hotshot, sprinter van), so we
 * collapse the many free-text labels brokers use into those four buckets.
 * Returns undefined when nothing matches; the adapter supplies a default.
 */
export function mapEquipment(raw?: string): Equipment | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase();
  if (/enclosed/.test(s)) return "enclosed_car_hauler";
  if (/hot\s?shot|flat\s?bed|step\s?deck|gooseneck|\brgn\b|lowboy|\bdeck\b/.test(s)) {
    return "hotshot_flatbed";
  }
  if (/open(\s|-)?(car|auto)?\s?(hauler|carrier|trailer)?|car\s?hauler|auto\s?hauler|\d+\s*car/.test(s)) {
    return "open_car_hauler";
  }
  if (/sprinter|cargo\s?van|\bvan\b|box\s?truck|straight\s?truck/.test(s)) {
    return "sprinter_van";
  }
  return undefined;
}

function parseSubjectLane(subject: string):
  | { origin: { city: string; state: string }; destination: { city: string; state: string }; rate?: number }
  | undefined {
  // "Atlanta, GA to Miami, FL - $1850" | "Atlanta GA -> Miami FL" | "... | ..."
  const m = subject.match(
    /([A-Za-z][A-Za-z .'-]+?)[,\s]+([A-Z]{2})\s*(?:-|–|—|→|->|>|to|\|)\s*([A-Za-z][A-Za-z .'-]+?)[,\s]+([A-Z]{2})/i,
  );
  if (!m) return undefined;
  const rateMatch = subject.match(/\$\s?([\d,]{3,7})(?:\.\d{1,2})?/);
  return {
    origin: { city: m[1].trim(), state: m[2].toUpperCase() },
    destination: { city: m[3].trim(), state: m[4].toUpperCase() },
    rate: rateMatch ? parseMoney(rateMatch[1]) : undefined,
  };
}

export function parseBrokerEmail(input: {
  from?: string;
  subject?: string;
  body?: string;
}): BrokerEmailParsed {
  const subject = input.subject ?? "";
  const bodyText = bodyToText(input.body ?? "");
  const subjectLane = parseSubjectLane(subject);

  // Walk the body line-by-line, collect every "Field: value" pair we see.
  const rawFields: Record<string, string> = {};
  for (const line of bodyText.split(/\n+/)) {
    const split = splitField(line);
    if (!split) continue;
    const key = normalizeKey(split[0]);
    if (!key) continue;
    // First occurrence wins — brokers often echo labels in the footer.
    if (!rawFields[key]) rawFields[key] = split[1];
  }

  const get = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      if (rawFields[k]) return rawFields[k];
    }
    return undefined;
  };

  const originRaw = get("origin", "from", "pickup", "pickupcity", "pickuplocation", "originlocation", "ptp", "shipper");
  const origin = (originRaw && parseCityState(originRaw)) || subjectLane?.origin;

  const destinationRaw = get("destination", "to", "delivery", "consignee", "dropoff", "deliverylocation", "destinationlocation", "dtp");
  const destination = (destinationRaw && parseCityState(destinationRaw)) || subjectLane?.destination;

  const rate =
    parseMoney(get("rate", "amount", "linehaul", "totalrate", "totalpay", "offer", "price", "payout", "allin") ?? "") ??
    subjectLane?.rate;

  const miles = parseInt0(get("miles", "totalmiles", "loadedmiles", "distance", "tripmiles") ?? "");
  const weightLbs = parseInt0(get("weight", "weightlbs", "wt") ?? "");
  const pieces = parseInt0(get("pieces", "qty", "quantity", "units", "count") ?? "");
  const equipmentRaw = get("equipment", "equipmenttype", "trailer", "trailertype", "truck", "trucktype", "mode");
  const equipment = mapEquipment(equipmentRaw);
  // 'pickup' is shared with the ORIGIN parser (which reads it as a LOCATION,
  // e.g. "Pickup: Atlanta, GA"). Prefer date-specific aliases here; only fall
  // back to the bare 'pickup' field when it actually parses to a calendar date,
  // so a city string is never stored as pickupAt (downstream Date.parse->NaN).
  const pickupAt =
    parseDate(get("pickupdate", "pickupat", "pickupdatetime", "pu", "pudate", "readydate")) ??
    parseDateStrict(get("pickup"));
  const deliveryAt = parseDate(get("delivery", "deliverydate", "deliveryat", "del", "deldate", "dropdate"));
  const postedAt = parseDate(get("posted", "postedat", "datetime"));
  const reference = get("reference", "ref", "loadid", "load", "loadnumber", "loadref", "ordernumber", "ordernum", "pro", "shipmentid");

  const broker = {
    name: get("broker", "brokername", "customer", "company", "agent", "agency"),
    mcNumber: (() => {
      const v = get("mc", "mcnumber", "mcno", "mcnum", "broker", "brokermc") ?? "";
      const m = v.match(/MC\s*#?\s*(\d{3,8})/i) ?? v.match(/^\s*(\d{4,8})\s*$/);
      return m ? m[1] : undefined;
    })(),
    phone: get("phone", "tel", "contactphone", "brokerphone"),
    email: get("email", "contactemail", "brokeremail"),
  };
  const brokerFilled =
    broker.name || broker.mcNumber || broker.phone || broker.email ? broker : undefined;

  const matched = Boolean(origin && destination && (rate || miles));

  return {
    matched,
    origin,
    destination,
    miles,
    rate,
    weightLbs,
    pieces,
    equipment,
    equipmentRaw,
    pickupAt,
    deliveryAt,
    postedAt,
    broker: brokerFilled,
    reference,
    rawFields,
  };
}
