// Detention computation unit tests.
//
// Covers:
//   - No checkins → no events
//   - Under free window → no events
//   - Pickup detention (auto + estimated source)
//   - Delivery detention
//   - Quarter-hour ceiling
//   - Custom freeHours + ratePerHourCents
//   - Multiple ARRIVAL checkins — earliest wins (completion — latest wins)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeDetentionForLoad,
  totalDetentionCents,
  previewDetentionCents,
  billableDetentionCents,
} from "./detention";
import type { LoadCheckin } from "@shared/schema";

function ck(
  kind: LoadCheckin["kind"],
  createdAt: string,
  id = `c-${kind}-${createdAt}`,
): LoadCheckin {
  return {
    id,
    loadId: "L1",
    driverUserId: "U1",
    kind,
    lat: null,
    lng: null,
    notes: null,
    createdAt,
  };
}

test("no checkins → no detention", () => {
  const events = computeDetentionForLoad({
    load: { id: "L1" },
    checkins: [],
  });
  assert.equal(events.length, 0);
});

test("pickup under free window → no detention", () => {
  const events = computeDetentionForLoad({
    load: { id: "L1" },
    checkins: [
      ck("pickup_arrived", "2026-05-26T08:00:00Z"),
      ck("loaded", "2026-05-26T09:30:00Z"), // 1.5h, within 2h free
    ],
  });
  assert.equal(events.length, 0);
});

test("pickup detention — 3h on-site, 1h billable @ $75/h", () => {
  const events = computeDetentionForLoad({
    load: { id: "L1" },
    checkins: [
      ck("pickup_arrived", "2026-05-26T08:00:00Z"),
      ck("loaded", "2026-05-26T11:00:00Z"), // 3h total, 1h after free
    ],
  });
  assert.equal(events.length, 1);
  const ev = events[0]!;
  assert.equal(ev.leg, "pickup");
  assert.equal(ev.totalHours, 3);
  assert.equal(ev.freeHours, 2);
  assert.equal(ev.billableHours, 1);
  assert.equal(ev.ratePerHourCents, 7_500);
  assert.equal(ev.amountCents, 7_500);
  assert.equal(ev.source, "auto");
});

test("quarter-hour ceiling — 2h12m → 0.25h billable", () => {
  const events = computeDetentionForLoad({
    load: { id: "L1" },
    checkins: [
      ck("pickup_arrived", "2026-05-26T08:00:00Z"),
      ck("loaded", "2026-05-26T10:12:00Z"), // 2.2h, 0.2h after free → ceil to 0.25h
    ],
  });
  assert.equal(events[0]!.billableHours, 0.25);
  assert.equal(events[0]!.amountCents, Math.round(0.25 * 7500));
});

