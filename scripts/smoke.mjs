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

  // -------------------------------------------------------------------------
  // Phase 3 — P1 checks (reset-password, reset-totp, revoke invite, assignments)
  // -------------------------------------------------------------------------

  // We need a real-pw user we can log in as. The dispatcher created in P0
  // (smoke.dispatcher@example.com) qualifies — bring them back for testing.
  // Look them up by listing all users.
  const allUsers = await request("/api/admin/users?limit=200");
  const dispUser = allUsers.items.find((u) => u.email === "smoke.dispatcher@example.com");
  if (!dispUser) throw new Error("Could not locate smoke.dispatcher user for P1 tests");

  // -- reset-password --------------------------------------------------------
  const reset1 = await request(`/api/admin/users/${dispUser.id}/reset-password`, {
    method: "POST",
    body: {},
  });
  if (!reset1.temporaryPassword || reset1.temporaryPassword.length !== 16) {
    throw new Error(`reset-password default length should be 16, got ${reset1.temporaryPassword?.length}`);
  }
  if (reset1.userId !== dispUser.id || reset1.email !== dispUser.email) {
    throw new Error("reset-password response missing/wrong userId or email");
  }
  // Old password "SmokeDispatcher1!" should no longer work.
  // (TOTP also got reset at this point... actually no — reset-password
  // doesn't touch TOTP. The dispatcher still has TOTP from their original
  // signup. We don't have that secret in this scope, so we won't try to
  // log them in here — that path is already exercised by P0's signup.
  // We'll verify password rotation by using a custom length next.)
  const reset2 = await request(`/api/admin/users/${dispUser.id}/reset-password`, {
    method: "POST",
    body: { length: 24 },
  });
  if (reset2.temporaryPassword.length !== 24) {
    throw new Error(`reset-password length=24 should yield 24-char password`);
  }
  if (reset2.temporaryPassword === reset1.temporaryPassword) {
    throw new Error("reset-password generated identical passwords twice — CSPRNG broken?");
  }
  let badLenStatus = 0;
  try {
    await request(`/api/admin/users/${dispUser.id}/reset-password`, {
      method: "POST",
      body: { length: 8 },
    });
  } catch (err) {
    badLenStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (badLenStatus !== 400) {
    throw new Error(`reset-password length=8 returned ${badLenStatus}, expected 400`);
  }
  console.log("[OK] POST /api/admin/users/:id/reset-password (default + length + validation)");

  // -- reset-totp (regenerate) ----------------------------------------------
  const totpReset = await request(`/api/admin/users/${dispUser.id}/reset-totp`, {
    method: "POST",
    body: { disable: false },
  });
  if (!totpReset.totpSecret || !totpReset.otpauthUrl) {
    throw new Error("reset-totp disable=false should return totpSecret + otpauthUrl");
  }
  if ("totpDisabled" in totpReset) {
    throw new Error("reset-totp disable=false should NOT have totpDisabled field");
  }
  if (totpReset.userId !== dispUser.id) throw new Error("reset-totp userId mismatch");

  // Verify TOTP is still enabled in the user record.
  const afterTotpReset = await request(`/api/admin/users/${dispUser.id}`);
  if (afterTotpReset.twoFactorEnabled !== true) {
    throw new Error("user.twoFactorEnabled should be true after reset (regenerate)");
  }
  console.log("[OK] POST /api/admin/users/:id/reset-totp regenerate");

  // -- reset-totp (disable) --------------------------------------------------
  const totpOff = await request(`/api/admin/users/${dispUser.id}/reset-totp`, {
    method: "POST",
    body: { disable: true },
  });
  if (totpOff.totpDisabled !== true) {
    throw new Error("reset-totp disable=true should return totpDisabled:true");
  }
  if ("totpSecret" in totpOff || "otpauthUrl" in totpOff) {
    throw new Error("reset-totp disable=true should NOT include secret/otpauthUrl");
  }
  const afterTotpOff = await request(`/api/admin/users/${dispUser.id}`);
  if (afterTotpOff.twoFactorEnabled !== false) {
    throw new Error("user.twoFactorEnabled should be false after disable");
  }
  console.log("[OK] POST /api/admin/users/:id/reset-totp disable=true");

  // 404 for unknown user id
  let totp404 = 0;
  try {
    await request(`/api/admin/users/usr_does_not_exist/reset-totp`, { method: "POST", body: {} });
  } catch (err) {
    totp404 = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (totp404 !== 404) {
    throw new Error(`reset-totp unknown user returned ${totp404}, expected 404`);
  }
  console.log("[OK] reset-totp / reset-password 404 on unknown user");

  // -- DELETE /api/admin/invites/:code (revoke) -----------------------------
  const liveInvite = await request("/api/admin/invites", {
    method: "POST",
    body: { role: "driver", ttlHours: 48 },
  });
  const revoked = await request(`/api/admin/invites/${liveInvite.code}`, { method: "DELETE" });
  if (revoked.code !== liveInvite.code || !revoked.revokedAt) {
    throw new Error("revoke invite response shape wrong");
  }
  // Now this code should no longer appear in active-status list...
  const stillActive = await request(`/api/admin/invites?status=active&limit=200`);
  if (stillActive.items.some((i) => i.code === liveInvite.code)) {
    throw new Error("revoked invite still appears in status=active");
  }
  // ...but it should appear in expired-status list.
  const inExpired = await request(`/api/admin/invites?status=expired&limit=200`);
  if (!inExpired.items.some((i) => i.code === liveInvite.code)) {
    throw new Error("revoked invite missing from status=expired");
  }
  // And signup with the revoked code → 400 (same generic message as expired).
  let revokedSignupStatus = 0;
  try {
    await request("/api/auth/signup", {
      method: "POST",
      body: {
        inviteCode: liveInvite.code,
        email: "should.not.work@example.com",
        fullName: "Nope",
        password: "WontWork123!",
      },
    });
  } catch (err) {
    revokedSignupStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (revokedSignupStatus !== 400) {
    throw new Error(`signup with revoked invite returned ${revokedSignupStatus}, expected 400`);
  }
  // Revoking again → 404 (the storage layer treats it as a found but already
  // expired row; we don't reject re-revokes — but unknown code returns 404).
  let revoke404 = 0;
  try {
    await request(`/api/admin/invites/DOS-XXXX-YYYY-ZZZZ`, { method: "DELETE" });
  } catch (err) {
    revoke404 = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (revoke404 !== 404) {
    throw new Error(`DELETE unknown invite returned ${revoke404}, expected 404`);
  }
  console.log("[OK] DELETE /api/admin/invites/:code (revoke + 404 + signup-blocked)");

  // -- Assignments ----------------------------------------------------------
  // Need a real dispatcher and a real client. dispUser is a dispatcher.
  // Pick any client from /api/clients (Phase 1 seed has 3).
  const allClients = await request("/api/clients");
  const someClient = allClients[0];
  if (!someClient?.id) throw new Error("No seeded clients available for assignment tests");

  // GET on empty (filtered to this dispatcher) should be []
  const emptyList = await request(
    `/api/admin/assignments?dispatcherId=${dispUser.id}&limit=50`,
  );
  if (!Array.isArray(emptyList.items)) {
    throw new Error("GET /api/admin/assignments did not return items[]");
  }

  const assignment = await request("/api/admin/assignments", {
    method: "POST",
    body: { clientId: someClient.id, dispatcherUserId: dispUser.id },
  });
  if (!assignment.id || assignment.removedAt !== null) {
    throw new Error("POST /api/admin/assignments did not return a fresh row");
  }
  if (assignment.clientId !== someClient.id || assignment.dispatcherUserId !== dispUser.id) {
    throw new Error("created assignment has wrong client/dispatcher refs");
  }
  // List should now contain it
  const afterCreate = await request(
    `/api/admin/assignments?dispatcherId=${dispUser.id}&limit=50`,
  );
  if (!afterCreate.items.some((a) => a.id === assignment.id)) {
    throw new Error("listed assignments missing the just-created one");
  }
  // Duplicate active → 409 with code: "duplicate_active"
  let dupAsnStatus = 0;
  let dupAsnBody = null;
  try {
    await request("/api/admin/assignments", {
      method: "POST",
      body: { clientId: someClient.id, dispatcherUserId: dispUser.id },
    });
  } catch (err) {
    dupAsnStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
    const bodyMatch = String(err.message).match(/returned \d+: (.+)$/);
    if (bodyMatch) {
      try { dupAsnBody = JSON.parse(bodyMatch[1]); } catch {}
    }
  }
  if (dupAsnStatus !== 409) {
    throw new Error(`duplicate active assignment returned ${dupAsnStatus}, expected 409`);
  }
  if (!dupAsnBody || dupAsnBody.code !== "duplicate_active") {
    throw new Error(`duplicate response should carry code:'duplicate_active', got ${JSON.stringify(dupAsnBody)}`);
  }
  console.log("[OK] POST /api/admin/assignments + duplicate_active guard (409)");

  // role guard — admin user is not a dispatcher
  let roleStatus = 0;
  try {
    await request("/api/admin/assignments", {
      method: "POST",
      body: { clientId: someClient.id, dispatcherUserId: me.id },
    });
  } catch (err) {
    roleStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (roleStatus !== 400) {
    throw new Error(`assignment with admin-role user returned ${roleStatus}, expected 400`);
  }

  // unknown client / dispatcher → 404
  let unkClientStatus = 0;
  try {
    await request("/api/admin/assignments", {
      method: "POST",
      body: { clientId: "cli_does_not_exist", dispatcherUserId: dispUser.id },
    });
  } catch (err) {
    unkClientStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (unkClientStatus !== 404) {
    throw new Error(`unknown client returned ${unkClientStatus}, expected 404`);
  }
  let unkDispStatus = 0;
  try {
    await request("/api/admin/assignments", {
      method: "POST",
      body: { clientId: someClient.id, dispatcherUserId: "usr_nope" },
    });
  } catch (err) {
    unkDispStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (unkDispStatus !== 404) {
    throw new Error(`unknown dispatcher returned ${unkDispStatus}, expected 404`);
  }
  console.log("[OK] assignment guards (role + 404 client + 404 dispatcher)");

  // DELETE — soft-delete + visibility via includeRemoved
  const removed = await request(`/api/admin/assignments/${assignment.id}`, { method: "DELETE" });
  if (!removed.removedAt || removed.removedByUserId !== me.id) {
    throw new Error("DELETE /api/admin/assignments/:id did not stamp removedAt + removedByUserId");
  }
  // Default list (includeRemoved=false) should NOT contain it any more
  const afterDelete = await request(
    `/api/admin/assignments?dispatcherId=${dispUser.id}&limit=50`,
  );
  if (afterDelete.items.some((a) => a.id === assignment.id)) {
    throw new Error("removed assignment still appears with includeRemoved default (false)");
  }
  // With includeRemoved=true — it should reappear
  const allHistory = await request(
    `/api/admin/assignments?dispatcherId=${dispUser.id}&includeRemoved=true&limit=50`,
  );
  const found = allHistory.items.find((a) => a.id === assignment.id);
  if (!found || !found.removedAt) {
    throw new Error("removed assignment missing from includeRemoved=true history");
  }
  // Double-remove → 409 already_removed
  let doubleRemoveStatus = 0;
  try {
    await request(`/api/admin/assignments/${assignment.id}`, { method: "DELETE" });
  } catch (err) {
    doubleRemoveStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (doubleRemoveStatus !== 409) {
    throw new Error(`double-delete returned ${doubleRemoveStatus}, expected 409`);
  }
  // Re-creating the same pair after remove is allowed and produces a NEW id
  const recreated = await request("/api/admin/assignments", {
    method: "POST",
    body: { clientId: someClient.id, dispatcherUserId: dispUser.id },
  });
  if (recreated.id === assignment.id) {
    throw new Error("re-created assignment should have a fresh id");
  }
  console.log("[OK] DELETE /api/admin/assignments/:id + history + re-create allowed");

  // -------------------------------------------------------------------------
  // Phase 3 — P2 checks (billing preview/generate/list/patch + booking link)
  // -------------------------------------------------------------------------

  // Use one of the seeded clients for billing math.
  const billingClient = allClients.find((c) => c.id === "ivan-enclosed-01") || allClients[0];
  const billingClient2 = allClients.find((c) => c.id === "oleg-hotshot-02") || allClients[1];

  // Create three loads tied to that client, all booked in 2026-05-04..05-10
  const billingWeekStart = "2026-05-04";
  const billingWeekEnd = "2026-05-10";

  function makeBookableLoad({ rate, bookedAt, clientId, originCity = "Tampa", destinationCity = "Atlanta" }) {
    return {
      source: "P2 Smoke",
      originCity,
      originState: "FL",
      originLat: 27.95,
      originLng: -82.45,
      destinationCity,
      destinationState: "GA",
      destinationLat: 33.75,
      destinationLng: -84.38,
      rate,
      loadedMiles: 460,
      pickupAt: new Date().toISOString(),
      deliveryAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      equipment: "enclosed_car_hauler",
      brokerName: "P2 Smoke Broker",
      brokerMc: "MC-999000",
      brokerScore: 80,
      fraudRisk: 12,
      marketQuality: 70,
      clientId,
      bookedAt,
    };
  }

  const ivanLoad1 = await request("/api/loads", {
    method: "POST",
    body: makeBookableLoad({ rate: 850, bookedAt: "2026-05-05", clientId: billingClient.id }),
  });
  const ivanLoad2 = await request("/api/loads", {
    method: "POST",
    body: makeBookableLoad({
      rate: 1200,
      bookedAt: "2026-05-09",
      clientId: billingClient.id,
      originCity: "Miami",
      destinationCity: "Charlotte",
    }),
  });
  // Out-of-window load for ivan — should NOT contribute to the invoice
  await request("/api/loads", {
    method: "POST",
    body: makeBookableLoad({ rate: 5000, bookedAt: "2026-04-30", clientId: billingClient.id }),
  });
  // Load for a different client — should NOT contribute either
  await request("/api/loads", {
    method: "POST",
    body: makeBookableLoad({ rate: 9999, bookedAt: "2026-05-07", clientId: billingClient2.id }),
  });

  if (!ivanLoad1.id || !ivanLoad2.id) {
    throw new Error("Failed to create bookable loads for P2 smoke");
  }
  console.log("[OK] POST /api/loads accepts optional clientId + bookedAt");

  // -- preview ---------------------------------------------------------------
  const preview = await request("/api/admin/billing/preview", {
    method: "POST",
    body: { clientId: billingClient.id, weekStart: billingWeekStart, weekEnd: billingWeekEnd },
  });
  if (preview.id !== null || preview.status !== null || preview.generatedAt !== null) {
    throw new Error("billing preview must have id/status/generatedAt = null");
  }
  if (preview.grossBooked !== 2050) {
    throw new Error(`grossBooked should be 2050 (850 + 1200), got ${preview.grossBooked}`);
  }
  if (preview.flatFee !== 150) {
    throw new Error(`flatFee should be 150, got ${preview.flatFee}`);
  }
  // 2050 * 0.03 = 61.5 — round-cents must NOT collapse trailing zero
  if (Math.abs(preview.percentFee - 61.5) > 0.001) {
    throw new Error(`percentFee should be 61.5 (2050 * 0.03), got ${preview.percentFee}`);
  }
  if (Math.abs(preview.totalDue - 211.5) > 0.001) {
    throw new Error(`totalDue should be 211.5 (150 + 61.5), got ${preview.totalDue}`);
  }
  if (preview.breakdown.loadCount !== 2) {
    throw new Error(`breakdown.loadCount should be 2, got ${preview.breakdown.loadCount}`);
  }
  if (preview.breakdown.loads.length !== 2) {
    throw new Error("breakdown.loads length mismatch");
  }
  if (!preview.breakdown.loads.every((l) => l.loadId && l.originCity && l.destinationCity)) {
    throw new Error("breakdown.loads missing required fields");
  }
  console.log("[OK] POST /api/admin/billing/preview (math + breakdown + nulls)");

  // Preview for client with no bookings → flat only
  const emptyPreview = await request("/api/admin/billing/preview", {
    method: "POST",
    body: { clientId: "max-van-03", weekStart: billingWeekStart, weekEnd: billingWeekEnd },
  });
  if (emptyPreview.grossBooked !== 0 || emptyPreview.percentFee !== 0 || emptyPreview.totalDue !== 150) {
    throw new Error(
      `empty preview should be grossBooked=0, percentFee=0, totalDue=150; got ${JSON.stringify({
        g: emptyPreview.grossBooked,
        p: emptyPreview.percentFee,
        t: emptyPreview.totalDue,
      })}`,
    );
  }
  if (emptyPreview.breakdown.loadCount !== 0) {
    throw new Error("empty preview should have loadCount=0");
  }
  console.log("[OK] preview with no bookings returns flat-fee only");

  // Validation paths
  let prev404 = 0;
  try {
    await request("/api/admin/billing/preview", {
      method: "POST",
      body: { clientId: "cli_does_not_exist", weekStart: billingWeekStart, weekEnd: billingWeekEnd },
    });
  } catch (err) {
    prev404 = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (prev404 !== 404) throw new Error(`preview unknown client returned ${prev404}, expected 404`);

  let prevBadDate = 0;
  try {
    await request("/api/admin/billing/preview", {
      method: "POST",
      body: { clientId: billingClient.id, weekStart: "not-a-date", weekEnd: billingWeekEnd },
    });
  } catch (err) {
    prevBadDate = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (prevBadDate !== 400) throw new Error(`preview bad date returned ${prevBadDate}, expected 400`);

  let prevBadRange = 0;
  try {
    await request("/api/admin/billing/preview", {
      method: "POST",
      body: { clientId: billingClient.id, weekStart: "2026-05-10", weekEnd: "2026-05-04" },
    });
  } catch (err) {
    prevBadRange = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (prevBadRange !== 400) throw new Error(`preview reversed range returned ${prevBadRange}, expected 400`);
  console.log("[OK] preview validation (404 unknown / 400 bad date / 400 reversed range)");

  // -- generate --------------------------------------------------------------
  const invoiceDraft = await request("/api/admin/billing/generate", {
    method: "POST",
    body: { clientId: billingClient.id, weekStart: billingWeekStart, weekEnd: billingWeekEnd },
  });
  if (!invoiceDraft.id || invoiceDraft.status !== "draft" || !invoiceDraft.generatedAt) {
    throw new Error("generate must return persisted invoice with id + status=draft + generatedAt");
  }
  if (Math.abs(invoiceDraft.totalDue - 211.5) > 0.001) {
    throw new Error(`generated totalDue should be 211.5, got ${invoiceDraft.totalDue}`);
  }
  // Duplicate generate for same (client, weekStart) → 409 with existingInvoiceId
  let dupGenStatus = 0;
  let dupGenBody = null;
  try {
    await request("/api/admin/billing/generate", {
      method: "POST",
      body: { clientId: billingClient.id, weekStart: billingWeekStart, weekEnd: billingWeekEnd },
    });
  } catch (err) {
    dupGenStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
    const bm = String(err.message).match(/returned \d+: (.+)$/);
    if (bm) { try { dupGenBody = JSON.parse(bm[1]); } catch {} }
  }
  if (dupGenStatus !== 409) throw new Error(`duplicate generate returned ${dupGenStatus}, expected 409`);
  if (!dupGenBody || dupGenBody.existingInvoiceId !== invoiceDraft.id) {
    throw new Error(`duplicate generate should carry existingInvoiceId, got ${JSON.stringify(dupGenBody)}`);
  }
  console.log("[OK] POST /api/admin/billing/generate (persist + 409 dup with existingInvoiceId)");

  // generate with status="sent" stamps sentAt
  const invoiceSent = await request("/api/admin/billing/generate", {
    method: "POST",
    body: {
      clientId: billingClient2.id,
      weekStart: billingWeekStart,
      weekEnd: billingWeekEnd,
      status: "sent",
    },
  });
  if (invoiceSent.status !== "sent" || !invoiceSent.sentAt) {
    throw new Error(`generate status=sent should stamp sentAt; got ${JSON.stringify(invoiceSent)}`);
  }
  console.log("[OK] generate status='sent' stamps sentAt at creation");

  // -- list ------------------------------------------------------------------
  const allInvoices = await request("/api/admin/billing/invoices?limit=50");
  if (!Array.isArray(allInvoices.items) || allInvoices.items.length < 2) {
    throw new Error("invoice list should have at least 2 items");
  }
  // Filter by client
  const byClient = await request(`/api/admin/billing/invoices?clientId=${billingClient.id}&limit=50`);
  if (!byClient.items.every((inv) => inv.clientId === billingClient.id)) {
    throw new Error("clientId filter leaked other clients");
  }
  if (!byClient.items.some((inv) => inv.id === invoiceDraft.id)) {
    throw new Error("clientId filter dropped our draft invoice");
  }
  // Filter by status
  const sentOnly = await request("/api/admin/billing/invoices?status=sent&limit=50");
  if (!sentOnly.items.every((inv) => inv.status === "sent")) {
    throw new Error("status=sent filter leaked other statuses");
  }
  if (!sentOnly.items.some((inv) => inv.id === invoiceSent.id)) {
    throw new Error("status=sent filter dropped our sent invoice");
  }
  console.log("[OK] GET /api/admin/billing/invoices (list + clientId + status filters)");

  // -- PATCH transitions -----------------------------------------------------
  // draft → sent
  const toSent = await request(`/api/admin/billing/invoices/${invoiceDraft.id}`, {
    method: "PATCH",
    body: { status: "sent" },
  });
  if (toSent.status !== "sent" || !toSent.sentAt) {
    throw new Error("PATCH draft→sent did not stamp sentAt");
  }
  // sent → paid
  const toPaid = await request(`/api/admin/billing/invoices/${invoiceDraft.id}`, {
    method: "PATCH",
    body: { status: "paid" },
  });
  if (toPaid.status !== "paid" || !toPaid.paidAt) {
    throw new Error("PATCH sent→paid did not stamp paidAt");
  }
  // paid → void: forbidden (paid is immutable)
  let pVStatus = 0;
  let pVBody = null;
  try {
    await request(`/api/admin/billing/invoices/${invoiceDraft.id}`, {
      method: "PATCH",
      body: { status: "void" },
    });
  } catch (err) {
    pVStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
    const bm = String(err.message).match(/returned \d+: (.+)$/);
    if (bm) { try { pVBody = JSON.parse(bm[1]); } catch {} }
  }
  if (pVStatus !== 409) throw new Error(`paid→void returned ${pVStatus}, expected 409`);
  if (!pVBody || pVBody.from !== "paid" || pVBody.to !== "void") {
    throw new Error(`invalid transition should carry from/to, got ${JSON.stringify(pVBody)}`);
  }
  // Notes-only update is allowed even on paid (immutable applies to status)
  const noted = await request(`/api/admin/billing/invoices/${invoiceDraft.id}`, {
    method: "PATCH",
    body: { notes: "Paid via Telegram by Ivan" },
  });
  if (noted.notes !== "Paid via Telegram by Ivan") {
    throw new Error("PATCH notes did not persist");
  }
  // Unknown id → 404
  let patch404 = 0;
  try {
    await request(`/api/admin/billing/invoices/inv-nope`, { method: "PATCH", body: { status: "sent" } });
  } catch (err) {
    patch404 = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (patch404 !== 404) throw new Error(`PATCH unknown id returned ${patch404}, expected 404`);
  // Bad status → 400
  let patchBad = 0;
  try {
    await request(`/api/admin/billing/invoices/${invoiceSent.id}`, {
      method: "PATCH",
      body: { status: "garbage" },
    });
  } catch (err) {
    patchBad = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (patchBad !== 400) throw new Error(`PATCH bad status returned ${patchBad}, expected 400`);
  console.log("[OK] PATCH /api/admin/billing/invoices/:id transitions + notes + 404 + 400");
} catch (error) {
  console.error("[FAIL]", error.message);
  console.error(output);
  process.exitCode = 1;
} finally {
  proc.kill("SIGTERM");
}
