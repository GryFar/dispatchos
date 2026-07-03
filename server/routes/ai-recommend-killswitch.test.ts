// ===========================================================================
// ai-recommend platform kill-switch / global-cap PRE-CHECK — HTTP integration.
// Run: npx tsx server/routes/ai-recommend-killswitch.test.ts  (picked up by smoke:ai)
// ===========================================================================
//
// The gap this pins: POST /api/dispatch/ai-recommend gates on
// storage.getAiQuotaStatus BEFORE the (paid) Claude call. That status now also
// consults the two PLATFORM levers (DISPATCHOS_AI_KILL kill-switch +
// DISPATCHOS_AI_GLOBAL_DAILY_CAP ceiling) — previously enforced only inside
// consumeAiQuota, which runs AFTER the model call. So before the fix, flipping
// the kill-switch (or hitting the global cap) still let this endpoint pay for a
// Claude call and merely refuse to record the spend.
//
// We boot a bare Express app with the real cockpit routes on a fresh temp DB,
// set a fake ANTHROPIC_API_KEY, and SPY on globalThis.fetch (the advisor calls
// the ambient fetch via fetchWithTimeout). Assertions are about the CONTRACT:
//   - kill-switch on  → endpoint blocks, fetch NEVER called (model not invoked);
//   - global cap hit  → endpoint 429s,   fetch NEVER called;
//   - control (both off, within quota) → fetch IS called and the rec returns.
// No network is ever touched — fetch is always the spy.

import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

// better-sqlite3 binds the DB file at import time — set a unique path BEFORE
// importing storage (same pattern as the other route tests).
process.env.DISPATCHOS_DB_PATH = join(
  tmpdir(),
  `dispatchos-ai-recommend-kill-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.db`,
);
process.env.DISPATCHOS_KEYRING_PRIMARY ||= Buffer.alloc(32, 7).toString("base64");
// A key must be present so the ONLY reason the model isn't called is our gate
// (getAiRecommendation early-returns null when the key is missing — that would
// mask the thing under test).
process.env.ANTHROPIC_API_KEY = "test-key-not-used";
// Start from a known-clean platform-lever env.
delete process.env.DISPATCHOS_AI_KILL;
delete process.env.DISPATCHOS_AI_GLOBAL_DAILY_CAP;

const express = (await import("express")).default;
const { storage } = await import("../storage");
const { registerCockpitRoutes } = await import("./cockpit");

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

// --- fetch spy: records call count, returns a well-formed Claude response so
// the control case yields a usable recommendation without any network. -------
const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  return {
    ok: true,
    status: 200,
    json: async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            recommendedLoadId: "x",
            reasoning: "test",
            watchOuts: [],
            confidence: 0.9,
          }),
        },
      ],
    }),
    text: async () => "",
  } as unknown as Response;
}) as typeof fetch;

// --- fixture: admin (so auth is configured) + dispatcher + assigned carrier
// with one available, scorable load. ---------------------------------------
function mkUser(role: string, linkedClientId?: string) {
  return storage.createUser({
    email: `${role}-${rnd()}@example.com`,
    fullName: `${role} User`,
    role: role as any,
    passwordSalt: "salt",
    passwordHash: "hash",
    ...(linkedClientId ? { linkedClientId } : {}),
  } as Parameters<typeof storage.createUser>[0]);
}

function mkClient(name: string) {
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
    persona: "fleet",
    currentLocation: {
      city: "Dallas",
      state: "TX",
      lat: 32.7767,
      lng: -96.797,
      status: "empty",
      updatedAt: new Date().toISOString(),
    },
  } as any);
}

function mkLoad(clientId: string) {
  return storage.upsertLoad({
    source: "TEST",
    originCity: "Dallas",
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

const admin = mkUser("admin");
const dispatcher = mkUser("dispatcher");
const carrier = mkClient("KillSwitch Carrier");
storage.createAssignment({
  clientId: carrier.id,
  dispatcherUserId: dispatcher.id,
  createdByUserId: admin.id,
});
mkLoad(carrier.id);

// --- boot the app with a test session-injection middleware (X-Test-User). ---
const app = express();
app.use(express.json());
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
registerCockpitRoutes(app);

const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as any).port;

interface Res {
  status: number;
  json: any;
}
function postRecommend(asUserId: string, clientId: string): Promise<Res> {
  const body = JSON.stringify({ clientId });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/dispatch/ai-recommend",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-test-user": asUserId,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json: any = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

try {
  // 1. Kill-switch ON → blocked WITHOUT invoking the model.
  {
    process.env.DISPATCHOS_AI_KILL = "1";
    fetchCalls = 0;
    const r = await postRecommend(dispatcher.id, carrier.id);
    assert("kill: model NOT called (fetch spy count 0)", fetchCalls === 0, `fetchCalls=${fetchCalls}`);
    assert("kill: endpoint returns a blocked status (not 200)", r.status !== 200, `status=${r.status}`);
    assert(
      "kill: quota pre-check blocked it (429 ai_quota_exceeded)",
      r.status === 429 && r.json?.code === "ai_quota_exceeded",
      `status=${r.status} body=${JSON.stringify(r.json)}`,
    );
    delete process.env.DISPATCHOS_AI_KILL;
  }

  // 2. Global cap reached → 429 without invoking the model.
  //    (cap must be a POSITIVE int — aiGlobalDailyCap() treats 0/invalid as the
  //    default 10000, mirroring consumeAiQuota — so we set cap=1 and burn that
  //    one slot with an approved call by a throwaway user to reach the ceiling.)
  {
    process.env.DISPATCHOS_AI_GLOBAL_DAILY_CAP = "1";
    // One approved call fills the global counter to the cap.
    assert("cap: precondition fill approved", storage.consumeAiQuota(mkUser("dispatcher").id).ok === true);
    fetchCalls = 0;
    const r = await postRecommend(dispatcher.id, carrier.id);
    assert("cap: model NOT called (fetch spy count 0)", fetchCalls === 0, `fetchCalls=${fetchCalls}`);
    assert(
      "cap: endpoint 429 ai_quota_exceeded",
      r.status === 429 && r.json?.code === "ai_quota_exceeded",
      `status=${r.status} body=${JSON.stringify(r.json)}`,
    );
    delete process.env.DISPATCHOS_AI_GLOBAL_DAILY_CAP;
  }

  // 3. Control: kill unset + cap not reached + within per-tenant quota → the
  //    model IS invoked and the endpoint returns the recommendation (200).
  {
    fetchCalls = 0;
    const r = await postRecommend(dispatcher.id, carrier.id);
    assert("control: model IS called exactly once", fetchCalls === 1, `fetchCalls=${fetchCalls}`);
    assert("control: endpoint 200 with a recommendation", r.status === 200 && r.json !== null, `status=${r.status} body=${JSON.stringify(r.json)}`);
  }
} finally {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
