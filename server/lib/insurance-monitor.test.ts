// Insurance-expiry monitor integration test (temp DB, no network).
// Run: npx tsx server/lib/insurance-monitor.test.ts
//
// runInsuranceCheck scans every client's three insurance expiry dates and,
// for each that crosses a milestone (ALERT_THRESHOLDS = 14/7/3/1/0/-1/-7 days),
// fires a one-shot alert (deduped per threshold). With no Telegram chat / owner
// email configured, notify() sends nothing (channels=[]) and makes no network
// call — so we can assert the pure detection + dedup logic deterministically.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-insurance-test-${Date.now()}.db`);
// No alert channels -> notify() is a no-op (no network) for the detection tests.
delete process.env.TELEGRAM_ALERT_CHAT_ID;
delete process.env.DISPATCHOS_OWNER_EMAIL;
delete process.env.OWNER_EMAIL;
// A Resend key so sendEmail() does NOT short-circuit in the HTML-escaping test
// below. We never actually hit the network — globalThis.fetch is stubbed there.
// Set before any import so integration-config never caches it as undefined.
process.env.RESEND_API_KEY = "re_test_key_not_real";

const { storage } = await import("../storage");
const { runInsuranceCheck } = await import("./insurance-monitor");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const rnd = () => Math.random().toString(36).slice(2, 10);

const TODAY = "2026-06-15";

function mkClient(id: string, ins: Record<string, string>): string {
  storage.upsertClient({
    id,
    name: `Carrier ${id}`,
    mc: `MC-${Math.floor(100000 + Math.random() * 800000)}`,
    equipment: "hotshot_flatbed",
    targetPpm: 2.2,
    minimumPpm: 1.9,
    mpg: 10,
    fuelPrice: 3.6,
    fixedCostPerMile: 0.35,
    preferredLanes: [],
    avoidStates: [],
    ...ins,
  } as Parameters<typeof storage.upsertClient>[0]);
  return id;
}

const suffix = rnd();
// 7 days out -> threshold 7.
const cExpiring = mkClient(`ins-exp-${suffix}`, { cargoInsuranceExpiresAt: "2026-06-22" });
// Today -> threshold 0.
const cToday = mkClient(`ins-today-${suffix}`, { cargoInsuranceExpiresAt: "2026-06-15" });
// 5 days expired -> threshold -1.
const cExpired = mkClient(`ins-expired-${suffix}`, { cargoInsuranceExpiresAt: "2026-06-10" });
// 15 days out -> just past the 14-day window -> no alert.
const cFuture = mkClient(`ins-future-${suffix}`, { cargoInsuranceExpiresAt: "2026-06-30" });
// No insurance dates -> never alerts.
const cNone = mkClient(`ins-none-${suffix}`, {});
// Garbage / unparseable expiry -> must NOT be treated as "expires today".
const cGarbage = mkClient(`ins-garbage-${suffix}`, { cargoInsuranceExpiresAt: "TBD" });

const res = await runInsuranceCheck(TODAY, null);
const mine = res.alertsSent.filter((a) => a.clientId.endsWith(suffix));
const byClient = (cid: string) => mine.find((a) => a.clientId === cid);

assert("expiring-in-7 alerts at threshold 7", byClient(cExpiring)?.daysBefore === 7, JSON.stringify(byClient(cExpiring)));
assert("due-today alerts at threshold 0", byClient(cToday)?.daysBefore === 0, JSON.stringify(byClient(cToday)));
assert("expired-5d alerts at threshold -1", byClient(cExpired)?.daysBefore === -1, JSON.stringify(byClient(cExpired)));
assert("15-days-out does NOT alert (past window)", !byClient(cFuture));
assert("no-insurance client does NOT alert", !byClient(cNone));
assert("unparseable expiry does NOT fire a false 'today' alert", !byClient(cGarbage), JSON.stringify(byClient(cGarbage)));
assert("exactly 3 of my clients alerted", mine.length === 3, `got ${mine.length}`);
assert("cargo type + label resolved", byClient(cToday)?.insuranceType === "cargo");
assert("no channels sent (no config -> no network)", mine.every((a) => a.channels.length === 0));

// Dedup: record the cExpiring alert, re-run -> it's skipped, not re-emitted.
storage.recordInsuranceAlertSent({
  clientId: cExpiring,
  insuranceType: "cargo",
  expiresAt: "2026-06-22",
  daysBefore: 7,
  channels: ["telegram"],
});
const res2 = await runInsuranceCheck(TODAY, null);
const mine2 = res2.alertsSent.filter((a) => a.clientId.endsWith(suffix));
assert("after recording, that alert is no longer re-emitted", !mine2.find((a) => a.clientId === cExpiring));
assert("skip counter advanced on re-run", res2.skippedAsAlreadySent >= 1, String(res2.skippedAsAlreadySent));

