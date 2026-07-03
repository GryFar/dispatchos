// ===========================================================================
// server/lib/billing.test.ts — integer-cents billing math (Audit Critical #7)
// ===========================================================================
//
// These tests pin the cents-based behaviour added in 2026-05-26.
//
// Pre-fix behaviour (kept here for context, not enforced):
//   grossBooked = roundCents(Σ rate)
//   percentFee  = roundCents(grossBooked * 0.03)
//   totalDue    = roundCents(flatFee + percentFee)
// — three independent roundings drifted by cents per invoice and by dollars
// over a quarter when many loads were summed.
//
// Post-fix behaviour:
//   grossBookedCents = Σ round(rate*100) — one rounding per load
//   percentFeeCents  = round(grossBookedCents * 300 / 10000)
//   totalDueCents    = flatFeeCents + percentFeeCents (no rounding)
// — exact integer math after each rate is converted to cents at the boundary.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// billing.ts imports ../storage, which opens better-sqlite3 at module load
// using DISPATCHOS_DB_PATH — point it at a temp file BEFORE importing so the
// computeInvoiceForWeek test below never touches a real database (same
// pattern as billing-week-boundary.test.ts).
process.env.DISPATCHOS_DB_PATH = join(
  tmpdir(),
  `dispatchos-billing-unit-test-${Date.now()}-${process.pid}.db`,
);
const { dollarsToCents, centsToDollars, FLAT_FEE_CENTS, computeInvoiceForWeek } =
  await import("./billing");
const { storage } = await import("../storage");

test("dollarsToCents — clean inputs", () => {
  assert.equal(dollarsToCents(0), 0);
  assert.equal(dollarsToCents(1), 100);
  assert.equal(dollarsToCents(123.45), 12345);
  assert.equal(dollarsToCents(2500), 250000);
});

test("dollarsToCents — float-noise: half-cent inputs are non-representable", () => {
  // Reality of IEEE 754: numbers like 1.005 are stored as 1.00499999… in
  // memory, so any rounding pipeline collapses them to 100¢. This is fine
  // for production money flow because rate-cons / forms never carry sub-cent
  // precision. The test pins observed behaviour so we don't accidentally
  // change it later.
  assert.equal(dollarsToCents(1.005), 100);
  assert.equal(dollarsToCents(2.675), 267);
  // Inputs that ARE representable round cleanly:
  assert.equal(dollarsToCents(1.01), 101);
  assert.equal(dollarsToCents(2.5), 250);
  assert.equal(dollarsToCents(99.99), 9999);
});

test("dollarsToCents — invalid inputs collapse to 0", () => {
  assert.equal(dollarsToCents(undefined), 0);
  assert.equal(dollarsToCents(null), 0);
  assert.equal(dollarsToCents(Number.NaN), 0);
  assert.equal(dollarsToCents(Number.POSITIVE_INFINITY), 0);
});

test("centsToDollars — round-trip stability", () => {
  for (const cents of [0, 1, 99, 100, 12345, 250_000, 9_999_999]) {
    assert.equal(dollarsToCents(centsToDollars(cents)), cents, `round-trip ${cents}`);
  }
});

test("FLAT_FEE_CENTS is $150 exactly", () => {
  assert.equal(FLAT_FEE_CENTS, 15_000);
  assert.equal(centsToDollars(FLAT_FEE_CENTS), 150);
});

test("percent fee is exactly 3% via basis points (no float drift)", () => {
  // Direct check of the basis-points formula used in computeInvoiceForWeek.
  // gross = $9,876.54 = 987_654¢ → fee = round(987654 * 300 / 10000) = 29_630¢ = $296.30
  const grossCents = 987_654;
  const feeCents = Math.round((grossCents * 300) / 10_000);
  assert.equal(feeCents, 29_630);
  assert.equal(centsToDollars(feeCents), 296.30);
});

test("invoice gross is the exact integer sum of per-load cents (fails on float-sum revert)", () => {
  // 100 loads at $1000.005 each. Per-load: dollarsToCents(1000.005) = 100_000¢
  // (1000.005 is stored as 1000.00499…, so toFixed(2) → "1000.00").
  // Old pre-fix pipeline float-summed the rates FIRST and rounded once:
  //   Σ rate = 100_000.4999… → round(×100) = 10_000_050¢
  // — a 50¢ divergence, so this test bites if billing ever reverts to
  // sum-then-round.
  const RATE = 1000.005;
  const COUNT = 100;
  const PER_LOAD_CENTS = 100_000;
  const EXPECTED_GROSS_CENTS = COUNT * PER_LOAD_CENTS; // 10_000_000¢

  // Guard the guard: prove the chosen inputs actually distinguish the two
  // pipelines, so the assertion below can never go vacuous.
  assert.equal(dollarsToCents(RATE), PER_LOAD_CENTS);
  const oldFloatSumCents = Math.round(
    Array.from({ length: COUNT }, () => RATE).reduce((s, r) => s + r, 0) * 100,
  );
  assert.notEqual(oldFloatSumCents, EXPECTED_GROSS_CENTS, "inputs no longer diverge; pick new rates");

  // Exercise the real invoice path end-to-end through storage. Post-2026-07 the
  // fee bills only platform-sourced (sourceId) loads DELIVERED in-window, so
  // stamp both on every load; the drift property (integer-exact gross sum) is
  // orthogonal to the source/delivery filter.
  const clientId = `bill-drift-${Math.random().toString(36).slice(2, 10)}`;
  // A paying client with a plan whose 2× cap ($598 for enterprise) is still far
  // below the uncapped $300k fee here — so we assert the UNCAPPED fee for the
  // drift check and the CAPPED fee separately below.
  storage.upsertClient({
    id: clientId, name: "Drift Co", planTier: "enterprise", billingStatus: "active",
  } as Parameters<typeof storage.upsertClient>[0]);
  for (let i = 0; i < COUNT; i++) {
    storage.upsertLoad({
      id: `load-drift-${clientId}-${i}`,
      clientId,
      bookedAt: "2026-06-10T12:00:00.000Z",
      deliveredAt: "2026-06-11T12:00:00.000Z", // inside the billed week
      status: "completed",
      sourceId: "src-test",
      sourceExternalId: `ext-drift-${i}`,
      rate: RATE,
      brokerMc: "MC-1",
      brokerName: "B",
    } as Parameters<typeof storage.upsertLoad>[0]);
  }

  const inv = computeInvoiceForWeek(clientId, "2026-06-08", "2026-06-14");
  assert.equal(inv.breakdown.loadCount, COUNT);
  // EXACT integer equality — no tolerance. A float-sum revert yields
  // 10_000_050¢ here and fails.
  assert.equal(inv.grossBookedCents, EXPECTED_GROSS_CENTS);
  assert.equal(inv.grossBooked, centsToDollars(EXPECTED_GROSS_CENTS));
  // 3% in basis points on the exact gross: 10_000_000 × 300 / 10_000 = 300_000¢.
  // This is the UNCAPPED fee — the drift property lives here, before clamping.
  assert.equal(inv.percentFeeUncappedCents, 300_000);
  // The monthly cap = 2 × enterprise $299 = $598 = 59_800¢, well below $3000, so
  // the charged fee clamps to the cap and the flag is set.
  assert.equal(inv.monthlyCapCents, 59_800);
  assert.equal(inv.percentFeeCents, 59_800);
  assert.equal(inv.capApplied, true);
  assert.equal(inv.totalDueCents, FLAT_FEE_CENTS + 59_800);
});
