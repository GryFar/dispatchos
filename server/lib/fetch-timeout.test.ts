// Regression tests for fetchWithTimeout signal composition.
// Run: npx tsx server/lib/fetch-timeout.test.ts
//
// fetchWithTimeout(url, init, timeoutMs) wraps the global fetch with an internal
// AbortController timeout. The FIX being locked in here: a caller-supplied
// init.signal is COMPOSED with the internal timeout signal via AbortSignal.any,
// instead of being silently dropped.
//
// PRE-FIX BUG: the implementation passed `fetch(url, { ...init, signal })` where
// `signal` was ONLY the internal controller.signal. Because the explicit `signal`
// key overwrites the spread `init.signal`, any caller-supplied AbortSignal was
// thrown away — a caller's own abort (or a pre-aborted signal) had no effect.
//
// These tests are deterministic and do NO real network: globalThis.fetch is
// stubbed with a controllable fake that (a) echoes back the signal it received
// and (b) rejects with an AbortError if/when that signal aborts. No multi-second
// waits — the internal-timeout test uses a 5ms timeout.

import { fetchWithTimeout } from "./fetch-timeout";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

const realFetch = globalThis.fetch;

// A controllable fake fetch. It records the `signal` it was handed and resolves
// only when `resolve()` is called from the test — UNLESS the passed signal
// aborts first, in which case it rejects with the signal's abort reason (this is
// exactly how real fetch behaves w.r.t. AbortSignal). No network, no timers of
// its own.
function installFakeFetch() {
  let capturedSignal: AbortSignal | undefined;
  let resolveFn: ((r: Response) => void) | null = null;
  const fakeResponse = { ok: true, status: 200 } as unknown as Response;

  globalThis.fetch = ((_url: string, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? undefined;
    capturedSignal = signal;
    return new Promise<Response>((resolve, reject) => {
      resolveFn = resolve;
      if (signal) {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true },
        );
      }
    });
  }) as typeof fetch;

  return {
    get signal() {
      return capturedSignal;
    },
    // Complete the in-flight fetch with a success Response.
    complete() {
      resolveFn?.(fakeResponse);
    },
    fakeResponse,
  };
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

// Helper: did a promise reject with an AbortError (name or reason.name)?
// Races against a short real-timer sentinel so a regression that drops the
// caller signal (leaving the call to hang on its internal timer) yields a clean
// DID_NOT_SETTLE FAIL instead of hanging the whole suite. The fixed code settles
// these promises synchronously-ish (within a microtask), well under 50ms.
const DID_NOT_SETTLE = Symbol("did-not-settle");
const DID_NOT_REJECT = Symbol("did-not-reject");
async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<typeof DID_NOT_SETTLE>((resolve) => {
    timer = setTimeout(() => resolve(DID_NOT_SETTLE), 50);
  });
  try {
    const r = await Promise.race([
      p.then(() => DID_NOT_REJECT, (e) => e),
      guard,
    ]);
    return r;
  } finally {
    clearTimeout(timer!);
  }
}
function isAbortError(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: string }).name === "AbortError";
}

// ---------------------------------------------------------------------------
// 1) Composition object identity: the signal handed to fetch is a NEW composed
//    signal (AbortSignal.any output), not the caller's signal verbatim and not
//    a bare internal signal that ignores the caller.
//
// REGRESSION: pre-fix, fetch received only controller.signal and the caller's
// signal was dropped — so the caller's signal would never have been part of the
// composition. We assert below (tests 2 & 3) that aborting the caller's signal
// actually aborts the call, which is the real behavioral guard. This identity
// check documents that AbortSignal.any composition is exercised (a distinct,
// composed signal object is produced).
// ---------------------------------------------------------------------------
{
  const fake = installFakeFetch();
  const callerController = new AbortController();
  const p = fetchWithTimeout("https://unused.test/x", { signal: callerController.signal }, 10_000);
  const handed = fake.signal;
  assert("compose: fetch received a signal", handed instanceof AbortSignal, String(handed));
  // The composed signal must NOT be the caller's raw signal (proves it was wrapped
  // with the internal timeout via AbortSignal.any, not passed through unchanged).
  assert(
    "compose: handed signal is a distinct composed signal (not caller's raw signal)",
    handed !== callerController.signal,
  );
  // Let the in-flight call finish so the promise settles (no dangling reject).
  fake.complete();
  await p;
  restoreFetch();
}

// ---------------------------------------------------------------------------
// 2) Pre-aborted caller signal -> the call rejects/aborts immediately with the
//    CALLER'S reason (not the internal timeout).
//
// REGRESSION: pre-fix the caller's signal was dropped, so an already-aborted
// caller signal had NO immediate effect — the handed signal stayed un-aborted
// and the call only failed much later when the internal timer fired (with the
// "fetch timed out" reason), or resolved if it completed first.
//
// We use a HUGE internal timeout (1e9 ms) so the internal timer can NOT be the
// cause within the test, and assert two things the pre-fix code fails:
//   * the signal handed to fetch is ALREADY aborted synchronously at call time
//     (pre-fix it is controller.signal, which is NOT aborted) — this is the
//     decisive guard;
//   * the rejection carries the CALLER'S abort reason ("caller bailed"), not the
//     timeout message.
// ---------------------------------------------------------------------------
{
  const fake = installFakeFetch();
  const pre = AbortSignal.abort(new DOMException("caller bailed", "AbortError"));
  const p = fetchWithTimeout("https://unused.test/x", { signal: pre }, 1_000_000_000);
  // Decisive: composed signal is aborted synchronously because the caller's
  // pre-aborted signal propagated through AbortSignal.any. Pre-fix: false.
  assert(
    "pre-aborted: composed signal handed to fetch is already aborted (caller's abort propagated)",
    fake.signal?.aborted === true,
  );
  const result = await rejectionOf(p);
  assert("pre-aborted: call rejects with AbortError", isAbortError(result), String((result as Error)?.name));
  // The rejection reason is the CALLER'S, proving it was the caller's abort that
  // ended the call — not the internal timeout (which would say "fetch timed out").
  assert(
    "pre-aborted: rejection carries the caller's reason (not the timeout)",
    (result as Error)?.message === "caller bailed",
    (result as Error)?.message,
  );
  restoreFetch();
}

