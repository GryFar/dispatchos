// ===========================================================================
// server/lib/billing-run.test.ts — weekly billing run (cron path).
// Run: npx tsx server/lib/billing-run.test.ts
// ===========================================================================
//
// Pins the launch-critical properties of runWeeklyBillingForAllClients:
//   1. Only 'active'/'past_due' clients with DELIVERED PLATFORM-SOURCED loads in
//      the last CLOSED week get an invoice, and the CRON invoice is 3% ONLY
//      (flat fee 0 — self-serve pricing is "subscription + 3%", the $150 flat is
//      the manual admin route's legacy managed-dispatch model).
//   2. Re-running never creates a second invoice — a still-draft, never-charged
//      invoice is RETRIED (charge only), anything else is skipped.
//   3. trial / expired / canceled / zero-billable clients are never invoiced —
//      a trialing customer with a card on file must NOT be charged during the
//      advertised free trial.
//
// UPDATED for the 2026-07 fee restructure: loads are now created platform-
// sourced (sourceId set) AND delivered in-window (deliveredAt), which is what
// listDeliveredSourcedLoadsForClientWeek/computeInvoiceForWeek bill. Manual
// (self-entered) loads leave source_id NULL and are exempt.

import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// billing-run.ts imports ../storage, which opens better-sqlite3 at module load
// using DISPATCHOS_DB_PATH — point it at a temp file BEFORE importing (same
// pattern as billing.test.ts). Also make sure no Stripe key leaks in from the
// environment: charge attempts must resolve to "stripe_not_configured".
process.env.DISPATCHOS_DB_PATH = join(
  tmpdir(),
  `dispatchos-billing-run-test-${Date.now()}-${process.pid}.db`,
);
delete process.env.STRIPE_SECRET_KEY;
delete process.env.DISPATCHOS_WEEKLY_FLAT_FEE_CENTS;

const { runWeeklyBillingForAllClients, lastClosedBillingWeek } = await import("./billing-run");
const { storage } = await import("../storage");

test("lastClosedBillingWeek — Mon–Sun window, closed only", () => {
  // Monday 2026-06-29 → last closed week is Mon 22 .. Sun 28.
  assert.deepEqual(lastClosedBillingWeek(0, new Date("2026-06-29T12:00:00Z")), {
    weekStart: "2026-06-22",
    weekEnd: "2026-06-28",
  });
  // Sunday 2026-06-28 — the running week has not closed yet.
  assert.deepEqual(lastClosedBillingWeek(0, new Date("2026-06-28T23:00:00Z")), {
    weekStart: "2026-06-15",
    weekEnd: "2026-06-21",
  });
  // weekOffset shifts one full week further back.
  assert.deepEqual(lastClosedBillingWeek(1, new Date("2026-06-29T12:00:00Z")), {
    weekStart: "2026-06-15",
    weekEnd: "2026-06-21",
  });
});

