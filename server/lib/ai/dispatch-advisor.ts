// ===========================================================================
// server/lib/ai/dispatch-advisor.ts — F2 AI Dispatcher (Claude advice layer)
// ===========================================================================
//
// getAiRecommendation(client, scoredLoads) → AiRecommendation | null
//
// The deterministic scorer (scoreLoadForClient) already ranks loads by
// dispatchScore and attaches economics (netPpmTotal, deadhead, fuelCost,
// counterOffer, warnings). This module layers a reasoning pass on top: it sends
// the carrier profile + the already-ranked top loads to Claude and asks for a
// plain-language recommendation a human dispatcher can act on — which load to
// take, why, and what to watch out for.
//
// Design notes:
//  - Triggered on-demand (a dispatcher button), never per board refresh, to
//    keep token spend controlled.
//  - We send only the top few already-scored loads with compact fields, not the
//    raw board — cheaper and less noisy.
//  - haiku model: fast + cheap, enough for ranking-explanation over a handful
//    of candidates.
//  - Never throws. Missing key / API error / unparseable output → null, so the
//    caller can return a clean 503 and the board keeps working.
//
// Raw fetch to the Messages API (no SDK), same pattern as receipt-ocr.ts.
// ANTHROPIC_API_KEY must be set in the environment (present in prod).

import type { Client, ScoredLoad } from "@shared/schema";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

export interface AiRecommendation {
  /** load id the model recommends booking first (must be one of the inputs). */
  recommendedLoadId: string | null;
  /** Plain-language reasoning for the recommendation (1-3 sentences). */
  reasoning: string;
  /** Things the dispatcher should verify before committing. */
  watchOuts: string[];
  /** Model's 0..1 confidence in the recommendation. */
  confidence: number;
}

const SYSTEM_PROMPT =
  "You are an experienced US freight dispatch advisor for a car-hauling / " +
  "trucking operation. You help a human dispatcher choose between already-" +
  "ranked load options. You are concise, practical, and you never invent " +
  "numbers — you reason only from the data given. You only return JSON.";

// Keep the per-load payload compact: only what's useful for a booking decision.
function compactLoad(l: ScoredLoad) {
  return {
    id: l.id,
    lane: `${l.originCity ?? "?"}, ${l.originState ?? "?"} -> ${l.destinationCity ?? "?"}, ${l.destinationState ?? "?"}`,
    rate: l.rate,
    loadedMiles: l.loadedMiles,
    deadheadMiles: l.deadheadMiles,
    deadheadRatio: Number(l.deadheadRatio?.toFixed?.(2) ?? l.deadheadRatio),
    netPpmTotal: Number(l.netPpmTotal?.toFixed?.(2) ?? l.netPpmTotal),
    fuelCost: l.fuelCost,
    dispatchScore: l.dispatchScore,
    verdict: l.verdict, // book | negotiate | skip
    counterOffer: l.counterOffer,
    brokerName: (l as ScoredLoad & { brokerName?: string }).brokerName ?? null,
    brokerMc: (l as ScoredLoad & { brokerMc?: string }).brokerMc ?? null,
    fraudRisk: (l as ScoredLoad & { fraudRisk?: number }).fraudRisk ?? null,
    pickupFeasibility: l.pickupFeasibility,
    warnings: l.warnings ?? [],
  };
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function coerce(raw: unknown, validIds: Set<string>): AiRecommendation | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const rec = typeof o.recommendedLoadId === "string" ? o.recommendedLoadId : null;
  return {
    // Only trust an id the model was actually given (anti-hallucination).
    recommendedLoadId: rec && validIds.has(rec) ? rec : null,
    reasoning: typeof o.reasoning === "string" ? o.reasoning.slice(0, 800) : "",
    watchOuts: Array.isArray(o.watchOuts)
      ? o.watchOuts.filter((w): w is string => typeof w === "string").slice(0, 6).map((w) => w.slice(0, 200))
      : [],
    confidence: clampNum(o.confidence, 0, 1, 0.5),
  };
}

/**
 * Ask Claude for a booking recommendation over already-scored loads.
 * `scoredLoads` should be the top few (the caller slices); we cap at 8 here as
 * a safety bound. Returns null on any failure.
 */
export async function getAiRecommendation(
  client: Client,
  scoredLoads: ScoredLoad[],
): Promise<AiRecommendation | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[dispatch-advisor] ANTHROPIC_API_KEY not set — skipping");
    return null;
  }
  if (!scoredLoads.length) return null;

  const loads = scoredLoads.slice(0, 8).map(compactLoad);
  const validIds = new Set(loads.map((l) => l.id));

  const carrier = {
    name: client.name,
    equipment: client.equipment,
    targetPpm: client.targetPpm,
    minimumPpm: client.minimumPpm,
    currentLocation: client.currentLocation
      ? `${client.currentLocation.city ?? "?"}, ${client.currentLocation.state ?? "?"}`
      : "unknown",
    avoidStates: client.avoidStates ?? [],
    preferredLanes: client.preferredLanes ?? [],
  };

  const userPrompt =
    "Carrier profile:\n" +
    JSON.stringify(carrier) +
    "\n\nAlready-ranked load options (dispatchScore desc; verdict is the scorer's call):\n" +
    JSON.stringify(loads) +
    "\n\nRecommend which single load the dispatcher should book first. " +
    "Weigh net pay-per-mile, deadhead, broker/fraud risk, pickup feasibility, " +
    "and fit with the carrier's lanes/avoid-states. You may disagree with the " +
    "scorer's top pick if there's a good reason — explain it. " +
    "Return ONLY a JSON object, no prose, no markdown, with exactly these keys:\n" +
    '{"recommendedLoadId": string, "reasoning": string, "watchOuts": string[], "confidence": number}\n' +
    "recommendedLoadId MUST be one of the provided load ids. reasoning is 1-3 " +
    "sentences. watchOuts lists concrete things to verify before booking " +
    "(e.g. confirm rate con, verify broker MC). confidence is 0..1.";

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
  } catch (err) {
    console.error("[dispatch-advisor] fetch failed:", (err as Error).message);
    return null;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[dispatch-advisor] API ${res.status}: ${body.slice(0, 200)}`);
    return null;
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return null;
  }

  const blocks = (payload as { content?: Array<{ type?: string; text?: string }> })?.content;
  const text = Array.isArray(blocks)
    ? blocks.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("")
    : "";
  if (!text) return null;

  const cleaned = text.replace(/```json|```/g, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }

  return coerce(parsed, validIds);
}
