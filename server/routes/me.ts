// ===========================================================================
// server/routes/me.ts — Phase 4 driver portal API (P0)
// ===========================================================================
//
// All `/api/me/*` endpoints below the existing `GET /api/me` (which lives in
// routes.ts and returns UserPublic). Driver portal aggregates and driver-
// scoped reads/writes go here. Each handler is wrapped in
// `requireRole('driver')` individually so they're registered BEFORE the
// shared `app.use("/api", requireRole.any())` gate in routes.ts (same pattern
// as registerAdminRoutes — see server/routes/admin.ts for the rationale).
//
// Tenant scoping rule: every endpoint MUST filter by the session user's id.
// We never trust a path/query parameter to identify "self". The Phase 4
// handoff §0.10 calls this out as the single most important security rule
// for the driver portal — a buggy filter here leaks loads across drivers.
//
// Response shapes — all flat objects / arrays (Phase 3 handoff §2.2). No
// `{ ok, data }` envelope. Errors use `{ message }` or
// `{ message, issues:[...] }` for Zod validation failures, matching the
// pattern in routes/admin.ts.
// ---------------------------------------------------------------------------

import type { Express, Request, Response, NextFunction } from "express";
import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { z } from "zod";
import {
  createCheckinSchema,
  createExpenseSchema,
  createIssueSchema,
  driverDocumentTypeSchema,
  driverStatusSchema,
  loadFullSchema,
  uploadDriverDocumentSchema,
  updateDriverProfileSchema,
  updateDriverStatusSchema,
  equipmentSchema,
  type DriverDashboard,
  type LoadFull,
} from "@shared/schema";
import { enrichLoadSync } from "../lib/ai/enrich";
import { parseLimit } from "../lib/query";
import { getCurrentUser, requireRole } from "../auth";
import { storage, uploadsRoot } from "../storage";
import { upload } from "../upload";
import { todayInState } from "../lib/us-state-tz";

// ---------------------------------------------------------------------------
// Helpers (mirror server/routes/admin.ts conventions)
// ---------------------------------------------------------------------------

function zodIssues(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path,
    message: issue.message,
  }));
}

function send400Validation(res: Response, error: ZodError) {
  return res.status(400).json({ message: "Validation failed", issues: zodIssues(error) });
}

function ah(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => handler(req, res, next))
      .catch((error: unknown) => {
        if (error instanceof ZodError) return send400Validation(res, error);
        return next(error);
      });
  };
}

/**
 * Reading the driver status off a load. We don't store a status column; we
 * derive it. P0 only distinguishes "booked" (has driver + bookedAt) from
 * "available" (anything else). Later phases (P1+, P3 booking flow) will add
 * in_transit / at_delivery / delivered based on check-ins.
 */
function deriveLoadStatus(load: LoadFull): "available" | "booked" {
  return load.driverId && load.bookedAt ? "booked" : "available";
}

/**
 * Helper: cast a Load (Phase 1 narrow type) through loadFullSchema so the
 * additive driverId/clientId/bookedAt fields are visible to the response
 * shape. We round-trip through the schema (which is permissive on optionals)
 * so downstream code sees a single, well-typed shape.
 */
function toLoadFull(load: unknown): LoadFull {
  return loadFullSchema.parse(load);
}

// V5-003: a hired driver must not see a load's commercial / risk internals.
// rate, brokerScore, fraudRisk, marketQuality and notes are dispatcher-side
// data — the driver only needs the route, dates, equipment and who to call
// (brokerName/brokerMc). An owner-operator IS their own carrier, so they keep
// the full record (their money, their risk view). We delete the keys rather
// than zero them so nothing leaks in the JSON; the cast keeps the existing
// loadFullSchema-typed response shape.
const DRIVER_HIDDEN_LOAD_FIELDS = [
  "rate",
  "brokerScore",
  "fraudRisk",
  "marketQuality",
  "notes",
] as const;

