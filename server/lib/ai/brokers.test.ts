// Broker history tests.
// Run: npx tsx server/lib/ai/brokers.test.ts

import { buildHistory, combineVerdicts, brokerEventSchema } from "./brokers";
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

// ---------------------------------------------------------------------------
// REGRESSION: brokerEventSchema.amountUsd must reject non-finite / negative
// money.
//
// The field is `z.number().finite().nonnegative().optional()`. A teammate
// refactoring nearby could trim those refinements back to a bare `z.number()`.
// Pre-fix (bare z.number()) every one of these would have PARSED SUCCESSFULLY,
// poisoning totalGross / totalLost with NaN, Infinity, or a negative credit.
// These guards PASS on the current code and would FAIL if .finite() /
// .nonnegative() were removed.
// ---------------------------------------------------------------------------
{
  // A complete, otherwise-valid event we can mutate the amount on.
  const base = {
    id: "reg1",
    brokerMc: "MC-470488",
    eventType: "load_booked" as const,
    loggedByUserId: "u1",
    loggedAt: "2026-06-29T00:00:00.000Z",
  };

  // Negative amount — would have been accepted by a bare z.number().
  const neg = brokerEventSchema.safeParse({ ...base, amountUsd: -2500 });
  assert("schema: rejects negative amountUsd", neg.success === false, `success=${neg.success}`);

  // NaN — passes typeof === "number" but is not finite.
  const nan = brokerEventSchema.safeParse({ ...base, amountUsd: Number.NaN });
  assert("schema: rejects NaN amountUsd", nan.success === false, `success=${nan.success}`);

  // +Infinity — also typeof number, not finite.
  const posInf = brokerEventSchema.safeParse({ ...base, amountUsd: Number.POSITIVE_INFINITY });
  assert("schema: rejects +Infinity amountUsd", posInf.success === false, `success=${posInf.success}`);

  // -Infinity — covers the non-finite + negative corner together.
  const negInf = brokerEventSchema.safeParse({ ...base, amountUsd: Number.NEGATIVE_INFINITY });
  assert("schema: rejects -Infinity amountUsd", negInf.success === false, `success=${negInf.success}`);

  // A valid positive amount still parses (the constraint must not over-reject).
  const ok = brokerEventSchema.safeParse({ ...base, amountUsd: 2500 });
  assert("schema: accepts positive amountUsd", ok.success === true, JSON.stringify(ok.success === false ? ok.error.issues : null));
  assert(
    "schema: parsed amount preserved",
    ok.success === true && ok.data.amountUsd === 2500,
  );

  // amountUsd is optional — an event with no amount (e.g. a note) still parses.
  const noAmount = brokerEventSchema.safeParse({ ...base, eventType: "responsive" as const });
  assert("schema: amountUsd optional (absent ok)", noAmount.success === true, `success=${noAmount.success}`);

  // Zero is non-negative and finite → valid.
  const zero = brokerEventSchema.safeParse({ ...base, amountUsd: 0 });
  assert("schema: accepts zero amountUsd", zero.success === true, `success=${zero.success}`);
}

// ---------------------------------------------------------------------------
// REGRESSION: buildHistory over schema-VALID events totals correctly.
//
// Because the schema now blocks non-finite/negative money upstream,
// buildHistory only ever sees clean amounts. This locks in that the gross/lost
// accumulation stays exact for a realistic mixed event log — a deterministic,
// fixed-input sanity check that would catch an accumulation regression in the
// load_booked / non_payment / rate_disputed branches.
// ---------------------------------------------------------------------------
{
  const at = "2026-06-29T00:00:00.000Z";
  const raw = [
    { id: "h1", brokerMc: "MC-470488", eventType: "load_booked", amountUsd: 2000, loggedByUserId: "u1", loggedAt: at },
    { id: "h2", brokerMc: "MC-470488", eventType: "load_booked", amountUsd: 3000, loggedByUserId: "u1", loggedAt: at },
    { id: "h3", brokerMc: "MC-470488", eventType: "load_booked", amountUsd: 1500.5, loggedByUserId: "u1", loggedAt: at },
    { id: "h4", brokerMc: "MC-470488", eventType: "load_completed", loggedByUserId: "u1", loggedAt: at },
    { id: "h5", brokerMc: "MC-470488", eventType: "non_payment", amountUsd: 1200, loggedByUserId: "u1", loggedAt: at },
    { id: "h6", brokerMc: "MC-470488", eventType: "rate_disputed", amountUsd: 300.25, loggedByUserId: "u1", loggedAt: at },
  ];

  // Every event must pass the schema (proves the totals below are over valid input).
  const parsed: BrokerEvent[] = raw.map((r, i) => {
    const p = brokerEventSchema.safeParse(r);
    assert(`history: event ${i} schema-valid`, p.success === true, p.success === false ? JSON.stringify(p.error.issues) : "");
    return (p.success ? p.data : (r as BrokerEvent));
  });

  const h = buildHistory(parsed);
  // gross = 2000 + 3000 + 1500.5 = 6500.5
  assert("history: totalGross exact", h.totalGross === 6500.5, `got ${h.totalGross}`);
  // lost = non_payment 1200 + rate_disputed 300.25 = 1500.25
  assert("history: totalLost exact", h.totalLost === 1500.25, `got ${h.totalLost}`);
  assert("history: 3 loads booked", h.loadsTotal === 3, `got ${h.loadsTotal}`);
  assert("history: 1 non-payment flag", h.flags.nonPayments === 1, `got ${h.flags.nonPayments}`);
  assert("history: 1 rate dispute flag", h.flags.rateDisputes === 1, `got ${h.flags.rateDisputes}`);
  // Totals are finite numbers (would be NaN if a poisoned amount had slipped through).
  assert("history: totals are finite", Number.isFinite(h.totalGross) && Number.isFinite(h.totalLost));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
