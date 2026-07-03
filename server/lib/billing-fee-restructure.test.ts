// ===========================================================================
// server/lib/billing-fee-restructure.test.ts
// Pins the 2026-07 success-fee restructure (three independent policy axes):
//
//   (a) SOURCE FILTER — the 3% success fee bills ONLY platform-sourced loads
//       (source_id NOT NULL). Self-entered / manual / CSV / self-dispatch loads
//       leave source_id NULL and are FREE.
//   (b) DELIVERY TRIGGER — a load bills in the week it is DELIVERED
//       (payload.deliveredAt in window), NOT the week it was booked. A load
//       booked in week 1 and delivered in week 3 bills in week 3; a
//       never-delivered load never bills.
//   (c) MONTHLY CAP — the month's total success fee is clamped to 2× the
//       client's plan monthlyCents. Accumulation across weeks in the same
//       calendar month counts existing NON-VOID invoices; void invoices don't.
//
// Run: npx tsx server/lib/billing-fee-restructure.test.ts
// ===========================================================================

import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(
  tmpdir(),
  `dispatchos-fee-restructure-${Date.now()}-${process.pid}.db`,
);

const { storage } = await import("../storage");
const { computeInvoiceForWeek, FLAT_FEE_CENTS } = await import("./billing");
const { PLANS } = await import("./plans");

const baseLoad = {
  source: "test",
  originCity: "Dallas", originState: "TX", originLat: 32.7, originLng: -96.8,
  destinationCity: "Phoenix", destinationState: "AZ", destinationLat: 33.4, destinationLng: -112.0,
  loadedMiles: 1065,
  pickupAt: "2026-06-10T08:00:00.000Z", deliveryAt: "2026-06-11T18:00:00.000Z",
  equipment: "open_car_hauler",
  brokerName: "B", brokerMc: "MC-1",
  brokerScore: 70, fraudRisk: 5, marketQuality: 60,
};

const rnd = () => Math.random().toString(36).slice(2, 10);
let seq = 0;

/** A paying client whose 2× cap is high enough to not clamp small fees. */
function mkClient(tier = "fleet_scale"): string {
  const id = `fee-cli-${rnd()}`;
  storage.upsertClient({ id, name: `Fee Co ${id}`, planTier: tier, billingStatus: "active" } as any);
  return id;
}

/** Create a load with explicit provenance + delivery, mirrored to columns. */
function mkLoad(clientId: string, opts: {
  rate: number;
  sourced?: boolean;      // sets source_id (default: true = platform-sourced)
  deliveredAt?: string;   // ISO timestamp; omit for a never-delivered load
  bookedAt?: string;
  status?: string;
}): string {
  const id = `fee-load-${clientId}-${seq++}`;
  storage.upsertLoad({
    ...baseLoad,
    id,
    clientId,
    rate: opts.rate,
    bookedAt: opts.bookedAt ?? "2026-06-01",
    ...(opts.sourced === false
      ? {}
      : { sourceId: "src-test", sourceExternalId: `ext-${id}` }),
    ...(opts.deliveredAt ? { deliveredAt: opts.deliveredAt, status: opts.status ?? "completed" } : {}),
  } as any);
  return id;
}

// ---------------------------------------------------------------------------
// (a) SOURCE FILTER
// ---------------------------------------------------------------------------
test("source filter — platform-sourced delivered loads bill; self-entered are exempt", () => {
  const client = mkClient();
  const WS = "2026-06-08", WE = "2026-06-14";
  const inWeek = "2026-06-10T12:00:00.000Z";

  mkLoad(client, { rate: 1000, sourced: true, deliveredAt: inWeek });   // billable
  mkLoad(client, { rate: 2000, sourced: true, deliveredAt: inWeek });   // billable
  mkLoad(client, { rate: 9000, sourced: false, deliveredAt: inWeek });  // self-entered → exempt

  const inv = computeInvoiceForWeek(client, WS, WE);
  assert.equal(inv.breakdown.loadCount, 2, "only the 2 sourced loads count");
  assert.equal(inv.grossBookedCents, 300_000, "gross = $1000 + $2000, self-entered $9000 excluded");
  assert.equal(inv.percentFeeCents, 9_000, "3% of $3000 = $90");
  assert.ok(!inv.breakdown.loads.some((l) => l.rateCents === 900_000), "self-entered load not in breakdown");
});

