// ===========================================================================
// server/lib/ai/receipt-ocr.ts — fuel receipt OCR via Claude vision
// ===========================================================================
//
// parseReceipt(imageBase64, mediaType?) → ReceiptData | null
//
// A driver photographs a US gas-station pump/receipt in Telegram; we pass the
// image to Claude (haiku, vision) and extract structured fuel-transaction
// fields. Returns null on any failure (no key, API error, unparseable, or the
// image clearly isn't a fuel receipt) so callers can degrade gracefully and
// ask the driver to re-send.
//
// Raw fetch to the Messages API (no SDK dependency). ANTHROPIC_API_KEY must be
// set in the environment (present in prod).

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

export interface ReceiptData {
  gallons: number | null;
  pricePerGallon: number | null; // dollars
  total: number | null; // dollars
  stationName: string | null;
  date: string | null; // ISO yyyy-MM-dd if Claude can read it, else null
  fuelType: "diesel" | "gasoline" | "def" | null;
  confidence: number; // 0..1, Claude's self-reported read confidence
}

type SupportedMedia = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

const SYSTEM_PROMPT =
  "You are a precise data extractor for US fuel receipts. " +
  "You only return JSON. You never guess values you cannot read.";

const USER_PROMPT =
  "Extract fuel purchase details from this US gas-station receipt or pump display. " +
  "Return ONLY a JSON object, no prose, no markdown fences, with exactly these keys:\n" +
  '{"gallons": number|null, "pricePerGallon": number|null, "total": number|null, ' +
  '"stationName": string|null, "date": string|null, "fuelType": "diesel"|"gasoline"|"def"|null, ' +
  '"confidence": number}\n' +
  "Rules: gallons/pricePerGallon/total are decimal numbers in US units and dollars. " +
  "date is ISO yyyy-MM-dd if clearly legible, else null. fuelType is the product if shown " +
  "(diesel for DSL/diesel, def for DEF/diesel-exhaust-fluid), else null. " +
  "confidence is your 0..1 confidence the image is a readable fuel receipt. " +
  "If the image is NOT a fuel receipt, set every field null and confidence 0. " +
  "Use null (not 0, not guesses) for anything you cannot read.";

function clampNum(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function coerceReceipt(raw: unknown): ReceiptData | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const ft = o.fuelType;
  const fuelType =
    ft === "diesel" || ft === "gasoline" || ft === "def" ? ft : null;
  const confidence = clampNum(o.confidence, 0, 1) ?? 0;
  return {
    gallons: clampNum(o.gallons, 0, 500),
    pricePerGallon: clampNum(o.pricePerGallon, 0, 20),
    total: clampNum(o.total, 0, 5000),
    stationName: typeof o.stationName === "string" ? o.stationName.slice(0, 120) : null,
    date: typeof o.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : null,
    fuelType,
    confidence,
  };
}

/**
 * Parse a fuel receipt image into structured data. `imageBase64` must be the
 * raw base64 (no data: prefix). Returns null on any failure.
 */
export async function parseReceipt(
  imageBase64: string,
  mediaType: SupportedMedia = "image/jpeg",
): Promise<ReceiptData | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[receipt-ocr] ANTHROPIC_API_KEY not set — skipping OCR");
    return null;
  }
  if (!imageBase64 || imageBase64.length < 100) {
    console.warn("[receipt-ocr] empty/too-small image — skipping");
    return null;
  }
  // Fail fast on oversized images: the Anthropic API rejects base64 image
  // payloads above its ~5MB limit, so anything beyond this threshold would only
  // waste an up-to-45s round-trip before the remote error path. Bail locally.
  if (imageBase64.length > 6_500_000) {
    console.warn("[receipt-ocr] image too large — skipping");
    return null;
  }

  let res: Response;
  // Audit V2-15 — cap Anthropic call at 45s. Without it a stalled vendor hangs
  // the cron / driver-bot path indefinitely (compare fmcsa.ts which uses 5s).
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45_000);
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: imageBase64 },
              },
              { type: "text", text: USER_PROMPT },
            ],
          },
        ],
      }),
    });
  } catch (err) {
    const msg = (err as Error).message;
    if ((err as Error).name === "AbortError") {
      console.error("[receipt-ocr] fetch timed out after 45s");
    } else {
      console.error("[receipt-ocr] fetch failed:", msg);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[receipt-ocr] API ${res.status}: ${body.slice(0, 200)}`);
    return null;
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return null;
  }

  // Messages API: { content: [{ type: "text", text: "..." }, ...] }
  const blocks = (payload as { content?: Array<{ type?: string; text?: string }> })?.content;
  const text = Array.isArray(blocks)
    ? blocks.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("")
    : "";
  if (!text) return null;

  // Strip any accidental markdown fences, then parse JSON.
  const cleaned = text.replace(/```json|```/g, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Last resort: pull the first {...} block out of the text.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) {
      console.warn("[receipt-ocr] could not parse JSON from model output");
      return null;
    }
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }

  const result = coerceReceipt(parsed);
  // Treat "not a receipt" (confidence 0, all null) as a soft failure → null.
  if (!result || (result.confidence === 0 && result.total === null && result.gallons === null)) {
    return null;
  }
  return result;
}