// ---------------------------------------------------------------------------
// 3) Abort on the caller signal mid-flight -> the in-flight call aborts with the
//    CALLER'S reason.
//
// REGRESSION: pre-fix, aborting the caller's signal AFTER the call started had
// no effect (the signal was dropped) — the handed signal stayed un-aborted and
// the call would only end on the internal timeout. With the fix, the composed
// signal forwards the caller's abort and the in-flight fetch rejects with the
// caller's reason. HUGE internal timeout so only the caller's abort can settle
// it. This test FAILS on the pre-fix behavior (handed signal never flips; the
// call would hang until the timer).
// ---------------------------------------------------------------------------
{
  const fake = installFakeFetch();
  const callerController = new AbortController();
  const p = fetchWithTimeout("https://unused.test/x", { signal: callerController.signal }, 1_000_000_000);
  // Not aborted yet, so nothing has settled. Now abort via the caller.
  assert("mid-flight: composed signal not aborted before caller aborts", fake.signal?.aborted === false);
  callerController.abort(new DOMException("user cancelled", "AbortError"));
  // Decisive synchronous guard: the caller's abort flips the COMPOSED signal
  // immediately. Pre-fix this stays false (caller signal was dropped).
  assert("mid-flight: composed signal flips to aborted right after caller aborts", fake.signal?.aborted === true);
  const result = await rejectionOf(p);
  assert("mid-flight: caller abort propagates -> call rejects with AbortError", isAbortError(result), String((result as Error)?.name));
  assert(
    "mid-flight: rejection carries the caller's reason (not the timeout)",
    (result as Error)?.message === "user cancelled",
    (result as Error)?.message,
  );
  restoreFetch();
}

// ---------------------------------------------------------------------------
// 4) Internal timeout still fires on its own (no caller signal involved).
//
// REGRESSION / invariant: composing with a caller signal must NOT break the
// original behavior — a stalled fetch with NO caller signal must still abort
// when the internal timeout elapses, with an AbortError whose message names the
// configured timeout. Deterministic & fast: 5ms timeout, fake fetch never
// completes on its own, so only the internal timer can abort it.
// ---------------------------------------------------------------------------
{
  const fake = installFakeFetch();
  // No init.signal — exercises the `callerSignal ? any() : controller.signal`
  // false branch; the internal controller is the sole abort source.
  const result = await rejectionOf(
    fetchWithTimeout("https://unused.test/slow", {}, 5),
  );
  assert("timeout: stalled call rejects with AbortError", isAbortError(result), String((result as Error)?.name));
  assert(
    "timeout: AbortError message names the configured timeout (5ms)",
    !!result && typeof (result as Error).message === "string" && (result as Error).message.includes("5ms"),
    (result as Error)?.message,
  );
  // With no caller signal, the signal handed to fetch is the bare internal one
  // and it aborted from the timer.
  assert("timeout: handed signal aborted by internal timer", fake.signal?.aborted === true);
  restoreFetch();
}

// ---------------------------------------------------------------------------
// 5) Internal timeout still wins even WHEN a caller signal is composed in
//    (and the caller never aborts). Proves the timeout leg of AbortSignal.any
//    is live, not shadowed by the caller leg.
//
// REGRESSION: a naive "fix" that replaced controller.signal with the caller's
// signal (instead of composing both) would break the internal timeout when a
// caller signal is present. This test FAILS on that broken variant.
// ---------------------------------------------------------------------------
{
  const fake = installFakeFetch();
  const callerController = new AbortController(); // never aborted
  const result = await rejectionOf(
    fetchWithTimeout("https://unused.test/slow", { signal: callerController.signal }, 5),
  );
  assert("timeout+caller: still rejects via internal timeout", isAbortError(result), String((result as Error)?.name));
  assert(
    "timeout+caller: AbortError message names the configured timeout (5ms)",
    !!result && (result as Error).message?.includes("5ms"),
    (result as Error)?.message,
  );
  restoreFetch();
}

// ---------------------------------------------------------------------------
// 6) Happy path: when nothing aborts, the caller's Response passes through and
//    the internal timer is cleared (no dangling abort after success).
// ---------------------------------------------------------------------------
{
  const fake = installFakeFetch();
  const callerController = new AbortController();
  const p = fetchWithTimeout("https://unused.test/ok", { signal: callerController.signal }, 10_000);
  fake.complete();
  const res = await p;
  assert("happy: resolves with the fetch Response", res === fake.fakeResponse);
  // The composed signal must remain un-aborted after a clean success.
  assert("happy: composed signal not aborted after success", fake.signal?.aborted === false);
  // Aborting the caller AFTER success is a no-op on the settled promise (sanity:
  // no unhandled rejection). The composed signal does forward the abort, but the
  // fetch promise already resolved.
  restoreFetch();
}

restoreFetch();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