test("source filter — a purely self-entered client is billed $0 success fee", () => {
  const client = mkClient();
  const WS = "2026-06-08", WE = "2026-06-14";
  mkLoad(client, { rate: 5000, sourced: false, deliveredAt: "2026-06-10T12:00:00.000Z" });
  const inv = computeInvoiceForWeek(client, WS, WE);
  assert.equal(inv.grossBookedCents, 0);
  assert.equal(inv.percentFeeCents, 0);
  assert.equal(inv.breakdown.loadCount, 0);
});

// ---------------------------------------------------------------------------
// (b) DELIVERY TRIGGER (incl. cross-week booking/delivery + never-delivered)
// ---------------------------------------------------------------------------
test("delivery trigger — a load booked wk1, delivered wk3, bills in wk3 (not wk1)", () => {
  const client = mkClient();
  // Three consecutive Mon–Sun weeks in June 2026.
  const WK1 = { s: "2026-06-01", e: "2026-06-07" };
  const WK3 = { s: "2026-06-15", e: "2026-06-21" };

  // Booked in week 1, delivered in week 3.
  mkLoad(client, {
    rate: 4000, sourced: true,
    bookedAt: "2026-06-03",
    deliveredAt: "2026-06-17T09:00:00.000Z", // week 3
  });

  const wk1 = computeInvoiceForWeek(client, WK1.s, WK1.e);
  assert.equal(wk1.grossBookedCents, 0, "not billed in the booking week");
  assert.equal(wk1.percentFeeCents, 0);

  const wk3 = computeInvoiceForWeek(client, WK3.s, WK3.e);
  assert.equal(wk3.grossBookedCents, 400_000, "billed in the delivery week");
  assert.equal(wk3.percentFeeCents, 12_000, "3% of $4000 = $120");
});

test("delivery trigger — a never-delivered (or cancelled) load is never billed", () => {
  const client = mkClient();
  const WS = "2026-06-08", WE = "2026-06-14";

  // Sourced + booked in-window but NEVER delivered (no deliveredAt).
  mkLoad(client, { rate: 3000, sourced: true, bookedAt: "2026-06-10" });
  // Sourced + delivered in-window but then cancelled → excluded.
  mkLoad(client, { rate: 7000, sourced: true, deliveredAt: "2026-06-11T10:00:00.000Z", status: "cancelled" });

  const inv = computeInvoiceForWeek(client, WS, WE);
  assert.equal(inv.grossBookedCents, 0, "neither never-delivered nor cancelled contributes");
  assert.equal(inv.percentFeeCents, 0);
  assert.equal(inv.breakdown.loadCount, 0);
});

// ---------------------------------------------------------------------------
// (c) MONTHLY CAP = 2× plan monthlyCents
// ---------------------------------------------------------------------------
test("monthly cap — a single huge week is clamped to 2× plan price", () => {
  const client = mkClient("oo_premium"); // $29/mo → cap = $58 = 5_800¢
  const cap = PLANS.oo_premium!.monthlyCents * 2;
  assert.equal(cap, 5_800);
  const WS = "2026-06-01", WE = "2026-06-07";

  // $10,000 delivered → 3% = $300, far above the $58 cap.
  mkLoad(client, { rate: 10_000, sourced: true, deliveredAt: "2026-06-03T12:00:00.000Z" });

  const inv = computeInvoiceForWeek(client, WS, WE);
  assert.equal(inv.percentFeeUncappedCents, 30_000, "uncapped 3% of $10k = $300");
  assert.equal(inv.percentFeeCents, 5_800, "clamped to the $58 monthly cap");
  assert.equal(inv.capApplied, true);
  assert.equal(inv.monthlyCapCents, 5_800);
  assert.equal(inv.totalDueCents, FLAT_FEE_CENTS + 5_800);
});