function driverSafeLoad(load: LoadFull, isOwnerOperator: boolean): LoadFull {
  if (isOwnerOperator) return load;
  const clone: Record<string, unknown> = { ...load };
  for (const key of DRIVER_HIDDEN_LOAD_FIELDS) {
    delete clone[key];
  }
  return clone as LoadFull;
}

/**
 * Build a short "Pickup today" / "Delivery today" panel item. Returns null if
 * the load's pickup (or delivery) is not on the current calendar date in UTC.
 *
 * P0 simplification: uses UTC calendar date for matching. This matches the
 * date-only convention used everywhere else (bookedAt, weekStart). Later
 * phases can layer driver-timezone awareness on top.
 */
function buildTodayStop(
  iso: string,
  city: string,
  state: string,
  contact?: string,
): { time: string; address: string; contact?: string } | null {
  if (!iso) return null;
  // "Today" must be computed in the pickup/delivery local time, not UTC, or a
  // driver on the West Coast loses the stop after ~16:00 local (already next
  // day in UTC). `state` is the stop's USPS code; falls back to UTC if unknown.
  const today = todayInState(state);
  if (iso.slice(0, 10) !== today) return null;
  return {
    time: iso,
    address: `${city}, ${state}`,
    contact,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerMeRoutes(app: Express): void {
  const driver = requireRole("driver");

  // -------------------------------------------------------------------------
  // GET /api/me/dashboard
  // -------------------------------------------------------------------------
  // Aggregates everything the driver home screen needs in a single round
  // trip. The driver portal polls this on a 30s interval (TanStack Query
  // refetchInterval) — keep it cheap. We do at most:
  //   - 1 SELECT for the user (getCurrentUser already loaded it)
  //   - 1 SELECT for loads-by-driver (index hit)
  //
  // Response shape: driverDashboardSchema (see shared/schema.ts).
  // -------------------------------------------------------------------------
  app.get(
    "/api/me/dashboard",
    driver,
    ah((req, res) => {
      const user = getCurrentUser(req);
      if (!user) return res.status(401).json({ message: "Authentication required" });

      // Pull a tight window of recent loads, newest first. We need:
      //   - the current load (status='booked'),
      //   - up to 3 recent loads to display in history,
      //   - today's pickup/delivery, derived from the current load.
      // Pulling 20 covers all three without a separate "latest" query — even
      // a busy driver doesn't have many active loads at once.
      //
      // Owner-operator: also include all loads for their carrier company
      // (clientId === linkedClientId), not only those assigned to this driver.
      const page = storage.listLoadsForDriver(user.id, { limit: 20 });
      let loads = page.items.map(toLoadFull);

      // V5-003: determine once whether this driver is an owner-operator (their
      // own carrier) — only then are they entitled to the loads' commercial data.
      let isOwnerOperator = false;
      if (user.linkedClientId) {
        const linkedClient = storage.getClient(user.linkedClientId);
        if ((linkedClient as any)?.persona === "owner_operator") {
          isOwnerOperator = true;
          const clientPage = storage.listLoadsForClientIds([user.linkedClientId], { limit: 20 });
          const clientLoads = clientPage.items.map(toLoadFull);
          // Merge: deduplicate by id, keep order newest-first
          const seen = new Set(loads.map((l) => l.id));
          for (const cl of clientLoads) {
            if (!seen.has(cl.id)) {
              seen.add(cl.id);
              loads.push(cl);
            }
          }
          // Re-sort merged list by pickupAt descending
          loads.sort((a, b) => b.pickupAt.localeCompare(a.pickupAt));
        }
      }

      const currentLoad = loads.find((l) => deriveLoadStatus(l) === "booked") ?? null;
      const recentLoads = loads.slice(0, 3);

      const todayPickup = currentLoad
        ? buildTodayStop(
            currentLoad.pickupAt,
            currentLoad.originCity,
            currentLoad.originState,
            currentLoad.brokerName,
          )
        : null;
      const todayDelivery = currentLoad
        ? buildTodayStop(
            currentLoad.deliveryAt,
            currentLoad.destinationCity,
            currentLoad.destinationState,
          )
        : null;

      // Enrich with carrier (client) + active dispatcher (Phase 5 dashboard context).
      // Driver should see "who I work for" and "who to call" without poking the API.
      const carrier = user.linkedClientId
        ? storage.getClient(user.linkedClientId)
        : undefined;
      const clientCard = carrier
        ? { id: carrier.id, name: carrier.name, mc: carrier.mc, persona: (carrier as any).persona as "owner_operator" | "fleet" | "enterprise" | undefined }
        : null;

      let dispatcherCard: {
        id: string;
        fullName: string;
        email: string;
        phone: string | null;
      } | null = null;
      if (user.linkedClientId) {
        const assignments = storage.listAssignmentsForClient(user.linkedClientId);
        // Find the first valid active dispatcher. We iterate (not [0]) because
        // a client may have stale assignments pointing to blocked or deleted
        // users — we want the first usable contact, not necessarily the oldest.
        for (const a of assignments) {
          const disp = storage.getUserById(a.dispatcherUserId);
          if (disp && !disp.blocked && disp.role === "dispatcher") {
            dispatcherCard = {
              id: disp.id,
              fullName: disp.fullName ?? disp.email,
              email: disp.email,
              phone: disp.phone ?? null,
            };
            break;
          }
        }
      }

      const body: DriverDashboard = {
        driver: {
          id: user.id,
          fullName: user.fullName,
          email: user.email,
          phone: user.phone,
          status: user.driverStatus ?? "available",
        },
        client: clientCard,
        dispatcher: dispatcherCard,
        // V5-003: strip commercial/risk fields for hired drivers (O-O keeps them).
        // todayPickup/todayDelivery were already built above from the full load
        // (they only use brokerName, which stays), so projecting here is safe.
        currentLoad: currentLoad ? driverSafeLoad(currentLoad, isOwnerOperator) : null,
        todayPickup,
        todayDelivery,
        recentLoads: recentLoads.map((l) => driverSafeLoad(l, isOwnerOperator)),
        // P0 stub — message threads land in a future phase.
        hasUnreadMessages: false,
        // P1: compute from driver_documents.expires_at. PendingDoc has more
        // fields than the P0 stub shape (id, daysUntilExpiry, status) but
        // this is a strict superset — P0 clients keep parsing without change.
        pendingDocs: storage.computePendingDocsForUser(user.id, 30),
      };
      return res.json(body);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/me/loads?status=available|booked&limit=&cursor=
  // -------------------------------------------------------------------------
  // Cursor pagination over `loads.driver_id = self.id`. Optional `status`
  // filter applied AFTER fetching the page so we keep a single indexed query;
  // P0 only has two meaningful values so the in-memory filter is fine.
  // -------------------------------------------------------------------------
  app.get(
    "/api/me/loads",
    driver,
    ah((req, res) => {
      const user = getCurrentUser(req);
      if (!user) return res.status(401).json({ message: "Authentication required" });

      const limitRaw = req.query.limit;
      const limit = limitRaw === undefined ? undefined : Number(limitRaw);
      if (limit !== undefined && (!Number.isFinite(limit) || limit < 1 || limit > 200)) {
        return res.status(400).json({ message: "limit must be an integer between 1 and 200" });
      }
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

      let statusFilter: "available" | "booked" | undefined;
      if (typeof req.query.status === "string") {
        if (req.query.status === "available" || req.query.status === "booked") {
          statusFilter = req.query.status;
        } else {
          return res.status(400).json({
            message: "status must be 'available' or 'booked'",
          });
        }
      }

      const page = storage.listLoadsForDriver(user.id, { limit, cursor });
      let items = page.items.map(toLoadFull);

      // Owner-operator: also include all loads for their carrier company
      let isOwnerOperator = false;
      if (user.linkedClientId) {
        const linkedClient = storage.getClient(user.linkedClientId);
        if ((linkedClient as any)?.persona === "owner_operator") {
          isOwnerOperator = true;
          const clientPage = storage.listLoadsForClientIds([user.linkedClientId], { limit: limit ?? 50 });
          const seen = new Set(items.map((l) => l.id));
          for (const cl of clientPage.items.map(toLoadFull)) {
            if (!seen.has(cl.id)) {
              seen.add(cl.id);
              items.push(cl);
            }
          }
          items.sort((a, b) => b.pickupAt.localeCompare(a.pickupAt));
        }
      }

      if (statusFilter) {
        items = items.filter((l) => deriveLoadStatus(l) === statusFilter);
      }

      // V5-003: strip commercial/risk fields for hired drivers (O-O keeps them).
      items = items.map((l) => driverSafeLoad(l, isOwnerOperator));

      return res.json({
        items,
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
        // total reflects the unfiltered driver-scoped count from storage.
        // The status filter is a UI convenience, not a separately-counted
        // facet — Phase 4 P0 keeps this simple.
        total: page.total,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/me/loads/:id
  // -------------------------------------------------------------------------
  // 404 (not 403) when the load belongs to a different driver. Returning 403
  // here would leak the existence of the id to anyone with a driver session.
  // 404 keeps the response identical for "no such load" and "not yours".
  // -------------------------------------------------------------------------
  app.get(
    "/api/me/loads/:id",
    driver,
    ah((req, res) => {
      const user = getCurrentUser(req);
      if (!user) return res.status(401).json({ message: "Authentication required" });

      const loadId = String(req.params.id);
      const driverId = storage.getLoadDriverId(loadId);
      if (driverId === undefined) return res.status(404).json({ message: "Load not found" });
      if (driverId !== user.id) {
        // Tenant leak prevention: same response shape as missing load.
        return res.status(404).json({ message: "Load not found" });
      }
      const load = storage.getLoad(loadId);
      if (!load) return res.status(404).json({ message: "Load not found" });

      // V5-003: strip commercial/risk fields unless this driver is an
      // owner-operator (their own carrier, entitled to the full record).
      let isOwnerOperator = false;
      if (user.linkedClientId) {
        const linkedClient = storage.getClient(user.linkedClientId);
        if ((linkedClient as any)?.persona === "owner_operator") {
          isOwnerOperator = true;
        }
      }
      return res.json(driverSafeLoad(toLoadFull(load), isOwnerOperator));
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/me/status   body: { status: 'available' | 'on_route' | 'off_duty' }
  // -------------------------------------------------------------------------
  // Only drivers have a status. We deliberately 400 (not 403) on admin or
  // dispatcher hitting this — requireRole('driver') already 403s for those
  // roles, but if Phase 5 ever loosens the gate (e.g. an "act-as" admin
  // tool), this defensive check stays correct. Vlad confirmed in the Q-thread
  // follow-up: explicit 400 > silent ignore.
  // -------------------------------------------------------------------------
  app.post(
    "/api/me/status",
    driver,
    ah((req, res) => {
      const user = getCurrentUser(req);
      if (!user) return res.status(401).json({ message: "Authentication required" });
      if (user.role !== "driver") {
        return res.status(400).json({ message: "Only drivers have a status" });
      }

      const body = updateDriverStatusSchema.parse(req.body);
      // Defensive re-parse — the schema already validates the enum. Kept here
      // to make the audit payload's `to` field a typed value.
      const next = driverStatusSchema.parse(body.status);
      const prev = user.driverStatus ?? "available";

      // No-op fast path — still 200 so the client can treat the call as
      // idempotent. Don't emit an audit event for a no-op (noise).
      if (prev === next) {
        return res.json(storage.toUserPublic(user));
      }

      const updated = storage.updateUserStatus(user.id, next);
      if (!updated) return res.status(404).json({ message: "User not found" });

      storage.audit("driver.status_changed", "user", user.id, {
        userId: user.id,
        from: prev,
        to: next,
      });
      return res.json(storage.toUserPublic(updated));
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/me/profile   body: { fullName?, phone? }
  // -------------------------------------------------------------------------
  // Driver-managed fields only. Email and role are admin-managed via
  // /api/admin/users/:id. Schema enforces "at least one field" — empty bodies
  // 400 cleanly.
  // -------------------------------------------------------------------------
  app.patch(
    "/api/me/profile",
    driver,
    ah((req, res) => {
      const user = getCurrentUser(req);
      if (!user) return res.status(401).json({ message: "Authentication required" });

      const patch = updateDriverProfileSchema.parse(req.body);
      const updated = storage.updateUserProfileFields(user.id, patch);
      if (!updated) return res.status(404).json({ message: "User not found" });

      storage.audit("user.profile_updated", "user", user.id, {
        userId: user.id,
        actorUserId: user.id,
        fields: Object.keys(patch),
      });
      return res.json(storage.toUserPublic(updated));
    }),
  );

  // ===========================================================================
  // Phase 4 P1 — Documents (driver-owned compliance docs)
  // ===========================================================================
  //
  // GET    /api/me/documents              — list own docs (cursor pagination)
  // POST   /api/me/documents              — multipart upload (file + metadata)
  // DELETE /api/me/documents/:id          — delete own doc + unlink file
  //
  // Tenant scoping: every read/write filtered by session userId. /:id endpoints
  // return 404 (not 403) if doc belongs to someone else — same anti-enumeration
  // pattern as P0 /api/me/loads/:id.

  app.get(
    "/api/me/documents",
    driver,
    ah((req, res) => {
      const user = getCurrentUser(req);
      if (!user) return res.status(401).json({ message: "Authentication required" });
      const limit = parseLimit(req.query.limit);
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
      const out = storage.listDriverDocumentsForUser(user.id, { limit, cursor });
      return res.json(out);
    }),
  );

  app.post(
    "/api/me/documents",
    driver,
    upload.single("file"),
    ah((req, res) => {
      const user = getCurrentUser(req);
      if (!user) return res.status(401).json({ message: "Authentication required" });
      const file = req.file;
      if (!file) return res.status(400).json({ message: "file is required (multipart field 'file')" });

      // Parse + validate metadata before we commit to a DB row. If parsing
      // fails, drop the uploaded temp file so we don't accumulate orphans.
      let meta: ReturnType<typeof uploadDriverDocumentSchema.parse>;
      try {
        meta = uploadDriverDocumentSchema.parse(req.body);
      } catch (err) {
        try { fs.unlinkSync(file.path); } catch { /* ignore */ }
        throw err;
      }

      // Move the temp file from multer's `uploadsRoot` flat dir into a typed
      // subfolder (driver-docs/<userId>/<filename>) for sanity in backups.
      const subdir = path.join(uploadsRoot, "driver-docs", user.id);
      fs.mkdirSync(subdir, { recursive: true });
      const safeBase = `${Date.now()}-${path.basename(file.originalname).replace(/[^\w.\-]/g, "_")}`;
      const finalPath = path.join(subdir, safeBase);
      fs.renameSync(file.path, finalPath);
      // storage_path is server-relative; resolution to absolute happens at read.
      const storagePath = path.relative(uploadsRoot, finalPath);

      // Audit V3-2 — carrier-level compliance docs (insurance, UCR, IRP,
      // MCS-150, DQ file generic) MUST NOT be driver-writable. A driver who
      // uploads a forged cargo_insurance with expiresAt=2030 would silence
      // the alert calendar and feed Montgomery defense pack with garbage.
      // Drivers can still self-upload PERSONAL compliance docs (CDL, medical,
      // their own §391 paperwork) which are required for THEIR DQ file.
      const CARRIER_LEVEL_DOC_TYPES = new Set([
        "cargo_insurance",
        "auto_liability",
        "general_liability",
        "ucr_certificate",
        "irp_cab_card",
        "mcs150",
        "dq_file",
      ]);
      if (CARRIER_LEVEL_DOC_TYPES.has(meta.type)) {
        // Cleanup multer temp file before bailing.
        try { fs.unlinkSync(file.path); } catch { /* ignore */ }
        return res.status(403).json({
          message:
            "This document type is carrier-level and must be uploaded by an admin or dispatcher via /admin/clients/:id/documents.",
        });
      }
      // Driver-uploaded personal compliance docs (cdl, medical, dq_*) stay
      // attached to the user. Linkage to the carrier is via the user.id;
      // computeDqStatusForDriver picks them up there.
      const inferredClientId: string | null = null;

      const doc = storage.insertDriverDocument({
        ownerUserId: user.id,
        clientId: inferredClientId,
        type: meta.type,
        fileName: file.originalname,
        storagePath,
        expiresAt: meta.expiresAt ?? null,
        notes: meta.notes ?? null,
      });

      storage.audit("driver.document_uploaded", "driver_document", doc.id, {
        userId: user.id,
        actorUserId: user.id,
        type: doc.type,
        expiresAt: doc.expiresAt,
        sizeBytes: file.size,
      });

      return res.status(201).json(doc);
    }),
  );

  app.delete(
    "/api/me/documents/:id",
    driver,
    ah((req, res) => {
      const user = getCurrentUser(req);
      if (!user) return res.status(401).json({ message: "Authentication required" });
      const id = String(req.params.id);
      const doc = storage.getDriverDocument(id);
      // 404 (not 403) when foreign — anti-enumeration, matches P0 loads/:id.
      if (!doc || doc.ownerUserId !== user.id) {
        return res.status(404).json({ message: "Document not found" });
      }
      const ok = storage.deleteDriverDocument(id, user.id);
      if (!ok) return res.status(404).json({ message: "Document not found" });
      // Best-effort unlink the file. Don't fail the request on FS errors —
      // the DB row is already gone, an orphan blob is recoverable.
      try {
        const abs = path.join(uploadsRoot, doc.storagePath);
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch { /* ignore */ }

      storage.audit("driver.document_deleted", "driver_document", id, {
        userId: user.id,
        actorUserId: user.id,
        type: doc.type,
      });
      return res.status(204).end();
    }),
  );

  // ===========================================================================
  // Phase 4 P1 — Check-ins
  // ===========================================================================
  //
  // GET  /api/me/loads/:id/checkins  — timeline for one load (driver-scoped)
  // POST /api/me/loads/:id/checkin   — record arrival/loaded/delivered + geo
  //
  // Load ownership is verified before any read/write — same 404 rule as P0.

  app.get(
    "/api/me/loads/:id/checkins",
    driver,
    ah((req, res) => {
      const user = getCurrentUser(req);
      if (!user) return res.status(401).json({ message: "Authentication required" });
      const loadDriverId = storage.getLoadDriverId(String(req.params.id));
      if (!loadDriverId || loadDriverId !== user.id) {
        return res.status(404).json({ message: "Load not found" });
      }
      return res.json({ items: storage.listCheckinsForLoad(String(req.params.id)) });
    }),
  );

  app.post(
    "/api/me/loads/:id/checkin",
    driver,
    ah((req, res) => {
      const user = getCurrentUser(req);
      if (!user) return res.status(401).json({ message: "Authentication required" });
      const loadDriverId = storage.getLoadDriverId(String(req.params.id));
      if (!loadDriverId || loadDriverId !== user.id) {
        return res.status(404).json({ message: "Load not found" });
      }
      const body = createCheckinSchema.parse(req.body);
      const checkin = storage.insertLoadCheckin({
        loadId: String(req.params.id),
        driverUserId: user.id,
        kind: body.kind,
        lat: body.lat ?? null,
        lng: body.lng ?? null,
        notes: body.notes ?? null,
      });
      storage.audit("driver.checkin", "load", String(req.params.id), {
        userId: user.id,
        actorUserId: user.id,
        kind: body.kind,
        hasGeo: typeof body.lat === "number",
      });
      return res.status(201).json(checkin);
    }),
  );

  // ===========================================================================
  // Phase 4 P1 — Expenses
  // ===========================================================================
  //
  // GET  /api/me/expenses             — list own expenses (cursor + ?loadId=)
  // POST /api/me/expenses             — log new expense (optional photo file)
  //
  // P1 scope: driver-side log only. No billing integration, no admin approval
  // queue (will arrive in Phase 5). Amount taken as dollars in body, stored
  // in cents (integer) to avoid floating-point drift in any future totals.

  app.get(
    "/api/me/expenses",
    driver,
    ah((req, res) => {
      const user = getCurrentUser(req);
      if (!user) return res.status(401).json({ message: "Authentication required" });
      const limit = parseLimit(req.query.limit);
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
      const loadId = typeof req.query.loadId === "string" ? req.query.loadId : undefined;
      const out = storage.listExpensesForUser(user.id, { limit, cursor, loadId });
      return res.json(out);
    }),
  );

  app.post(
    "/api/me/expenses",
    driver,
    upload.single("photo"),
    ah((req, res) => {
      const user = getCurrentUser(req);
      if (!user) return res.status(401).json({ message: "Authentication required" });

      let body: ReturnType<typeof createExpenseSchema.parse>;
      try {
        body = createExpenseSchema.parse(req.body);
      } catch (err) {
        if (req.file) { try { fs.unlinkSync(req.file.path); } catch { /* ignore */ } }
        throw err;
      }

      // If the expense references a load, verify it belongs to this driver
      // (same anti-enumeration: a foreign loadId acts as if not found).
      if (body.loadId) {
        const owner = storage.getLoadDriverId(body.loadId);
        if (!owner || owner !== user.id) {
          if (req.file) { try { fs.unlinkSync(req.file.path); } catch { /* ignore */ } }
          return res.status(404).json({ message: "Load not found" });
        }
      }

      // Move uploaded photo (if any) into receipts subfolder.
      let photoStoragePath: string | null = null;
      if (req.file) {
        const subdir = path.join(uploadsRoot, "receipts", user.id);
        fs.mkdirSync(subdir, { recursive: true });
        const safeBase = `${Date.now()}-${path.basename(req.file.originalname).replace(/[^\w.\-]/g, "_")}`;
        const finalPath = path.join(subdir, safeBase);
        fs.renameSync(req.file.path, finalPath);
        photoStoragePath = path.relative(uploadsRoot, finalPath);
      }

      const expense = storage.insertDriverExpense({
        driverUserId: user.id,
        loadId: body.loadId ?? null,
        category: body.category,
        amountCents: Math.round(body.amount * 100),
        photoStoragePath,
        notes: body.notes ?? null,
      });

      storage.audit("driver.expense_filed", "driver_expense", expense.id, {
        userId: user.id,
        actorUserId: user.id,
        category: expense.category,
        amountCents: expense.amountCents,
        loadId: expense.loadId,
        hasPhoto: photoStoragePath !== null,
      });

      return res.status(201).json(expense);
    }),
  );

  // ===========================================================================
  // Phase 4 P1 — Issues (driver-reported problems)
  // ===========================================================================
  //
  // POST /api/me/issues
  //
  // Creates an approval_task. Routing logic (Phase 4 P0 dispatcher portal):
  //   1. Driver has linkedClientId AND that client has an active dispatcher
  //      → assigneeRole='dispatcher', payload.dispatcherUserId = X,
  //        payload.routedTo='dispatcher'
  //   2. Otherwise (no linked client / unassigned client)
  //      → assigneeRole='admin', payload.routedTo='admin_fallback'
  //
  // Admin queue (P1.1) sees both; dispatcher queue filters by
  // payload.dispatcherUserId via json_extract. This way nothing ever falls
  // through the cracks even before all clients have dispatchers attached.

  app.post(
    "/api/me/issues",
    driver,
    ah((req, res) => {
      const user = getCurrentUser(req);
      if (!user) return res.status(401).json({ message: "Authentication required" });
      const body = createIssueSchema.parse(req.body);

      // If issue references a load, verify ownership (same 404 rule).
      if (body.loadId) {
        const owner = storage.getLoadDriverId(body.loadId);
        if (!owner || owner !== user.id) {
          return res.status(404).json({ message: "Load not found" });
        }
      }

      // Routing: dispatcher first, admin fallback.
      let assigneeRole: "dispatcher" | "admin" = "admin";
      let dispatcherUserId: string | null = null;
      let routedTo: "dispatcher" | "admin_fallback" = "admin_fallback";
      if (user.linkedClientId) {
        const active = storage.getActiveDispatcherForClient(user.linkedClientId);
        if (active) {
          assigneeRole = "dispatcher";
          dispatcherUserId = active.dispatcherUserId;
          routedTo = "dispatcher";
        }
      }

      const task = storage.createApprovalTask({
        taskType: "driver_issue",
        assigneeRole,
        payload: {
          severity: body.severity,
          title: body.title,
          description: body.description ?? null,
          loadId: body.loadId ?? null,
          reporterUserId: user.id,
          dispatcherUserId,
          routedTo,
        },
        createdByUserId: user.id,
      });

      storage.audit("driver.issue_reported", "approval_task", task.id, {
        userId: user.id,
        actorUserId: user.id,
        severity: body.severity,
        title: body.title,
        loadId: body.loadId ?? null,
        routedTo,
        dispatcherUserId,
      });

      return res.status(201).json(task);
    }),
  );

  // ===========================================================================
  // Owner-operator self-dispatch: POST /api/me/loads
  // ===========================================================================
  //
  // Allows a driver with persona=owner_operator to create loads for their own
  // company without going through an admin or dispatcher. The server:
  //   1. Verifies caller is a driver with linkedClientId.
  //   2. Verifies the linked client has persona=owner_operator.
  //   3. Creates the load with clientId=linkedClientId, driverId=user.id.
  //
  // Security: we NEVER trust the body for clientId or driverId — both are
  // derived from the session user, ensuring tenant isolation.
  // ===========================================================================

  const selfDispatchLoadSchema = z.object({
    originCity: z.string().min(1),
    originState: z.string().min(2).max(2),
    destinationCity: z.string().min(1),
    destinationState: z.string().min(2).max(2),
    rate: z.number().positive(),
    pickupAt: z.string(),
    deliveryAt: z.string(),
    equipment: equipmentSchema,
    brokerName: z.string().default("Self-dispatch"),
    brokerMc: z.string().default(""),
    notes: z.string().optional(),
  });

  app.post(
    "/api/me/loads",
    driver,
    ah(async (req, res) => {
      const user = getCurrentUser(req);
      if (!user) return res.status(401).json({ message: "Authentication required" });

      if (!user.linkedClientId) {
        return res.status(403).json({
          message: "Self-dispatch requires a linked carrier company. Contact your admin.",
        });
      }

      const client = storage.getClient(user.linkedClientId);
      if (!client) {
        return res.status(403).json({ message: "Linked client not found." });
      }

      if ((client as any).persona !== "owner_operator") {
        return res.status(403).json({
          message: "Self-dispatch is only available for owner-operator accounts.",
        });
      }

      const body = selfDispatchLoadSchema.parse(req.body);

      // Build a full InsertLoad. brokerScore/fraudRisk will be filled by
      // enrichLoadSync; loadedMiles is approximated as 0 (planner phase later).
      const rawLoad = {
        source: "self_dispatch",
        originCity: body.originCity,
        originState: body.originState,
        originLat: 0,
        originLng: 0,
        destinationCity: body.destinationCity,
        destinationState: body.destinationState,
        destinationLat: 0,
        destinationLng: 0,
        rate: body.rate,
        loadedMiles: 0,
        pickupAt: body.pickupAt,
        deliveryAt: body.deliveryAt,
        equipment: body.equipment,
        brokerName: body.brokerName,
        brokerMc: body.brokerMc,
        brokerScore: 100,
        fraudRisk: 0,
        marketQuality: 100,
        notes: body.notes,
        // Server-injected tenant fields — never from body
        clientId: user.linkedClientId,
        driverId: user.id,
        bookedAt: new Date().toISOString(),
      };

      const enriched = enrichLoadSync(rawLoad);
      const load = storage.upsertLoad(enriched as any);

      storage.audit("driver.self_dispatch_load_created", "load", load.id, {
        actorUserId: user.id,
        clientId: user.linkedClientId,
        driverId: user.id,
      });

      return res.status(201).json(load);
    }),
  );
}
