import http from "node:http";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import FormData from "form-data";

const port = 5055;
const baseUrl = `http://127.0.0.1:${port}`;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
let cookieHeader = "";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      `${baseUrl}${path}`,
      {
        method: options.method || "GET",
        headers: {
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const setCookie = res.headers["set-cookie"];
        if (setCookie?.length) {
          cookieHeader = setCookie.map((cookie) => cookie.split(";")[0]).join("; ");
        }
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`${path} returned ${res.statusCode}: ${body}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(body);
          }
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function upload(path, fields, fileField) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append(fileField.name, fileField.value, fileField.options);
    const req = http.request(
      `${baseUrl}${path}`,
      {
        method: "POST",
        headers: {
          ...form.getHeaders(),
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
      },
      (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${path} returned ${res.statusCode}: ${body}`));
          return;
        }
        resolve(JSON.parse(body));
      });
    });
    req.on("error", reject);
    form.pipe(req);
  });
}

function base32ToBuffer(secret) {
  let bits = "";
  for (const char of secret.replace(/=+$/g, "").toUpperCase()) {
    const value = BASE32.indexOf(char);
    if (value >= 0) bits += value.toString(2).padStart(5, "0");
  }
  return Buffer.from((bits.match(/.{8}/g) || []).map((byte) => parseInt(byte, 2)));
}

function totp(secret) {
  const counter = Math.floor(Date.now() / 30_000);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter & 0xffffffff, 4);
  const hmac = crypto.createHmac("sha1", base32ToBuffer(secret)).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

async function waitForServer(proc) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (proc.exitCode !== null) {
      throw new Error(`Server exited early with code ${proc.exitCode}`);
    }
    try {
      await request("/api/health");
      return;
    } catch {
      await wait(400);
    }
  }
  throw new Error("Server did not become ready within 15 seconds");
}