test("monthly cap — accumulates across weeks in the same month, clamps to zero once exhausted", () => {
  const client = mkClient("oo_premium"); // cap = $58 = 5_800¢
  // Week 1 of June: a $1500 delivery → 3% = $45 (under cap). Persist it as a
  // real non-void invoice so the NEXT week sees it in the month total.
  const wk1 = { s: "2026-06-01", e: "2026-06-07" };
  mkLoad(client, { rate: 1500, sourced: true, deliveredAt: "2026-06-03T12:00:00.000Z" });
  const inv1 = computeInvoiceForWeek(client, wk1.s, wk1.e);
  assert.equal(inv1.percentFeeCents, 4_500, "wk1 3% of $1500 = $45, under the $58 cap");
  assert.equal(inv1.capApplied, false);
  storage.createInvoice({
    clientId: client, weekStart: wk1.s, weekEnd: wk1.e,
    flatFee: 0, percentFee: inv1.percentFee, grossBooked: inv1.grossBooked,
  });

  // Week 2 of June: a $2000 delivery → uncapped 3% = $60, but only $13 of cap
  // remains ($58 − $45), so it clamps to $13.
  const wk2 = { s: "2026-06-08", e: "2026-06-14" };
  mkLoad(client, { rate: 2000, sourced: true, deliveredAt: "2026-06-10T12:00:00.000Z" });
  const inv2 = computeInvoiceForWeek(client, wk2.s, wk2.e);
  assert.equal(inv2.percentFeeUncappedCents, 6_000, "wk2 uncapped = $60");
  assert.equal(inv2.monthAlreadyBilledCents, 4_500, "sees wk1's $45 already billed");
  assert.equal(inv2.percentFeeCents, 1_300, "clamped to remaining cap $58 − $45 = $13");
  assert.equal(inv2.capApplied, true);
  storage.createInvoice({
    clientId: client, weekStart: wk2.s, weekEnd: wk2.e,
    flatFee: 0, percentFee: inv2.percentFee, grossBooked: inv2.grossBooked,
  });

  // Week 3 of June: cap fully exhausted ($45 + $13 = $58) → any new fee = $0.
  const wk3 = { s: "2026-06-15", e: "2026-06-21" };
  mkLoad(client, { rate: 5000, sourced: true, deliveredAt: "2026-06-17T12:00:00.000Z" });
  const inv3 = computeInvoiceForWeek(client, wk3.s, wk3.e);
  assert.equal(inv3.monthAlreadyBilledCents, 5_800, "month total now at the cap");
  assert.equal(inv3.percentFeeUncappedCents, 15_000, "wk3 uncapped = $150");
  assert.equal(inv3.percentFeeCents, 0, "cap exhausted → clamp to zero");
  assert.equal(inv3.capApplied, true);
});

test("monthly cap — VOID invoices do not consume cap", () => {
  const client = mkClient("oo_premium"); // cap = $58
  const wk1 = { s: "2026-07-01", e: "2026-07-07" };
  // A $58 fee then VOIDED — must not permanently eat the month's cap.
  const voided = storage.createInvoice({
    clientId: client, weekStart: wk1.s, weekEnd: wk1.e,
    flatFee: 0, percentFee: 58, grossBooked: 1933.33,
  });
  const res = storage.updateInvoice(voided.id, { status: "void" });
  assert.ok("invoice" in res && res.invoice.status === "void", "invoice voided");

  // A live $30 invoice in the same month.
  storage.createInvoice({
    clientId: client, weekStart: "2026-07-08", weekEnd: "2026-07-14",
    flatFee: 0, percentFee: 30, grossBooked: 1000,
  });

  // New week: the voided $58 is ignored; only the live $30 counts, so $28 of cap
  // remains and a fresh $50 fee clamps to $28.
  const wk3 = { s: "2026-07-15", e: "2026-07-21" };
  mkLoad(client, { rate: 5000, sourced: true, deliveredAt: "2026-07-17T12:00:00.000Z" }); // 3% = $150
  const inv = computeInvoiceForWeek(client, wk3.s, wk3.e);
  assert.equal(inv.monthAlreadyBilledCents, 3_000, "only the live $30 counts, not the voided $58");
  assert.equal(inv.percentFeeCents, 2_800, "remaining cap $58 − $30 = $28");
  assert.equal(inv.capApplied, true);
});

test("monthly cap — cap is scoped to the calendar month (a new month resets it)", () => {
  const client = mkClient("oo_premium"); // cap = $58
  // June invoice at the cap.
  storage.createInvoice({
    clientId: client, weekStart: "2026-06-22", weekEnd: "2026-06-28",
    flatFee: 0, percentFee: 58, grossBooked: 1933.33,
  });
  // A July week starts fresh — June's fees don't count.
  const july = { s: "2026-07-06", e: "2026-07-12" };
  mkLoad(client, { rate: 1000, sourced: true, deliveredAt: "2026-07-08T12:00:00.000Z" });
  const inv = computeInvoiceForWeek(client, july.s, july.e);
  assert.equal(inv.monthAlreadyBilledCents, 0, "June's cap-consuming invoice is a different month");
  assert.equal(inv.percentFeeCents, 3_000, "full 3% of $1000 = $30, unclamped");
  assert.equal(inv.capApplied, false);
});
