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

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?(tr|td|th|p|div|li|br)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
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
  const m = value.match(/^\s*([A-Za-z][A-Za-z .'-]+?)[,\s]+([A-Z]{2})(?:\s+(\d{5}))?\s*$/);
  if (!m) return undefined;
  return { city: m[1].trim(), state: m[2].toUpperCase(), zip: m[3] };
}

function parseMoney(value: string): number | undefined {
  // "$1,850" | "1850" | "USD 1,850.00"
  const cleaned = value.replace(/[^0-9.]/g, "");
  if (!cleaned) return undefined;
  const n = Math.round(Number(cleaned));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseInt0(value: string): number | undefined {
  const m = value.match(/-?\d[\d,]*/);
  if (!m) return undefined;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
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
  const bodyText = /<[a-z][\s\S]*>/i.test(input.body) ? stripHtml(input.body) : input.body;
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
  const pickupAt = get("pickup", "pickupdate", "pickupat", "pickupdatetime");
  const postedAt = get("posted", "postedat", "datetime");
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
