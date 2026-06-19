// Shared fetch-with-timeout. Raw vendor fetches without an AbortController can
// hang a request or cron pass indefinitely if the vendor socket stalls (there
// is no server-level request timeout). Wrap them so a stall becomes a caught
// AbortError instead of an infinite hang. Mirrors the AbortController pattern
// already used in fmcsa.ts / receipt-ocr.ts.

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