// ===========================================================================
// REGRESSION: owner-email HTML body escapes tenant-controlled values.
// ===========================================================================
//
// notify() interpolates the carrier name (and id/expiry) into the owner's
// alert email HTML. The name comes straight off the client record (tenant
// input). The fix wraps every dynamic value in escapeHtml() before building
// the HTML body. If a future refactor drops that escaping and interpolates the
// raw name, a carrier called `<img src=x onerror=alert(1)>` would inject live
// markup into the owner's inbox (HTML-injection / stored-XSS into the email).
//
// To exercise the email branch deterministically (NO network): we resolve an
// owner email via the override arg, leave a Resend key in env (set at top), and
// stub globalThis.fetch so sendEmail's POST to Resend is captured in-process —
// no socket is ever opened. We then read the exact `html` / `text` payload that
// would have been sent and assert on the escaping.
{
  const realFetch = globalThis.fetch;
  // Carrier name carrying an XSS/HTML-injection payload + a bare ampersand.
  const PAYLOAD = `<img src=x onerror="alert(1)"> & "Acme" <b>Logistics</b>`;
  // Unique marker so we capture THIS client's email even though the same run
  // also emails other clients seeded earlier (call ordering is irrelevant).
  const PT_MARKER = `Logistics</b>`;
  let capturedHtml: string | null = null;
  let capturedText: string | null = null;
  let capturedSubject: string | null = null;
  let payloadEmailCount = 0;

  // Deterministic, offline stub. sendEmail() POSTs JSON {html,text,subject,...}
  // to api.resend.com; we record only the call carrying our payload and return a
  // minimal OK Response. No real network, no timers beyond the one
  // fetchWithTimeout clears immediately.
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    try {
      const parsed = JSON.parse(String(init?.body ?? "{}"));
      const text = typeof parsed.text === "string" ? parsed.text : "";
      if (text.includes(PT_MARKER)) {
        payloadEmailCount++;
        capturedHtml = typeof parsed.html === "string" ? parsed.html : null;
        capturedText = text;
        capturedSubject = typeof parsed.subject === "string" ? parsed.subject : null;
      }
    } catch {
      /* ignore non-JSON bodies */
    }
    return new Response(JSON.stringify({ id: "email_test_id" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  try {
    const cInject = `ins-inject-${suffix}`;
    storage.upsertClient({
      id: cInject,
      name: PAYLOAD,
      mc: `MC-${Math.floor(100000 + Math.random() * 800000)}`,
      equipment: "hotshot_flatbed",
      targetPpm: 2.2,
      minimumPpm: 1.9,
      mpg: 10,
      fuelPrice: 3.6,
      fixedCostPerMile: 0.35,
      preferredLanes: [],
      avoidStates: [],
      // Due today -> threshold 0 -> exactly one alert this run.
      cargoInsuranceExpiresAt: TODAY,
    } as Parameters<typeof storage.upsertClient>[0]);

    // Resolve an owner email via the override so notify() enters the email branch.
    const resEmail = await runInsuranceCheck(TODAY, "owner@example.test");
    const injAlert = resEmail.alertsSent.find((a) => a.clientId === cInject);

    assert("inject client alerted (due today)", injAlert?.daysBefore === 0, JSON.stringify(injAlert));
    // The email channel actually fired (proves the HTML branch executed, not a
    // no-op) — guards the test itself against silently never reaching escaping.
    assert("email channel reported sent", injAlert?.channels.includes("email") === true, JSON.stringify(injAlert?.channels));
    assert("resend email for this carrier sent exactly once", payloadEmailCount === 1, String(payloadEmailCount));
    assert("html body captured", typeof capturedHtml === "string" && capturedHtml.length > 0);

    const html = capturedHtml ?? "";
    // REGRESSION (would FAIL pre-fix): the raw <img> tag must NOT appear in the
    // HTML body. Pre-fix raw interpolation would emit it verbatim.
    assert("html does NOT contain raw <img tag", !html.includes("<img"), html.slice(0, 200));
    // REGRESSION: angle brackets from the payload's <b> are neutralised too.
    assert("html does NOT contain raw <b> tag", !html.includes("<b>"), html.slice(0, 200));
    // REGRESSION: the payload appears in its HTML-escaped form instead.
    assert("html contains escaped &lt;img", html.includes("&lt;img"), html.slice(0, 200));
    assert("html contains escaped &amp; for bare ampersand", html.includes("&amp;"), html.slice(0, 200));
    // REGRESSION: the double-quote in the payload is entity-encoded (attribute
    // breakout protection), so no raw onerror="..." survives in the markup.
    assert('html does NOT contain raw onerror=" attribute', !html.includes('onerror="'), html.slice(0, 200));

    // Plaintext field is intentionally NOT escaped — the raw name must survive
    // verbatim in the text body (escaping there would corrupt the plaintext UX).
    const text = capturedText ?? "";
    assert("plaintext body contains the RAW (unescaped) carrier name", text.includes(PAYLOAD), text.slice(0, 200));
    assert("plaintext body does NOT contain HTML entities from escaping", !text.includes("&lt;") && !text.includes("&amp;"), text.slice(0, 200));
    // The subject is the headline (no tenant name) — sanity that it's plain.
    assert("subject is a plain headline (no injected markup)", typeof capturedSubject === "string" && !capturedSubject!.includes("<img"), String(capturedSubject));
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
