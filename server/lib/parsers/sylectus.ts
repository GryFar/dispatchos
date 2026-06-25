// Sylectus email parser.
//
// Sylectus sends "load posted" notifications via email when a broker posts
// to their board and the carrier has matching profile. Format is mostly
// stable plain-text or simple HTML. We pull the structured fields out so
// /api/email/ingest can persist a real Load draft instead of the generic
// regex grab-bag in parseEmailToLoad.
//
// Reference shapes (real samples redacted):
//
//   Subject: New Load Posted - Atlanta, GA to Miami, FL - $1850
//
//   Body (plain or wrapped in HTML):
//     Pickup: 05/20/2026 09:00
//     Origin: Atlanta, GA 30303
//     Destination: Miami, FL 33101
//     Miles: 661
//     Weight: 28000 lbs
//     Pieces: 12
//     Equipment: Van
//     Rate: $1,850
//     Broker: ACME Logistics (MC# 123456)
//     Phone: (555) 123-4567
//     Email: dispatch@acme.com
//     Posted: 05/20/2026 06:15
//     Reference: ABC-12345
//
// Two patterns we explicitly support:
//   1. The "field: value" line-based body above (Sylectus default).
//   2. HTML table where each <tr> holds [label, value]; we strip tags and
//      fall back to pattern #1.
//
// Anything we can't pattern-match falls through to undefined — callers
// already know how to handle missing fields.

export interface SylectusParsed {
  source: "sylectus";
  matched: boolean;            // true if we found enough to call it a Sylectus posting
  origin?: { city: string; state: string; zip?: string };
  destination?: { city: string; state: string; zip?: string };
  miles?: number;
  rate?: number;               // USD, integer
  weightLbs?: number;
  pieces?: number;
  equipment?: string;          // raw label, e.g. "Van" | "Reefer" | "Flatbed"
  pickupAt?: string;           // ISO if parseable, otherwise raw
  postedAt?: string;
  broker?: { name?: string; mcNumber?: string; phone?: string; email?: string };
  reference?: string;          // broker load reference
  rawFields: Record<string, string>;   // every field: value we extracted
}

const FIELD_LINE = /^\s*([A-Za-z][A-Za-z \\/.#-]{1,30}?)\s*[:#-]\s*(.+?)\s*$/;

// Hard cap on the body we feed to the (synchronous) regex pipeline. Inbound
// email bodies are attacker-controllable and the schema only caps them at 1MB,
// far above the ~100KB needed to make the tag-strip regexes stall the single
// event loop. A real Sylectus posting is a few KB, so 32KB is generous.
const MAX_PARSE_LEN = 32_768;

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?(tr|td|th|p|div|li|br)[^>]*>/gi, "\n")
    // Bounded tag class: cap the run between '<' and '>' so a body with a
    // single unclosed '<' followed by a huge non-'>' run cannot backtrack.
    .replace(/<[^<>]{0,2000}>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\r/g, "");
}

function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseCityState(value: string): { city: string; state: string; zip?: string } | undefined {
  // "Atlanta, GA" or "Atlanta, GA 30303" or "Atlanta GA 30303"
  // Reject overlong values up front — a real "City, ST 12345" is well under 80
  // chars, and the bounded count below removes the space/separator ambiguity
  // that previously allowed O(n^2) backtracking on attacker-controlled input.
  if (value.length > 80) return undefined;
  const m = value.match(/^\s*([A-Za-z][A-Za-z.'-]{0,38})((?: [A-Za-z.'-]+){0,5})[,\s]+([A-Z]{2})(?:\s+(\d{5}))?\s*$/);
  if (!m) return undefined;
  const city = (m[1] + (m[2] || "")).trim();
  return { city, state: m[3].toUpperCase(), zip: m[4] };
}

