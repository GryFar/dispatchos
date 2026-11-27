// ai-drafts route test (temp DB, in-process Express) — locks the security gates
// on POST /api/ai/draft-broker-reply.
// Run: npx tsx server/routes/ai-drafts.test.ts
//
// Covers:
//   - requireRole: a non-dispatcher (driver) → 403, no model call.
//   - tenant isolation: a dispatcher NOT assigned to the load's carrier → 404
//     (anti-enumeration), no model call.
//   - validation: missing loadId → 400.
//   - kill-switch (the fix): DISPATCHOS_AI_KILL=1 → 503 ai_unavailable and the
//     model is NEVER called — the switch must PREVENT the paid call, not just
//     refuse to record it afterwards.
//   - happy path: 200 { draft }, exactly one model call, one quota unit spent.
//
// The model is mocked by overriding globalThis.fetch (same as broker-reply.test.ts),
// so nothing hits the network. A test session is injected via an X-Test-User
// header, mirroring routes/me-owner-view.test.ts.

import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

process.env.DISPATCHOS_DB_PATH = join(
  tmpdir(),
  `dispatchos-ai-drafts-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.db`,
);
process.env.DISPATCHOS_KEYRING_PRIMARY ||= Buffer.alloc(32, 7).toString("base64");
// A key IS set so the model path is reachable — but globalThis.fetch is mocked,
// so no real call is ever made.
process.env.ANTHROPIC_API_KEY = "test-key";
delete process.env.DISPATCHOS_AI_KILL;

const express = (await import("express")).default;
const { storage } = await import("../storage");
const { registerAiDraftRoutes } = await import("./ai-drafts");

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

// --- model mock (override globalThis.fetch; fetchWithTimeout calls it) --------
const realFetch = globalThis.fetch;
let fetchCalls = 0;
function mockDraft(text = "Thanks for the offer — given our lane average we'd need $2,600 to cover this. Can you do that?"): void {
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return {
      ok: true,
      json: async () => ({ content: [{ type: "text", text }] }),
      text: async () => "",
    } as unknown as Response;
  }) as typeof fetch;
}

// --- fixtures ----------------------------------------------------------------
function mkUser(role: string, linkedClientId?: string) {
  return storage.createUser({
    email: `${role}-${rnd()}@example.com`,
    fullName: `${role} User`,
    role: role as any,
    passwordSalt: "salt",
    passwordHash: "hash",
    ...(linkedClientId ? { linkedClientId } : {}),
  } as any);
}
function mkClient(name: string) {
  return storage.upsertClient({
    name,
    mc: `MC-${Math.floor(Math.random() * 900000 + 100000)}`,
    equipment: "open_car_hauler",
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
      city: "Dallas", state: "TX", lat: 32.7767, lng: -96.797,
      status: "empty", updatedAt: new Date().toISOString(),
    },
  } as any);
}
function mkLoad(clientId: string) {
  return storage.upsertLoad({
    source: "TEST",
    originCity: "Dallas", originState: "TX", originLat: 32.7767, originLng: -96.797,
    destinationCity: "Atlanta", destinationState: "GA", destinationLat: 33.749, destinationLng: -84.388,
    rate: 2000, loadedMiles: 780,
    pickupAt: "2026-08-01T12:00:00.000Z", deliveryAt: "2026-08-02T12:00:00.000Z",
    equipment: "open_car_hauler", brokerName: "Acme Logistics", brokerMc: "",
    brokerScore: 70, fraudRisk: 15, marketQuality: 70,
    clientId,
  } as any);
}

const admin = mkUser("admin"); // so getAuthState().isConfigured === true
const dispatcher = mkUser("dispatcher");
const otherDispatcher = mkUser("dispatcher");
const driver = mkUser("driver");
const carrier = mkClient("Assigned Carrier");
const load = mkLoad(carrier.id);
storage.createAssignment({ clientId: carrier.id, dispatcherUserId: dispatcher.id, createdByUserId: admin.id });

// --- app boot with test session injection (mirrors me-owner-view.test.ts) ----
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  const uid = req.headers["x-test-user"];
  if (typeof uid === "string" && uid) {
    const u = storage.getUserById(uid);
    req.session = { userId: uid, role: u?.role, epoch: (u as any)?.sessionEpoch ?? 0, destroy: (cb: () => void) => cb() };
  } else {
    req.session = { destroy: (cb: () => void) => cb() };
  }
  next();
});
registerAiDraftRoutes(app);

const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as any).port;

interface Res { status: number; json: any }
function post(path: string, opts: { asUserId?: string; body?: unknown }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = {};
    if (opts.asUserId) headers["x-test-user"] = opts.asUserId;
    if (bodyStr !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(bodyStr));
    }
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        let json: any = null;
        try { json = b ? JSON.parse(b) : null; } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

const PATH = "/api/ai/draft-broker-reply";

// 1. Non-dispatcher (driver) → 403, no model call.
{
  mockDraft();
  const r = await post(PATH, { asUserId: driver.id, body: { loadId: load.id } });
  assert("driver → 403", r.status === 403, `status=${r.status}`);
  assert("driver: model not called", fetchCalls === 0, `calls=${fetchCalls}`);
}

// 2. Tenant isolation: a dispatcher NOT assigned to the carrier → 404, no call.
{
  mockDraft();
  const r = await post(PATH, { asUserId: otherDispatcher.id, body: { loadId: load.id } });
  assert("unassigned dispatcher → 404 (anti-enumeration)", r.status === 404, `status=${r.status}`);
  assert("tenant: model not called", fetchCalls === 0, `calls=${fetchCalls}`);
}

// 3. Missing loadId → 400.
{
  mockDraft();
  const r = await post(PATH, { asUserId: dispatcher.id, body: {} });
  assert("missing loadId → 400", r.status === 400, `status=${r.status}`);
  assert("400: model not called", fetchCalls === 0, `calls=${fetchCalls}`);
}

// 4. Kill-switch (the fix): DISPATCHOS_AI_KILL=1 → 503 and the model is NEVER
//    called — the switch must PREVENT the paid call, not refuse it afterwards.
{
  process.env.DISPATCHOS_AI_KILL = "1";
  mockDraft();
  const r = await post(PATH, { asUserId: dispatcher.id, body: { loadId: load.id } });
  assert("kill-switch → 503", r.status === 503, `status=${r.status}`);
  assert("kill-switch → code ai_unavailable", r.json?.code === "ai_unavailable", JSON.stringify(r.json));
  assert("kill-switch: model NOT called (the fix)", fetchCalls === 0, `calls=${fetchCalls}`);
  delete process.env.DISPATCHOS_AI_KILL;
}

// 5. Happy path → 200 { draft }, exactly one model call, one quota unit spent.
{
  const before = storage.getAiQuotaStatus(dispatcher.id, undefined, carrier.id).remainingToday;
  mockDraft("Counter-offer: $2,600 all-in given our lane average. Let me know.");
  const r = await post(PATH, { asUserId: dispatcher.id, body: { loadId: load.id } });
  assert("assigned dispatcher → 200", r.status === 200, `status=${r.status}`);
  assert("200: draft string returned", typeof r.json?.draft === "string" && r.json.draft.length > 0);
  assert("200: model called exactly once", fetchCalls === 1, `calls=${fetchCalls}`);
  const after = storage.getAiQuotaStatus(dispatcher.id, undefined, carrier.id).remainingToday;
  assert("200: one quota unit consumed", after === before - 1, `before=${before} after=${after}`);
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
await new Promise<void>((resolve) => server.close(() => resolve()));
process.exit(fail > 0 ? 1 : 0);
