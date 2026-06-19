// IFTA ping pagination test (temp DB).
// Run: npx tsx server/lib/ifta-pagination.test.ts
//
// P1 (legal under-report): buildIftaQuarterly fetched pings via
// listLocationPings(..., limit: 5000), hard-capped at 5000. A driver pinging
// every ~5 min produces ~26k pings/quarter, so only the first ~17 days counted
// and taxable miles were silently truncated. The fix paginates the FULL window
// via storage.listLocationPingsInWindow. This inserts >5000 pings and proves
// (a) the window iterator returns all of them while the capped reader does not,
// and (b) the report's miles reflect every step, not just the first 5000.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), "dispatchos-ifta-pagination-test.db");
const { storage } = await import("../storage");
const { buildIftaQuarterly } = await import("./ifta");

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

const clientId = `ifta-page-client-${rnd()}`;
const driver = storage.createUser({
  email: `ifta-page-${rnd()}@example.com`,
  fullName: "High-Frequency Driver",
  role: "driver",
  passwordSalt: "x",
  passwordHash: "y",
  linkedClientId: clientId,
});

// 6000 pings, 1s apart, all in Q2 2026, drifting north through TX in tiny
// steps (~0.0069 mi each — well under the 200km GPS-jump filter). 6000 > the
// old 5000 cap, so the bug would drop the last ~1000 steps.
const N = 6000;
const baseMs = Date.UTC(2026, 3, 10, 8, 0, 0); // 2026-04-10T08:00:00Z (Q2)
for (let i = 0; i < N; i++) {
  storage.recordLocationPing({
    userId: driver.id,
    lat: 31.5 + i * 0.0001, // 31.5 -> 32.1, stays inside TX
    lng: -98.0,
    source: "manual",
    capturedAt: new Date(baseMs + i * 1000).toISOString(),
  });
}

const { start, end } = { start: "2026-04-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" };

const windowPings = storage.listLocationPingsInWindow(driver.id, start, end);
assert("window iterator returns ALL 6000 pings", windowPings.length === N, String(windowPings.length));

// Sanity: the old capped reader truncates at 5000 — that was the bug.
const cappedPings = storage.listLocationPings(driver.id, { sinceIso: start, limit: 5000 });
assert("capped reader truncates at 5000 (the old bug)", cappedPings.length === 5000, String(cappedPings.length));

// Window pings must be strictly ordered and unique (keyset correctness).
let ordered = true;
for (let i = 1; i < windowPings.length; i++) {
  if (windowPings[i]!.captured_at < windowPings[i - 1]!.captured_at) ordered = false;
}
assert("window pings are captured_at-ordered (no keyset gap/loop)", ordered);

// The report now reflects every step. Each ~0.0069mi step × 5999 ≈ 41.4 mi.
// With the old cap it would be ~5000 steps ≈ 34.5 mi. We assert the count of
// attributed steps via miles being meaningfully above the capped figure.
const q2 = buildIftaQuarterly(clientId, 2026, 2);
const tx = q2.rows.find((r) => r.state === "TX");
assert("TX row present", !!tx);
// Expected ≈ (N-1) steps × stepMiles. stepMiles ≈ haversine(0.0001 deg lat).
const expectedMiles = (N - 1) * 0.0069; // ~41.4
assert(
  "TX miles reflect >5000 steps (not truncated)",
  !!tx && tx.miles > 5200 * 0.0069 && tx.miles < expectedMiles * 1.15,
  tx ? `${tx.miles}` : "no TX row",
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
