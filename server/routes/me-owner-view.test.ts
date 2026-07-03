// ===========================================================================
// WAVE B — owner-view /api/me/* endpoints — HTTP integration test (temp DB).
// Run: npx tsx server/routes/me-owner-view.test.ts
// ===========================================================================
//
// Boots a bare Express app with registerMeRoutes on top of a fresh temp-DB
// storage, plus a tiny test-only session-injection middleware (reads an
// X-Test-User header and populates req.session.userId/role/epoch, exactly what
// getCurrentUser + requireRole read). No real login/cookies needed — the auth
// primitives resolve the user from the session object we inject.
//
// Covers WAVEB-OWNERVIEW-SPEC §E:
//   E.1  owner-vs-invited-driver access, per endpoint (owner 200, others 403)
//   E.2  tenant isolation (owner A sees ONLY carrier-A data)
//   E.3  broker-trust PUBLIC projection regression (AUDIT-2026-06-19 H2):
//        recentSignals expose ONLY {signalType,positive,reportedAt} — no
//        notes / clientId / reportedByUserId, even from another tenant.
//   E.4  advisor consumes NO quota when the AI is unavailable (no API key).
//   E.6  empty-state: 0 loads → {items:[]} / {rows:[]} / zero-total IFTA, 200.
//
// Deterministic, no network (ANTHROPIC_API_KEY is force-unset so the advisor
// path returns null → 503 without a Claude call).
// ---------------------------------------------------------------------------

import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

// better-sqlite3 binds the DB file at import time — unique path BEFORE importing
// storage (same pattern as dispatcher-load-visibility.test.ts).
process.env.DISPATCHOS_DB_PATH = join(
  tmpdir(),
  `dispatchos-owner-view-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.db`,
);
process.env.DISPATCHOS_KEYRING_PRIMARY ||= Buffer.alloc(32, 7).toString("base64");
// Force the AI advisor unavailable so E.4 (no-quota-on-failure) is deterministic
// and no test ever makes a paid Claude call.
delete process.env.ANTHROPIC_API_KEY;

const express = (await import("express")).default;
const { storage } = await import("../storage");
const { registerMeRoutes } = await import("./me");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}
const rnd = () => Math.random().toString(36).slice(2, 10);

// ---------------------------------------------------------------------------
// Fixture: two owner-operator carriers (A, B), each with an owner + a load.
// Plus a hired (non-owner) driver linked to carrier A, and a driver linked to
// carrier A that is NOT the recorded owner.
// ---------------------------------------------------------------------------
function mkClient(name: string, persona: string, ownerUserId?: string) {
  return storage.upsertClient({
    name,
    mc: `MC-${Math.floor(Math.random() * 900000 + 100000)}`,
    equipment: "hotshot_flatbed",
    targetPpm: 2,
    minimumPpm: 1.8,
    mpg: 10,
    fuelPrice: 3.6,
    fixedCostPerMile: 0.35,
    preferredLanes: [],
    avoidStates: [],
    billingStatus: "active",
    persona,
    // Real onboarded carriers always carry a currentLocation (the deadhead
    // origin scoreLoadForClient reads). Seed one so the scorer can run.
    currentLocation: {
      city: "Dallas",
      state: "TX",
      lat: 32.7767,
      lng: -96.797,
      status: "empty",
      updatedAt: new Date().toISOString(),
    },
    ...(ownerUserId ? { ownerUserId } : {}),
  } as any);
}

function mkLoad(clientId: string, originCity: string) {
  return storage.upsertLoad({
    source: "TEST",
    originCity,
    originState: "TX",
    originLat: 32.7767,
    originLng: -96.797,
    destinationCity: "Houston",
    destinationState: "TX",
    destinationLat: 29.7604,
    destinationLng: -95.3698,
    rate: 1800,
    loadedMiles: 240,
    pickupAt: "2026-08-01T12:00:00.000Z",
    deliveryAt: "2026-08-02T12:00:00.000Z",
    equipment: "hotshot_flatbed",
    brokerName: "Test Broker",
    brokerMc: "",
    brokerScore: 70,
    fraudRisk: 15,
    marketQuality: 70,
    clientId,
  } as any);
}

