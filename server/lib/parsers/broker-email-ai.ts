// AI-assisted fallback for the deterministic broker-email parser.
//
// The regex parser (parseBrokerEmail) is fast + deterministic but loses fields
// on "wild" formats (HTML tables, reply chains, nested forwards). This layer:
//   1. runs the regex parser first;
//   2. if the load-defining fields (origin/dest city+state, rate, pickup) are
//      all present -> returns it untouched (ZERO AI cost on clean mail);
//   3. otherwise, with a key + inside a daily budget, makes ONE claude-haiku
//      call (strict JSON + per-field confidence, temperature 0) and fills ONLY
//      the empty critical fields whose confidence >= 0.7. The regex value always
//      wins a conflict (it is deterministic). A filled result is flagged
//      aiAssisted.
//
// equipment is intentionally NOT part of the AI trigger: broker emails routinely
// omit it and the adapter supplies a sensible default, so gating the (paid) AI
// call on it would fire on otherwise-clean mail. The model still fills equipment
// when it is called for another missing field.
//
// Graceful by construction: no key / budget spent / fetch error / bad JSON /
// low confidence -> the regex result is returned unchanged. Never throws.
// Same raw-fetch + null-on-any-error shape as lib/ai/dispatch-advisor.ts.

import { fetchWithTimeout } from "../fetch-timeout";
import { parseBrokerEmail, mapEquipment, type BrokerEmailParsed } from "./broker-email";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";
const MAX_BODY_CHARS = 6000;
const MIN_CONFIDENCE = 0.7;

export type AiAssistedParse = BrokerEmailParsed & { aiAssisted?: boolean };

/** Load-defining fields; their absence is what triggers the AI fallback. */
export function criticalComplete(p: BrokerEmailParsed): boolean {
  return Boolean(
    p.origin?.city &&
      p.origin?.state &&
      p.destination?.city &&
      p.destination?.state &&
      typeof p.rate === "number" &&
      p.rate > 0 &&
      p.pickupAt,
  );
}

// In-memory daily budget. NOT the DB (storage.ts is off-limits for this work,
// and the spec allows an in-memory counter with a date reset). Resets when the
// UTC day rolls over. Cap from env DISPATCHOS_AI_PARSE_DAILY_CAP, default 200.
const budget = { day: "", count: 0 };
function budgetAllows(): boolean {
  const raw = Number(process.env.DISPATCHOS_AI_PARSE_DAILY_CAP);
  const limit = Number.isFinite(raw) && raw >= 0 ? raw : 200;
  const today = new Date().toISOString().slice(0, 10);
  if (budget.day !== today) {
    budget.day = today;
    budget.count = 0;
  }
  if (budget.count >= limit) return false;
  budget.count += 1;
  return true;
}

/** Shape the model must return: each core field optional + a 0..1 confidence. */
interface AiFields {
  originCity?: string;
  originState?: string;
  confidenceOrigin?: number;
  destinationCity?: string;
  destinationState?: string;
  confidenceDestination?: number;
  rate?: number;
  confidenceRate?: number;
  pickupDate?: string;
  confidencePickup?: number;
  equipment?: string;
  confidenceEquipment?: number;
  weightLbs?: number;
  miles?: number;
  reference?: string;
}

const SYSTEM_PROMPT = [
  "You extract structured load fields from a raw freight broker email (subject + body).",
  "Return ONLY a JSON object, no prose, no markdown fences. Unknown fields: omit them.",
  "For every core field include a confidence 0..1 (how sure you are it is correct).",
  "rate = total line-haul in whole US dollars (integer; no $, no commas).",
  "state = 2-letter US code. equipment = the raw equipment phrase exactly as written.",
  "JSON keys: originCity, originState, confidenceOrigin, destinationCity,",
  "destinationState, confidenceDestination, rate, confidenceRate, pickupDate,",
  "confidencePickup, equipment, confidenceEquipment, weightLbs, miles, reference.",
].join(" ");

