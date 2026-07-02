// Trial-expiry lifecycle integration test (temp DB, no network).
// Run: npx tsx server/lib/trial-expiry.test.ts
//
// runTrialExpiryCheck walks trial clients and either:
//   - flips an ended trial (no LIVE Stripe sub) to billingStatus="expired"
//     (read-only), or
//   - emits a reminder at exactly 7/3/1 days out (deduped per day).
// The critical guard: a client on a LIVE subscription is NOT expired — but a
// bare leftover stripeSubscriptionId is NOT proof of a live sub (a canceled/
// incomplete checkout leaves billingStatus='trial' + a stale id). Liveness is
// judged by billingStatus and the (re-synced) trial window, NOT id presence:
//   - billingStatus='trial' + ended window + stale sub id  -> EXPIRED
//   - live trialing sub (trial window re-synced into the future) -> NOT expired
//
// With no Telegram/email configured, sends are no-ops (no network), so the
// state transitions + outcomes are deterministic.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), "dispatchos-trial-test.db");
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_DRIVER_BOT_TOKEN;
delete process.env.TELEGRAM_ALERT_CHAT_ID;
delete process.env.OWNER_EMAIL;
delete process.env.RESEND_FROM_EMAIL;

const { storage } = await import("../storage");
const { runTrialExpiryCheck } = await import("./trial-expiry");

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
const DAY = 24 * 3600 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

function mkClient(id: string, extra: Record<string, unknown>): string {
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
    ...extra,
  } as Parameters<typeof storage.upsertClient>[0]);
  return id;
}

const sfx = rnd();
const expiredNoSub = mkClient(`trial-exp-${sfx}`, { billingStatus: "trial", trialEndsAt: "2020-01-01" });
// Dead checkout: trial window ended, billingStatus still 'trial', but a stale
// sub id lingers from a canceled/incomplete subscription. This is NOT a live
// sub, so it MUST expire (the bug was that the bare id blocked expiry forever).
const expiredStaleSub = mkClient(`trial-stale-${sfx}`, {
  billingStatus: "trial",
  trialEndsAt: "2020-01-01",
  stripeSubscriptionId: "sub_dead_123",
});
// Genuinely live trialing sub: the webhook re-synced trial_end forward, so the
// fresh trial window is still in the future (and outside the 7/3/1 reminder
// window). This client must NOT be expired and must produce no outcome.
const liveTrialSub = mkClient(`trial-live-${sfx}`, {
  billingStatus: "trial",
  trialEndsAt: inDays(10),
  stripeSubscriptionId: "sub_paying_123",
});
const remind3 = mkClient(`trial-r3-${sfx}`, { billingStatus: "trial", trialEndsAt: inDays(3) });
const notWindow = mkClient(`trial-r5-${sfx}`, { billingStatus: "trial", trialEndsAt: inDays(5) });
const activeAcct = mkClient(`trial-active-${sfx}`, { billingStatus: "active", trialEndsAt: inDays(3) });
const noEnd = mkClient(`trial-noend-${sfx}`, { billingStatus: "trial" });

const outcomes = await runTrialExpiryCheck();
const mine = outcomes.filter((o) => o.clientId.endsWith(sfx));
const byId = (id: string) => mine.find((o) => o.clientId === id);

// Expiry path.
assert("ended trial w/o Stripe -> expired outcome", byId(expiredNoSub)?.kind === "expired");
assert(
  "ended trial flips DB billingStatus to expired",
  (storage.getClient(expiredNoSub) as Record<string, unknown>).billingStatus === "expired",
);
// Stale sub id alone must NOT block expiry — a dead checkout's leftover id is
// not a live sub, so the ended trial still flips to 'expired'.
assert("ended trial w/ STALE sub id -> expired outcome", byId(expiredStaleSub)?.kind === "expired");
assert(
  "ended trial w/ stale sub id flips DB billingStatus to expired",
  (storage.getClient(expiredStaleSub) as Record<string, unknown>).billingStatus === "expired",
);
// A genuinely live trialing sub (trial window re-synced into the future) is
// left untouched — neither expired nor (being outside 7/3/1) reminded.
assert("live trialing sub -> NOT expired (no outcome)", !byId(liveTrialSub));
assert(
  "live trialing sub stays trial (not locked out)",
  (storage.getClient(liveTrialSub) as Record<string, unknown>).billingStatus === "trial",
);

// Reminder path.
assert("3-days-out -> reminder outcome", byId(remind3)?.kind === "reminder");
assert("reminder reports daysUntil 3", byId(remind3)?.daysUntil === 3, String(byId(remind3)?.daysUntil));
assert("5-days-out (not in 7/3/1) -> no outcome", !byId(notWindow));
assert("active (non-trial) account ignored", !byId(activeAcct));
assert("trial without end date ignored", !byId(noEnd));
assert("no channels sent (nothing configured)", mine.every((o) => o.channels.length === 0));

// Dedup: record the 3-day reminder, re-run -> not re-emitted.
storage.recordComplianceAlertSent({
  clientId: remind3,
  kind: "trial_reminder",
  expiresAt: (storage.getClient(remind3) as Record<string, string>).trialEndsAt,
  daysBefore: 3,
  channels: ["telegram"],
});
const outcomes2 = await runTrialExpiryCheck();
assert(
  "recorded reminder not re-emitted on next run",
  !outcomes2.filter((o) => o.clientId.endsWith(sfx)).find((o) => o.clientId === remind3 && o.kind === "reminder"),
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
