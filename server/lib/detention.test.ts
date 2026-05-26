// Detention computation unit tests.
//
// Covers:
//   - No checkins → no events
//   - Under free window → no events
//   - Pickup detention (auto + estimated source)
//   - Delivery detention
//   - Quarter-hour ceiling
//   - Custom freeHours + ratePerHourCents
//   - Multiple checkins of the same kind — latest wins

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDetentionForLoad, totalDetentionCents } from "./detention";
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

test("multiple pickup_arrived checkins — latest wins", () => {
  const events = computeDetentionForLoad({
    load: { id: "L1" },
    checkins: [
      ck("pickup_arrived", "2026-05-26T05:00:00Z", "old"),
      ck("pickup_arrived", "2026-05-26T08:00:00Z", "new"),
      ck("loaded", "2026-05-26T11:00:00Z"),
    ],
  });
  // Latest pickup_arrived = 08:00, loaded at 11:00 → 3h total, 1h billable
  assert.equal(events[0]!.billableHours, 1);
});