function extractText(payload: unknown): string | null {
  const p = payload as { content?: Array<{ type?: string; text?: string }> };
  const block = p?.content?.find((b) => b?.type === "text" && typeof b.text === "string");
  return block?.text ?? null;
}

function parseJsonLoose(text: string): AiFields | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned) as AiFields;
  } catch {
    /* fall through to brace extraction */
  }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as AiFields;
  } catch {
    return null;
  }
}

// One Messages-API call. Any failure (no key handled by caller, network, non-2xx,
// unparseable body) resolves to null so the caller falls back to the regex parse.
async function callModel(subject: string, body: string): Promise<AiFields | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const userPrompt = `SUBJECT: ${subject}\n\nBODY:\n${body.slice(0, MAX_BODY_CHARS)}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return null;
  }
  const text = extractText(payload);
  return text ? parseJsonLoose(text) : null;
}

/** Regex wins conflicts; AI only fills EMPTY fields at confidence >= 0.7. */
function mergeAi(base: BrokerEmailParsed, ai: AiFields): AiAssistedParse {
  const out: AiAssistedParse = { ...base };
  let used = false;
  const ok = (c?: number) => typeof c === "number" && c >= MIN_CONFIDENCE;

  if (!out.origin?.city && !out.origin?.state && ai.originCity && ai.originState && ok(ai.confidenceOrigin)) {
    out.origin = { city: ai.originCity.trim(), state: ai.originState.trim().toUpperCase() };
    used = true;
  }
  if (
    !out.destination?.city &&
    !out.destination?.state &&
    ai.destinationCity &&
    ai.destinationState &&
    ok(ai.confidenceDestination)
  ) {
    out.destination = { city: ai.destinationCity.trim(), state: ai.destinationState.trim().toUpperCase() };
    used = true;
  }
  if ((out.rate === undefined || out.rate <= 0) && typeof ai.rate === "number" && ai.rate > 0 && ok(ai.confidenceRate)) {
    out.rate = Math.round(ai.rate);
    used = true;
  }
  if (!out.pickupAt && ai.pickupDate && ok(ai.confidencePickup)) {
    out.pickupAt = ai.pickupDate;
    used = true;
  }
  if (!out.equipment && ai.equipment && ok(ai.confidenceEquipment)) {
    const mapped = mapEquipment(ai.equipment);
    if (mapped) {
      out.equipment = mapped;
      out.equipmentRaw = out.equipmentRaw ?? ai.equipment;
      used = true;
    }
  }
  // Non-critical extras: fill only if empty, never override the regex.
  if (out.weightLbs === undefined && typeof ai.weightLbs === "number" && ai.weightLbs > 0) {
    out.weightLbs = Math.round(ai.weightLbs);
  }
  if (out.miles === undefined && typeof ai.miles === "number" && ai.miles > 0) {
    out.miles = Math.round(ai.miles);
  }
  if (!out.reference && ai.reference) out.reference = String(ai.reference);

  if (used) {
    out.aiAssisted = true;
    // Endpoints/rate may now be present -> recompute the "usable load" flag the
    // same way the regex parser does (both endpoints + rate-or-miles).
    out.matched = Boolean(out.origin && out.destination && ((out.rate ?? 0) > 0 || (out.miles ?? 0) > 0));
  }
  return out;
}

/**
 * Parse a broker email, using an AI fallback ONLY to fill load-defining fields
 * the regex parser missed. Async; safe to await from the (async) adapter fetch
 * path. Deterministic + free when the regex parse is already complete or when no
 * API key / budget is available.
 */
export async function parseBrokerEmailWithAi(input: {
  from?: string;
  subject?: string;
  body?: string;
}): Promise<AiAssistedParse> {
  const base = parseBrokerEmail(input);
  if (criticalComplete(base)) return base; // clean mail -> zero AI cost
  if (!process.env.ANTHROPIC_API_KEY) return base; // graceful without a key
  if (!budgetAllows()) return base; // daily cap reached -> silently regex-only

  const ai = await callModel(String(input.subject ?? ""), String(input.body ?? ""));
  if (!ai) return base;
  return mergeAi(base, ai);
}