function mkUser(role: string, linkedClientId?: string) {
  return storage.createUser({
    email: `${role}-${rnd()}@example.com`,
    fullName: `${role} User`,
    role: role as any,
    passwordSalt: "salt",
    passwordHash: "hash",
    ...(linkedClientId ? { linkedClientId } : {}),
  });
}

// An admin must exist so getAuthState().isConfigured === true (else requireRole
// short-circuits every request with a bootstrap 401).
const admin = mkUser("admin");

// Owner A owns carrier A; Owner B owns carrier B.
const ownerA = mkUser("driver");
const ownerB = mkUser("driver");
const carrierA = mkClient("Tenant A Trucking", "owner_operator", ownerA.id);
const carrierB = mkClient("Tenant B Trucking", "owner_operator", ownerB.id);
// Re-link owners now that we have the carrier ids.
storage.updateUser(ownerA.id, { linkedClientId: carrierA.id } as any);
storage.updateUser(ownerB.id, { linkedClientId: carrierB.id } as any);
// Fall back to a direct field patch if updateUser isn't the right shape — we
// re-fetch below and assert, so a wrong path is caught loudly.
const ownerAFull = storage.getUserById(ownerA.id)!;
const ownerBFull = storage.getUserById(ownerB.id)!;

// A hired driver linked to carrier A but on a FLEET carrier persona view: model
// as a driver linked to a fleet carrier (never an owner).
const fleetCarrier = mkClient("Fleet Co", "fleet");
const hiredDriver = mkUser("driver", fleetCarrier.id);

// A driver linked to owner-op carrier A but who is NOT the recorded owner
// (guards the isOwnerOf ownerUserId branch).
const notOwnerDriver = mkUser("driver", carrierA.id);

// A dispatcher (wrong role entirely → 403 via requireRole('driver')).
const dispatcher = mkUser("dispatcher");

const loadA = mkLoad(carrierA.id, "Dallas");
const loadB = mkLoad(carrierB.id, "Austin");

assert("setup: ownerA linked to carrierA", ownerAFull.linkedClientId === carrierA.id,
  String(ownerAFull.linkedClientId));
assert("setup: ownerB linked to carrierB", ownerBFull.linkedClientId === carrierB.id,
  String(ownerBFull.linkedClientId));
assert("setup: loadA != loadB", loadA.id !== loadB.id);

// ---------------------------------------------------------------------------
// Boot the app with a test session-injection middleware.
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
// Inject a session from the X-Test-User header. getCurrentUser reads
// req.session.userId; requireRole reads req.session (+ getCurrentUser). We set
// epoch to the user's sessionEpoch so getCurrentUser doesn't invalidate it.
app.use((req: any, _res, next) => {
  const uid = req.headers["x-test-user"];
  if (typeof uid === "string" && uid) {
    const u = storage.getUserById(uid);
    req.session = {
      userId: uid,
      role: u?.role,
      epoch: (u as any)?.sessionEpoch ?? 0,
      destroy: (cb: () => void) => cb(),
    };
  } else {
    req.session = { destroy: (cb: () => void) => cb() };
  }
  next();
});
registerMeRoutes(app);

const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as any).port;

