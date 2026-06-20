import http from "node:http";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import FormData from "form-data";

const port = 5055;
const baseUrl = `http://127.0.0.1:${port}`;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
// M4: out-of-band token the locked bootstrap gate requires in production mode.
const SMOKE_BOOTSTRAP_TOKEN = crypto.randomBytes(16).toString("hex");
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
          // CSRF Origin check (PR #90, V3-4) rejects authenticated non-GET
          // requests without an Origin. The server whitelists http://127.* and
          // http://localhost, so send our own loopback origin to mimic a real
          // same-origin browser request rather than weakening the check.
          Origin: baseUrl,
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
          ...(options.headers || {}),
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
          Origin: baseUrl, // CSRF Origin check (PR #90) — same as in request()
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

function totp(secret, stepOffset = 0) {
  const counter = Math.floor(Date.now() / 30_000) + stepOffset;
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

// Wait until just inside the next 30s TOTP window. The server accepts codes only
// within a ±1 window AND refuses any counter <= the last accepted one (replay
// guard, server/auth.ts verifyTotp). After confirm-signup (counter C) and the
// first login (C+1), a 3rd login in the SAME 30s window is impossible by design —
// no in-window candidate exceeds minCounter. So we let the clock roll into a fresh
// window, then log in with stepOffset=1 (drift +1) to clear the replay guard.
async function waitForNextTotpWindow() {
  const ms = 30_000 - (Date.now() % 30_000) + 750;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// fix(smoke): TOTP-confirm-before-login helpers — PR #116 contract
// ---------------------------------------------------------------------------
// After #116, POST /api/auth/signup no longer auto-creates a session.
// Instead it returns { pendingConfirmationToken, totpSecret }.  The caller
// must POST /api/auth/totp/confirm-signup with a valid TOTP code to stamp
// totp_confirmed_at and receive a real session.
//
// Similarly, POST /api/auth/setup (bootstrap) does not return a
// pendingConfirmationToken.  Use confirmTotpViaResumeSetup() for that path:
// it calls POST /api/auth/totp/resume-setup (email+password) to obtain a
// fresh token, then confirm-signup as above.
// ---------------------------------------------------------------------------

/**
 * Confirm a pending TOTP setup using the token returned by /api/auth/signup.
 * On success, confirm-signup creates the session (sets cookieHeader).
 */
async function confirmTotpSignup(pendingConfirmationToken, totpSecret, stepOffset = 0) {
  const res = await request("/api/auth/totp/confirm-signup", {
    method: "POST",
    body: { pendingConfirmationToken, token: totp(totpSecret, stepOffset) },
  });
  if (!res.ok) throw new Error(`confirm-signup did not return ok=true: ${JSON.stringify(res)}`);
  return res;
}

/**
 * For the bootstrap-admin path: /api/auth/setup doesn't return a
 * pendingConfirmationToken, so we obtain one via resume-setup and then
 * confirm. After this call the session is NOT yet set (resume-setup is
 * unauthenticated and confirm-signup logs the user in), so callers should
 * then call /api/auth/login as before once totp_confirmed_at is stamped.
 *
 * Actually, confirm-signup itself creates the session, so after this call
 * the cookieHeader is live and login is not needed.  We keep the original
 * login call after this to preserve the smoke's explicit login-path coverage.
 * To avoid TOTP replay, pass stepOffset=1 to the subsequent login.
 */
async function confirmTotpViaResumeSetup(email, password, stepOffset = 0) {
  const resume = await request("/api/auth/totp/resume-setup", {
    method: "POST",
    body: { email, password },
  });
  if (!resume.pendingConfirmationToken || !resume.totpSecret) {
    throw new Error(`resume-setup did not return token/secret: ${JSON.stringify(resume)}`);
  }
  await confirmTotpSignup(resume.pendingConfirmationToken, resume.totpSecret, stepOffset);
  return resume.totpSecret;
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

// Per-run artifacts — captured so the finally block can delete them (otherwise
// every smoke run leaves a smoke-*.db + smoke-data-*/ behind; ~hundreds of MB
// piled up before this cleanup was added).
const SMOKE_STAMP = Date.now();
const SMOKE_DB_PATH = `smoke-${SMOKE_STAMP}.db`;
const SMOKE_DATA_ROOT = `smoke-data-${SMOKE_STAMP}`;

const proc = spawn(process.execPath, ["dist/index.cjs"], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    DISPATCHOS_DB_PATH: SMOKE_DB_PATH,
    DISPATCHOS_DATA_ROOT: SMOKE_DATA_ROOT,
    // The mock load-board adapter is gated out of production (it fabricates
    // loads). The smoke run boots in NODE_ENV=production but needs it to
    // exercise the load-source pipeline, so opt in explicitly here.
    DISPATCHOS_ENABLE_MOCK_ADAPTER: "true",
    DISPATCHOS_RATE_LIMIT_PER_MINUTE: "5000",
    // Boot-gate (Critical #3, PR #71) refuses to start in production mode
    // without a real session secret. Provide an ephemeral 64-char hex secret
    // for the smoke run — not a known placeholder, satisfies the >= 32 check.
    DISPATCHOS_SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
    // Cookie defaults to Secure in production mode (PR #71), but the smoke
    // server runs over plain http://127.0.0.1, so a Secure cookie would never
    // round-trip and every post-login request would look unauthenticated.
    // Disable Secure for the local smoke run only.
    DISPATCHOS_COOKIE_SECURE: "false",
    // M4: bootstrap is now locked whenever NODE_ENV=production (this smoke run
    // starts the server in production mode), so the harness must present a
    // bootstrap token to create the first admin. Send it via X-Bootstrap-Token
    // on the /api/auth/setup + /api/auth/bootstrap calls below.
    DISPATCHOS_BOOTSTRAP_TOKEN: SMOKE_BOOTSTRAP_TOKEN,
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

  // Boot must be clean: the auth rate-limiter's custom keyGenerator has to
  // normalize IPs via ipKeyGenerator, or express-rate-limit warns
  // ERR_ERL_KEY_GEN_IPV6 (an IPv6 client could otherwise bypass the limit).
  if (/ERR_ERL_KEY_GEN_IPV6/.test(output)) {
    throw new Error("server logged ERR_ERL_KEY_GEN_IPV6 — rate-limiter keyGenerator must use ipKeyGenerator");
  }
  console.log("[OK] server boots without rate-limiter IPv6 keygen warning");

  const health = await request("/api/health");
  if (!health.ok) throw new Error("/api/health did not return ok=true");

  const initialAuth = await request("/api/auth/status");
  if (initialAuth.isConfigured) throw new Error("Smoke DB auth should start unconfigured");
  const setup = await request("/api/auth/setup", {
    method: "POST",
    headers: { "X-Bootstrap-Token": SMOKE_BOOTSTRAP_TOKEN },
    body: { username: "owner", password: "SmokePassword123!" },
  });
  if (!setup.totpSecret) throw new Error("Auth setup did not return TOTP secret");
  // fix(smoke) #116: setup doesn't stamp totp_confirmed_at — use resume-setup
  // to get a pendingConfirmationToken, confirm TOTP, then login explicitly.
  // confirm-signup logs us in (creates session), but we still call login below
  // to keep explicit coverage of the login path.  Use stepOffset=1 on login
  // to avoid replay rejection by the counter guard (PR #99).
  await confirmTotpViaResumeSetup("owner@dispatchos.local", "SmokePassword123!");
  // Session from confirm-signup is now live; clear it so we exercise login path.
  cookieHeader = "";
  await request("/api/auth/login", {
    method: "POST",
    body: { username: "owner", password: "SmokePassword123!", token: totp(setup.totpSecret, 1) },
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

  // Phase 1 smoke originally hit /api/audit?limit=10. Phase 3 P4 redefines
  // ?limit=… as the paginated path (spec §6.1), so this assertion now uses
  // the no-params path which keeps the legacy flat-array contract for v1.2.7
  // dashboards. The paginated path is exercised in the P4 block below.
  const audit = await request("/api/audit");
  if (!Array.isArray(audit) || audit.length < 3) {
    throw new Error("/api/audit (legacy) did not return create/update events");
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
  // confirm-signup (offset 0) and the first login (offset 1) consume two counters
  // in the current 30s window; the server's ±1 window + replay guard make a third
  // in-window login impossible, so wait for a fresh window and use offset 1.
  await waitForNextTotpWindow();
  await request("/api/auth/login", {
    method: "POST",
    body: { username: "owner", password: "SmokePassword123!", token: totp(setup.totpSecret, 1) },
  });
  const reMe = await request("/api/me");
  if (reMe.id !== me.id) {
    throw new Error("re-login returned a different user id");
  }
  console.log("[OK] re-login produces same user id (persistent users table)");

  // M4 regression: in production mode the gate rejects a tokenless bootstrap
  // with 401 *before* it even checks whether auth is configured.
  let noTokenStatus = 0;
  try {
    await request("/api/auth/bootstrap", {
      method: "POST",
      body: { email: "no-token@example.com", password: "AnotherPass123!" },
    });
  } catch (err) {
    noTokenStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (noTokenStatus !== 401) {
    throw new Error(`/api/auth/bootstrap without token returned ${noTokenStatus}, expected 401`);
  }
  console.log("[OK] /api/auth/bootstrap rejects tokenless call in production mode (M4)");

  // With a valid token, bootstrap should refuse to run again now that an admin
  // exists (409).
  let bootstrapStatus = 0;
  try {
    await request("/api/auth/bootstrap", {
      method: "POST",
      headers: { "X-Bootstrap-Token": SMOKE_BOOTSTRAP_TOKEN },
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
  // V5-006: invite codes are 5 blocks (~98 bits), DOS-XXXX-XXXX-XXXX-XXXX-XXXX
  // (see server/lib/invite-code.ts). Older smoke expected 3 blocks.
  if (!/^DOS-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){4}$/.test(dispatcherInvite.code)) {
    throw new Error(`invite code does not match DOS-XXXX-XXXX-XXXX-XXXX-XXXX format: ${dispatcherInvite.code}`);
  }
  if (!dispatcherInvite.signupUrl || !dispatcherInvite.signupUrl.includes("#/signup?code=")) {
    throw new Error(`invite signupUrl missing hash-route /#/signup: ${dispatcherInvite.signupUrl}`);
  }
  if (dispatcherInvite.role !== "dispatcher") {
    throw new Error("invite did not return role=dispatcher");
  }
  console.log("[OK] POST /api/admin/invites (DOS-XXXX-XXXX-XXXX-XXXX-XXXX + hash signupUrl)");

  // Anti-fraud: a disposable-email signup is rejected before the invite is
  // consumed. Use a fresh invite so the rejection can't be confused with an
  // already-used code, and verify the invite survives (not consumed).
  const disposableInvite = await request("/api/admin/invites", {
    method: "POST",
    body: { role: "dispatcher", ttlHours: 24 },
  });
  let disposableStatus = 0;
  let disposableCode = "";
  const savedCookie = cookieHeader;
  cookieHeader = ""; // signup is unauthenticated
  try {
    await request("/api/auth/signup", {
      method: "POST",
      body: {
        inviteCode: disposableInvite.code,
        email: "throwaway@mailinator.com",
        fullName: "Throwaway Tester",
        password: "SmokeDisposable1!",
      },
    });
  } catch (err) {
    disposableStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
    disposableCode = /disposable_email/.test(String(err.message)) ? "disposable_email" : "";
  }
  cookieHeader = savedCookie; // back to admin
  if (disposableStatus !== 400 || disposableCode !== "disposable_email") {
    throw new Error(
      `disposable email signup should be 400 disposable_email, got ${disposableStatus} ${disposableCode}`,
    );
  }
  // The invite must still be active (rejection happens before consume).
  const disposableInviteStillActive = await request("/api/admin/invites?status=active&limit=50");
  if (!disposableInviteStillActive.items.some((i) => i.code === disposableInvite.code)) {
    throw new Error("disposable-rejected invite should NOT be consumed");
  }
  console.log("[OK] signup blocks disposable email (400) without consuming invite");

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
  // Seat limits (P1 revenue leak): an oo_basic carrier (1 included seat, no
  // paid overage) must not be able to add a second driver — neither directly
  // nor via a pending invite. Previously canAddDriver was never called.
  // -------------------------------------------------------------------------
  const seatClient = await request("/api/clients", {
    method: "POST",
    body: {
      name: "Seat Limit Carrier",
      mc: "MC-SEAT01",
      equipment: "open_car_hauler",
      planTier: "oo_basic",
      persona: "owner_operator",
      targetPpm: 2.5,
      minimumPpm: 2.0,
      mpg: 9,
      fuelPrice: 3.6,
      fixedCostPerMile: 0.4,
      preferredLanes: [],
      avoidStates: [],
      currentLocation: {
        city: "Dallas",
        state: "TX",
        lat: 32.7767,
        lng: -96.797,
        source: "manual_checkin",
        updatedAt: new Date().toISOString(),
        status: "empty",
        availableAt: new Date().toISOString(),
      },
    },
  });
  if (!seatClient.id) throw new Error("seat-limit: POST /api/clients did not create id");

  // First driver fills the single included seat — allowed.
  const firstDriver = await request("/api/admin/users", {
    method: "POST",
    body: {
      email: "seat.driver1@example.com",
      fullName: "Seat Driver One",
      role: "driver",
      linkedClientId: seatClient.id,
    },
  });
  if (!firstDriver.id) throw new Error("seat-limit: first driver should be allowed");
  console.log("[OK] seat-limit: first driver allowed on oo_basic");

  // Second driver must be blocked with 402 (needs upgrade).
  let secondDriverStatus = 0;
  try {
    await request("/api/admin/users", {
      method: "POST",
      body: {
        email: "seat.driver2@example.com",
        fullName: "Seat Driver Two",
        role: "driver",
        linkedClientId: seatClient.id,
      },
    });
  } catch (err) {
    secondDriverStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (secondDriverStatus !== 402) {
    throw new Error(`seat-limit: second driver returned ${secondDriverStatus}, expected 402`);
  }
  console.log("[OK] seat-limit: second driver blocked (402) on oo_basic");

  // A driver invite for the now-full carrier must also be blocked.
  let seatInviteStatus = 0;
  try {
    await request("/api/admin/invites", {
      method: "POST",
      body: { role: "driver", linkedClientId: seatClient.id },
    });
  } catch (err) {
    seatInviteStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (seatInviteStatus !== 402) {
    throw new Error(`seat-limit: driver invite returned ${seatInviteStatus}, expected 402`);
  }
  console.log("[OK] seat-limit: driver invite blocked (402) on full oo_basic carrier");

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
  // fix(smoke) #116: signup no longer auto-creates a session.  Confirm TOTP
  // via confirm-signup (which stamps totp_confirmed_at and creates the session).
  if (!signupRes.pendingConfirmationToken) {
    throw new Error("/api/auth/signup did not return pendingConfirmationToken");
  }
  await confirmTotpSignup(signupRes.pendingConfirmationToken, signupRes.totpSecret);
  // Session is now live (created by confirm-signup) — /api/me should return the dispatcher.
  const meAfterSignup = await request("/api/me");
  if (meAfterSignup.id !== signupRes.id || meAfterSignup.role !== "dispatcher") {
    throw new Error("/api/me after signup did not reflect the new user");
  }
  console.log("[OK] POST /api/auth/signup + confirm-signup creates session (TOTP confirmed)");

  // H1 (security regression): the legacy global routes are admin-only now — a
  // dispatcher must NOT read other tenants' data through them (they use the
  // tenant-scoped /api/dispatch/* API instead).
  for (const ep of ["/api/clients", "/api/loads", "/api/dispatch-board"]) {
    let st = 0;
    try { await request(ep); } catch (err) { st = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0); }
    if (st !== 403) {
      throw new Error(`dispatcher reached ${ep} (status ${st}), expected 403 — cross-tenant IDOR guard (H1)`);
    }
  }
  console.log("[OK] dispatcher blocked (403) from legacy admin-only routes (H1 IDOR guard)");

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

  // F2 AI Dispatcher: a dispatcher passes the role gate but is tenant-scoped —
  // requesting a client they aren't assigned to returns 404 (not 403), proving
  // the endpoint is registered, dispatcher-reachable, and tenant-guarded.
  let aiUnassignedStatus = 0;
  try {
    await request("/api/dispatch/ai-recommend", {
      method: "POST",
      body: { clientId: "definitely-not-assigned" },
    });
  } catch (err) {
    aiUnassignedStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (aiUnassignedStatus !== 404) {
    throw new Error(`ai-recommend for an unassigned client should be 404, got ${aiUnassignedStatus}`);
  }
  console.log("[OK] POST /api/dispatch/ai-recommend tenant-scopes to assigned clients (404)");

  await request("/api/auth/logout", { method: "POST" });
  cookieHeader = adminCookieHeader; // back to admin session

  // Security: a BLOCKED user must not be able to finish signup and obtain a
  // session via a still-valid pending-confirmation token (minted before the
  // block). Fresh invite → signup user B → block as admin → confirm-signup→403.
  const blockInvite = await request("/api/admin/invites", {
    method: "POST",
    body: { role: "dispatcher", ttlHours: 24 },
  });
  const adminCookieForBlockTest = cookieHeader;
  cookieHeader = ""; // signup is unauthenticated (separate jar)
  const blockedSignup = await request("/api/auth/signup", {
    method: "POST",
    body: {
      inviteCode: blockInvite.code,
      email: "smoke.blocked@example.com",
      fullName: "Blocked Signup",
      password: "BlockedSignup1!",
    },
  });
  if (!blockedSignup.id || !blockedSignup.pendingConfirmationToken || !blockedSignup.totpSecret) {
    throw new Error("blocked-signup setup missing id/pendingConfirmationToken/totpSecret");
  }
  cookieHeader = adminCookieForBlockTest; // back to admin to block them
  await request(`/api/admin/users/${blockedSignup.id}`, {
    method: "PATCH",
    body: { blocked: true },
  });
  cookieHeader = ""; // confirm-signup is unauthenticated
  let blockedConfirmStatus = 0;
  try {
    await request("/api/auth/totp/confirm-signup", {
      method: "POST",
      body: {
        pendingConfirmationToken: blockedSignup.pendingConfirmationToken,
        token: totp(blockedSignup.totpSecret),
      },
    });
  } catch (err) {
    blockedConfirmStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (blockedConfirmStatus !== 403) {
    throw new Error(`blocked user confirm-signup returned ${blockedConfirmStatus}, expected 403`);
  }
  cookieHeader = adminCookieForBlockTest; // restore admin session for the rest
  console.log("[OK] blocked user cannot finish signup via pending token (403)");

  // F2 AI Dispatcher: admin is the wrong role for /api/dispatch/* — 403.
  let aiAdminStatus = 0;
  try {
    await request("/api/dispatch/ai-recommend", {
      method: "POST",
      body: { clientId: "anything" },
    });
  } catch (err) {
    aiAdminStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (aiAdminStatus !== 403) {
    throw new Error(`ai-recommend as admin should be 403, got ${aiAdminStatus}`);
  }
  console.log("[OK] POST /api/dispatch/ai-recommend blocks admin (403)");

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

  // -- DELETE /api/admin/users/:id (soft delete) ----------------------------
  // Create a throwaway user specifically for the delete test so we don't
  // disturb stubDriver (used by later filter/P1 assertions).
  const toDelete = await request("/api/admin/users", {
    method: "POST",
    body: {
      email: "stub.todelete@example.com",
      fullName: "Delete Me",
      role: "driver",
    },
  });

  // Self-delete is refused (admin fat-finger guard).
  let selfDeleteStatus = 0;
  try {
    await request(`/api/admin/users/${me.id}`, { method: "DELETE" });
  } catch (err) {
    selfDeleteStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (selfDeleteStatus !== 400) {
    throw new Error(`self-delete returned ${selfDeleteStatus}, expected 400`);
  }

  // Delete the throwaway — should succeed, stamp deletedAt, force blocked.
  const deletedUser = await request(`/api/admin/users/${toDelete.id}`, {
    method: "DELETE",
  });
  if (!deletedUser.deletedAt) {
    throw new Error("DELETE user did not stamp deletedAt");
  }
  if (deletedUser.blocked !== true) {
    throw new Error("DELETE user should force blocked=true");
  }

  // Deleted user must disappear from default listing.
  const afterUserDelete = await request("/api/admin/users?q=todelete&limit=50");
  if (afterUserDelete.items.some((u) => u.id === toDelete.id)) {
    throw new Error("LEAK: soft-deleted user still appears in default listing");
  }

  // GET by id still returns the record (admin can inspect deleted users).
  const deletedFetch = await request(`/api/admin/users/${toDelete.id}`);
  if (!deletedFetch.deletedAt) {
    throw new Error("GET deleted user should still return record with deletedAt");
  }
  console.log("[OK] DELETE /api/admin/users/:id (soft delete + hidden from list + self-guard)");

  // -------------------------------------------------------------------------
  // Phase 3 — P1 checks (reset-password, reset-totp, revoke invite, assignments)

  // We need a real-pw user we can log in as. The dispatcher created in P0
  // (smoke.dispatcher@example.com) qualifies — bring them back for testing.
  // Look them up by listing all users.
  const allUsers = await request("/api/admin/users?limit=200");
  const dispUser = allUsers.items.find((u) => u.email === "smoke.dispatcher@example.com");
  if (!dispUser) throw new Error("Could not locate smoke.dispatcher user for P1 tests");

  // Keyset cursor round-trip over HTTP: page the full user set one row at a time,
  // following the opaque nextCursor, and assert we see every user exactly once
  // (no drops, no dupes). Exercises the real base64 keyset cursor end-to-end.
  {
    const expectedIds = allUsers.items.map((u) => u.id);
    const walked = [];
    let cursor = null;
    let guard = 0;
    do {
      const q = `/api/admin/users?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await request(q);
      walked.push(...page.items.map((u) => u.id));
      cursor = page.hasMore ? page.nextCursor : null;
      if (++guard > expectedIds.length + 5) throw new Error("user cursor walk did not terminate");
    } while (cursor);
    if (walked.length !== new Set(walked).size) {
      throw new Error(`cursor walk produced duplicate users: ${walked.join(",")}`);
    }
    if (new Set(walked).size !== new Set(expectedIds).size) {
      throw new Error(`cursor walk saw ${new Set(walked).size} users, expected ${new Set(expectedIds).size}`);
    }
    console.log("[OK] keyset cursor walk over /api/admin/users (no drops, no dupes)");
  }

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

  // -------------------------------------------------------------------------
  // Phase 3 — P3 checks (dashboard stats aggregate)
  // -------------------------------------------------------------------------

  const stats = await request("/api/admin/dashboard/stats");
  if (!stats.mrr || !stats.users || !stats.loads || !stats.audit || !stats.integrations || !stats.system) {
    throw new Error(`dashboard/stats missing top-level keys: ${Object.keys(stats).join(",")}`);
  }
  // MRR shape
  if (typeof stats.mrr.currentUsd !== "number" || typeof stats.mrr.activeClients !== "number") {
    throw new Error("mrr missing numeric currentUsd / activeClients");
  }
  // We've created 2 invoices in P2 (one draft→paid for ivan, one sent for oleg).
  // monthToDatePercentFee should be > 0 (61.5 + 61.5 = 123 for May 2026 if
  // both invoices count; status='paid' and status='sent' both qualify).
  if (stats.mrr.currentUsd <= 0) {
    throw new Error(`MRR currentUsd should be > 0 with active billing; got ${stats.mrr.currentUsd}`);
  }
  if (!stats.mrr.trend || !["up", "down", "flat"].includes(stats.mrr.trend.direction)) {
    throw new Error("mrr.trend.direction must be up|down|flat");
  }
  // users shape — admins>=1, dispatchers>=1 (smoke.dispatcher), drivers>=1 (stub)
  if (stats.users.admins < 1 || stats.users.dispatchers < 1 || stats.users.drivers < 1) {
    throw new Error(`users counts low: ${JSON.stringify(stats.users)}`);
  }
  if (typeof stats.users.lastSignupAt !== "string") {
    throw new Error("users.lastSignupAt should be set after P0 signup");
  }
  // loads shape — verdict object has exactly book/negotiate/skip
  const verdictKeys = Object.keys(stats.loads.byVerdict).sort();
  if (verdictKeys.join(",") !== "book,negotiate,skip") {
    throw new Error(`loads.byVerdict keys wrong: ${verdictKeys.join(",")}`);
  }
  // audit shape
  if (typeof stats.audit.eventsLast24h !== "number") {
    throw new Error("audit.eventsLast24h not a number");
  }
  if (stats.audit.eventsLast24h < 1) {
    throw new Error("audit.eventsLast24h should be >0 after running this smoke");
  }
  // integrations shape — at least the 5 keys mentioned in spec hint
  const intKeys = Object.keys(stats.integrations);
  if (intKeys.length < 4) {
    throw new Error(`expected several integrations, got ${intKeys.length}`);
  }
  for (const [name, h] of Object.entries(stats.integrations)) {
    if (!["ok", "warn", "missing", "error"].includes(h.status)) {
      throw new Error(`integration ${name} has bad status: ${h.status}`);
    }
  }
  // system shape
  if (!stats.system.version || typeof stats.system.uptimeSeconds !== "number") {
    throw new Error("system shape missing version/uptimeSeconds");
  }
  console.log("[OK] GET /api/admin/dashboard/stats (full shape + MRR + verdict + integrations)");

  // period=month works
  const statsMonth = await request("/api/admin/dashboard/stats?period=month");
  if (!statsMonth.loads || typeof statsMonth.loads.weekCount !== "number") {
    throw new Error("dashboard/stats?period=month did not return loads");
  }
  console.log("[OK] /api/admin/dashboard/stats?period=month");

  // Dispatcher gets 403
  const adminCookieForP3 = cookieHeader;
  cookieHeader = "";
  let dashForbidden = 0;
  try {
    // login as dispatcher first... we don't have the dispatcher's password
    // (P1 reset rotated it, the new temp pw is in scope as reset2.temporaryPassword).
    await request("/api/auth/login", {
      method: "POST",
      body: {
        email: "smoke.dispatcher@example.com",
        password: reset2.temporaryPassword,
        // P1 disabled TOTP for this user — login without token is allowed.
      },
    });
    await request("/api/admin/dashboard/stats");
    dashForbidden = 200;
  } catch (err) {
    dashForbidden = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (dashForbidden !== 403) {
    throw new Error(`dispatcher hitting /api/admin/dashboard/stats returned ${dashForbidden}, expected 403`);
  }
  cookieHeader = adminCookieForP3;
  console.log("[OK] /api/admin/dashboard/stats blocks non-admin (403)");

  // -------------------------------------------------------------------------
  // Phase 3 — P4 checks (audit pagination extension + legacy backward-compat)
  // -------------------------------------------------------------------------

  // Legacy contract — no query params → flat array (Event[])
  const legacy = await request("/api/audit");
  if (!Array.isArray(legacy)) {
    throw new Error("legacy /api/audit (no params) must return a flat array");
  }

  // ANY new query param → paginated shape
  const paged = await request("/api/audit?limit=20");
  if (!paged.items || !Array.isArray(paged.items)) {
    throw new Error("/api/audit?limit=20 must return paginated { items: [...] }");
  }
  if (typeof paged.hasMore !== "boolean") {
    throw new Error("paginated audit missing hasMore boolean");
  }
  if (paged.items.length === 0) {
    throw new Error("/api/audit?limit=20 returned no items, expected many after smoke run");
  }
  // Items are enriched with actorUserId/actorEmail (may be null)
  for (const ev of paged.items) {
    if (!("actorUserId" in ev) || !("actorEmail" in ev)) {
      throw new Error("paginated audit item missing actorUserId / actorEmail fields");
    }
    if (!("eventType" in ev) || !("createdAt" in ev)) {
      throw new Error("paginated audit item missing core fields");
    }
  }
  // At least one item should have a non-null actorUserId (admin actions throughout smoke)
  if (!paged.items.some((ev) => ev.actorUserId && ev.actorEmail)) {
    throw new Error("expected at least one audit event with actor enrichment");
  }
  console.log("[OK] /api/audit (paginated + actor enrichment)");

  // Filter by eventType
  const onlyUserCreated = await request("/api/audit?eventType=user.created&limit=50");
  if (!onlyUserCreated.items.every((ev) => ev.eventType === "user.created")) {
    throw new Error("eventType=user.created filter leaked other types");
  }
  if (onlyUserCreated.items.length < 1) {
    throw new Error("expected at least 1 user.created event in audit");
  }

  // Multi-eventType (array form)
  const twoTypes = await request("/api/audit?eventType=user.created&eventType=invite.created&limit=50");
  if (!twoTypes.items.every((ev) => ev.eventType === "user.created" || ev.eventType === "invite.created")) {
    throw new Error("multi eventType filter leaked other types");
  }

  // Filter by entityType
  const onlyInvites = await request("/api/audit?entityType=invite&limit=50");
  if (!onlyInvites.items.every((ev) => ev.entityType === "invite")) {
    throw new Error("entityType=invite filter leaked other entity types");
  }

  // Filter by actorId (admin user, who did the most ops in smoke)
  const byActor = await request(`/api/audit?actorId=${me.id}&limit=50`);
  if (!byActor.items.every((ev) => ev.actorUserId === me.id)) {
    throw new Error("actorId filter leaked other actors");
  }
  console.log("[OK] /api/audit filters (eventType single/multi, entityType, actorId)");

  // Filter by since/until window — events in last hour should match total
  const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await request(`/api/audit?since=${encodeURIComponent(sinceIso)}&limit=200`);
  if (!recent.items.every((ev) => ev.createdAt >= sinceIso)) {
    throw new Error("since filter let in older events");
  }
  console.log("[OK] /api/audit since filter");

  // limit validation
  let badLimit = 0;
  try {
    await request("/api/audit?limit=9999");
  } catch (err) {
    badLimit = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (badLimit !== 400) throw new Error(`audit limit=9999 returned ${badLimit}, expected 400`);
  console.log("[OK] /api/audit limit validation");

  // ===========================================================================
  // Phase 4 — driver portal P0
  // ===========================================================================
  //
  // Covers:
  //   - driver invite (linkedClientId), signup → redirect "/d"
  //   - GET /api/me/dashboard shape under driver session
  //   - GET /api/me/loads pagination + driver scoping
  //   - load assignment by setting driverId on POST /api/loads (additive)
  //   - cross-driver leakage check (driver B cannot see driver A's loads, 404 on detail)
  //   - POST /api/me/status (audit lookup)
  //   - PATCH /api/me/profile (fullName + phone)
  //   - GET /api/auth/login redirect=/d (already verified above in P0 signup,
  //     re-verified after explicit re-login below)
  //
  // At this point cookieHeader = adminCookieForP3 (admin session, set at line ~1364).
  // ---------------------------------------------------------------------------

  // billingClient already references ivan-enclosed-01 (seeded). Reuse for driver linkage.
  const driverInvite = await request("/api/admin/invites", {
    method: "POST",
    body: {
      role: "driver",
      ttlHours: 24,
      linkedClientId: billingClient.id,
    },
  });
  if (driverInvite.role !== "driver") {
    throw new Error(`P4 driver invite did not return role=driver: ${JSON.stringify(driverInvite)}`);
  }
  if (driverInvite.linkedClientId !== billingClient.id) {
    throw new Error(`P4 driver invite linkedClientId mismatch: ${driverInvite.linkedClientId}`);
  }
  if (!/#\/signup\?code=/.test(driverInvite.signupUrl || "")) {
    throw new Error(`P4 driver invite signupUrl missing hash route: ${driverInvite.signupUrl}`);
  }
  console.log("[OK] P4 driver invite (linkedClientId + hash signupUrl)");

  // Second driver invite for the cross-driver leak test (no linkedClientId needed
  // — driver tenancy is by user id, not client id).
  const driverInvite2 = await request("/api/admin/invites", {
    method: "POST",
    body: { role: "driver", ttlHours: 24 },
  });

  // Save admin cookie and signup driver A in a fresh jar.
  const p4AdminCookie = cookieHeader;
  cookieHeader = "";
  const driverA = await request("/api/auth/signup", {
    method: "POST",
    body: {
      inviteCode: driverInvite.code,
      email: "smoke.driver.a@example.com",
      fullName: "Smoke Driver A",
      password: "SmokeDriverA1!",
    },
  });
  if (driverA.role !== "driver") {
    throw new Error(`P4 driverA signup wrong role: ${JSON.stringify(driverA)}`);
  }
  if (driverA.redirect !== "/d") {
    throw new Error(`P4 driverA signup redirect expected "/d", got ${driverA.redirect}`);
  }
  // fix(smoke) #116: confirm TOTP to stamp totp_confirmed_at and create session.
  if (!driverA.pendingConfirmationToken) {
    throw new Error("P4 driverA signup did not return pendingConfirmationToken");
  }
  await confirmTotpSignup(driverA.pendingConfirmationToken, driverA.totpSecret);
  console.log("[OK] P4 driver signup + confirm-signup (redirect=/d, TOTP confirmed)");

  const driverACookie = cookieHeader;

  // Self-serve signup (no invite): creates a driver account with NO carrier/
  // trial — the trial is gated by the MC+FMCSA check in onboarding, not the
  // invite. (Anti-fraud is preserved; the invite path above still works.)
  cookieHeader = "";
  const selfServe = await request("/api/auth/signup", {
    method: "POST",
    body: { email: "selfserve.smoke@example.com", fullName: "Self Serve", password: "SelfServe123!" },
  });
  if (selfServe.role !== "driver" || !selfServe.pendingConfirmationToken) {
    throw new Error(`self-serve signup (no invite) wrong shape: ${JSON.stringify(selfServe)}`);
  }
  if (selfServe.redirect !== "/d") {
    throw new Error(`self-serve signup redirect expected "/d", got ${selfServe.redirect}`);
  }
  console.log("[OK] self-serve signup without invite (role=driver, no carrier yet)");
  cookieHeader = driverACookie;

  // GET /api/me — driverStatus + linkedClientId surfaced via toUserPublic
  const meDriverA = await request("/api/me");
  if (meDriverA.driverStatus !== "available") {
    throw new Error(`P4 /api/me driverStatus expected 'available', got ${meDriverA.driverStatus}`);
  }
  if (meDriverA.linkedClientId !== billingClient.id) {
    throw new Error(`P4 /api/me linkedClientId mismatch: ${meDriverA.linkedClientId}`);
  }
  console.log("[OK] P4 /api/me surfaces driverStatus + linkedClientId");

  // GET /api/me/dashboard — initial state (no loads yet)
  const dashEmpty = await request("/api/me/dashboard");
  if (!dashEmpty.driver || dashEmpty.driver.id !== driverA.id) {
    throw new Error(`P4 dashboard.driver.id mismatch: ${JSON.stringify(dashEmpty.driver)}`);
  }
  if (dashEmpty.driver.status !== "available") {
    throw new Error(`P4 dashboard.driver.status expected 'available', got ${dashEmpty.driver.status}`);
  }
  if (dashEmpty.currentLoad !== null) {
    throw new Error("P4 dashboard.currentLoad must be null when driver has no booked loads");
  }
  if (!Array.isArray(dashEmpty.recentLoads) || dashEmpty.recentLoads.length !== 0) {
    throw new Error(`P4 dashboard.recentLoads must be [] initially, got ${JSON.stringify(dashEmpty.recentLoads)}`);
  }
  if (dashEmpty.hasUnreadMessages !== false) {
    throw new Error("P4 dashboard.hasUnreadMessages must be false in P0");
  }
  if (!Array.isArray(dashEmpty.pendingDocs)) {
    throw new Error("P4 dashboard.pendingDocs must be an array");
  }
  console.log("[OK] P4 GET /api/me/dashboard initial shape (driver / null current / [] recent)");

  // GET /api/me/loads — initial empty paginated shape
  const loadsEmpty = await request("/api/me/loads");
  if (!Array.isArray(loadsEmpty.items) || loadsEmpty.items.length !== 0) {
    throw new Error("P4 /api/me/loads initial state must have items: []");
  }
  if (loadsEmpty.hasMore !== false || loadsEmpty.nextCursor !== null || loadsEmpty.total !== 0) {
    throw new Error(`P4 /api/me/loads initial pagination shape wrong: ${JSON.stringify(loadsEmpty)}`);
  }
  console.log("[OK] P4 GET /api/me/loads (cursor pagination, empty)");

  // Switch back to admin to create a load assigned to driver A.
  cookieHeader = p4AdminCookie;
  const driverALoad = await request("/api/loads", {
    method: "POST",
    body: {
      ...makeBookableLoad({
        rate: 1200,
        bookedAt: "2026-05-15",
        clientId: billingClient.id,
        originCity: "Orlando",
        destinationCity: "Charlotte",
      }),
      driverId: driverA.id,
    },
  });
  if (driverALoad.id == null) {
    throw new Error("P4 POST /api/loads with driverId did not return a load id");
  }
  // Re-fetch and confirm driverId is mirrored in the payload.
  const driverALoadCheck = await request(`/api/loads`);
  const foundDriverALoad = driverALoadCheck.find((l) => l.id === driverALoad.id);
  if (!foundDriverALoad || foundDriverALoad.driverId !== driverA.id) {
    throw new Error("P4 POST /api/loads did not persist driverId in payload");
  }
  console.log("[OK] P4 POST /api/loads accepts driverId additively");

  // Also create one available (no driverId) load and one for driver B to make
  // the leak test meaningful.
  const unassignedLoad = await request("/api/loads", {
    method: "POST",
    body: makeBookableLoad({
      rate: 999,
      bookedAt: "2026-05-15",
      clientId: billingClient.id,
      originCity: "Tampa",
      destinationCity: "Savannah",
    }),
  });
  if (!unassignedLoad.id) throw new Error("P4 unassigned load create failed");

  // Sign up driver B (different jar).
  cookieHeader = "";
  const driverB = await request("/api/auth/signup", {
    method: "POST",
    body: {
      inviteCode: driverInvite2.code,
      email: "smoke.driver.b@example.com",
      fullName: "Smoke Driver B",
      password: "SmokeDriverB1!",
    },
  });
  if (driverB.redirect !== "/d") {
    throw new Error(`P4 driverB signup redirect expected "/d", got ${driverB.redirect}`);
  }
  // fix(smoke) #116: confirm TOTP to stamp totp_confirmed_at and create session.
  if (!driverB.pendingConfirmationToken) {
    throw new Error("P4 driverB signup did not return pendingConfirmationToken");
  }
  await confirmTotpSignup(driverB.pendingConfirmationToken, driverB.totpSecret);
  const driverBCookie = cookieHeader;

  // Create one load for driver B (admin again).
  cookieHeader = p4AdminCookie;
  const driverBLoad = await request("/api/loads", {
    method: "POST",
    body: {
      ...makeBookableLoad({
        rate: 750,
        bookedAt: "2026-05-15",
        clientId: billingClient.id,
        originCity: "Miami",
        destinationCity: "Jacksonville",
      }),
      driverId: driverB.id,
    },
  });

  // Now switch to driver A — should see exactly one load, theirs.
  cookieHeader = driverACookie;
  const aLoads = await request("/api/me/loads");
  if (aLoads.total !== 1) {
    throw new Error(`P4 driver A should have total=1, got ${aLoads.total}`);
  }
  if (!aLoads.items.some((l) => l.id === driverALoad.id)) {
    throw new Error("P4 driver A did not see their assigned load in /api/me/loads");
  }
  if (aLoads.items.some((l) => l.id === driverBLoad.id)) {
    throw new Error("P4 LEAK: driver A sees driver B's load in /api/me/loads");
  }
  if (aLoads.items.some((l) => l.id === unassignedLoad.id)) {
    throw new Error("P4 LEAK: driver A sees an unassigned load in /api/me/loads");
  }
  console.log("[OK] P4 /api/me/loads scoping (driver A sees only own load, 0 leakage)");

  // Driver A dashboard now has currentLoad = driverALoad, recentLoads has 1 entry.
  const aDash = await request("/api/me/dashboard");
  if (!aDash.currentLoad || aDash.currentLoad.id !== driverALoad.id) {
    throw new Error("P4 driver A dashboard.currentLoad mismatch");
  }
  if (aDash.recentLoads.length !== 1 || aDash.recentLoads[0].id !== driverALoad.id) {
    throw new Error("P4 driver A dashboard.recentLoads mismatch");
  }
  console.log("[OK] P4 /api/me/dashboard reflects newly assigned load");

  // Detail endpoint: driver A → 200; driver A asking for driver B's load → 404.
  const aDetail = await request(`/api/me/loads/${driverALoad.id}`);
  if (aDetail.id !== driverALoad.id) throw new Error("P4 /api/me/loads/:id own load mismatch");

  let leakStatus = 0;
  try {
    await request(`/api/me/loads/${driverBLoad.id}`);
  } catch (err) {
    leakStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (leakStatus !== 404) {
    throw new Error(`P4 driver A reading driver B's load returned ${leakStatus}, expected 404`);
  }
  console.log("[OK] P4 GET /api/me/loads/:id returns 404 for cross-driver fetch (no leak)");

  // Same 404 for the unassigned load (driver_id IS NULL → not yours).
  let unassignedStatus = 0;
  try {
    await request(`/api/me/loads/${unassignedLoad.id}`);
  } catch (err) {
    unassignedStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (unassignedStatus !== 404) {
    throw new Error(`P4 driver reading unassigned load returned ${unassignedStatus}, expected 404`);
  }
  console.log("[OK] P4 GET /api/me/loads/:id returns 404 for unassigned load (driver_id IS NULL)");

  // POST /api/me/status — change available → on_route → off_duty.
  const statusOnRoute = await request("/api/me/status", {
    method: "POST",
    body: { status: "on_route" },
  });
  if (statusOnRoute.driverStatus !== "on_route") {
    throw new Error(`P4 /api/me/status response did not reflect new status: ${JSON.stringify(statusOnRoute)}`);
  }
  const meAfterStatus = await request("/api/me");
  if (meAfterStatus.driverStatus !== "on_route") {
    throw new Error("P4 /api/me did not reflect updated driverStatus");
  }

  // Idempotent no-op — POST same status returns 200 with same shape, no audit.
  const statusNoop = await request("/api/me/status", {
    method: "POST",
    body: { status: "on_route" },
  });
  if (statusNoop.driverStatus !== "on_route") {
    throw new Error("P4 /api/me/status idempotent no-op did not return same status");
  }
  console.log("[OK] P4 POST /api/me/status changes + idempotent no-op");

  // Bad status enum → 400
  let badStatus = 0;
  try {
    await request("/api/me/status", { method: "POST", body: { status: "vacationing" } });
  } catch (err) {
    badStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (badStatus !== 400) {
    throw new Error(`P4 /api/me/status with invalid enum returned ${badStatus}, expected 400`);
  }
  console.log("[OK] P4 POST /api/me/status validates enum (400 on garbage)");

  // PATCH /api/me/profile — update fullName + phone.
  const patched = await request("/api/me/profile", {
    method: "PATCH",
    body: { fullName: "Smoke Driver A (renamed)", phone: "+1 555 0100" },
  });
  if (patched.fullName !== "Smoke Driver A (renamed)" || patched.phone !== "+1 555 0100") {
    throw new Error(`P4 /api/me/profile did not apply patch: ${JSON.stringify(patched)}`);
  }
  console.log("[OK] P4 PATCH /api/me/profile (fullName + phone)");

  // Empty patch → 400 via refine
  let emptyPatchStatus = 0;
  try {
    await request("/api/me/profile", { method: "PATCH", body: {} });
  } catch (err) {
    emptyPatchStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (emptyPatchStatus !== 400) {
    throw new Error(`P4 /api/me/profile empty body returned ${emptyPatchStatus}, expected 400`);
  }
  console.log("[OK] P4 PATCH /api/me/profile rejects empty body (400)");

  // Cross-role probe: admin trying /api/me/dashboard → 403 (requireRole('driver'))
  cookieHeader = p4AdminCookie;
  let adminDashStatus = 0;
  try {
    await request("/api/me/dashboard");
  } catch (err) {
    adminDashStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (adminDashStatus !== 403) {
    throw new Error(`P4 admin hitting /api/me/dashboard returned ${adminDashStatus}, expected 403`);
  }
  console.log("[OK] P4 /api/me/dashboard blocks non-driver (403)");

  // Login redirect re-check: explicit POST /api/auth/login as driver A.
  // (signup + confirm-signup verified redirect=/d; this confirms the login path.)
  // fix(smoke) #116: confirm-signup used stepOffset=0, so use offset=1 here to
  // avoid replay rejection by the counter guard (PR #99).
  cookieHeader = "";
  const loginA = await request("/api/auth/login", {
    method: "POST",
    body: {
      email: "smoke.driver.a@example.com",
      password: "SmokeDriverA1!",
      token: totp(driverA.totpSecret, 1),
    },
  });
  if (loginA.redirect !== "/d") {
    throw new Error(`P4 /api/auth/login redirect for driver expected "/d", got ${loginA.redirect}`);
  }
  console.log("[OK] P4 POST /api/auth/login redirect=/d for role=driver");

  // Audit event sanity: driver.status_changed should be visible to admin via filter.
  cookieHeader = p4AdminCookie;
  const statusAudit = await request("/api/audit?eventType=driver.status_changed&limit=10");
  if (!statusAudit.items.some((ev) => ev.entityId === driverA.id)) {
    throw new Error("P4 driver.status_changed audit event not found for driver A");
  }
  console.log("[OK] P4 audit: driver.status_changed recorded");

  // ===========================================================================
  // PHASE 4 P1 — Driver operations (documents, check-ins, expenses, issues)
  // ===========================================================================

  cookieHeader = driverACookie;

  // -- P1 documents: empty list ---------------------------------------------
  const docsEmpty = await request("/api/me/documents");
  if (!Array.isArray(docsEmpty.items) || docsEmpty.items.length !== 0) {
    throw new Error(`P1 docs: empty list shape unexpected: ${JSON.stringify(docsEmpty)}`);
  }
  if (typeof docsEmpty.hasMore !== "boolean" || typeof docsEmpty.total !== "number") {
    throw new Error("P1 docs: empty list missing hasMore/total");
  }
  console.log("[OK] P1 GET /api/me/documents (empty list shape)");

  // -- P1 documents: upload a CDL with expires_at ---------------------------
  const today = new Date();
  const in60Days = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const in10Days = new Date(today.getTime() + 10 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const yesterday = new Date(today.getTime() - 1 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const cdlDoc = await upload(
    "/api/me/documents",
    { type: "cdl", expiresAt: in60Days, notes: "Class A" },
    {
      name: "file",
      value: Buffer.from("%PDF-1.4 fake cdl content\n", "utf-8"),
      options: { filename: "cdl.pdf", contentType: "application/pdf" },
    },
  );
  if (cdlDoc.type !== "cdl" || cdlDoc.expiresAt !== in60Days) {
    throw new Error(`P1 docs: upload returned wrong shape: ${JSON.stringify(cdlDoc)}`);
  }
  if (cdlDoc.ownerUserId !== driverA.id) {
    throw new Error("P1 docs: ownerUserId leak — should equal current driver");
  }
  console.log("[OK] P1 POST /api/me/documents (CDL upload + persisted shape)");

  // -- P1 documents: a soon-expiring + an expired one ------------------------
  const medicalDoc = await upload(
    "/api/me/documents",
    { type: "medical", expiresAt: in10Days },
    {
      name: "file",
      value: Buffer.from("medical card", "utf-8"),
      options: { filename: "medical.png", contentType: "image/png" },
    },
  );
  const expiredDoc = await upload(
    "/api/me/documents",
    { type: "ifta", expiresAt: yesterday },
    {
      name: "file",
      value: Buffer.from("ifta sticker", "utf-8"),
      options: { filename: "ifta.jpg", contentType: "image/jpeg" },
    },
  );
  if (!medicalDoc.id || !expiredDoc.id) throw new Error("P1 docs: extra uploads failed");
  console.log("[OK] P1 POST /api/me/documents (soon-expiring + expired uploads)");

  // -- P1 documents: list now has 3, all owned by driverA -------------------
  const docsList = await request("/api/me/documents");
  if (docsList.items.length !== 3) {
    throw new Error(`P1 docs: expected 3 items, got ${docsList.items.length}`);
  }
  if (docsList.items.some((d) => d.ownerUserId !== driverA.id)) {
    throw new Error("P1 docs: list leaked another driver's document");
  }
  console.log("[OK] P1 GET /api/me/documents (3 items, all owned)");

  // -- P1 documents: validation 400 on bad type ------------------------------
  try {
    await upload(
      "/api/me/documents",
      { type: "NOT_A_TYPE" },
      {
        name: "file",
        value: Buffer.from("x", "utf-8"),
        options: { filename: "x.pdf", contentType: "application/pdf" },
      },
    );
    throw new Error("P1 docs: invalid type should 400");
  } catch (e) {
    if (!/400/.test(e.message)) throw e;
  }
  console.log("[OK] P1 POST /api/me/documents validates type enum (400)");

  // -- P1 documents: missing file 400 ----------------------------------------
  try {
    await request("/api/me/documents", { method: "POST", body: { type: "other" } });
    throw new Error("P1 docs: missing file should 400");
  } catch (e) {
    if (!/400|file is required/i.test(e.message)) throw e;
  }
  console.log("[OK] P1 POST /api/me/documents requires file (400)");

  // -- P1 dashboard: pendingDocs now populated -------------------------------
  const dashWithDocs = await request("/api/me/dashboard");
  if (!Array.isArray(dashWithDocs.pendingDocs)) {
    throw new Error("P1 dashboard: pendingDocs must be array");
  }
  // Expect medical (soon) + ifta (expired) = 2 flagged. CDL is 60 days out, not flagged.
  const flaggedCount = dashWithDocs.pendingDocs.length;
  if (flaggedCount !== 2) {
    throw new Error(
      `P1 dashboard: expected 2 pending docs (medical+ifta), got ${flaggedCount}: ${JSON.stringify(
        dashWithDocs.pendingDocs,
      )}`,
    );
  }
  const hasExpired = dashWithDocs.pendingDocs.some((d) => d.status === "expired");
  const hasSoon = dashWithDocs.pendingDocs.some((d) => d.status === "soon");
  if (!hasExpired || !hasSoon) {
    throw new Error("P1 dashboard: pendingDocs missing expired or soon entries");
  }
  console.log("[OK] P1 /api/me/dashboard pendingDocs reflects expires_at (30-day window)");

  // -- P1 documents: delete one ---------------------------------------------
  await request(`/api/me/documents/${expiredDoc.id}`, { method: "DELETE" });
  const docsAfterDelete = await request("/api/me/documents");
  if (docsAfterDelete.items.length !== 2) {
    throw new Error("P1 docs: delete should leave 2 items");
  }
  console.log("[OK] P1 DELETE /api/me/documents/:id");

  // -- P1 documents: cross-driver 404 ----------------------------------------
  // Create driverB, try to delete cdlDoc as B → 404 (not 403, anti-enumeration).
  cookieHeader = p4AdminCookie;
  const inviteB2 = await request("/api/admin/invites", {
    method: "POST",
    body: { role: "driver", ttlHours: 1, linkedClientId: "oleg-hotshot-02" },
  });
  cookieHeader = "";
  const driverB2 = await request("/api/auth/signup", {
    method: "POST",
    body: {
      inviteCode: inviteB2.code,
      email: "smoke.driver.b2@example.com",
      fullName: "Smoke Driver B2",
      password: "SmokeDriverB2!",
    },
  });
  // fix(smoke) #116: confirm TOTP to stamp totp_confirmed_at and create session.
  if (!driverB2.pendingConfirmationToken) {
    throw new Error("P1 driverB2 signup did not return pendingConfirmationToken");
  }
  await confirmTotpSignup(driverB2.pendingConfirmationToken, driverB2.totpSecret);
  const driverB2Cookie = cookieHeader;
  cookieHeader = driverB2Cookie;
  try {
    await request(`/api/me/documents/${cdlDoc.id}`, { method: "DELETE" });
    throw new Error("P1 docs: cross-driver delete should 404");
  } catch (e) {
    if (!/404/.test(e.message)) throw e;
  }
  console.log("[OK] P1 DELETE /api/me/documents/:id 404 on cross-driver");

  // -- P1 check-ins: empty timeline -----------------------------------------
  cookieHeader = driverACookie;
  const ckEmpty = await request(`/api/me/loads/${driverALoad.id}/checkins`);
  if (!Array.isArray(ckEmpty.items) || ckEmpty.items.length !== 0) {
    throw new Error("P1 checkins: empty timeline shape unexpected");
  }
  console.log("[OK] P1 GET /api/me/loads/:id/checkins (empty)");

  // -- P1 check-ins: pickup_arrived with geo --------------------------------
  const pickupChk = await request(`/api/me/loads/${driverALoad.id}/checkin`, {
    method: "POST",
    body: { kind: "pickup_arrived", lat: 27.95, lng: -82.46 },
  });
  if (pickupChk.kind !== "pickup_arrived" || pickupChk.lat !== 27.95) {
    throw new Error("P1 checkin: shape mismatch");
  }
  if (pickupChk.driverUserId !== driverA.id) {
    throw new Error("P1 checkin: driverUserId leak");
  }
  console.log("[OK] P1 POST /api/me/loads/:id/checkin (pickup_arrived + geo)");

  // -- P1 check-ins: kind=note works without lat/lng ------------------------
  const noteChk = await request(`/api/me/loads/${driverALoad.id}/checkin`, {
    method: "POST",
    body: { kind: "note", notes: "Stopped for fuel" },
  });
  if (noteChk.lat !== null) throw new Error("P1 checkin: note kind should have null lat");
  console.log("[OK] P1 POST /api/me/loads/:id/checkin (note kind, no geo required)");

  // -- P1 check-ins: arrival kinds REQUIRE lat/lng (400) --------------------
  try {
    await request(`/api/me/loads/${driverALoad.id}/checkin`, {
      method: "POST",
      body: { kind: "delivered" },
    });
    throw new Error("P1 checkin: arrival without geo should 400");
  } catch (e) {
    if (!/400/.test(e.message) || !/lat/i.test(e.message)) throw e;
  }
  console.log("[OK] P1 POST /api/me/loads/:id/checkin validates geo for arrival (400)");

  // -- P1 check-ins: cross-driver 404 ---------------------------------------
  cookieHeader = driverB2Cookie;
  try {
    await request(`/api/me/loads/${driverALoad.id}/checkin`, {
      method: "POST",
      body: { kind: "pickup_arrived", lat: 1, lng: 1 },
    });
    throw new Error("P1 checkin: cross-driver should 404");
  } catch (e) {
    if (!/404/.test(e.message)) throw e;
  }
  console.log("[OK] P1 POST /api/me/loads/:id/checkin 404 on cross-driver");

  // -- P1 check-ins: timeline now has 2 ordered ascending -------------------
  cookieHeader = driverACookie;
  const ckList = await request(`/api/me/loads/${driverALoad.id}/checkins`);
  if (ckList.items.length !== 2) {
    throw new Error(`P1 checkins: expected 2, got ${ckList.items.length}`);
  }
  if (ckList.items[0].kind !== "pickup_arrived" || ckList.items[1].kind !== "note") {
    throw new Error("P1 checkins: timeline not in ascending order");
  }
  console.log("[OK] P1 GET /api/me/loads/:id/checkins (2 ordered)");

  // -- P1 expenses: empty list ----------------------------------------------
  const expEmpty = await request("/api/me/expenses");
  if (!Array.isArray(expEmpty.items) || expEmpty.items.length !== 0) {
    throw new Error("P1 expenses: empty shape unexpected");
  }
  console.log("[OK] P1 GET /api/me/expenses (empty)");

  // -- P1 expenses: create one with placeholder photo -----------------------
  // (smoke's `upload` helper always wants a file field; we send a 1-byte
  //  placeholder. Server will still create a row, photo_storage_path set.)
  const fuelExp = await upload(
    "/api/me/expenses",
    { loadId: driverALoad.id, category: "fuel", amount: "78.55", notes: "Pilot Tampa" },
    {
      name: "photo",
      value: Buffer.from("x", "utf-8"),
      options: { filename: "smoke-receipt.txt", contentType: "text/plain" },
    },
  );
  if (fuelExp.category !== "fuel" || fuelExp.amountCents !== 7855) {
    throw new Error(`P1 expense: shape wrong: ${JSON.stringify(fuelExp)}`);
  }
  if (fuelExp.driverUserId !== driverA.id) {
    throw new Error("P1 expense: driverUserId leak");
  }
  console.log("[OK] P1 POST /api/me/expenses (fuel + amount→cents conversion)");

  // -- P1 expenses: cross-driver loadId → 404 -------------------------------
  cookieHeader = driverB2Cookie;
  const crossExp = await upload(
    "/api/me/expenses",
    { loadId: driverALoad.id, category: "fuel", amount: "10" },
    {
      name: "photo",
      value: Buffer.from("x", "utf-8"),
      options: { filename: "y.txt", contentType: "text/plain" },
    },
  ).catch((err) => ({ __err: err.message }));
  if (!crossExp.__err || !/404/.test(crossExp.__err)) {
    throw new Error(`P1 expense: cross-driver loadId should 404, got ${JSON.stringify(crossExp)}`);
  }
  console.log("[OK] P1 POST /api/me/expenses 404 on cross-driver loadId");

  // -- P1 expenses: filter by loadId ---------------------------------------
  cookieHeader = driverACookie;
  const expByLoad = await request(`/api/me/expenses?loadId=${driverALoad.id}`);
  if (expByLoad.items.length !== 1 || expByLoad.items[0].id !== fuelExp.id) {
    throw new Error("P1 expense: filter by loadId returned wrong items");
  }
  console.log("[OK] P1 GET /api/me/expenses?loadId= filter");

  // -- P1 expenses: OCR scan-receipt preview --------------------------------
  // No ANTHROPIC_API_KEY in the smoke env → parseReceipt returns null; the
  // endpoint must still 200 with { ocr: null } so the form falls back to manual
  // entry. (We don't assert a real OCR read — that needs the vendor key.)
  cookieHeader = driverACookie;
  const pngBytes = Buffer.from("89504e470d0a1a0a0000", "hex"); // PNG magic header
  const scan = await upload(
    "/api/me/expenses/scan-receipt",
    {},
    { name: "photo", value: pngBytes, options: { filename: "receipt.png", contentType: "image/png" } },
  );
  if (!("ocr" in scan) || scan.ocr !== null) {
    throw new Error(`scan-receipt should return { ocr: null } without API key, got ${JSON.stringify(scan)}`);
  }
  console.log("[OK] P1 POST /api/me/expenses/scan-receipt (graceful ocr:null without key)");

  // Non-image (txt passes the upload filter but can't be OCR'd) → 400.
  const scanBad = await upload(
    "/api/me/expenses/scan-receipt",
    {},
    { name: "photo", value: Buffer.from("x"), options: { filename: "r.txt", contentType: "text/plain" } },
  ).catch((err) => ({ __err: err.message }));
  if (!scanBad.__err || !/400/.test(scanBad.__err)) {
    throw new Error(`scan-receipt non-image should 400, got ${JSON.stringify(scanBad)}`);
  }
  console.log("[OK] P1 POST /api/me/expenses/scan-receipt 400 on non-image");

  // Driver-only: an admin session is rejected (403) before any file work.
  cookieHeader = adminCookieHeader;
  const scanForbidden = await upload(
    "/api/me/expenses/scan-receipt",
    {},
    { name: "photo", value: pngBytes, options: { filename: "receipt.png", contentType: "image/png" } },
  ).catch((err) => ({ __err: err.message }));
  if (!scanForbidden.__err || !/403/.test(scanForbidden.__err)) {
    throw new Error(`scan-receipt must be driver-only (403 for admin), got ${JSON.stringify(scanForbidden)}`);
  }
  console.log("[OK] P1 POST /api/me/expenses/scan-receipt 403 for non-driver");
  // -- Fuel transactions: log + list + scoping (feeds IFTA gallons) ----------
  cookieHeader = driverACookie;
  const fuelEmpty = await request("/api/me/fuel");
  if (!Array.isArray(fuelEmpty.items) || fuelEmpty.items.length !== 0) {
    throw new Error(`fuel: empty shape unexpected: ${JSON.stringify(fuelEmpty)}`);
  }
  console.log("[OK] GET /api/me/fuel (empty)");

  const fuelTx = await request("/api/me/fuel", {
    method: "POST",
    body: {
      loadId: driverALoad.id,
      gallons: 50,
      pricePerGallon: 4.3,
      fuelType: "diesel",
      stationName: "Pilot Dallas",
      stationLat: 32.8,
      stationLng: -96.8,
      occurredAt: "2026-05-15T12:00:00.000Z",
    },
  });
  if (fuelTx.gallons !== 50 || fuelTx.pricePerGallonCents !== 430) {
    throw new Error(`fuel: shape wrong: ${JSON.stringify(fuelTx)}`);
  }
  // total omitted -> auto-computed: 50 * $4.30 = $215.00 -> 21500 cents.
  if (fuelTx.totalCents !== 21500) {
    throw new Error(`fuel: total not auto-computed, got ${fuelTx.totalCents}`);
  }
  if (fuelTx.userId !== driverA.id) throw new Error("fuel: userId leak/mismatch");
  console.log("[OK] POST /api/me/fuel (log + total auto-compute)");

  const fuelList = await request("/api/me/fuel");
  if (fuelList.items.length !== 1 || fuelList.items[0].id !== fuelTx.id) {
    throw new Error("fuel: list did not return the logged tx");
  }
  console.log("[OK] GET /api/me/fuel (lists own)");

  // Cross-driver loadId -> 404 (anti-enumeration).
  cookieHeader = driverB2Cookie;
  let fuelCross = 0;
  try {
    await request("/api/me/fuel", {
      method: "POST",
      body: { loadId: driverALoad.id, gallons: 10, pricePerGallon: 4 },
    });
  } catch (e) {
    fuelCross = Number(String(e.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (fuelCross !== 404) throw new Error(`fuel: cross-driver loadId should 404, got ${fuelCross}`);
  console.log("[OK] POST /api/me/fuel 404 on cross-driver loadId");

  // Admin (non-driver) -> 403.
  cookieHeader = adminCookieHeader;
  let fuelForbidden = 0;
  try {
    await request("/api/me/fuel", { method: "POST", body: { gallons: 10, pricePerGallon: 4 } });
  } catch (e) {
    fuelForbidden = Number(String(e.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (fuelForbidden !== 403) throw new Error(`fuel: non-driver should 403, got ${fuelForbidden}`);
  console.log("[OK] POST /api/me/fuel 403 for non-driver");
  cookieHeader = driverACookie;

  // -- P1 issues: create driver_issue task ----------------------------------
  const issueTask = await request("/api/me/issues", {
    method: "POST",
    body: {
      loadId: driverALoad.id,
      severity: "urgent",
      title: "Broker no-show at pickup",
      description: "Waited 90 min, gate locked.",
    },
  });
  // P4 P0 changed routing: drivers whose linkedClientId has an active dispatcher
  // assignment now route to that dispatcher; admin is the fallback. driverA's
  // billingClient is assigned to dispUser, so this issue routes to dispatcher.
  if (issueTask.taskType !== "driver_issue" || issueTask.assigneeRole !== "dispatcher") {
    throw new Error(`P1 issue: wrong task shape: ${JSON.stringify(issueTask)}`);
  }
  if (issueTask.payload.severity !== "urgent" || issueTask.payload.reporterUserId !== driverA.id) {
    throw new Error("P1 issue: payload missing severity or reporterUserId");
  }
  if (issueTask.payload.dispatcherUserId !== dispUser.id || issueTask.payload.routedTo !== "dispatcher") {
    throw new Error(`P1 issue: P0 routing not applied: ${JSON.stringify(issueTask.payload)}`);
  }
  console.log("[OK] P1 POST /api/me/issues (creates approval_task, routes to dispatcher when client has one)");

  // -- P1 issues: title validation ------------------------------------------
  try {
    await request("/api/me/issues", {
      method: "POST",
      body: { severity: "info", title: "ab" },
    });
    throw new Error("P1 issue: short title should 400");
  } catch (e) {
    if (!/400/.test(e.message)) throw e;
  }
  console.log("[OK] P1 POST /api/me/issues validates title length (400)");

  // -- P1 issues: cross-driver loadId → 404 ---------------------------------
  cookieHeader = driverB2Cookie;
  try {
    await request("/api/me/issues", {
      method: "POST",
      body: { loadId: driverALoad.id, severity: "info", title: "test foreign load" },
    });
    throw new Error("P1 issue: cross-driver loadId should 404");
  } catch (e) {
    if (!/404/.test(e.message)) throw e;
  }
  console.log("[OK] P1 POST /api/me/issues 404 on cross-driver loadId");

  // -- P1 audit: all new event types recorded -------------------------------
  cookieHeader = p4AdminCookie;
  for (const eventType of [
    "driver.document_uploaded",
    "driver.document_deleted",
    "driver.checkin",
    "driver.expense_filed",
    "driver.issue_reported",
  ]) {
    const auditRes = await request(`/api/audit?eventType=${eventType}&limit=10`);
    if (!auditRes.items.length) {
      throw new Error(`P1 audit: expected at least 1 ${eventType} event`);
    }
  }
  console.log("[OK] P1 audit: all 5 new event types recorded");

  // -- P1 admin (non-driver) blocked from /api/me/documents -----------------
  cookieHeader = p4AdminCookie;
  try {
    await request("/api/me/documents");
    throw new Error("P1 docs: admin should be blocked with 403");
  } catch (e) {
    if (!/403/.test(e.message)) throw e;
  }
  console.log("[OK] P1 /api/me/documents blocks non-driver (403)");

  // ===========================================================================
  // PHASE 4 P1.1 — Admin approval queue
  // ===========================================================================
  //
  // Reuses the issue created earlier ("Broker no-show at pickup", urgent) by
  // driver A — that's our test fixture. We also create a second issue for
  // dismiss path coverage.

  // -- P1.1 admin sees the open task -----------------------------------------
  cookieHeader = p4AdminCookie;
  const queueOpen = await request("/api/admin/approval-tasks?status=open&limit=10");
  if (!Array.isArray(queueOpen.items) || queueOpen.items.length === 0) {
    throw new Error("P1.1 queue: expected at least 1 open task");
  }
  const issueTaskInQueue = queueOpen.items.find((t) => t.id === issueTask.id);
  if (!issueTaskInQueue) {
    throw new Error("P1.1 queue: driver-issue task missing from open list");
  }
  if (!issueTaskInQueue.createdByEmail || !issueTaskInQueue.createdByEmail.includes("@")) {
    throw new Error("P1.1 queue: task missing creator email (JOIN broken)");
  }
  if (issueTaskInQueue.createdByEmail !== "smoke.driver.a@example.com") {
    throw new Error(
      `P1.1 queue: wrong creator email: ${issueTaskInQueue.createdByEmail}`,
    );
  }
  if (typeof queueOpen.total !== "number" || queueOpen.total < 1) {
    throw new Error("P1.1 queue: total field missing or zero");
  }
  console.log("[OK] P1.1 GET /api/admin/approval-tasks?status=open (with creator JOIN)");

  // -- P1.1 GET single task --------------------------------------------------
  const oneTask = await request(`/api/admin/approval-tasks/${issueTask.id}`);
  if (oneTask.id !== issueTask.id) throw new Error("P1.1 queue: GET :id mismatch");
  if (oneTask.payload.severity !== "urgent") {
    throw new Error("P1.1 queue: payload not preserved on GET :id");
  }
  console.log("[OK] P1.1 GET /api/admin/approval-tasks/:id");

  // -- P1.1 GET unknown id → 404 ---------------------------------------------
  try {
    await request("/api/admin/approval-tasks/task-nonexistent-99999");
    throw new Error("P1.1 queue: unknown id should 404");
  } catch (e) {
    if (!/404/.test(e.message)) throw e;
  }
  console.log("[OK] P1.1 GET /api/admin/approval-tasks/:id 404 on unknown");

  // -- P1.1 PATCH resolve ----------------------------------------------------
  const resolved = await request(`/api/admin/approval-tasks/${issueTask.id}`, {
    method: "PATCH",
    body: { action: "resolve", resolution: "Called broker, rescheduled to 9am." },
  });
  if (resolved.status !== "resolved") {
    throw new Error(`P1.1 queue: resolve expected status=resolved, got ${resolved.status}`);
  }
  if (resolved.resolvedAt == null || resolved.resolvedByUserId == null) {
    throw new Error("P1.1 queue: resolvedAt / resolvedByUserId not stamped");
  }
  if (resolved.payload.resolution !== "Called broker, rescheduled to 9am.") {
    throw new Error("P1.1 queue: resolution note not merged into payload");
  }
  console.log("[OK] P1.1 PATCH /api/admin/approval-tasks/:id action=resolve");

  // -- P1.1 PATCH already-resolved → 409 ------------------------------------
  try {
    await request(`/api/admin/approval-tasks/${issueTask.id}`, {
      method: "PATCH",
      body: { action: "resolve" },
    });
    throw new Error("P1.1 queue: re-resolve should 409");
  } catch (e) {
    if (!/409/.test(e.message)) throw e;
  }
  console.log("[OK] P1.1 PATCH /api/admin/approval-tasks/:id 409 on terminated");

  // -- P1.1 dismiss path: create another issue, dismiss it ------------------
  cookieHeader = driverACookie;
  const issue2 = await request("/api/me/issues", {
    method: "POST",
    body: { severity: "info", title: "Duplicate of prior issue" },
  });
  cookieHeader = p4AdminCookie;
  const dismissed = await request(`/api/admin/approval-tasks/${issue2.id}`, {
    method: "PATCH",
    body: { action: "dismiss", resolution: "Duplicate of task " + issueTask.id },
  });
  if (dismissed.status !== "dismissed") {
    throw new Error(`P1.1 queue: dismiss expected status=dismissed, got ${dismissed.status}`);
  }
  console.log("[OK] P1.1 PATCH /api/admin/approval-tasks/:id action=dismiss");

  // -- P1.1 status filters work ---------------------------------------------
  const resolvedList = await request("/api/admin/approval-tasks?status=resolved&limit=50");
  if (!resolvedList.items.some((t) => t.id === issueTask.id)) {
    throw new Error("P1.1 queue: ?status=resolved missing resolved task");
  }
  const dismissedList = await request("/api/admin/approval-tasks?status=dismissed&limit=50");
  if (!dismissedList.items.some((t) => t.id === issue2.id)) {
    throw new Error("P1.1 queue: ?status=dismissed missing dismissed task");
  }
  console.log("[OK] P1.1 GET /api/admin/approval-tasks status filter");

  // -- P1.1 role gating: driver hitting admin queue → 403 -------------------
  cookieHeader = driverACookie;
  try {
    await request("/api/admin/approval-tasks?status=open");
    throw new Error("P1.1 queue: driver should be blocked with 403");
  } catch (e) {
    if (!/403/.test(e.message)) throw e;
  }
  console.log("[OK] P1.1 /api/admin/approval-tasks blocks non-admin (403)");

  // -- P1.1 audit events recorded -------------------------------------------
  cookieHeader = p4AdminCookie;
  const resolvedAudit = await request("/api/audit?eventType=admin.approval_task_resolved&limit=10");
  if (!resolvedAudit.items.some((ev) => ev.entityId === issueTask.id)) {
    throw new Error("P1.1 audit: admin.approval_task_resolved not recorded for issueTask");
  }
  const dismissedAudit = await request("/api/audit?eventType=admin.approval_task_dismissed&limit=10");
  if (!dismissedAudit.items.some((ev) => ev.entityId === issue2.id)) {
    throw new Error("P1.1 audit: admin.approval_task_dismissed not recorded for issue2");
  }
  console.log("[OK] P1.1 audit: resolved + dismissed events recorded");

  // ===========================================================================
  // PHASE 4 P0 — Dispatcher portal
  // ===========================================================================
  //
  // We re-use earlier fixtures:
  //   - dispUser  (smoke.dispatcher@example.com) with a known totpSecret
  //   - someClient assignment with dispUser was DELETE'd then re-created earlier
  //   - driverA   has linkedClientId === billingClient.id (no dispatcher!)
  //
  // For the dispatcher routing tests we need a driver whose linkedClientId
  // points to a client that IS assigned to dispUser. We'll create that pair
  // here, alongside the dispatcher login.

  // -- P0 Login as dispatcher -----------------------------------------------
  // NOTE: by this point the dispatcher's password has been rotated twice by
  // P1 reset-password tests, and TOTP has been disabled by P1 reset-totp.
  // So we log in with reset2.temporaryPassword and NO token.
  cookieHeader = "";
  const dispLogin = await request("/api/auth/login", {
    method: "POST",
    body: {
      email: "smoke.dispatcher@example.com",
      password: reset2.temporaryPassword,
      // P1 disabled TOTP for this user — login without token is allowed.
    },
  });
  if (dispLogin.redirect !== "/dispatch") {
    throw new Error(`P0 dispatcher login redirect should be /dispatch, got ${dispLogin.redirect}`);
  }
  const dispCookie = cookieHeader;
  console.log("[OK] P4 P0 POST /api/auth/login redirect=/dispatch for role=dispatcher");

  // -- P0 dispatcher /api/me reflects role + assignedClientIds --------------
  const dispMe = await request("/api/me");
  if (dispMe.role !== "dispatcher" || !Array.isArray(dispMe.assignedClientIds)) {
    throw new Error("P0 dispatcher /api/me missing assignedClientIds");
  }
  console.log("[OK] P4 P0 /api/me surfaces assignedClientIds for dispatcher");

  // -- P0 dashboard (empty-ish — no driver issues yet for this dispatcher) --
  const dispDash = await request("/api/dispatch/me/dashboard");
  if (dispDash.dispatcher.id !== dispUser.id) {
    throw new Error("P0 dashboard wrong dispatcher.id");
  }
  if (!Array.isArray(dispDash.assignedClients) || !Array.isArray(dispDash.recentLoads)) {
    throw new Error("P0 dashboard missing arrays");
  }
  if (typeof dispDash.stats.assignedClientsCount !== "number") {
    throw new Error("P0 dashboard stats missing");
  }
  console.log("[OK] P4 P0 GET /api/dispatch/me/dashboard (shape + counts)");

  // -- P0 /api/dispatch/clients lists this dispatcher's clients -------------
  const dispClients = await request("/api/dispatch/clients");
  if (!Array.isArray(dispClients.items)) {
    throw new Error("P0 /api/dispatch/clients missing items[]");
  }
  // dispUser has someClient assigned (recreated earlier in smoke).
  const hasSomeClient = dispClients.items.some((c) => c.id === someClient.id);
  if (!hasSomeClient) {
    throw new Error(`P0 /api/dispatch/clients missing someClient ${someClient.id}`);
  }
  console.log("[OK] P4 P0 GET /api/dispatch/clients (assigned clients only)");

// -- P0 /api/dispatch/loads scoping --------------------------------------
  // dispUser is assigned to someClient (= ivan-enclosed-01). driverALoad lives on
  // that same client → MUST be visible. Create a "leak load" on a different client
  // (oleg-hotshot-02, NOT assigned to dispUser) → MUST NOT be visible.
  cookieHeader = p4AdminCookie;
  const leakClient = allClients.find((c) => c.id === "oleg-hotshot-02") || allClients[1];
  const leakLoad = await request("/api/loads", {
    method: "POST",
    body: makeBookableLoad({
      rate: 1111,
      bookedAt: "2026-05-15",
      clientId: leakClient.id,
    }),
  });
  if (!leakLoad.id) {
    throw new Error("P0 leakLoad setup: load not created");
  }
  cookieHeader = dispCookie;

  const dispLoads = await request("/api/dispatch/loads?limit=50");
  if (!Array.isArray(dispLoads.items)) {
    throw new Error("P0 /api/dispatch/loads missing items[]");
  }
  if (!dispLoads.items.some((l) => l.id === driverALoad.id)) {
    throw new Error("P0 /api/dispatch/loads should INCLUDE driverALoad (own-client load)");
  }
  if (dispLoads.items.some((l) => l.id === leakLoad.id)) {
    throw new Error("P0 /api/dispatch/loads LEAKED a load from an unassigned client!");
  }
  console.log("[OK] P4 P0 /api/dispatch/loads scoping (own-client included, cross-client excluded)");

// -- P0 own-client load detail → 200 -------------------------------------
  const dispOwnLoadDetail = await request(`/api/dispatch/loads/${driverALoad.id}`);
  if (dispOwnLoadDetail.id !== driverALoad.id) {
    throw new Error("P0 dispatcher own-client load detail mismatch");
  }
  console.log("[OK] P4 P0 GET /api/dispatch/loads/:id 200 on own-client load");

  // -- P0 cross-tenant load detail → 404 -----------------------------------
  try {
    await request(`/api/dispatch/loads/${leakLoad.id}`);
    throw new Error("P0 dispatcher should NOT see leakLoad (404 expected)");
  } catch (e) {
    if (!/404/.test(e.message)) throw e;
  }
  console.log("[OK] P4 P0 GET /api/dispatch/loads/:id 404 on cross-tenant");

  // -- P0 unknown load id → 404 --------------------------------------------
  try {
    await request("/api/dispatch/loads/load-nonexistent-12345");
    throw new Error("P0 unknown load id should 404");
  } catch (e) {
    if (!/404/.test(e.message)) throw e;
  }
  console.log("[OK] P4 P0 GET /api/dispatch/loads/:id 404 on unknown");

  // -- P0 setup: create a driver linked to someClient (so issues route to dispUser) --
  cookieHeader = p4AdminCookie;
  const dispDriverInvite = await request("/api/admin/invites", {
    method: "POST",
    body: { role: "driver", ttlHours: 1, linkedClientId: someClient.id },
  });
  cookieHeader = "";
  const dispDriver = await request("/api/auth/signup", {
    method: "POST",
    body: {
      inviteCode: dispDriverInvite.code,
      email: "smoke.driver.disp@example.com",
      fullName: "Smoke Driver For Dispatcher",
      password: "SmokeDriverDisp1!",
    },
  });
  // fix(smoke) #116: confirm TOTP to stamp totp_confirmed_at and create session.
  if (!dispDriver.pendingConfirmationToken) {
    throw new Error("P4 P0 dispDriver signup did not return pendingConfirmationToken");
  }
  await confirmTotpSignup(dispDriver.pendingConfirmationToken, dispDriver.totpSecret);
  const dispDriverCookie = cookieHeader;
  console.log("[OK] P4 P0 setup: driver linked to dispatcher-assigned client");

  // -- P0 issue routing: driver of dispatcher-assigned client routes to disp ----
  cookieHeader = dispDriverCookie;
  const dispDriverIssue = await request("/api/me/issues", {
    method: "POST",
    body: {
      severity: "warn",
      title: "Dispatcher routing test",
      description: "Should appear in dispatcher queue, not admin.",
    },
  });
  if (dispDriverIssue.assigneeRole !== "dispatcher") {
    throw new Error(
      `P0 issue routing: expected assigneeRole=dispatcher, got ${dispDriverIssue.assigneeRole}`,
    );
  }
  if (dispDriverIssue.payload.dispatcherUserId !== dispUser.id) {
    throw new Error(
      `P0 issue routing: payload.dispatcherUserId mismatch: ${JSON.stringify(dispDriverIssue.payload)}`,
    );
  }
  if (dispDriverIssue.payload.routedTo !== "dispatcher") {
    throw new Error("P0 issue routing: payload.routedTo should be 'dispatcher'");
  }
  console.log("[OK] P4 P0 POST /api/me/issues routes to dispatcher when client has one");

  // -- P0 issue routing FALLBACK: driverB2 (oleg-hotshot-02 has no dispatcher) → admin --
  cookieHeader = driverB2Cookie;
  const fallbackIssue = await request("/api/me/issues", {
    method: "POST",
    body: { severity: "info", title: "Routing fallback test" },
  });
  if (fallbackIssue.assigneeRole !== "admin") {
    throw new Error(
      `P0 issue routing fallback: expected admin, got ${fallbackIssue.assigneeRole}`,
    );
  }
  if (fallbackIssue.payload.routedTo !== "admin_fallback") {
    throw new Error("P0 issue routing fallback: payload.routedTo should be 'admin_fallback'");
  }
  if (fallbackIssue.payload.dispatcherUserId !== null) {
    throw new Error("P0 issue routing fallback: dispatcherUserId should be null");
  }
  console.log("[OK] P4 P0 POST /api/me/issues falls back to admin when no dispatcher");

  // -- P0 dispatcher sees the routed issue in their queue -------------------
  cookieHeader = dispCookie;
  const dispQueue = await request("/api/dispatch/approval-tasks?status=open&limit=50");
  if (!Array.isArray(dispQueue.items)) {
    throw new Error("P0 dispatcher queue missing items[]");
  }
  const dispTaskInQueue = dispQueue.items.find((t) => t.id === dispDriverIssue.id);
  if (!dispTaskInQueue) {
    throw new Error("P0 dispatcher queue missing the routed driver-issue");
  }
  if (dispTaskInQueue.createdByEmail !== "smoke.driver.disp@example.com") {
    throw new Error("P0 dispatcher queue: createdByEmail JOIN broken");
  }
  // Fallback issue (admin-routed) should NOT appear here.
  if (dispQueue.items.some((t) => t.id === fallbackIssue.id)) {
    throw new Error("P0 dispatcher queue LEAKED an admin-routed issue!");
  }
  console.log("[OK] P4 P0 GET /api/dispatch/approval-tasks (own tasks only, no leak)");

  // -- P0 dashboard now reflects open task count ----------------------------
  const dispDash2 = await request("/api/dispatch/me/dashboard");
  if (dispDash2.stats.openTasksCount < 1) {
    throw new Error("P0 dashboard openTasksCount should be >= 1 after routed issue");
  }
  if (!dispDash2.recentOpenTasks.some((t) => t.id === dispDriverIssue.id)) {
    throw new Error("P0 dashboard recentOpenTasks missing the routed task");
  }
  console.log("[OK] P4 P0 /api/dispatch/me/dashboard reflects new open task");

  // -- P0 GET single task with scope check ----------------------------------
  const oneDispTask = await request(`/api/dispatch/approval-tasks/${dispDriverIssue.id}`);
  if (oneDispTask.id !== dispDriverIssue.id) {
    throw new Error("P0 GET single dispatch task mismatch");
  }
  console.log("[OK] P4 P0 GET /api/dispatch/approval-tasks/:id");

  // -- P0 cross-tenant single task (admin-routed task) → 404 ----------------
  try {
    await request(`/api/dispatch/approval-tasks/${fallbackIssue.id}`);
    throw new Error("P0 dispatcher should NOT see admin-routed task");
  } catch (e) {
    if (!/404/.test(e.message)) throw e;
  }
  console.log("[OK] P4 P0 GET /api/dispatch/approval-tasks/:id 404 on cross-tenant");

  // -- P0 PATCH resolve the routed task -------------------------------------
  const dispResolved = await request(`/api/dispatch/approval-tasks/${dispDriverIssue.id}`, {
    method: "PATCH",
    body: { action: "resolve", resolution: "Called driver, sorted out." },
  });
  if (dispResolved.status !== "resolved") {
    throw new Error(`P0 dispatcher resolve: status=${dispResolved.status}`);
  }
  if (dispResolved.resolvedByUserId !== dispUser.id) {
    throw new Error("P0 dispatcher resolve: resolvedByUserId mismatch");
  }
  if (dispResolved.payload.resolution !== "Called driver, sorted out.") {
    throw new Error("P0 dispatcher resolve: resolution note not merged");
  }
  console.log("[OK] P4 P0 PATCH /api/dispatch/approval-tasks/:id action=resolve");

  // -- P0 PATCH already-resolved → 409 --------------------------------------
  try {
    await request(`/api/dispatch/approval-tasks/${dispDriverIssue.id}`, {
      method: "PATCH",
      body: { action: "resolve" },
    });
    throw new Error("P0 re-resolve should 409");
  } catch (e) {
    if (!/409/.test(e.message)) throw e;
  }
  console.log("[OK] P4 P0 PATCH /api/dispatch/approval-tasks/:id 409 on terminated");

  // -- P0 PATCH cross-tenant (admin-routed task) → 404 ---------------------
  try {
    await request(`/api/dispatch/approval-tasks/${fallbackIssue.id}`, {
      method: "PATCH",
      body: { action: "resolve" },
    });
    throw new Error("P0 dispatcher should NOT be able to PATCH admin-routed task");
  } catch (e) {
    if (!/404/.test(e.message)) throw e;
  }
  console.log("[OK] P4 P0 PATCH /api/dispatch/approval-tasks/:id 404 on cross-tenant");

  // -- P0 role gating: driver hitting /api/dispatch/* → 403 ----------------
  cookieHeader = dispDriverCookie;
  try {
    await request("/api/dispatch/me/dashboard");
    throw new Error("P0 driver hitting dispatch should 403");
  } catch (e) {
    if (!/403/.test(e.message)) throw e;
  }
  console.log("[OK] P4 P0 /api/dispatch/* blocks non-dispatcher driver (403)");

  // -- P0 role gating: admin hitting /api/dispatch/* → 403 (clean separation) --
  cookieHeader = p4AdminCookie;
  try {
    await request("/api/dispatch/me/dashboard");
    throw new Error("P0 admin hitting dispatch should 403");
  } catch (e) {
    if (!/403/.test(e.message)) throw e;
  }
  console.log("[OK] P4 P0 /api/dispatch/* blocks admin (403, clean role separation)");

  // -- P0 audit events for dispatcher actions ------------------------------
  const dispAudit = await request(
    "/api/audit?eventType=dispatcher.approval_task_resolved&limit=10",
  );
  if (!dispAudit.items.some((ev) => ev.entityId === dispDriverIssue.id)) {
    throw new Error("P0 audit: dispatcher.approval_task_resolved not recorded");
  }
  console.log("[OK] P4 P0 audit: dispatcher.approval_task_resolved recorded");
// -- Admin Settings → Integrations -----------------------------------------
  cookieHeader = p4AdminCookie;
  const adminIntegrations = await request("/api/admin/integrations");
  if (!adminIntegrations.generatedAt || !Array.isArray(adminIntegrations.integrations)) {
    throw new Error("Admin integrations: missing generatedAt or integrations[]");
  }
  if (adminIntegrations.integrations.length < 5) {
    throw new Error(
      `Admin integrations: expected >=5 connectors, got ${adminIntegrations.integrations.length}`,
    );
  }
  const sylectus = adminIntegrations.integrations.find((i) => i.key === "sylectus_inbound");
  if (!sylectus) {
    throw new Error("Admin integrations: sylectus_inbound entry missing");
  }
  for (const required of ["key", "label", "kind", "status", "missing", "stats24h"]) {
    if (!(required in sylectus)) {
      throw new Error(`Admin integrations: entry is missing field '${required}'`);
    }
  }
  if (typeof sylectus.stats24h.eventCount !== "number" || !("lastEventAt" in sylectus.stats24h)) {
    throw new Error("Admin integrations: stats24h shape mismatch");
  }
  // Sylectus has no env vars (works via CF Worker) → must be ready or active.
  if (sylectus.status !== "ready" && sylectus.status !== "active") {
    throw new Error(
      `Admin integrations: sylectus_inbound expected ready|active, got ${sylectus.status}`,
    );
  }
  // FMCSA's env vars are not set in smoke env → must be needs_config.
  const fmcsa = adminIntegrations.integrations.find((i) => i.key === "fmcsa");
  if (!fmcsa || fmcsa.status !== "needs_config") {
    throw new Error(
      `Admin integrations: fmcsa expected needs_config, got ${fmcsa?.status}`,
    );
  }
  console.log("[OK] Admin GET /api/admin/integrations (shape + 24h stats)");

  // -- Admin Settings → Email inbox ------------------------------------------
  const adminEmailIngest = await request("/api/admin/email-ingest?limit=10");
  if (!Array.isArray(adminEmailIngest.items)) {
    throw new Error("Admin email-ingest: items[] missing");
  }
  if (adminEmailIngest.limit !== 10) {
    throw new Error(`Admin email-ingest: limit echo expected 10, got ${adminEmailIngest.limit}`);
  }
  // Smoke earlier did POST /api/email/ingest → there must be at least 1 entry.
  if (adminEmailIngest.items.length === 0) {
    throw new Error("Admin email-ingest: expected at least 1 email from smoke history");
  }
  const firstEmail = adminEmailIngest.items[0];
  if (!firstEmail.id || !firstEmail.createdAt) {
    throw new Error("Admin email-ingest: item missing id or createdAt");
  }
  console.log("[OK] Admin GET /api/admin/email-ingest (paginated, last N)");

  // -- Admin integrations endpoint blocks non-admin --------------------------
  cookieHeader = dispCookie;
  try {
    await request("/api/admin/integrations");
    throw new Error("Admin integrations: dispatcher must be blocked (403)");
  } catch (e) {
    if (!/403/.test(e.message)) throw e;
  }
  console.log("[OK] Admin /api/admin/integrations blocks non-admin (403)");

  // -- Admin client profile editor: GET /api/admin/clients/:id ---------------
  cookieHeader = p4AdminCookie;

  const allClientsList = await request("/api/clients");
  if (!Array.isArray(allClientsList) || allClientsList.length === 0) {
    throw new Error("Admin client profile: no clients in fixture to test against");
  }
  const profileTarget = allClientsList[0];

  const profileFetched = await request(`/api/admin/clients/${profileTarget.id}`);
  if (profileFetched.id !== profileTarget.id) {
    throw new Error(`Admin GET /api/admin/clients/:id returned wrong id: ${profileFetched.id}`);
  }
  for (const required of ["name", "mc", "equipment", "currentLocation"]) {
    if (!(required in profileFetched)) {
      throw new Error(`Admin client profile: response missing '${required}'`);
    }
  }
  try {
    await request("/api/admin/clients/does-not-exist-xyz");
    throw new Error("Admin GET /api/admin/clients/:id should 404 on unknown id");
  } catch (e) {
    if (!/404/.test(e.message)) throw e;
  }
  console.log("[OK] Admin GET /api/admin/clients/:id (shape + 404)");

  // -- Admin client profile editor: PATCH /api/admin/clients/:id ------------
  const patchPayload = {
    maxGvwLbs: 80000,
    payCentsPerMile: 0.65,
    blockedBrokers: ["123456", "789012"],
    tollsCostPerMile: 0.05,
    wearCostPerMile: 0.15,
  };
  const patchResult = await request(`/api/admin/clients/${profileTarget.id}`, {
    method: "PATCH",
    body: patchPayload,
  });
  if (patchResult.maxGvwLbs !== 80000) {
    throw new Error(`Admin PATCH client: maxGvwLbs not persisted, got ${patchResult.maxGvwLbs}`);
  }
  if (patchResult.payCentsPerMile !== 0.65) {
    throw new Error(`Admin PATCH client: payCentsPerMile not persisted, got ${patchResult.payCentsPerMile}`);
  }
  if (!Array.isArray(patchResult.blockedBrokers) || patchResult.blockedBrokers.length !== 2) {
    throw new Error("Admin PATCH client: blockedBrokers not persisted as array");
  }
  const reFetched = await request(`/api/admin/clients/${profileTarget.id}`);
  if (reFetched.maxGvwLbs !== 80000) {
    throw new Error("Admin PATCH client: re-fetch shows maxGvwLbs not persisted");
  }
  const auditAfterPatch = await request("/api/audit?eventType=client.profile_patched&limit=1");
  if (!Array.isArray(auditAfterPatch.items) || auditAfterPatch.items.length === 0) {
    throw new Error("Admin PATCH client: audit event 'client.profile_patched' missing");
  }
  console.log("[OK] Admin PATCH /api/admin/clients/:id (saves smart-matching fields + audit)");

  // -- RBAC: dispatcher cannot edit client profiles -------------------------
  cookieHeader = dispCookie;
  try {
    await request(`/api/admin/clients/${profileTarget.id}`, {
      method: "PATCH",
      body: { maxGvwLbs: 99999 },
    });
    throw new Error("Admin PATCH client: dispatcher must be blocked (403)");
  } catch (e) {
    if (!/403/.test(e.message)) throw e;
  }
  console.log("[OK] Admin PATCH /api/admin/clients/:id blocks non-admin (403)");

  // -- Dispatcher reassign driver: setup -------------------------------------
  // Reuses fixtures from earlier P4 P0 block:
  //   - dispCookie is assigned to someClient.id (= ivan-enclosed-01 = billingClient.id)
  //   - driverA has linkedClientId = billingClient.id
  //   - driverALoad lives on billingClient.id with driverId = driverA.id
  //   - driverB2 (declared later in P4 P0 section as "smoke.driver.b2@example.com")
  //     is linked to oleg-hotshot-02 (= billingClient2.id), NOT assigned to dispUser
  cookieHeader = dispCookie;

  // -- GET /api/dispatch/clients/:clientId/drivers — list drivers ------------
  const ownDrivers = await request(`/api/dispatch/clients/${billingClient.id}/drivers`);
  if (!Array.isArray(ownDrivers.items)) {
    throw new Error("Dispatcher GET /clients/:id/drivers missing items[]");
  }
  if (!ownDrivers.items.some((d) => d.id === driverA.id)) {
    throw new Error(
      `Dispatcher GET /clients/:id/drivers should include driverA, got ${JSON.stringify(ownDrivers.items.map((d) => d.id))}`,
    );
  }
  for (const d of ownDrivers.items) {
    for (const f of ["id", "fullName", "email", "driverStatus"]) {
      if (!(f in d)) {
        throw new Error(`Dispatcher driver list item missing '${f}'`);
      }
    }
  }
  console.log("[OK] Dispatcher GET /api/dispatch/clients/:id/drivers (lists own client's drivers)");

  // -- GET cross-tenant returns 404 (anti-enumeration) -----------------------
  try {
    await request(`/api/dispatch/clients/${billingClient2.id}/drivers`);
    throw new Error("Dispatcher GET /clients/:id/drivers should 404 on cross-tenant client");
  } catch (e) {
    if (!/404/.test(e.message)) throw e;
  }
  console.log("[OK] Dispatcher GET /api/dispatch/clients/:id/drivers 404 on cross-tenant");

  // -- PATCH /api/dispatch/loads/:id — successful reassign + audit -----------
  // Unassign first (set driverId: null), then re-assign back to driverA.
  const unassigned = await request(`/api/dispatch/loads/${driverALoad.id}`, {
    method: "PATCH",
    body: { driverId: null },
  });
  if (unassigned.driverId != null) {
    throw new Error(`Dispatcher PATCH load with null driverId should clear it, got ${unassigned.driverId}`);
  }

  const reassigned = await request(`/api/dispatch/loads/${driverALoad.id}`, {
    method: "PATCH",
    // expectedDriverId required when assigning (anti double-book); load was just
    // unassigned above, so the current driver is null.
    body: { driverId: driverA.id, expectedDriverId: null },
  });
  if (reassigned.driverId !== driverA.id) {
    throw new Error(`Dispatcher PATCH load: driverId not persisted, got ${reassigned.driverId}`);
  }

  // Audit event must be present
  cookieHeader = p4AdminCookie; // audit requires admin
  const reassignAudit = await request("/api/audit?eventType=load.driver_reassigned&limit=5");
  if (!Array.isArray(reassignAudit.items) || reassignAudit.items.length < 2) {
    throw new Error(
      `Dispatcher PATCH load: expected 2 audit events (unassign + reassign), got ${reassignAudit.items?.length}`,
    );
  }
  console.log("[OK] Dispatcher PATCH /api/dispatch/loads/:id (reassign + audit)");

  // -- PATCH assign WITHOUT expectedDriverId is rejected (anti double-book) ---
  cookieHeader = dispCookie;
  try {
    await request(`/api/dispatch/loads/${driverALoad.id}`, {
      method: "PATCH",
      body: { driverId: driverA.id }, // no expectedDriverId
    });
    throw new Error("Dispatcher PATCH assign without expectedDriverId should 400");
  } catch (e) {
    if (!/400/.test(e.message)) throw e;
  }
  console.log("[OK] Dispatcher PATCH assign w/o expectedDriverId → 400 (anti double-book)");

  // -- PATCH rejects cross-client driver -------------------------------------
  // driverB2 is linked to billingClient2 (oleg), not billingClient (ivan).
  // driverALoad is on billingClient (ivan). Assigning driverB2 → 400.
  cookieHeader = dispCookie;
  try {
    await request(`/api/dispatch/loads/${driverALoad.id}`, {
      method: "PATCH",
      // driverALoad now has driverA assigned; provide the token so we reach the
      // cross-client validation (not the missing-token 400).
      body: { driverId: driverB2.id, expectedDriverId: driverA.id },
    });
    throw new Error("Dispatcher PATCH load should 400 when driver linked to different client");
  } catch (e) {
    if (!/400/.test(e.message)) throw e;
  }
  console.log("[OK] Dispatcher PATCH /api/dispatch/loads/:id 400 on cross-client driver");

  // ===========================================================================
  // Phase 6 — load_sources admin CRUD (mock adapter only; mock needs no creds
  // so these run without DISPATCHOS_KEYRING_PRIMARY configured).
  // ===========================================================================
  cookieHeader = adminCookieHeader; // back to admin session

  // Adapters list — mock + sylectus_email implemented, stubs present.
  const adaptersResp = await request("/api/admin/load-sources/adapters");
  if (!Array.isArray(adaptersResp.adapters)) {
    throw new Error("load-sources/adapters: expected adapters array");
  }
  const mockAdapter = adaptersResp.adapters.find((a) => a.key === "mock");
  if (!mockAdapter || !mockAdapter.implemented) {
    throw new Error("load-sources/adapters: mock adapter missing or not implemented");
  }
  if (!adaptersResp.adapters.some((a) => a.implemented === false)) {
    throw new Error("load-sources/adapters: expected at least one stub (implemented:false)");
  }
  // Email-forwarding brokers are now real adapters (broker-email.ts), not stubs.
  for (const key of ["rxo_email", "tql_email", "coyote_email", "echo_email", "landstar_email"]) {
    const a = adaptersResp.adapters.find((x) => x.key === key);
    if (!a || a.implemented !== true) {
      throw new Error(`load-sources/adapters: ${key} should be implemented (real email adapter)`);
    }
    if (a.requiresCredentials !== false) {
      throw new Error(`load-sources/adapters: ${key} should be credential-free (email forwarding)`);
    }
  }
  console.log("[OK] GET /api/admin/load-sources/adapters (mock + 5 broker-email implemented, stubs present)");

  // End-to-end: create an RXO email source and confirm the Test endpoint
  // authenticates (config has the required inboundAddress) + fetches without
  // error. No matching inbound email yet, so fetch returns 0 — the point is
  // that the real adapter wires up end to end, not just that it exists.
  const rxoSource = (
    await request("/api/admin/load-sources", {
      method: "POST",
      body: {
        clientId: "ivan-enclosed-01",
        adapterKey: "rxo_email",
        label: "RXO forwarding (smoke)",
        configJson: { inboundAddress: "loads+smoke@dispatchos.co" },
        pollIntervalMin: 20,
        status: "paused",
      },
    })
  ).loadSource;
  if (!rxoSource?.id) throw new Error("rxo_email load source create did not return id");
  const rxoTest = await request(`/api/admin/load-sources/${rxoSource.id}/test`, {
    method: "POST",
  });
  if (rxoTest.ok !== true) {
    throw new Error(`rxo_email test did not pass authenticate: ${JSON.stringify(rxoTest)}`);
  }
  console.log("[OK] POST /api/admin/load-sources (rxo_email create + Test authenticates)");

  // Create requires clientId/adapterKey/label.
  let lsBadStatus = 0;
  try {
    await request("/api/admin/load-sources", { method: "POST", body: { label: "incomplete" } });
  } catch (err) {
    lsBadStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (lsBadStatus !== 400) {
    throw new Error(`load-sources create without required fields returned ${lsBadStatus}, expected 400`);
  }

  // Create a mock source (no credentials).
  const createdSource = (
    await request("/api/admin/load-sources", {
      method: "POST",
      body: {
        clientId: "ivan-enclosed-01",
        adapterKey: "mock",
        label: "Smoke Mock Source",
        configJson: { lane: { originState: "FL", destinationState: "GA" }, count: 3 },
        pollIntervalMin: 20,
        status: "paused",
      },
    })
  ).loadSource;
  if (!createdSource?.id) throw new Error("load-sources create did not return an id");
  if (createdSource.status !== "paused") throw new Error("created source should be paused");
  if (createdSource.hasCredentials !== false) {
    throw new Error("mock source should report hasCredentials:false");
  }
  // Credentials must never leak to the UI payload.
  if ("credentialsEnc" in createdSource || "credentialsIv" in createdSource) {
    throw new Error("LEAK: load source payload exposed credential fields");
  }
  console.log("[OK] POST /api/admin/load-sources (mock create + redaction + hasCredentials)");

  // List includes it.
  const lsList = await request("/api/admin/load-sources");
  if (!lsList.loadSources.some((s) => s.id === createdSource.id)) {
    throw new Error("created source not present in list");
  }
  console.log("[OK] GET /api/admin/load-sources (list includes created)");

  // Get by id.
  const lsOne = await request(`/api/admin/load-sources/${createdSource.id}`);
  if (lsOne.loadSource?.id !== createdSource.id) throw new Error("get-by-id mismatch");
  console.log("[OK] GET /api/admin/load-sources/:id");

  // Test the mock adapter — should authenticate + fetch 1 sample.
  const lsTest = await request(`/api/admin/load-sources/${createdSource.id}/test`, { method: "POST" });
  if (lsTest.ok !== true) {
    throw new Error(`mock test should succeed, got ok=${lsTest.ok} error=${lsTest.error}`);
  }
  if (typeof lsTest.latencyMs !== "number") throw new Error("test should report latencyMs");
  console.log("[OK] POST /api/admin/load-sources/:id/test (mock authenticate + fetch)");

  // Patch label + status.
  const lsPatched = (
    await request(`/api/admin/load-sources/${createdSource.id}`, {
      method: "PATCH",
      body: { label: "Smoke Mock Renamed", status: "active" },
    })
  ).loadSource;
  if (lsPatched.label !== "Smoke Mock Renamed" || lsPatched.status !== "active") {
    throw new Error("PATCH did not persist label/status");
  }
  console.log("[OK] PATCH /api/admin/load-sources/:id (label + status)");

  // Soft delete -> status paused.
  const lsDeleted = await request(`/api/admin/load-sources/${createdSource.id}`, { method: "DELETE" });
  if (lsDeleted.ok !== true) throw new Error("DELETE should return ok:true");
  const lsAfterDelete = await request(`/api/admin/load-sources/${createdSource.id}`);
  if (lsAfterDelete.loadSource.status !== "paused") {
    throw new Error("soft-deleted source should be paused");
  }
  console.log("[OK] DELETE /api/admin/load-sources/:id (soft delete -> paused)");

  // 404 on unknown id.
  let lsNotFound = 0;
  try {
    await request("/api/admin/load-sources/does-not-exist");
  } catch (err) {
    lsNotFound = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (lsNotFound !== 404) throw new Error(`unknown load source returned ${lsNotFound}, expected 404`);
  console.log("[OK] GET /api/admin/load-sources/:id 404 on unknown");

  // ===========================================================================
  // Admin load detail — GET /api/admin/loads/:id (PR #46 backend)
  // ===========================================================================
  cookieHeader = adminCookieHeader; // ensure admin session

  const adminLoad = await request(`/api/admin/loads/${createdLoad.id}`);
  if (!adminLoad.load || adminLoad.load.id !== createdLoad.id) {
    throw new Error("admin load detail: load missing or id mismatch");
  }
  if (!Array.isArray(adminLoad.checkins)) throw new Error("admin load detail: checkins not array");
  if (!Array.isArray(adminLoad.events)) throw new Error("admin load detail: events not array");
  if (!Array.isArray(adminLoad.scores)) throw new Error("admin load detail: scores not array");
  // load.created event should be present in the events timeline.
  if (!adminLoad.events.some((e) => e.eventType === "load.created")) {
    throw new Error("admin load detail: expected load.created in events");
  }
  // clientName / driverName keys present (nullable but defined).
  if (!("clientName" in adminLoad.load) || !("driverName" in adminLoad.load)) {
    throw new Error("admin load detail: clientName/driverName keys missing");
  }
  console.log("[OK] GET /api/admin/loads/:id (load + checkins + events + scores)");

  // 404 on unknown load.
  let adminLoadNotFound = 0;
  try {
    await request("/api/admin/loads/does-not-exist");
  } catch (err) {
    adminLoadNotFound = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (adminLoadNotFound !== 404) {
    throw new Error(`admin load detail unknown returned ${adminLoadNotFound}, expected 404`);
  }
  console.log("[OK] GET /api/admin/loads/:id 404 on unknown");

  // ===========================================================================
  // Killer #1 — Broker Trust Score (POST signal, GET :mc, GET top)
  // ===========================================================================
  cookieHeader = adminCookieHeader; // admin is allowed (dispatcher|admin)

  const trustMc = "MC-TRUST-001";

  // Unknown MC returns neutral score 50 with empty breakdown.
  const trustEmpty = await request(`/api/broker-trust/${trustMc}`);
  if (trustEmpty.score !== 50 || trustEmpty.totalSignals !== 0) {
    throw new Error(`empty broker trust expected score=50/total=0, got ${trustEmpty.score}/${trustEmpty.totalSignals}`);
  }
  console.log("[OK] GET /api/broker-trust/:mc (empty => neutral 50)");

  // Report a few positive signals.
  for (const t of ["paid_on_time", "ratecon_honored", "fast_response"]) {
    const r = await request("/api/broker-trust/signal", {
      method: "POST",
      body: { brokerMc: trustMc, signalType: t, positive: true },
    });
    if (!r.id) throw new Error(`signal ${t} did not return id`);
  }
  console.log("[OK] POST /api/broker-trust/signal (positive signals)");

  // Score should now be above neutral, breakdown should reflect counts.
  const trustPos = await request(`/api/broker-trust/${trustMc}`);
  if (trustPos.score <= 50) throw new Error(`expected score > 50 after positives, got ${trustPos.score}`);
  if (trustPos.totalSignals !== 3 || trustPos.positiveCount !== 3) {
    throw new Error(`expected 3 positive signals, got total=${trustPos.totalSignals} pos=${trustPos.positiveCount}`);
  }
  if (trustPos.breakdown.payment.onTime !== 1 || trustPos.breakdown.ratecon.honored !== 1) {
    throw new Error("breakdown did not reflect reported signals");
  }
  if (!Array.isArray(trustPos.recentSignals) || trustPos.recentSignals.length !== 3) {
    throw new Error("recentSignals should list the 3 signals");
  }
  console.log("[OK] GET /api/broker-trust/:mc (score + breakdown + recentSignals)");

  // A fraud signal should crater the score.
  await request("/api/broker-trust/signal", {
    method: "POST",
    body: { brokerMc: trustMc, signalType: "fraud_attempt", positive: false },
  });
  const trustFraud = await request(`/api/broker-trust/${trustMc}`);
  if (trustFraud.score >= 50) throw new Error(`fraud should drop score below 50, got ${trustFraud.score}`);
  if (trustFraud.breakdown.fraud.count !== 1) throw new Error("fraud breakdown count should be 1");
  console.log("[OK] POST /api/broker-trust/signal (fraud craters score)");

  // Leaderboard includes our MC.
  const trustTop = await request("/api/broker-trust/top?direction=negative&limit=20");
  if (!Array.isArray(trustTop.items) || !trustTop.items.some((i) => i.mc === trustMc)) {
    throw new Error("leaderboard should include the reported MC");
  }
  console.log("[OK] GET /api/broker-trust/top (leaderboard)");

  // Invalid signal type rejected (400).
  let trustBadStatus = 0;
  try {
    await request("/api/broker-trust/signal", {
      method: "POST",
      body: { brokerMc: trustMc, signalType: "not_a_real_signal", positive: true },
    });
  } catch (err) {
    trustBadStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (trustBadStatus !== 400) throw new Error(`bad signal type returned ${trustBadStatus}, expected 400`);
 console.log("[OK] POST /api/broker-trust/signal (invalid type => 400)");

  // ===========================================================================
  // Killer #6 — Multi-Driver Cockpit (GET /api/dispatch/cockpit)
  // ===========================================================================
  // dispCookie = smoke.dispatcher, assigned to ivan-enclosed-01 (with loads).
  cookieHeader = dispCookie;

  const cockpit = await request("/api/dispatch/cockpit");
  if (!Array.isArray(cockpit.carriers)) throw new Error("cockpit: carriers not array");
  if (!Array.isArray(cockpit.topLoads)) throw new Error("cockpit: topLoads not array");
  if (!Array.isArray(cockpit.suggestions)) throw new Error("cockpit: suggestions not array");
  if (!cockpit.carriers.some((c) => c.id === "ivan-enclosed-01")) {
    throw new Error("cockpit: expected assigned carrier ivan-enclosed-01");
  }
  const cockpitCarrier = cockpit.carriers.find((c) => c.id === "ivan-enclosed-01");
  if (
    !("locationState" in cockpitCarrier) ||
    !("hoursAvailable" in cockpitCarrier) ||
    !("alerts" in cockpitCarrier)
  ) {
    throw new Error("cockpit: carrier missing expected fields");
  }
  console.log("[OK] GET /api/dispatch/cockpit (carriers + topLoads + suggestions)");

  // Admin is blocked — cockpit is a dispatcher-only surface.
  cookieHeader = adminCookieHeader;
  let cockpitForbidden = 0;
  try {
    await request("/api/dispatch/cockpit");
  } catch (err) {
    cockpitForbidden = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (cockpitForbidden !== 403) {
    throw new Error(`cockpit should block admin with 403, got ${cockpitForbidden}`);
  }
  console.log("[OK] GET /api/dispatch/cockpit blocks admin (403)");

  // ===========================================================================
  // Killer #4 — Predictive Load Hunting: lane watchlist + predictions
  // ===========================================================================
  // dispCookie = smoke.dispatcher, assigned to ivan-enclosed-01.
  cookieHeader = dispCookie;

  // Create a watch on an unusual lane so seed loads don't pollute match_count.
  const watchCreate = await request("/api/dispatch/watchlist", {
    method: "POST",
    body: {
      clientId: "ivan-enclosed-01",
      originState: "WY",
      destinationState: "VT",
      minPpm: 1.5,
    },
  });
  if (!watchCreate.id) throw new Error("watchlist: create returned no id");
  console.log("[OK] POST /api/dispatch/watchlist (create)");

  // List shows it, matchCount 0.
  const watchList = await request("/api/dispatch/watchlist?clientId=ivan-enclosed-01");
  const theWatch = watchList.items.find((w) => w.id === watchCreate.id);
  if (!theWatch) throw new Error("watchlist: created watch not in list");
  if (theWatch.matchCount !== 0) throw new Error("watchlist: fresh watch should have matchCount 0");
  console.log("[OK] GET /api/dispatch/watchlist (list)");

  // Admin creating a load on WY->VT above the min ppm should trigger a match.
  cookieHeader = adminCookieHeader;
  await request("/api/loads", {
    method: "POST",
    body: {
      source: "manual",
      originCity: "Cheyenne",
      originState: "WY",
      originLat: 41.14,
      originLng: -104.82,
      destinationCity: "Burlington",
      destinationState: "VT",
      destinationLat: 44.48,
      destinationLng: -73.21,
      rate: 5000,
      loadedMiles: 2000, // 2.5 ppm > 1.5 min
      equipment: "open_car_hauler",
      brokerName: "Watch Test Broker",
      brokerMc: "MC-WATCH-1",
      brokerScore: 80,
      fraudRisk: 10,
      marketQuality: 70,
      pickupAt: new Date(Date.now() + 86400000).toISOString(),
      deliveryAt: new Date(Date.now() + 3 * 86400000).toISOString(),
    },
  });

  // Back to dispatcher: the watch should now show matchCount 1.
  cookieHeader = dispCookie;
  const watchAfter = await request("/api/dispatch/watchlist?clientId=ivan-enclosed-01");
  const matchedWatch = watchAfter.items.find((w) => w.id === watchCreate.id);
  if (!matchedWatch || matchedWatch.matchCount !== 1) {
    throw new Error(`watchlist: expected matchCount 1 after matching load, got ${matchedWatch?.matchCount}`);
  }
  console.log("[OK] watchlist match bumps match_count on new load");

  // Predictions endpoint returns the watched lane with accumulated stats.
  const preds = await request("/api/dispatch/predictions?clientId=ivan-enclosed-01");
  if (!Array.isArray(preds.predictions)) throw new Error("predictions: not an array");
  if (!preds.predictions.some((p) => p.originState === "WY" && p.destinationState === "VT")) {
    throw new Error("predictions: watched lane WY->VT missing");
  }
  console.log("[OK] GET /api/dispatch/predictions (dow stats for watched lanes)");

  // Delete the watch.
  const del = await request(`/api/dispatch/watchlist/${watchCreate.id}`, { method: "DELETE" });
  if (!del.deleted) throw new Error("watchlist: delete did not report deleted");
  console.log("[OK] DELETE /api/dispatch/watchlist/:id");

  // Admin is blocked from the dispatcher-only watchlist surface.
  cookieHeader = adminCookieHeader;
  let watchForbidden = 0;
  try {
    await request("/api/dispatch/watchlist?clientId=ivan-enclosed-01");
  } catch (err) {
    watchForbidden = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (watchForbidden !== 403) {
    throw new Error(`watchlist should block admin with 403, got ${watchForbidden}`);
  }
  console.log("[OK] GET /api/dispatch/watchlist blocks admin (403)");

  // ===========================================================================
  // Anti-fraud — one MC docket = one account (onboarding MC claim)
  // ===========================================================================
  const fraudMc = "MC-FRAUDTEST-9001";

  // Account A (admin session) claims the MC via onboarding.
  cookieHeader = adminCookieHeader;
  await request("/api/me/onboarding", {
    method: "PATCH",
    body: { step: 2, data: { mc: fraudMc } },
  });
  console.log("[OK] onboarding MC claim (account A)");

  // Account A re-saving the same MC is idempotent (no 409).
  await request("/api/me/onboarding", {
    method: "PATCH",
    body: { step: 2, data: { mc: fraudMc } },
  });
  console.log("[OK] onboarding MC re-claim by same account is idempotent");

  // Account B (dispatcher session) tries the same MC → must be rejected 409.
  cookieHeader = dispCookie;
  let mcConflictStatus = 0;
  let mcConflictCode = "";
  try {
    await request("/api/me/onboarding", {
      method: "PATCH",
      body: { step: 2, data: { mc: fraudMc } },
    });
  } catch (err) {
    mcConflictStatus = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
    mcConflictCode = /mc_already_claimed/.test(String(err.message)) ? "mc_already_claimed" : "";
  }
  if (mcConflictStatus !== 409 || mcConflictCode !== "mc_already_claimed") {
    throw new Error(
      `duplicate MC should be 409 mc_already_claimed, got ${mcConflictStatus} ${mcConflictCode}`,
    );
  }
  console.log("[OK] onboarding MC claim blocks a second account (409)");

  // A genuinely different docket (different digits) must NOT conflict — account
  // B can claim it freely. (Note: "MC-FRAUDTEST-9001" normalizes to MC-9001
  // since normalizeMc keeps only digits, so we use 7777 here for a clean,
  // distinct docket.)
  let mcDistinct = -1;
  try {
    const r = await request("/api/me/onboarding", {
      method: "PATCH",
      body: { step: 2, data: { mc: "MC-7777" } },
    });
    mcDistinct = 200; // request() throws on non-2xx, so reaching here = success
  } catch (err) {
    mcDistinct = Number(String(err.message).match(/returned (\d+)/)?.[1] || 0);
  }
  if (mcDistinct !== 200) {
    throw new Error(`distinct docket MC-7777 should be claimable, got ${mcDistinct}`);
  }
  console.log("[OK] onboarding MC claim distinguishes distinct dockets");

} catch (error) {
  console.error("[FAIL]", error.message);
  console.error(output);
  process.exitCode = 1;
} finally {
  // Clean up this run's DB + data root (and SQLite WAL/SHM sidecars) so smoke
  // artifacts don't accumulate in the repo. On Windows the server holds the
  // SQLite file lock until it fully exits, so wait for proc 'exit' (with a
  // short fallback) before deleting — otherwise rmSync races the lock.
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    proc.once("exit", finish);
    proc.kill("SIGTERM");
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish();
    }, 3000);
  });
  for (const f of [
    SMOKE_DB_PATH,
    `${SMOKE_DB_PATH}-wal`,
    `${SMOKE_DB_PATH}-shm`,
    SMOKE_DATA_ROOT,
  ]) {
    try {
      rmSync(f, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