test("weekly run — 3%-only for active clients, retry on re-run, trial/canceled/idle skipped", async () => {
  const { weekStart, weekEnd } = lastClosedBillingWeek();
  const bookedAt = `${weekStart}T12:00:00.000Z`;

  const rnd = () => Math.random().toString(36).slice(2, 10);
  const clientA = `bruncli-a-${rnd()}`; // active, $3000 booked
  const clientB = `bruncli-b-${rnd()}`; // active, $500 booked
  const clientC = `bruncli-c-${rnd()}`; // canceled — never billed
  const clientD = `bruncli-d-${rnd()}`; // TRIAL with a booked load — never billed
  const clientE = `bruncli-e-${rnd()}`; // active, idle week — no $0 invoice

  // Paying plan (fleet_scale, $129/mo → 2× cap $258) so the monthly cap never
  // clamps the small fees under test here.
  const mkClient = (id: string, billingStatus: string) =>
    storage.upsertClient({ id, name: `Run Co ${id}`, billingStatus, planTier: "fleet_scale" } as Parameters<
      typeof storage.upsertClient
    >[0]);
  mkClient(clientA, "active");
  mkClient(clientB, "active");
  mkClient(clientC, "canceled");
  mkClient(clientD, "trial");
  mkClient(clientE, "active");

  // Loads are platform-sourced AND delivered in-window — the billable shape.
  // deliveredAt lands mid-week (weekStart + a few hours) so it's inside the
  // closed week the cron bills.
  const deliveredAt = `${weekStart}T18:00:00.000Z`;
  const mkLoad = (clientId: string, i: number, rate: number, at = bookedAt) =>
    storage.upsertLoad({
      id: `brun-load-${clientId}-${i}`,
      clientId,
      bookedAt: at,
      deliveredAt,
      status: "completed",
      sourceId: "src-test",
      sourceExternalId: `ext-${clientId}-${i}`,
      rate,
      brokerMc: "MC-1",
      brokerName: "B",
    } as Parameters<typeof storage.upsertLoad>[0]);

  mkLoad(clientA, 1, 1000);
  mkLoad(clientA, 2, 2000);
  mkLoad(clientB, 1, 500);
  mkLoad(clientC, 1, 9999); // canceled client — must never be billed
  mkLoad(clientD, 1, 7777); // trialing client — must never be billed

  // --- First run: the two active+booked clients invoiced, rest skipped. ------
  const run1 = await runWeeklyBillingForAllClients();
  assert.equal(run1.weekStart, weekStart);
  assert.equal(run1.weekEnd, weekEnd);
  assert.equal(run1.generated, 2, JSON.stringify(run1.results));
  assert.equal(run1.failed, 0, JSON.stringify(run1.results));
  // No Stripe key in the test env → invoices persist but charges don't fire.
  assert.equal(run1.charged, 0);
  const resultFor = (run: typeof run1, id: string) => run.results.find((r) => r.clientId === id);
  assert.equal(resultFor(run1, clientC)?.reason, "client_canceled");
  assert.equal(resultFor(run1, clientD)?.reason, "client_trial");
  assert.equal(resultFor(run1, clientE)?.reason, "no_booked_loads");
  for (const id of [clientC, clientD, clientE]) {
    assert.equal(resultFor(run1, id)?.outcome, "skipped");
    assert.equal(storage.findInvoiceForWeek(id, weekStart), undefined, `${id} must not be billed`);
  }
  for (const id of [clientA, clientB]) {
    const r = resultFor(run1, id);
    assert.equal(r?.outcome, "generated", `client ${id}: ${JSON.stringify(r)}`);
    assert.equal(r?.chargeStatus, "stripe_not_configured");
  }

  // --- Totals: 3% ONLY — the cron must not levy the legacy $150 flat. --------
  const invA = storage.findInvoiceForWeek(clientA, weekStart);
  assert.ok(invA, "client A invoice exists");
  assert.equal(invA.flatFee, 0);
  assert.equal(invA.grossBooked, 3000);
  assert.equal(invA.percentFee, 90);
  assert.equal(invA.totalDue, 90);
  assert.equal(invA.status, "draft"); // uncharged stays retriable

  const invB = storage.findInvoiceForWeek(clientB, weekStart);
  assert.ok(invB, "client B invoice exists");
  assert.equal(invB.flatFee, 0);
  assert.equal(invB.grossBooked, 500);
  assert.equal(invB.percentFee, 15);
  assert.equal(invB.totalDue, 15);

  // --- Second run: no new invoices; still-draft charges are RETRIED. ---------
  const run2 = await runWeeklyBillingForAllClients();
  assert.equal(run2.generated, 0, JSON.stringify(run2.results));
  assert.equal(run2.failed, 0);
  assert.equal(run2.retried, 2, JSON.stringify(run2.results));
  for (const id of [clientA, clientB]) {
    const r = resultFor(run2, id);
    assert.equal(r?.outcome, "retried", `client ${id}: ${JSON.stringify(r)}`);
    assert.equal(r?.chargeStatus, "stripe_not_configured");
  }
  // Still exactly one invoice per client (same ids as run 1), still draft.
  assert.equal(storage.findInvoiceForWeek(clientA, weekStart)?.id, invA.id);
  assert.equal(storage.findInvoiceForWeek(clientB, weekStart)?.id, invB.id);
  assert.equal(storage.findInvoiceForWeek(clientA, weekStart)?.status, "draft");
});

test("weekly run — DISPATCHOS_WEEKLY_FLAT_FEE_CENTS env knob restores a flat fee", async () => {
  // Bill a DIFFERENT (earlier) week so the unique index can't collide with the
  // main test above.
  const { weekStart } = lastClosedBillingWeek(1);
  const clientF = `bruncli-f-${Math.random().toString(36).slice(2, 10)}`;
  storage.upsertClient({ id: clientF, name: "Run Co F", billingStatus: "active", planTier: "fleet_scale" } as Parameters<
    typeof storage.upsertClient
  >[0]);
  storage.upsertLoad({
    id: `brun-load-${clientF}-1`,
    clientId: clientF,
    bookedAt: `${weekStart}T12:00:00.000Z`,
    deliveredAt: `${weekStart}T18:00:00.000Z`,
    status: "completed",
    sourceId: "src-test",
    sourceExternalId: `ext-${clientF}-1`,
    rate: 1000,
    brokerMc: "MC-1",
    brokerName: "B",
  } as Parameters<typeof storage.upsertLoad>[0]);

  process.env.DISPATCHOS_WEEKLY_FLAT_FEE_CENTS = "15000";
  try {
    const run = await runWeeklyBillingForAllClients(1);
    const r = run.results.find((x) => x.clientId === clientF);
    assert.equal(r?.outcome, "generated", JSON.stringify(run.results));
    const inv = storage.findInvoiceForWeek(clientF, weekStart);
    assert.ok(inv);
    assert.equal(inv.flatFee, 150);
    assert.equal(inv.percentFee, 30);
    assert.equal(inv.totalDue, 180);
  } finally {
    delete process.env.DISPATCHOS_WEEKLY_FLAT_FEE_CENTS;
  }
});
