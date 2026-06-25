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

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), "dispatchos-insurance-test.db");
// No alert channels -> notify() is a no-op (no network).
delete process.env.TELEGRAM_ALERT_CHAT_ID;
delete process.env.DISPATCHOS_OWNER_EMAIL;

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