test("delivery detention — separate event", () => {
  const events = computeDetentionForLoad({
    load: { id: "L1" },
    checkins: [
      ck("pickup_arrived", "2026-05-26T08:00:00Z"),
      ck("loaded", "2026-05-26T09:30:00Z"), // no detention here
      ck("delivery_arrived", "2026-05-27T13:00:00Z"),
      ck("delivered", "2026-05-27T17:30:00Z"), // 4.5h, 2.5h billable
    ],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.leg, "delivery");
  assert.equal(events[0]!.billableHours, 2.5);
  assert.equal(events[0]!.amountCents, Math.round(2.5 * 7500));
});

test("both legs detained — two events, totals sum", () => {
  const events = computeDetentionForLoad({
    load: { id: "L1" },
    checkins: [
      ck("pickup_arrived", "2026-05-26T08:00:00Z"),
      ck("loaded", "2026-05-26T11:00:00Z"), // 1h billable
      ck("delivery_arrived", "2026-05-27T13:00:00Z"),
      ck("delivered", "2026-05-27T16:00:00Z"), // 1h billable
    ],
  });
  assert.equal(events.length, 2);
  assert.equal(totalDetentionCents(events), 15_000); // 1h + 1h × $75 = $150
});

test("estimated source — pickup_arrived but no loaded yet", () => {
  const events = computeDetentionForLoad({
    load: { id: "L1" },
    checkins: [ck("pickup_arrived", "2026-05-26T08:00:00Z")],
    nowIso: "2026-05-26T13:00:00Z", // 5h on-site, no loaded checkin yet
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.source, "estimated");
  assert.equal(events[0]!.billableHours, 3); // 5h - 2h free
});

test("custom freeHours and rate per client", () => {
  const events = computeDetentionForLoad({
    load: { id: "L1" },
    checkins: [
      ck("pickup_arrived", "2026-05-26T08:00:00Z"),
      ck("loaded", "2026-05-26T10:00:00Z"), // 2h total
    ],
    freeHours: 1, // Walmart-style
    ratePerHourCents: 10_000, // $100/h
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.billableHours, 1);
  assert.equal(events[0]!.amountCents, 10_000);
});

test("malformed config clamps — negative freeHours floored to 0, negative rate floored to 0", () => {
  // Per-client config can arrive malformed. A negative free window must NOT
  // bill the whole on-site time, and a negative rate must NOT produce a
  // negative charge. Both are clamped to 0 (Audit medium).
  const negFree = computeDetentionForLoad({
    load: { id: "L1" },
    checkins: [
      ck("pickup_arrived", "2026-05-26T08:00:00Z"),
      ck("loaded", "2026-05-26T09:00:00Z"), // 1h on-site
    ],
    freeHours: -5,
  });
  // freeHours clamped to 0 → all 1h is billable, but the rate is the default.
  assert.equal(negFree.length, 1);
  assert.equal(negFree[0]!.freeHours, 0);
  assert.equal(negFree[0]!.billableHours, 1);

  const negRate = computeDetentionForLoad({
    load: { id: "L1" },
    checkins: [
      ck("pickup_arrived", "2026-05-26T08:00:00Z"),
      ck("loaded", "2026-05-26T11:00:00Z"),
    ],
    ratePerHourCents: -7_500,
  });
  // rate clamped to 0 → no negative charge.
  assert.equal(negRate[0]!.ratePerHourCents, 0);
  assert.equal(negRate[0]!.amountCents, 0);
});

test("non-finite config falls back to defaults", () => {
  const events = computeDetentionForLoad({
    load: { id: "L1" },
    checkins: [
      ck("pickup_arrived", "2026-05-26T08:00:00Z"),
      ck("loaded", "2026-05-26T11:00:00Z"), // 3h on-site
    ],
    freeHours: Number.NaN,
    ratePerHourCents: Number.NaN,
  });
  // NaN config → defaults: 2h free, $75/h, so 1h billable @ $75.
  assert.equal(events[0]!.freeHours, 2);
  assert.equal(events[0]!.ratePerHourCents, 7_500);
  assert.equal(events[0]!.billableHours, 1);
  assert.equal(events[0]!.amountCents, 7_500);
});

test("multiple pickup_arrived checkins — EARLIEST arrival wins (no understatement)", () => {
  const events = computeDetentionForLoad({
    load: { id: "L1" },
    checkins: [
      ck("pickup_arrived", "2026-05-26T05:00:00Z", "old"),
      ck("pickup_arrived", "2026-05-26T08:00:00Z", "new"),
      ck("loaded", "2026-05-26T11:00:00Z"),
    ],
  });
  // Detention must measure from the FIRST on-site arrival (05:00), not a
  // later re-recorded one. 05:00→11:00 = 6h total, 4h billable after 2h free.
  // Using the latest arrival (08:00) would have understated this to 1h.
  assert.equal(events[0]!.arrivedAt, "2026-05-26T05:00:00Z");
  assert.equal(events[0]!.totalHours, 6);
  assert.equal(events[0]!.billableHours, 4);
});

// --- GPS corroboration (revenue-leak fix: 1 ping is enough) -----------------
// A 4h wait near the pickup with a single in-radius GPS fix is real detention
// and must bill. Previously this scored 'unverified' (needed >=2 pings) → $0.
const PICKUP_LOAD = {
  id: "L1",
  originLat: 33.749, // Atlanta
  originLng: -84.388,
};
const onSiteCheckins = [
  ck("pickup_arrived", "2026-05-26T08:00:00Z"),
  ck("loaded", "2026-05-26T12:00:00Z"), // 4h total → 2h billable
];

test("1 in-radius ping corroborates a long wait (verified + billable)", () => {
  const events = computeDetentionForLoad({
    load: PICKUP_LOAD,
    checkins: onSiteCheckins,
    gpsPings: [{ lat: 33.7495, lng: -84.3885, capturedAt: "2026-05-26T10:00:00Z" }],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.source, "verified");
  assert.equal(events[0]!.pingCount, 1);
  assert.equal(events[0]!.billableHours, 2);
  // The fix: this revenue is no longer dropped from billable totals.
  assert.equal(billableDetentionCents(events), events[0]!.amountCents);
  assert.ok(billableDetentionCents(events) > 0);
});

test("0 in-radius pings stays unverified (fraud/off-device guard)", () => {
  const events = computeDetentionForLoad({
    load: PICKUP_LOAD,
    checkins: onSiteCheckins,
    // ping is far away (different city) → not corroborating
    gpsPings: [{ lat: 40.7128, lng: -74.006, capturedAt: "2026-05-26T10:00:00Z" }],
  });
  assert.equal(events[0]!.source, "unverified");
  assert.equal(events[0]!.pingCount, 0);
  // Unverified is still excluded from billable totals.
  assert.equal(billableDetentionCents(events), 0);
});

test("no gpsPings supplied → legacy 'auto' source still billable", () => {
  const events = computeDetentionForLoad({ load: PICKUP_LOAD, checkins: onSiteCheckins });
  assert.equal(events[0]!.source, "auto");
  assert.equal(events[0]!.pingCount, undefined);
  assert.ok(billableDetentionCents(events) > 0);
});

test("multiple delivery_arrived checkins — EARLIEST arrival wins", () => {
  const events = computeDetentionForLoad({
    load: { id: "L1" },
    checkins: [
      ck("delivery_arrived", "2026-05-27T10:00:00Z", "old"),
      ck("delivery_arrived", "2026-05-27T13:00:00Z", "new"),
      ck("delivered", "2026-05-27T17:00:00Z"),
    ],
  });
  // 10:00→17:00 = 7h total, 5h billable after 2h free (latest-arrival bug
  // would have measured 13:00→17:00 = 4h total, only 2h billable).
  assert.equal(events[0]!.leg, "delivery");
  assert.equal(events[0]!.arrivedAt, "2026-05-27T10:00:00Z");
  assert.equal(events[0]!.totalHours, 7);
  assert.equal(events[0]!.billableHours, 5);
});

// --- Non-bill-safe preview vs bill-safe total -------------------------------
test("previewDetentionCents includes unverified/estimated; billable excludes them", () => {
  // One unverified pickup leg (GPS far away) — preview counts it, billing must not.
  const events = computeDetentionForLoad({
    load: PICKUP_LOAD,
    checkins: onSiteCheckins,
    gpsPings: [{ lat: 40.7128, lng: -74.006, capturedAt: "2026-05-26T10:00:00Z" }],
  });
  assert.equal(events[0]!.source, "unverified");
  assert.ok(events[0]!.amountCents > 0);
  // Preview surface shows the gross opportunity...
  assert.equal(previewDetentionCents(events), events[0]!.amountCents);
  // ...but the bill-safe path excludes the unverified amount.
  assert.equal(billableDetentionCents(events), 0);
  // totalDetentionCents is a deprecated alias of previewDetentionCents.
  assert.equal(totalDetentionCents(events), previewDetentionCents(events));
});
