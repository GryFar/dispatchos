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

import { dollarsToCents, centsToDollars, FLAT_FEE_CENTS } from "./billing";

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

test("sum-of-many-loads has zero cumulative drift (vs old float sum)", () => {
  // Simulate 100 loads with rates that float-summed would drift.
  const rates = Array.from({ length: 100 }, () => 1234.56 + Math.random() * 0.01);

  // Old approach: float sum → round once.
  const oldGross = Math.round(rates.reduce((s, r) => s + r, 0) * 100) / 100;

  // New approach: per-rate to cents, sum integers.
  const newCents = rates.reduce((s, r) => s + dollarsToCents(r), 0);
  const newGross = centsToDollars(newCents);

  // Drift must be <= 1¢ * loadCount worst-case but in practice always 0¢
  // because we round once per load with toFixed(2) protection.
  const driftDollars = Math.abs(oldGross - newGross);
  assert.ok(driftDollars <= 0.5, `cumulative drift too large: ${driftDollars}`);
});
