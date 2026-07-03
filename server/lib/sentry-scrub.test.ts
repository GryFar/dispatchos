// server/lib/sentry-scrub.test.ts — scrubSentryEvent (server/instrument.ts).
// Run: npx tsx server/lib/sentry-scrub.test.ts
//
// Super-audit 2026-07-02 [data-pii-leaks, MEDIUM]: the Sentry beforeSend hook
// only stripped authorization/cookie/set-cookie headers — it left the URL
// query string, the Telegram bot token in the webhook PATH, the request body
// (login passwords / reset tokens / inbound payloads) and every other
// credential header (x-cron-secret, x-inbound-secret, x-api-key, …) intact, so
// a crash event could exfiltrate secrets to Sentry. These pin the wider scrub.
//
// No Sentry init runs here (SENTRY_DSN unset → instrument.ts is a no-op); we
// import the pure exported scrubber directly.

import assert from "node:assert/strict";
import test from "node:test";
import type * as Sentry from "@sentry/node";
import { scrubSentryEvent } from "../instrument";

function ev(request: Record<string, unknown>, tags?: Record<string, unknown>): Sentry.Event {
  return { request, tags } as unknown as Sentry.Event;
}

test("by-design 4xx events are dropped (return null)", () => {
  for (const code of [400, 401, 403, 404, 429]) {
    assert.equal(scrubSentryEvent(ev({}, { status_code: code })), null, `status ${code}`);
  }
  // A 500 (or untagged) event is kept.
  assert.notEqual(scrubSentryEvent(ev({}, { status_code: 500 })), null);
  assert.notEqual(scrubSentryEvent(ev({})), null);
});

test("URL: query string dropped, Telegram webhook token redacted", () => {
  const out = scrubSentryEvent(
    ev({ url: "https://dispatchos.co/api/telegram/webhook/123456:AAExampleBotTokenSecret?x=1" }),
  );
  const url = (out!.request as { url?: string }).url!;
  assert.ok(!url.includes("?"), `query not stripped: ${url}`);
  assert.ok(!url.includes("AAExampleBotTokenSecret"), `bot token leaked: ${url}`);
  assert.ok(url.includes("<redacted>"), `token not redacted: ${url}`);
});

test("request body and cookies are removed entirely", () => {
  const out = scrubSentryEvent(
    ev({
      data: { email: "a@b.co", password: "hunter2", token: "reset-abc" },
      cookies: { "dispatchos.sid": "s%3Asecret" },
      query_string: "token=abc",
    }),
  );
  const r = out!.request as { data?: unknown; cookies?: unknown; query_string?: unknown };
  assert.equal(r.data, undefined, "body not scrubbed");
  assert.equal(r.cookies, undefined, "cookies not scrubbed");
  assert.equal(r.query_string, undefined, "query_string not scrubbed");
});

test("every credential-bearing header is stripped (not just authorization/cookie)", () => {
  const out = scrubSentryEvent(
    ev({
      headers: {
        Authorization: "Bearer x",
        "Proxy-Authorization": "Bearer y",
        Cookie: "a=b",
        "Set-Cookie": "a=b",
        "X-Cron-Secret": "cron-sec",
        "X-Inbound-Secret": "in-sec",
        "X-Telegram-Bot-Api-Secret-Token": "tg-sec",
        "X-Api-Key": "ak",
        "X-Reset-Password": "p",
        "Content-Type": "application/json",
        "X-Request-Id": "keep-me",
      },
    }),
  );
  const h = (out!.request as { headers: Record<string, unknown> }).headers;
  for (const gone of [
    "Authorization",
    "Proxy-Authorization",
    "Cookie",
    "Set-Cookie",
    "X-Cron-Secret",
    "X-Inbound-Secret",
    "X-Telegram-Bot-Api-Secret-Token",
    "X-Api-Key",
    "X-Reset-Password",
  ]) {
    assert.equal(h[gone], undefined, `leaked header: ${gone}`);
  }
  // Non-secret headers survive so events stay useful.
  assert.equal(h["Content-Type"], "application/json");
  assert.equal(h["X-Request-Id"], "keep-me");
});

test("no request object → no crash", () => {
  const out = scrubSentryEvent({ tags: { status_code: 500 } } as unknown as Sentry.Event);
  assert.notEqual(out, null);
});

console.log("sentry-scrub: all tests passed");