function parseMoney(value: string): number | undefined {
  // "$1,850" | "1850" | "USD 1,850.00" | "$2,400 all-in"
  // Anchor on the FIRST numeric token so a trailing FSC/per-mile figure on the
  // same line can't be concatenated into the rate (1000x inflation / NaN).
  const m = value.match(/\$?\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return undefined;
  const n = Math.round(Number(m[1].replace(/,/g, "")));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseInt0(value: string): number | undefined {
  const m = value.match(/-?\d[\d,]*/);
  if (!m) return undefined;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

// Normalize a date field to ISO when we recognize the shape, else return the
// raw string (the interface contract: "ISO if parseable, otherwise raw").
// Mirrors broker-email.ts's parseDate so the pickup-reminder window query —
// which compares against ISO bounds — actually sees Sylectus pickups.
function parseDate(value?: string): string | undefined {
  if (!value) return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  // Already ISO-ish.
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? raw : d.toISOString();
  }
  // US "MM/DD/YYYY[ HH:MM]" — the common Sylectus / broker format.
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

function parseSubjectLane(subject: string):
  | { origin: { city: string; state: string }; destination: { city: string; state: string }; rate?: number }
  | undefined {
  // "Atlanta, GA to Miami, FL - $1850" / "Atlanta GA -> Miami FL"
  const m = subject.match(
    /([A-Za-z][A-Za-z .'-]+?)[,\s]+([A-Z]{2})\s*(?:-|→|->|to)\s*([A-Za-z][A-Za-z .'-]+?)[,\s]+([A-Z]{2})/i,
  );
  if (!m) return undefined;
  const rateMatch = subject.match(/\$\s?([\d,]{3,7})(?:\.\d{1,2})?/);
  return {
    origin: { city: m[1].trim(), state: m[2].toUpperCase() },
    destination: { city: m[3].trim(), state: m[4].toUpperCase() },
    rate: rateMatch ? parseMoney(rateMatch[1]) : undefined,
  };
}

/**
 * Heuristic "is this from Sylectus?" check. We look at the From header and
 * a few body markers. The caller is responsible for deciding whether to
 * persist the result regardless of matched=false.
 */
function isSylectus(from: string, body: string): boolean {
  const low = from.toLowerCase();
  if (low.includes("sylectus.com")) return true;
  if (low.includes("sylectus.net")) return true;
  // Body markers — Sylectus footers / common header text.
  return /sylectus/i.test(body) || /www\.sylectus\.com/i.test(body);
}

export function parseSylectusEmail(input: {
  from: string;
  subject: string;
  body: string;
}): SylectusParsed {
  // Truncate before any regex touches the body: inbound email is attacker-
  // controllable and runs synchronously on the event loop.
  const body =
    input.body.length > MAX_PARSE_LEN ? input.body.slice(0, MAX_PARSE_LEN) : input.body;
  const bodyText = /<[a-z][\s\S]*>/i.test(body) ? stripHtml(body) : body;
  const looksSylectus = isSylectus(input.from, bodyText);
  const subjectLane = parseSubjectLane(input.subject);

  // Walk the body line-by-line, collect every "Field: value" pair we see.
  const rawFields: Record<string, string> = {};
  for (const line of bodyText.split(/\n+/)) {
    const m = line.match(FIELD_LINE);
    if (!m) continue;
    const key = normalizeKey(m[1]);
    if (!key) continue;
    // First occurrence wins — Sylectus sometimes echoes labels in footer.
    if (!rawFields[key]) rawFields[key] = m[2].trim();
  }

  const get = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      if (rawFields[k]) return rawFields[k];
    }
    return undefined;
  };

  const origin =
    (get("origin", "from", "pickup", "pickupcity", "originlocation") &&
      parseCityState(get("origin", "from", "pickup", "pickupcity", "originlocation")!)) ||
    subjectLane?.origin;

  const destination =
    (get("destination", "to", "delivery", "destinationlocation") &&
      parseCityState(get("destination", "to", "delivery", "destinationlocation")!)) ||
    subjectLane?.destination;

  const rate =
    parseMoney(get("rate", "amount", "linehaul", "totalrate", "price") ?? "") ?? subjectLane?.rate;

  const miles = parseInt0(get("miles", "totalmiles", "loadedmiles", "distance") ?? "");
  const weightLbs = parseInt0(get("weight", "weightlbs") ?? "");
  const pieces = parseInt0(get("pieces", "qty", "quantity") ?? "");
  const equipment = get("equipment", "equipmenttype", "trailer", "truck");
  const pickupAt = parseDate(get("pickup", "pickupdate", "pickupat", "pickupdatetime"));
  const postedAt = parseDate(get("posted", "postedat", "datetime"));
  const reference = get("reference", "ref", "loadid", "loadnumber", "loadref");

  const broker = {
    name: get("broker", "brokername", "carrier", "company"),
    mcNumber: (() => {
      const v = get("mc", "mcnumber", "mcno", "broker") ?? "";
      const m = v.match(/MC\s*#?\s*(\d{3,8})/i);
      return m ? m[1] : undefined;
    })(),
    phone: get("phone", "tel"),
    email: get("email", "contactemail"),
  };
  const brokerFilled =
    broker.name || broker.mcNumber || broker.phone || broker.email ? broker : undefined;

  // "matched" gate: we say true when we either saw Sylectus markers OR
  // we successfully extracted both endpoints + rate.
  const matched =
    looksSylectus || Boolean(origin && destination && (rate || miles));

  return {
    source: "sylectus",
    matched,
    origin,
    destination,
    miles,
    rate,
    weightLbs,
    pieces,
    equipment,
    pickupAt,
    postedAt,
    broker: brokerFilled,
    reference,
    rawFields,
  };
}
