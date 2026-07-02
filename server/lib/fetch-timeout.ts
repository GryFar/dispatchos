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
  // Abort with an explicit AbortError reason that names the elapsed timeout.
  // fetch rejects with this reason, so callers logging err.message now see the
  // configured timeoutMs. The reason keeps name === "AbortError" so existing
  // callers that branch on that (e.g. load-alerts.ts) are unaffected.
  const timer = setTimeout(
    () => controller.abort(new DOMException(`fetch timed out after ${timeoutMs}ms`, "AbortError")),
    timeoutMs,
  );
  // Compose the internal timeout signal with any caller-supplied signal so a
  // caller's own abort is still honored instead of being silently dropped by
  // the spread+overwrite below. AbortSignal.any is available on Node 20.3+.
  const callerSignal = init.signal;
  const signal = callerSignal
    ? AbortSignal.any([controller.signal, callerSignal])
    : controller.signal;
  try {
    return await fetch(url, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}
