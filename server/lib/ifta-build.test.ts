// IFTA buildQuarterly integration test (temp DB).
// Run: npx tsx server/lib/ifta-build.test.ts
//
// Exercises the DB-backed miles-per-state aggregation: state attribution,
// the >200km GPS-jump filter (the easy-to-regress bit), unknown-state
// (offshore) handling, and quarter isolation. Fuel/gallons come from a
// separate ingest path and are left at 0 here.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), "dispatchos-ifta-build-test.db");
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
const near = (got: number, want: number, tol: number) => Math.abs(got - want) <= tol;

const clientId = `ifta-client-${rnd()}`;
const driver = storage.createUser({
  email: `ifta-driver-${rnd()}@example.com`,
  fullName: "IFTA Driver",
  role: "driver",
  passwordSalt: "x",
  passwordHash: "y",
  linkedClientId: clientId,
});

const ping = (lat: number, lng: number, iso: string) =>
  storage.recordLocationPing({ userId: driver.id, lat, lng, source: "manual", capturedAt: iso });

// Q2 2026 — three TX pings (small steps), then a >200km jump into OK that must
// be ignored, then two OK pings (small step). ~0.1deg lat ≈ 6.9 mi per step.
ping(32.80, -96.80, "2026-04-10T08:00:00.000Z"); // TX
ping(32.90, -96.80, "2026-04-10T08:30:00.000Z"); // TX  (+~6.9mi)
ping(33.00, -96.80, "2026-04-10T09:00:00.000Z"); // TX  (+~6.9mi)
ping(35.50, -97.50, "2026-04-10T12:00:00.000Z"); // OK  (jump ~277km -> filtered)
ping(35.60, -97.50, "2026-04-10T12:30:00.000Z"); // OK  (+~6.9mi)
// Offshore pair (Gulf of Mexico) -> unknown state.
ping(25.00, -90.00, "2026-04-11T08:00:00.000Z");
ping(25.10, -90.00, "2026-04-11T08:30:00.000Z"); // (+~6.9mi unattributed)
// Q3 ping pair (Ohio) — must NOT appear in the Q2 report.
ping(40.00, -83.00, "2026-07-15T08:00:00.000Z");
ping(40.10, -83.00, "2026-07-15T08:30:00.000Z");

const q2 = buildIftaQuarterly(clientId, 2026, 2);
const tx = q2.rows.find((r) => r.state === "TX");
const ok = q2.rows.find((r) => r.state === "OK");

assert("TX row present", !!tx);
assert("TX miles ~13.8 (two ~6.9mi steps)", !!tx && near(tx.miles, 13.8, 1.5), JSON.stringify(tx));
assert("OK row present", !!ok);
// The decisive check: without the >200km jump filter, OK would be ~180mi.
assert("OK miles ~6.9 — the 277km jump was filtered out", !!ok && ok.miles < 20, JSON.stringify(ok));
assert("no OH row in Q2 (July pings excluded)", !q2.rows.some((r) => r.state === "OH"));
assert("unknown-state miles ~6.9 from offshore pair", near(q2.unknownStateMiles, 6.9, 1.5), String(q2.unknownStateMiles));
assert(
  "totals.miles == sum of rows",
  near(q2.totals.miles, (tx?.miles ?? 0) + (ok?.miles ?? 0), 0.2),
  `${q2.totals.miles}`,
);
assert("gallons 0 (no fuel ingested)", q2.totals.gallons === 0);
assert("avgMpg null when no gallons", q2.totals.avgMpg === null);

// Quarter isolation the other way: Q3 should contain the Ohio pings.
const q3 = buildIftaQuarterly(clientId, 2026, 3);
assert("OH row present in Q3", q3.rows.some((r) => r.state === "OH"));
assert("no TX row in Q3 (April pings excluded)", !q3.rows.some((r) => r.state === "TX"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
