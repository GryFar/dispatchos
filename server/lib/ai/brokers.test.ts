// Broker history tests.
// Run: npx tsx server/lib/ai/brokers.test.ts

import { buildHistory, combineVerdicts } from "./brokers";
import type { BrokerEvent } from "./brokers";
import type { FmcsaVerdict } from "./fmcsa";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

let id = 0;
function ev(type: BrokerEvent["eventType"], extra: Partial<BrokerEvent> = {}): BrokerEvent {
  return {
    id: `e${++id}`,
    brokerMc: "MC-470488",
    eventType: type,
    loggedByUserId: "u1",
    loggedAt: new Date().toISOString(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Empty history → unknown
// ---------------------------------------------------------------------------
{
  const h = buildHistory([], "Test Broker");
  assert("empty: verdict unknown", h.verdict === "unknown");
  assert("empty: score neutral 50", h.performanceScore === 50);
  assert("empty: reasons mention no history", h.reasons[0]?.toLowerCase().includes("no history") ?? false);
}

// ---------------------------------------------------------------------------
// Strong relationship — 50 loads, all on time, no issues
// ---------------------------------------------------------------------------
{
  const events: BrokerEvent[] = [];
  for (let i = 0; i < 50; i++) {
    events.push(ev("load_booked", { amountUsd: 2000 }));
    events.push(ev("load_completed"));
    events.push(ev("paid_on_time"));
    events.push(ev("rate_honored"));
  }
  events.push(ev("responsive"));
  events.push(ev("responsive"));
  events.push(ev("responsive"));

  const h = buildHistory(events);
  assert("strong: verdict green", h.verdict === "green", `got ${h.verdict} score=${h.performanceScore}`);
  assert("strong: score ≥ 90", h.performanceScore >= 90, `got ${h.performanceScore}`);
  assert("strong: 50 completed loads", h.loadsCompleted === 50);
  assert("strong: $100k gross", h.totalGross === 100000);
  assert("strong: 0 lost", h.totalLost === 0);
  assert("strong: established partner reason", h.reasons.some(r => r.includes("established")));
}

// ---------------------------------------------------------------------------
// One non-payment kills score
// ---------------------------------------------------------------------------
{
  const events = [
    ev("load_booked", { amountUsd: 2500 }),
    ev("load_booked", { amountUsd: 2500 }),
    ev("load_booked", { amountUsd: 2500 }),
    ev("load_completed"),
    ev("load_completed"),
    ev("load_completed"),
    ev("paid_on_time"),
    ev("paid_on_time"),
    ev("non_payment", { amountUsd: 2500 }),
  ];
  const h = buildHistory(events);
  assert("nonpay: verdict at most yellow", h.verdict !== "green", `got ${h.verdict}`);
  assert("nonpay: lost 2500", h.totalLost === 2500);
  assert("nonpay: nonPayments = 1", h.flags.nonPayments === 1);
}

// ---------------------------------------------------------------------------
// Fraud report = instant red
// ---------------------------------------------------------------------------
{
  const events = [
    ev("load_booked", { amountUsd: 2000 }),
    ev("load_completed"),
    ev("fraud_report"),
  ];
  const h = buildHistory(events);
  assert("fraud: verdict red", h.verdict === "red");
  assert("fraud: score 0", h.performanceScore === 0);
}

// ---------------------------------------------------------------------------
// Two double-broker attempts = red
// ---------------------------------------------------------------------------
{
  const events: BrokerEvent[] = [];
  for (let i = 0; i < 5; i++) {
    events.push(ev("load_booked"));
    events.push(ev("load_completed"));
  }
  events.push(ev("double_broker_attempt"));
  events.push(ev("double_broker_attempt"));
  const h = buildHistory(events);
  assert("dbroker: verdict red", h.verdict === "red");
  assert("dbroker: score ≤ 10", h.performanceScore <= 10);
}

// ---------------------------------------------------------------------------
// combineVerdicts
// ---------------------------------------------------------------------------
{
  const cleanFmcsa: FmcsaVerdict = { verdict: "green", score: 95, reasons: ["clean"], redFlags: [] };
  const cleanHistory = buildHistory([
    ev("load_booked", { amountUsd: 2000 }),
    ev("load_booked", { amountUsd: 2000 }),
    ev("load_booked", { amountUsd: 2000 }),
    ev("load_booked", { amountUsd: 2000 }),
    ev("load_booked", { amountUsd: 2000 }),
    ev("load_completed"),
    ev("load_completed"),
    ev("load_completed"),
    ev("load_completed"),
    ev("load_completed"),
    ev("paid_on_time"),
    ev("paid_on_time"),
    ev("paid_on_time"),
    ev("paid_on_time"),
    ev("paid_on_time"),
  ]);
  const c1 = combineVerdicts(cleanFmcsa, cleanHistory);
  assert("combine: clean+clean = green", c1.verdict === "green");
  assert("combine: hasHistory true", c1.hasHistory === true);

  // FMCSA red wins
  const redFmcsa: FmcsaVerdict = { verdict: "red", score: 5, reasons: ["OOS"], redFlags: ["OOS"] };
  const c2 = combineVerdicts(redFmcsa, cleanHistory);
  assert("combine: red FMCSA → red", c2.verdict === "red");

  // Internal red also wins
  const redHistory = buildHistory([
    ev("load_booked"),
    ev("load_completed"),
    ev("fraud_report"),
  ]);
  const c3 = combineVerdicts(cleanFmcsa, redHistory);
  assert("combine: internal fraud → red", c3.verdict === "red");

  // No history — FMCSA dominates
  const c4 = combineVerdicts(cleanFmcsa, buildHistory([]));
  assert("combine: no history uses FMCSA score", c4.score === 95);
  assert("combine: no history hasHistory false", c4.hasHistory === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