interface Res {
  status: number;
  json: any;
  headers: http.IncomingHttpHeaders;
  raw: string;
}
function request(
  method: string,
  path: string,
  asUserId?: string,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers: asUserId ? { "x-test-user": asUserId } : {} },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          let json: any = null;
          try {
            json = body ? JSON.parse(body) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json, headers: res.headers, raw: body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// The five owner-view GET endpoints (advisor is POST, tested separately).
const GET_ENDPOINTS = [
  "/api/me/loads/scored",
  "/api/me/broker-trust/123456",
  "/api/me/detention",
  "/api/me/ifta",
  "/api/me/ifta.csv",
];

try {
  // -----------------------------------------------------------------------
  // E.1 — access control per endpoint.
  // -----------------------------------------------------------------------
  for (const ep of GET_ENDPOINTS) {
    const asOwner = await request("GET", ep, ownerA.id);
    assert(`E.1 owner 2xx: GET ${ep}`, asOwner.status >= 200 && asOwner.status < 300,
      `status=${asOwner.status} body=${asOwner.raw.slice(0, 120)}`);

    const asHired = await request("GET", ep, hiredDriver.id);
    assert(`E.1 hired-driver 403: GET ${ep}`, asHired.status === 403, `status=${asHired.status}`);

    const asNotOwner = await request("GET", ep, notOwnerDriver.id);
    assert(`E.1 linked-but-not-owner 403: GET ${ep}`, asNotOwner.status === 403,
      `status=${asNotOwner.status}`);

    const asDispatcher = await request("GET", ep, dispatcher.id);
    assert(`E.1 wrong-role 403: GET ${ep}`, asDispatcher.status === 403,
      `status=${asDispatcher.status}`);

    const anon = await request("GET", ep);
    assert(`E.1 unauth 401: GET ${ep}`, anon.status === 401, `status=${anon.status}`);
  }

  // Advisor POST access mirrors the GETs (403 for non-owners) — assert the
  // hired driver is rejected before any AI/quota logic runs.
  const advHired = await request("POST", "/api/me/loads/ai-recommend", hiredDriver.id);
  assert("E.1 advisor hired-driver 403", advHired.status === 403, `status=${advHired.status}`);

  // -----------------------------------------------------------------------
  // E.2 — tenant isolation: owner A's scored board contains ONLY carrier-A
  // loads (no carrier-B load id).
  // -----------------------------------------------------------------------
  const scoredA = await request("GET", "/api/me/loads/scored", ownerA.id);
  const idsA: string[] = (scoredA.json?.items ?? []).map((i: any) => i.id);
  assert("E.2 scored: contains carrier-A load", idsA.includes(loadA.id));
  assert("E.2 scored: does NOT contain carrier-B load", !idsA.includes(loadB.id),
    `ids=${idsA.join(",")}`);

  // Owner B's board is the mirror image.
  const scoredB = await request("GET", "/api/me/loads/scored", ownerB.id);
  const idsB: string[] = (scoredB.json?.items ?? []).map((i: any) => i.id);
  assert("E.2 scored: owner-B does NOT see carrier-A load", !idsB.includes(loadA.id));

  // IFTA report clientId is session-derived (never leaks the other tenant).
  const iftaA = await request("GET", "/api/me/ifta", ownerA.id);
  assert("E.2 ifta: clientId === carrierA (session-derived)",
    iftaA.json?.clientId === carrierA.id, `got=${iftaA.json?.clientId}`);

  // -----------------------------------------------------------------------
  // E.3 — broker-trust PUBLIC projection regression (AUDIT-2026-06-19 H2).
  // Seed a signal for MC X from tenant B WITH notes/clientId/reporter set;
  // owner A must see ONLY {signalType,positive,reportedAt}.
  // -----------------------------------------------------------------------
  const SECRET_MC = "999888";
  storage.recordBrokerTrustSignal({
    brokerMc: SECRET_MC,
    clientId: carrierB.id,
    signalType: "paid_on_time",
    positive: true,
    notes: "TENANT-B-PRIVATE-NOTE-do-not-leak",
    reportedByUserId: ownerB.id,
  });
  const bt = await request("GET", `/api/me/broker-trust/${SECRET_MC}`, ownerA.id);
  assert("E.3 broker-trust 200", bt.status === 200, `status=${bt.status}`);
  const recent = bt.json?.recentSignals ?? [];
  assert("E.3 broker-trust: has the seeded signal", recent.length === 1, `len=${recent.length}`);
  if (recent.length === 1) {
    const keys = Object.keys(recent[0]).sort();
    assert(
      "E.3 broker-trust: recentSignals key set === {positive,reportedAt,signalType}",
      JSON.stringify(keys) === JSON.stringify(["positive", "reportedAt", "signalType"]),
      `keys=${keys.join(",")}`,
    );
    assert("E.3 broker-trust: NO notes leaked", !("notes" in recent[0]));
    assert("E.3 broker-trust: NO clientId leaked", !("clientId" in recent[0]));
    assert("E.3 broker-trust: NO reportedByUserId leaked", !("reportedByUserId" in recent[0]));
  }
  // Belt-and-suspenders: the tenant-B secret note string appears NOWHERE in the
  // serialized owner-A response.
  assert("E.3 broker-trust: secret note absent from whole body",
    !bt.raw.includes("TENANT-B-PRIVATE-NOTE"));
  // Aggregate counts (the intended shared moat) ARE exposed.
  assert("E.3 broker-trust: totalSignals counted", bt.json?.totalSignals === 1);

  // -----------------------------------------------------------------------
  // E.4 — advisor consumes NO quota when the AI is unavailable.
  // With ANTHROPIC_API_KEY unset, getAiRecommendation returns null → 503, and
  // consumeAiQuota must never run (usedToday stays 0).
  // -----------------------------------------------------------------------
  const beforeQuota = storage.getAiQuotaStatus(ownerA.id, undefined, carrierA.id);
  const adv = await request("POST", "/api/me/loads/ai-recommend", ownerA.id);
  // carrier A has a scored load, so we reach the AI call → 503 ai_unavailable.
  assert("E.4 advisor 503 ai_unavailable (no API key)",
    adv.status === 503 && adv.json?.code === "ai_unavailable",
    `status=${adv.status} body=${adv.raw.slice(0, 120)}`);
  const afterQuota = storage.getAiQuotaStatus(ownerA.id, undefined, carrierA.id);
  assert("E.4 advisor: NO quota consumed on AI failure",
    afterQuota.usedToday === beforeQuota.usedToday,
    `before=${beforeQuota.usedToday} after=${afterQuota.usedToday}`);

  // -----------------------------------------------------------------------
  // E.6 — empty-state: a fresh owner with 0 loads gets clean empties, not 500.
  // Owner C: brand-new owner-op carrier, no loads / checkins / fuel.
  // -----------------------------------------------------------------------
  const ownerC = mkUser("driver");
  const carrierC = mkClient("Tenant C Trucking", "owner_operator", ownerC.id);
  storage.updateUser(ownerC.id, { linkedClientId: carrierC.id } as any);

  const scoredC = await request("GET", "/api/me/loads/scored", ownerC.id);
  assert("E.6 scored empty: 200 + items:[]",
    scoredC.status === 200 && Array.isArray(scoredC.json?.items) && scoredC.json.items.length === 0,
    `status=${scoredC.status} body=${scoredC.raw.slice(0, 120)}`);

  const detC = await request("GET", "/api/me/detention", ownerC.id);
  assert("E.6 detention empty: 200 + rows:[]",
    detC.status === 200 && Array.isArray(detC.json?.rows) && detC.json.rows.length === 0,
    `status=${detC.status}`);

  const iftaC = await request("GET", "/api/me/ifta", ownerC.id);
  assert("E.6 ifta empty: 200 + zero totals + avgMpg null",
    iftaC.status === 200 &&
      iftaC.json?.totals?.miles === 0 &&
      iftaC.json?.totals?.gallons === 0 &&
      iftaC.json?.totals?.avgMpg === null,
    `status=${iftaC.status} totals=${JSON.stringify(iftaC.json?.totals)}`);

  // Advisor with 0 loads → 404 (no scored loads) BEFORE any AI/quota spend.
  const advC = await request("POST", "/api/me/loads/ai-recommend", ownerC.id);
  assert("E.6 advisor empty: 404 no scored loads", advC.status === 404, `status=${advC.status}`);

  // -----------------------------------------------------------------------
  // Bonus: IFTA query validation (bad quarter → 400).
  // -----------------------------------------------------------------------
  const badQ = await request("GET", "/api/me/ifta?quarter=9", ownerA.id);
  assert("ifta: bad quarter → 400", badQ.status === 400, `status=${badQ.status}`);

  // CSV content-type + attachment disposition.
  const csv = await request("GET", "/api/me/ifta.csv", ownerA.id);
  assert("ifta.csv: text/csv + attachment",
    csv.status === 200 &&
      String(csv.headers["content-type"] ?? "").includes("text/csv") &&
      String(csv.headers["content-disposition"] ?? "").includes("attachment"),
    `ct=${csv.headers["content-type"]} cd=${csv.headers["content-disposition"]}`);
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
