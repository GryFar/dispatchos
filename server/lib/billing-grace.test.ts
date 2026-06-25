// Billing past_due grace-period test (temp DB).
// Run: npx tsx server/lib/billing-grace.test.ts
//
// Nikita: grace was computed from trialEndsAt (could be months before the
// actual failed payment), instantly read-only-ing a long-active carrier. Now
// requireActiveBilling prefers pastDueSince (stamped by the Stripe webhook).

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), "dispatchos-billing-grace-test.db");
const { storage } = await import("../storage");
const { requireActiveBilling } = await import("../auth");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}
const rnd = () => Math.random().toString(36).slice(2, 10);
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 24 * 3600 * 1000).toISOString();

// getCurrentUser reads req.session.userId, so we create a real admin user and
// put its id in the session. Carrier is resolved (admin path) from body.clientId.
const admin = storage.createUser({
  email: `admin-${rnd()}@test.local`,
  username: `admin-${rnd()}`,
  fullName: "Test Admin",
  passwordSalt: "test-salt",
  passwordHash: "test-hash",
  role: "admin",
} as any);

function run(clientId: string): { status: number | null; body: any } {
  let captured: { status: number | null; body: any } = { status: null, body: null };
  const req: any = { body: { clientId }, query: {}, session: { userId: admin.id }, headers: {} };
  const res: any = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { captured = { status: this.statusCode, body: payload }; return this; },
  };
  let nexted = false;
  requireActiveBilling(req, res, () => { nexted = true; });
  if (nexted) captured = { status: null, body: null };
  return captured;
}

const mkClient = (over: Record<string, unknown>) =>
  storage.upsertClient({
    name: `Carrier ${rnd()}`, mc: `MC-${Math.floor(Math.random() * 900000 + 100000)}`,
    equipment: "hotshot_flatbed", targetPpm: 2, minimumPpm: 1.8, mpg: 10,
    fuelPrice: 3.6, fixedCostPerMile: 0.35, preferredLanes: [], avoidStates: [],
    ...over,
  } as any);

// Sanity: with no carrier context the middleware lets the request through.
const r0 = (() => {
  let st: number | null = null;
  const req: any = { body: {}, query: {}, session: { userId: admin.id }, headers: {} };
  const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json() { st = this.statusCode; return this; } };
  let n = false;
  requireActiveBilling(req, res, () => { n = true; });
  return n ? null : st;
})();
assert("no clientId -> passes through (auth OK)", r0 === null, `got status=${r0}`);

// 1. Long-active carrier: trial ended 150 days ago, payment failed 2 days ago.
const recent = mkClient({ billingStatus: "past_due", trialEndsAt: iso(150), pastDueSince: iso(2) });
const r1 = run(recent.id);
assert("recent failure (2d) within grace -> passes", r1.status === null, `got status=${r1.status}`);

// 2. Failure 10 days ago -> past grace -> 402 read-only.
const stale = mkClient({ billingStatus: "past_due", trialEndsAt: iso(150), pastDueSince: iso(10) });
const r2 = run(stale.id);
assert("stale failure (10d) past grace -> 402", r2.status === 402, `got status=${r2.status}`);
assert("402 reports past_due", r2.body?.billingStatus === "past_due");

// 3. Legacy record: no pastDueSince, old trialEndsAt -> falls back, still 402.
const legacy = mkClient({ billingStatus: "past_due", trialEndsAt: iso(150) });
const r3 = run(legacy.id);
assert("legacy (no pastDueSince) falls back to trialEndsAt -> 402", r3.status === 402, `got status=${r3.status}`);

// 4. Active carrier passes regardless.
const active = mkClient({ billingStatus: "active", trialEndsAt: iso(150) });
const r4 = run(active.id);
assert("active carrier passes", r4.status === null, `got status=${r4.status}`);

// 4b. Expired carrier is blocked read-only.
const expired = mkClient({ billingStatus: "expired", trialEndsAt: iso(1) });
const r4b = run(expired.id);
assert("expired carrier -> 402", r4b.status === 402, `got status=${r4b.status}`);
assert("402 reports expired", r4b.body?.billingStatus === "expired");

// 4c. Canceled carrier is blocked read-only (terminal status, treated like expired).
const canceled = mkClient({ billingStatus: "canceled", trialEndsAt: iso(1) });
const r4c = run(canceled.id);
assert("canceled carrier -> 402", r4c.status === 402, `got status=${r4c.status}`);
assert("402 reports canceled", r4c.body?.billingStatus === "canceled");

// 5. pastDueSince survives the payload round-trip.
const stored = storage.getClient(recent.id) as any;
assert("pastDueSince persisted in payload", typeof stored.pastDueSince === "string");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