const proc = spawn(process.execPath, ["dist/index.cjs"], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    DISPATCHOS_DB_PATH: `smoke-${Date.now()}.db`,
    DISPATCHOS_DATA_ROOT: `smoke-data-${Date.now()}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
proc.stdout.on("data", (data) => {
  output += data.toString();
});
proc.stderr.on("data", (data) => {
  output += data.toString();
});

try {
  await waitForServer(proc);

  const health = await request("/api/health");
  if (!health.ok) throw new Error("/api/health did not return ok=true");

  const initialAuth = await request("/api/auth/status");
  if (initialAuth.isConfigured) throw new Error("Smoke DB auth should start unconfigured");
  const setup = await request("/api/auth/setup", {
    method: "POST",
    body: { username: "owner", password: "SmokePassword123!" },
  });
  if (!setup.totpSecret) throw new Error("Auth setup did not return TOTP secret");
  await request("/api/auth/login", {
    method: "POST",
    body: { username: "owner", password: "SmokePassword123!", token: totp(setup.totpSecret) },
  });
  const authed = await request("/api/auth/status");
  if (!authed.authenticated) throw new Error("Auth login failed");

  const clients = await request("/api/clients");
  if (!Array.isArray(clients) || clients.length < 3) {
    throw new Error("/api/clients must return at least 3 seeded clients");
  }

  const board = await request("/api/dispatch-board?clientId=ivan-enclosed-01");
  if (!board.topRecommendation) throw new Error("dispatch board missing topRecommendation");
  if (!board.loads?.[0]?.netPpmTotal) throw new Error("loads missing net total PPM scoring");
  if (!["high", "medium", "low"].includes(board.loads[0].locationConfidence)) {
    throw new Error("loads missing location confidence");
  }

  const createdClient = await request("/api/clients", {
    method: "POST",
    body: {
      name: "Smoke Test Carrier",
      mc: "MC-000111",
      equipment: "hotshot_flatbed",
      targetPpm: 2.2,
      minimumPpm: 1.9,
      mpg: 10,
      fuelPrice: 3.6,
      fixedCostPerMile: 0.35,
      preferredLanes: ["TX → Midwest"],
      avoidStates: [],
      currentLocation: {
        city: "Austin",
        state: "TX",
        lat: 30.2672,
        lng: -97.7431,
        source: "manual_checkin",
        updatedAt: new Date().toISOString(),
        status: "empty",
        availableAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      },
    },
  });
  if (!createdClient.id) throw new Error("POST /api/clients did not create id");

  const updatedClient = await request(`/api/clients/${createdClient.id}/location`, {
    method: "PATCH",
    body: {
      city: "San Antonio",
      state: "TX",
      lat: 29.4252,
      lng: -98.4946,
      source: "manual_checkin",
      status: "empty",
    },
  });
  if (updatedClient.currentLocation.city !== "San Antonio") {
    throw new Error("PATCH /api/clients/:id/location did not persist location");
  }

  const createdLoad = await request("/api/loads", {
    method: "POST",
    body: {
      source: "Manual smoke",
      originCity: "San Antonio",
      originState: "TX",
      originLat: 29.4252,
      originLng: -98.4946,
      destinationCity: "Tulsa",
      destinationState: "OK",
      destinationLat: 36.154,
      destinationLng: -95.9928,
      rate: 1550,
      loadedMiles: 520,
      pickupAt: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(),
      deliveryAt: new Date(Date.now() + 30 * 60 * 60 * 1000).toISOString(),
      equipment: "hotshot_flatbed",
      brokerName: "Smoke Broker",
      brokerMc: "MC-222333",
      brokerScore: 80,
      fraudRisk: 10,
      marketQuality: 75,
    },
  });
  if (!createdLoad.id) throw new Error("POST /api/loads did not create id");

  const smokeBoard = await request(`/api/dispatch-board?clientId=${createdClient.id}`);
  if (!smokeBoard.loads.some((load) => load.id === createdLoad.id)) {
    throw new Error("Created load is missing from scored dispatch board");
  }

  const audit = await request("/api/audit?limit=10");
  if (!Array.isArray(audit) || audit.length < 3) {
    throw new Error("/api/audit did not return create/update events");
  }

  const broker = await request("/api/broker/check", {
    method: "POST",
    body: { brokerMc: "MC-222333", brokerName: "Smoke Broker" },
  });
  if (!broker.verdict || !broker.riskScore) {
    throw new Error("/api/broker/check missing verdict/riskScore");
  }

  const document = await request("/api/documents", {
    method: "POST",
    body: {
      clientId: createdClient.id,
      loadId: createdLoad.id,
      type: "rate_confirmation",
      status: "received",
      fileName: "smoke-rate-confirmation.pdf",
      notes: "Smoke test document metadata.",
    },
  });
  if (!document.id) throw new Error("POST /api/documents did not create id");

  const csv = [
    "source,originCity,originState,originLat,originLng,destinationCity,destinationState,destinationLat,destinationLng,rate,loadedMiles,pickupAt,deliveryAt,equipment,brokerName,brokerMc,brokerScore,fraudRisk,marketQuality,notes",
    `CSV Smoke,Austin,TX,30.2672,-97.7431,Oklahoma City,OK,35.4676,-97.5164,1200,390,${new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()},${new Date(Date.now() + 30 * 60 * 60 * 1000).toISOString()},hotshot_flatbed,CSV Broker,MC-444555,76,12,72,Imported by smoke`,
  ].join("\n");
  const imported = await request("/api/loads/import-csv", {
    method: "POST",
    body: { csv },
  });
  if (!Array.isArray(imported.created) || imported.created.length !== 1) {
    throw new Error("CSV import did not create one load");
  }

  const drivePlan = await request(`/api/drive/folder-plan?clientId=${createdClient.id}`);
  if (!Array.isArray(drivePlan.folders) || drivePlan.folders.length !== 1) {
    throw new Error("/api/drive/folder-plan did not return client folder plan");
  }

  const createdFolders = await request("/api/drive/create-local-folders", {
    method: "POST",
    body: { clientId: createdClient.id },
  });
  if (!Array.isArray(createdFolders.created) || createdFolders.created.length < 2) {
    throw new Error("/api/drive/create-local-folders did not create folder list");
  }

  const telegramLoc = await request("/api/telegram/command", {
    method: "POST",
    body: {
      clientId: createdClient.id,
      command: "/loc",
      city: "Temple",
      state: "TX",
      lat: 31.0982,
      lng: -97.3428,
      text: "Empty at truck stop",
    },
  });
  if (telegramLoc.action !== "location_updated") throw new Error("Telegram /loc did not update location");

  const telegramYes = await request("/api/telegram/command", {
    method: "POST",
    body: { clientId: createdClient.id, command: "/yes", text: "approve top load" },
  });
  if (!telegramYes.ok) throw new Error("Telegram /yes did not return ok");

  const email = await request("/api/email/ingest", {
    method: "POST",
    body: {
      from: "broker@example.com",
      subject: "Load Austin TX to Tulsa OK $1550",
      body: "Austin TX -> Tulsa OK, 520 miles, pickup today, MC-222333",
    },
  });
  if (!email.parsed) throw new Error("/api/email/ingest did not parse email");

  const uploadPath = `smoke-upload-${Date.now()}.txt`;
  writeFileSync(uploadPath, "smoke rate confirmation");
  const uploaded = await upload(
    "/api/documents/upload",
    {
      clientId: createdClient.id,
      loadId: createdLoad.id,
      type: "bol",
      status: "received",
      notes: "Uploaded by smoke",
    },
    {
      name: "file",
      value: Buffer.from("smoke rate confirmation"),
      options: { filename: "smoke-bol.txt", contentType: "text/plain" },
    },
  );
  rmSync(uploadPath, { force: true });
  if (!uploaded.storageUrl) throw new Error("/api/documents/upload missing storageUrl");

  const backup = await request("/api/backup/export");
  if (!backup.exportedAt || !Array.isArray(backup.clients) || !Array.isArray(backup.loads) || !Array.isArray(backup.documents)) {
    throw new Error("/api/backup/export did not return a full backup payload");
  }

  const redactedBackup = await request("/api/backup/export?redacted=true");
  if (redactedBackup.documents.some((document) => String(document.storageUrl || "").includes("uploads"))) {
    throw new Error("Redacted backup leaked local upload path");
  }

  console.log("[OK] /api/health");
  console.log("[OK] auth setup/login/TOTP");
  console.log("[OK] /api/clients");
  console.log("[OK] /api/dispatch-board location-aware scoring");
  console.log("[OK] POST /api/clients");
  console.log("[OK] PATCH /api/clients/:id/location");
  console.log("[OK] POST /api/loads");
  console.log("[OK] POST /api/loads/import-csv");
  console.log("[OK] POST /api/broker/check");
  console.log("[OK] POST /api/documents");
  console.log("[OK] /api/drive/folder-plan");
  console.log("[OK] /api/drive/create-local-folders");
  console.log("[OK] /api/telegram/command");
  console.log("[OK] /api/email/ingest");
  console.log("[OK] /api/documents/upload");
  console.log("[OK] /api/audit");
  console.log("[OK] /api/backup/export");
  console.log("[OK] /api/backup/export?redacted=true");

  const integrations = await request("/api/integrations/status");
  if (!Array.isArray(integrations.integrations)) throw new Error("/api/integrations/status failed");
  const system = await request("/api/system/status");
  if (!Array.isArray(system.checks)) throw new Error("/api/system/status failed");
  const portal = await request("/api/portal/status");
  if (!portal.adminPortal) throw new Error("/api/portal/status failed");
  if (portal.phase !== "1.3.0-phase1") {
    throw new Error("/api/portal/status missing phase=1.3.0-phase1");
  }
  if (!portal.dispatcherPortal || !portal.driverPortal) {
    throw new Error("/api/portal/status missing dispatcher/driver portal blocks");
  }
  const report = await request(`/api/reports/weekly?clientId=${createdClient.id}`);
  if (!report.summary) throw new Error("/api/reports/weekly failed");
  console.log("[OK] /api/integrations/status");
  console.log("[OK] /api/system/status");
  console.log("[OK] /api/portal/status (phase 1)");
  console.log("[OK] /api/reports/weekly");

  // -------------------------------------------------------------------------
  // Phase 1 checks
  // -------------------------------------------------------------------------

  // GET /api/me should return the admin who was created by bootstrap.
  const me = await request("/api/me");
  if (!me.id || me.role !== "admin") {
    throw new Error(`/api/me did not return admin role, got role=${me.role}`);
  }
  if (!me.email || !me.email.includes("@")) {
    throw new Error(`/api/me email is invalid: ${me.email}`);
  }
  if (me.twoFactorEnabled !== true) {
    throw new Error("/api/me did not report twoFactorEnabled=true for bootstrapped admin");
  }
  if (typeof me.linkedClientId !== "undefined" || typeof me.assignedClientIds !== "undefined") {
    throw new Error("/api/me leaked dispatcher/driver fields on admin response");
  }
  console.log("[OK] /api/me admin shape");

  // auth status now includes role and authenticated:true
  const status2 = await request("/api/auth/status");
  if (!status2.authenticated || status2.role !== "admin") {
    throw new Error("/api/auth/status did not include role=admin after login");
  }
  if (status2.authDisabled !== false) {
    throw new Error("/api/auth/status should report authDisabled=false (backdoor removed)");
  }
  console.log("[OK] /api/auth/status reflects role");

  // Backup export now includes users (without secrets) and the new tables.
  const backupV2 = await request("/api/backup/export");
  if (!Array.isArray(backupV2.users) || backupV2.users.length < 1) {
    throw new Error("/api/backup/export must include users[]");
  }
  if (backupV2.users.some((u) => u.passwordHash || u.passwordSalt || u.totpSecret)) {
    throw new Error("/api/backup/export leaked password/TOTP secrets");
  }
  if (!Array.isArray(backupV2.invites) || !Array.isArray(backupV2.assignments) || !Array.isArray(backupV2.invoices)) {
    throw new Error("/api/backup/export missing invites/assignments/invoices arrays");
  }
  if (backupV2.version !== "1.3.0-phase1") {
    throw new Error(`/api/backup/export version mismatch: got ${backupV2.version}`);
  }
  console.log("[OK] /api/backup/export Phase 1 shape (users, invites, assignments, invoices)");

  // Logout, then verify /api/me returns 401 and protected endpoints return 401.
  await request("/api/auth/logout", { method: "POST" });
  cookieHeader = ""; // clear local cookie store
  let unauthedMeStatus = 0;
  try {
    await request("/api/me");
  } catch (err) {
    unauthedMeStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (unauthedMeStatus !== 401) {
    throw new Error(`/api/me after logout returned ${unauthedMeStatus}, expected 401`);
  }
  let unauthedClientsStatus = 0;
  try {
    await request("/api/clients");
  } catch (err) {
    unauthedClientsStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (unauthedClientsStatus !== 401) {
    throw new Error(`/api/clients after logout returned ${unauthedClientsStatus}, expected 401`);
  }
  console.log("[OK] logout invalidates session (401 on /api/me and /api/clients)");

  // Re-login still works after logout (proves persistent session store is alive).
  await request("/api/auth/login", {
    method: "POST",
    body: { username: "owner", password: "SmokePassword123!", token: totp(setup.totpSecret) },
  });
  const reMe = await request("/api/me");
  if (reMe.id !== me.id) {
    throw new Error("re-login returned a different user id");
  }
  console.log("[OK] re-login produces same user id (persistent users table)");

  // Bootstrap should refuse to run again now that an admin exists (409).
  let bootstrapStatus = 0;
  try {
    await request("/api/auth/bootstrap", {
      method: "POST",
      body: { email: "second-admin@example.com", password: "AnotherPass123!" },
    });
  } catch (err) {
    bootstrapStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (bootstrapStatus !== 409) {
    throw new Error(`/api/auth/bootstrap repeat returned ${bootstrapStatus}, expected 409`);
  }
  console.log("[OK] /api/auth/bootstrap rejects re-run after admin exists");

  // -------------------------------------------------------------------------
  // Phase 3 — P0 checks (admin users CRUD + invites + signup)
  // -------------------------------------------------------------------------

  // GET /api/admin/users — admin himself is in the list
  const usersList = await request("/api/admin/users?limit=50");
  if (!Array.isArray(usersList.items)) {
    throw new Error("/api/admin/users did not return paginated { items: [...] }");
  }
  if (!usersList.items.some((u) => u.role === "admin")) {
    throw new Error("/api/admin/users did not include the bootstrapped admin");
  }
  if (typeof usersList.hasMore !== "boolean") {
    throw new Error("/api/admin/users response missing hasMore boolean");
  }
  if (usersList.items.some((u) => u.passwordHash || u.passwordSalt || u.totpSecret)) {
    throw new Error("/api/admin/users leaked secret fields");
  }
  console.log("[OK] GET /api/admin/users paginated shape");

  // POST /api/admin/invites — dispatcher invite
  const dispatcherInvite = await request("/api/admin/invites", {
    method: "POST",
    body: { role: "dispatcher", ttlHours: 24 },
  });
  if (!/^DOS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(dispatcherInvite.code)) {
    throw new Error(`invite code does not match DOS-XXXX-XXXX-XXXX format: ${dispatcherInvite.code}`);
  }
  if (!dispatcherInvite.signupUrl || !dispatcherInvite.signupUrl.includes("#/signup?code=")) {
    throw new Error(`invite signupUrl missing hash-route /#/signup: ${dispatcherInvite.signupUrl}`);
  }
  if (dispatcherInvite.role !== "dispatcher") {
    throw new Error("invite did not return role=dispatcher");
  }
  console.log("[OK] POST /api/admin/invites (DOS-XXXX-XXXX-XXXX + hash signupUrl)");

  // GET /api/admin/invites — status=active includes the new one
  const activeInvites = await request("/api/admin/invites?status=active&limit=50");
  if (!Array.isArray(activeInvites.items) || !activeInvites.items.some((i) => i.code === dispatcherInvite.code)) {
    throw new Error("/api/admin/invites?status=active did not return the new invite");
  }
  console.log("[OK] GET /api/admin/invites?status=active");

  // role=admin invites are rejected
  let adminInviteStatus = 0;
  try {
    await request("/api/admin/invites", { method: "POST", body: { role: "admin" } });
  } catch (err) {
    adminInviteStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (adminInviteStatus !== 400) {
    throw new Error(`POST /api/admin/invites role=admin returned ${adminInviteStatus}, expected 400`);
  }
  console.log("[OK] /api/admin/invites refuses role=admin");

  // -------------------------------------------------------------------------
  // Signup as a brand-new user (separate cookie jar)
  // -------------------------------------------------------------------------
  const adminCookieHeader = cookieHeader;
  cookieHeader = "";
  const signupRes = await request("/api/auth/signup", {
    method: "POST",
    body: {
      inviteCode: dispatcherInvite.code,
      email: "smoke.dispatcher@example.com",
      fullName: "Smoke Dispatcher",
      password: "SmokeDispatcher1!",
    },
  });
  if (!signupRes.id || signupRes.role !== "dispatcher") {
    throw new Error(`/api/auth/signup did not return dispatcher: ${JSON.stringify(signupRes)}`);
  }
  if (!signupRes.totpSecret || !signupRes.otpauthUrl) {
    throw new Error("/api/auth/signup did not return TOTP onboarding fields");
  }
  if (signupRes.redirect !== "/dispatch") {
    throw new Error(`/api/auth/signup redirect should be /dispatch, got ${signupRes.redirect}`);
  }
  // Session is auto-bound after signup — /api/me should now return the dispatcher.
  const meAfterSignup = await request("/api/me");
  if (meAfterSignup.id !== signupRes.id || meAfterSignup.role !== "dispatcher") {
    throw new Error("/api/me after signup did not reflect the new user");
  }
  console.log("[OK] POST /api/auth/signup consumes invite + auto-login");

  // Re-using the consumed code → 400
  let reuseStatus = 0;
  try {
    await request("/api/auth/signup", {
      method: "POST",
      body: {
        inviteCode: dispatcherInvite.code,
        email: "another.dispatcher@example.com",
        fullName: "Another",
        password: "AnotherPass1!",
      },
    });
  } catch (err) {
    reuseStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (reuseStatus !== 400) {
    throw new Error(`re-using a consumed invite returned ${reuseStatus}, expected 400`);
  }
  console.log("[OK] consumed invite cannot be re-used");

  // Dispatcher cannot reach /api/admin/users (role gating)
  let forbiddenStatus = 0;
  try {
    await request("/api/admin/users?limit=10");
  } catch (err) {
    forbiddenStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (forbiddenStatus !== 403) {
    throw new Error(`/api/admin/users as dispatcher returned ${forbiddenStatus}, expected 403`);
  }
  console.log("[OK] /api/admin/users blocks non-admin (403)");

  await request("/api/auth/logout", { method: "POST" });
  cookieHeader = adminCookieHeader; // back to admin session

  // -------------------------------------------------------------------------
  // Admin POST /api/admin/users — create a stub driver, then GET by id
  // -------------------------------------------------------------------------
  const stubDriver = await request("/api/admin/users", {
    method: "POST",
    body: {
      email: "stub.driver@example.com",
      fullName: "Stub Driver",
      role: "driver",
    },
  });
  if (stubDriver.role !== "driver" || stubDriver.blocked !== false) {
    throw new Error("POST /api/admin/users did not return the new driver");
  }
  if (stubDriver.twoFactorEnabled !== false) {
    throw new Error("stub driver should have twoFactorEnabled=false (no TOTP yet)");
  }
  const fetched = await request(`/api/admin/users/${stubDriver.id}`);
  if (fetched.id !== stubDriver.id) {
    throw new Error("GET /api/admin/users/:id did not return the right user");
  }
  // Duplicate email rejected
  let dupStatus = 0;
  try {
    await request("/api/admin/users", {
      method: "POST",
      body: { email: "stub.driver@example.com", fullName: "Dup", role: "driver" },
    });
  } catch (err) {
    dupStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (dupStatus !== 409) {
    throw new Error(`duplicate email returned ${dupStatus}, expected 409`);
  }
  console.log("[OK] POST + GET /api/admin/users (stub + duplicate guard)");

  // PATCH — block then unblock the stub driver
  const blocked = await request(`/api/admin/users/${stubDriver.id}`, {
    method: "PATCH",
    body: { blocked: true },
  });
  if (blocked.blocked !== true) throw new Error("PATCH blocked:true did not stick");
  const unblocked = await request(`/api/admin/users/${stubDriver.id}`, {
    method: "PATCH",
    body: { blocked: false, fullName: "Stub Driver (renamed)" },
  });
  if (unblocked.blocked !== false || unblocked.fullName !== "Stub Driver (renamed)") {
    throw new Error("PATCH unblock+rename did not persist");
  }
  console.log("[OK] PATCH /api/admin/users/:id");

  // Last-admin protection: admin tries to block himself → 400
  let selfBlockStatus = 0;
  try {
    await request(`/api/admin/users/${me.id}`, { method: "PATCH", body: { blocked: true } });
  } catch (err) {
    selfBlockStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (selfBlockStatus !== 400) {
    throw new Error(`self-block returned ${selfBlockStatus}, expected 400`);
  }
  // Admin tries to demote himself away from role=admin → 400 (last admin)
  let demoteStatus = 0;
  try {
    await request(`/api/admin/users/${me.id}`, {
      method: "PATCH",
      body: { role: "dispatcher" },
    });
  } catch (err) {
    demoteStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (demoteStatus !== 400) {
    throw new Error(`demote last admin returned ${demoteStatus}, expected 400`);
  }
  console.log("[OK] last-admin protection (block-self + role-demote)");

  // Filters: q="stub" finds the driver, role=driver narrows correctly
  const filteredQ = await request("/api/admin/users?q=stub&role=driver&limit=50");
  if (!filteredQ.items.some((u) => u.id === stubDriver.id)) {
    throw new Error("filter q=stub&role=driver missed the stub driver");
  }
  if (filteredQ.items.some((u) => u.role !== "driver")) {
    throw new Error("role=driver filter leaked non-drivers");
  }
  console.log("[OK] /api/admin/users filters (q, role)");
} catch (error) {
  console.error("[FAIL]", error.message);
  console.error(output);
  process.exitCode = 1;
} finally {
  proc.kill("SIGTERM");
}
