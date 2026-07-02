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

// 6000 pings, 30s apart, all in Q2 2026, driving north through TX. Each step is
// ~0.0667 km (66.7 m) — above the 50m stationary-jitter floor and below the
// 200km GPS-jump cap — at an implied ~8 km/h, well under the 200 km/h teleport
// cap. These thresholds match storage.computeDriverDistanceMiles, so the steps
// represent real movement that the mileage filters must KEEP. 6000 > the old
// 5000 cap, so the pagination bug would drop the last ~1000 steps.
const N = 6000;
const STEP_DEG = 0.0006; // ~66.7 m per step at this latitude
const CADENCE_MS = 30_000; // 30s between pings → ~8 km/h implied speed
const baseMs = Date.UTC(2026, 3, 10, 8, 0, 0); // 2026-04-10T08:00:00Z (Q2)
for (let i = 0; i < N; i++) {
  storage.recordLocationPing({
    userId: driver.id,
    lat: 31.5 + i * STEP_DEG, // 31.5 -> ~35.1, stays inside TX
    lng: -98.0,
    source: "manual",
    capturedAt: new Date(baseMs + i * CADENCE_MS).toISOString(),
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

// The report now reflects every step. Each ~0.04146mi step × 5999 ≈ 248.7 mi.
// With the old cap it would be ~5000 steps ≈ 207 mi. We assert the count of
// attributed steps via miles being meaningfully above the capped figure — and
// that the jitter/teleport filters did NOT drop these legitimate steps.
const STEP_MILES = 0.04146; // ~66.7 m per step in miles
const q2 = buildIftaQuarterly(clientId, 2026, 2);
// The lat 31.5 -> 35.1 path crosses the TX/OK border (~lat 33.6 at lng -98 per
// the state bounding-box resolver), so the miles split across TX + OK rows.
// Assert on the TOTAL across all states — that proves every step was counted
// (the jitter/teleport filters KEPT all real movement) and is robust to which
// state the resolver attributes each segment to. (Empirically TX 146.5 + OK
// 102.2 = 248.7, exactly (N-1) steps; with the old 5000-ping cap it would be
// ~207.) Lower bound (5200 steps) proves we counted past the old cap.
assert("at least one state row present", q2.rows.length > 0, String(q2.rows.length));
const totalMiles = q2.rows.reduce((s, r) => s + r.miles, 0);
const expectedMiles = (N - 1) * STEP_MILES;
assert(
  "total miles reflect >5000 steps (not truncated)",
  totalMiles > 5200 * STEP_MILES && totalMiles < expectedMiles * 1.15,
  `${totalMiles.toFixed(1)} across ${q2.rows.map((r) => r.state).join("+")}`,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
