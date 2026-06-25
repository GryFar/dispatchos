// ===========================================================================
// server/routes/dispatch.ts — Phase 4 dispatcher portal API (P0)
// ===========================================================================
//
// All `/api/dispatch/*` endpoints. Each handler is wrapped in
// `requireRole('dispatcher')` so they're registered BEFORE the catch-all
// `app.use("/api", requireRole.any())` gate in routes.ts. Same pattern as
// registerAdminRoutes / registerMeRoutes.
//
// **Tenant-scoping rule** (mirrors driver portal §0.10):
// Every read MUST be filtered through the dispatcher's active assignments
// (assignments table, removed_at IS NULL). Cross-tenant attempts return 404,
// never 403 — same anti-enumeration policy as /api/me/loads/:id.
//
// Why dispatcher (not admin) — admins use /api/admin/* with full visibility.
// Dispatchers see only their assigned clients and the loads/issues attached
// to those clients. Admin hitting /api/dispatch/* → 403 (clean separation,
// per Phase 4 P0 spec).
// ---------------------------------------------------------------------------

import type { Express, Request, Response, NextFunction } from "express";
import { ZodError, z } from "zod";
import {
  dispatchLoadsListFiltersSchema,
  dispatchDriverSchema,
  resolveApprovalTaskSchema,
  type DispatchDashboard,
  type LoadFull,
  loadFullSchema,
} from "@shared/schema";
import { getCurrentUser, requireRole, billingBlockReason } from "../auth";
import { storage } from "../storage";
import { parseLimit } from "../lib/query";
// Nominal car-hauler slot counts per equipment type. NOT live capacity —
// "used" is derived from active loads. Tune these to your real fleet.
const NOMINAL_CAPACITY_BY_EQUIPMENT: Record<string, number> = {
  enclosed_car_hauler: 6,
  open_car_hauler: 9,
  hotshot_flatbed: 3,
  sprinter_van: 2,
};

// Phase 7 presence window — driver is "online" if seen within 2 minutes.
const ONLINE_WINDOW_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers (same conventions as admin.ts / me.ts)
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

/** Cast a raw Load (Phase 1 narrow) through loadFullSchema for response shape. */
function toLoadFull(load: unknown): LoadFull {
  return loadFullSchema.parse(load);
}

/** Like toLoadFull but never throws: returns null if the row fails schema
 *  validation. Used by list/peek endpoints so one malformed legacy load
 *  doesn't 400 the entire response (e.g. the dashboard peek). The detail
 *  endpoint keeps strict toLoadFull — there a bad load SHOULD surface. */
function toLoadFullSafe(load: unknown): LoadFull | null {
  const parsed = loadFullSchema.safeParse(load);
  return parsed.success ? parsed.data : null;
}

/**
 * Phase 6: enrich a Load (or list of Loads) with denormalized human-readable
 * names so the dispatcher UI doesn't render raw IDs. We pull clientName and
 * driverName from already-loaded maps to keep this O(1) per load.
 *
 * Single endpoint use: build the maps once with buildNameMaps(...) then call
 * enrichLoadWithNames per row. Both maps fall back to `undefined` if not
 * found — frontend renders the raw ID as fallback.
 */
function buildNameMaps(loads: Array<{ clientId?: string; driverId?: string | null }>) {
  const clientIds = Array.from(
    new Set(loads.map((l) => l.clientId).filter((id): id is string => Boolean(id))),
  );
  const driverIds = Array.from(
    new Set(loads.map((l) => l.driverId).filter((id): id is string => Boolean(id))),
  );
  // Targeted name lookup for just these ids instead of scanning the entire
  // clients table on every board render. getClientNamesByIds already honors
  // the soft-delete filter listClients() applied, and returns {} for [].
  const clientNames = new Map<string, string>(
    Object.entries(storage.getClientNamesByIds(clientIds)),
  );
  const driverNames = new Map<string, string>();
  for (const driverId of driverIds) {
    const u = storage.getUserById(driverId);
    if (u) driverNames.set(driverId, u.fullName);
  }
  return { clientNames, driverNames };
}

function enrichLoadWithNames<T extends { clientId?: string; driverId?: string | null }>(
  load: T,
  maps: { clientNames: Map<string, string>; driverNames: Map<string, string> },
) {
  return {
    ...load,
    clientName: load.clientId ? maps.clientNames.get(load.clientId) ?? null : null,
    driverName: load.driverId ? maps.driverNames.get(load.driverId) ?? null : null,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerDispatchRoutes(app: Express): void {
  // -------------------------------------------------------------------------
  // GET /api/dispatch/me/dashboard — aggregate dashboard
  // -------------------------------------------------------------------------
  //
  // Returns the dispatcher's assigned clients (with active drivers/loads
  // counts), 3 stat numbers, a peek at recent open tasks, and a peek at
  // recent loads. Single round-trip — no pagination on the peeks (limited
  // to 5 each in the SQL).
  //
  app.get(
    "/api/dispatch/me/dashboard",
    requireRole("dispatcher"),
    ah((req, res) => {
      const me = getCurrentUser(req);
      if (!me) return res.status(401).json({ message: "Authentication required" });

      const assignedClients = storage.listAssignedClientsForDispatcher(me.id);
      const clientIds = assignedClients.map((c) => c.id);

      // Loads peek (5 most recent across all my clients)
      const loadsPeek = storage.listLoadsForClientIds(clientIds, { limit: 5 });

      // Open tasks for this dispatcher
      const openTasks = storage.listApprovalTasksForDispatcher(me.id, {
        status: "open",
        limit: 5,
      });

      // Active loads count is the sum of per-client activeLoadsCount we
      // already computed (avoids a second query). Same for drivers.
      const activeLoadsCount = assignedClients.reduce(
        (sum, c) => sum + c.activeLoadsCount,
        0,
      );

      const body: DispatchDashboard = {
        dispatcher: {
          id: me.id,
          fullName: me.fullName,
          email: me.email,
        },
        stats: {
          assignedClientsCount: assignedClients.length,
          activeLoadsCount,
          openTasksCount: openTasks.total,
        },
        recentOpenTasks: openTasks.items.map((t) => ({
          id: t.id,
          taskType: t.taskType,
          assigneeRole: t.assigneeRole,
          resolvedByUserId: t.resolvedByUserId,
          resolvedAt: t.resolvedAt,
          status: t.status,
          payload: t.payload,
          createdByUserId: t.createdByUserId,
          createdAt: t.createdAt,
        })),
        recentLoads: loadsPeek.items
          .map((l) => toLoadFullSafe(l))
          .filter((l): l is LoadFull => l !== null),
        assignedClients,
      };
      return res.json(body);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/dispatch/clients — my assigned clients
  // -------------------------------------------------------------------------
  app.get(
    "/api/dispatch/clients",
    requireRole("dispatcher"),
    ah((req, res) => {
      const me = getCurrentUser(req);
      if (!me) return res.status(401).json({ message: "Authentication required" });
      const items = storage.listAssignedClientsForDispatcher(me.id);
      return res.json({ items });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/dispatch/loads — loads belonging to my assigned clients
  // -------------------------------------------------------------------------
  //
  // Optional filters: clientId (must be one of mine — otherwise 403-ish empty),
  // status (available | booked | all), limit + cursor.
  //
  app.get(
    "/api/dispatch/loads",
    requireRole("dispatcher"),
    ah((req, res) => {
      const me = getCurrentUser(req);
      if (!me) return res.status(401).json({ message: "Authentication required" });
      const filters = dispatchLoadsListFiltersSchema.parse({
        clientId: req.query.clientId,
        status: req.query.status,
        limit: parseLimit(req.query.limit),
        cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
      });

      const assignments = storage.listAssignmentsForDispatcher(me.id);
      let clientIds = assignments.map((a) => a.clientId);

      if (filters.clientId) {
        // Narrow to the requested client — but only if it's one of mine.
        // Cross-tenant request → empty result set (no leak, no 404 reveal).
        if (!clientIds.includes(filters.clientId)) {
          return res.json({ items: [], nextCursor: null, hasMore: false, total: 0 });
        }
        clientIds = [filters.clientId];
      }

      const out = storage.listLoadsForClientIds(clientIds, {
        limit: filters.limit,
        cursor: filters.cursor,
        status:
          filters.status === "available" || filters.status === "booked"
            ? filters.status
            : undefined,
      });

      const items = out.items.map((l) => toLoadFull(l));
      const maps = buildNameMaps(items);
      return res.json({
        items: items.map((l) => enrichLoadWithNames(l, maps)),
        nextCursor: out.nextCursor,
        hasMore: out.hasMore,
        total: out.total,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/dispatch/loads/:id — single load, scoped
  // -------------------------------------------------------------------------
  //
  // Returns 404 if the load doesn't exist OR doesn't belong to one of my
  // clients. Same anti-enumeration behaviour as driver portal.
  //
  app.get(
    "/api/dispatch/loads/:id",
    requireRole("dispatcher"),
    ah((req, res) => {
      const me = getCurrentUser(req);
      if (!me) return res.status(401).json({ message: "Authentication required" });
      const id = String(req.params.id);
      const load = storage.getLoad(id);
      if (!load) return res.status(404).json({ message: "Load not found" });
      if (!storage.loadIsVisibleToDispatcher(id, me.id)) {
        return res.status(404).json({ message: "Load not found" });
      }
      const full = toLoadFull(load);
      const maps = buildNameMaps([full]);
      return res.json(enrichLoadWithNames(full, maps));
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/dispatch/loads/:id/checkins — read-only timeline
  // -------------------------------------------------------------------------
  app.get(
    "/api/dispatch/loads/:id/checkins",
    requireRole("dispatcher"),
    ah((req, res) => {
      const me = getCurrentUser(req);
      if (!me) return res.status(401).json({ message: "Authentication required" });
      const id = String(req.params.id);
      if (!storage.loadIsVisibleToDispatcher(id, me.id)) {
        return res.status(404).json({ message: "Load not found" });
      }
      return res.json({ items: storage.listCheckinsForLoad(id) });
    }),
  );

  // -------------------------------------------------------------------------
  // Approval queue — same shape as admin queue, filtered to this dispatcher
  // -------------------------------------------------------------------------
  //
  // GET    /api/dispatch/approval-tasks         — list (filter by status)
  // GET    /api/dispatch/approval-tasks/:id     — single (with scope check)
  // PATCH  /api/dispatch/approval-tasks/:id     — resolve/dismiss
  //
  app.get(
    "/api/dispatch/approval-tasks",
    requireRole("dispatcher"),
    ah((req, res) => {
      const me = getCurrentUser(req);
      if (!me) return res.status(401).json({ message: "Authentication required" });
      const status = req.query.status as
        | "open"
        | "in_progress"
        | "resolved"
        | "dismissed"
        | "all"
        | undefined;
      const limit = parseLimit(req.query.limit);
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
      const out = storage.listApprovalTasksForDispatcher(me.id, {
        status: status === "all" || !status ? undefined : status,
        limit,
        cursor,
      });
      return res.json(out);
    }),
  );

  app.get(
    "/api/dispatch/approval-tasks/:id",
    requireRole("dispatcher"),
    ah((req, res) => {
      const me = getCurrentUser(req);
      if (!me) return res.status(401).json({ message: "Authentication required" });
      const id = String(req.params.id);
      const task = storage.getApprovalTask(id);
      if (!task) return res.status(404).json({ message: "Task not found" });
      // Tenant check: payload.dispatcherUserId must equal me.id, AND task
      // must be assigneeRole='dispatcher'. Either failure → 404 (don't leak
      // which one).
      const payloadDispatcher = (task.payload as { dispatcherUserId?: string })
        .dispatcherUserId;
      if (task.assigneeRole !== "dispatcher" || payloadDispatcher !== me.id) {
        return res.status(404).json({ message: "Task not found" });
      }
      return res.json(task);
    }),
  );

  app.patch(
    "/api/dispatch/approval-tasks/:id",
    requireRole("dispatcher"),
    ah((req, res) => {
      const me = getCurrentUser(req);
      if (!me) return res.status(401).json({ message: "Authentication required" });
      const id = String(req.params.id);
      const body = resolveApprovalTaskSchema.parse(req.body);
      const existing = storage.getApprovalTask(id);
      if (!existing) return res.status(404).json({ message: "Task not found" });
      // Tenant check (same as GET :id)
      const payloadDispatcher = (existing.payload as { dispatcherUserId?: string })
        .dispatcherUserId;
      if (existing.assigneeRole !== "dispatcher" || payloadDispatcher !== me.id) {
        return res.status(404).json({ message: "Task not found" });
      }
      if (existing.status === "resolved" || existing.status === "dismissed") {
        return res.status(409).json({
          message: "Task is already terminated",
          currentStatus: existing.status,
        });
      }
      const updated = storage.resolveApprovalTask(id, body.action, me.id, body.resolution);
      if (!updated) {
        return res.status(409).json({ message: "Task is already terminated" });
      }
      const eventType =
        body.action === "resolve"
          ? "dispatcher.approval_task_resolved"
          : "dispatcher.approval_task_dismissed";
      storage.audit(eventType, "approval_task", id, {
        actorUserId: me.id,
        taskType: updated.taskType,
        previousStatus: existing.status,
        newStatus: updated.status,
        resolution: body.resolution ?? null,
      });
      return res.json(updated);
    }),
  );
  // -------------------------------------------------------------------------
  // GET /api/dispatch/clients/:clientId/drivers — list drivers for a client
  // -------------------------------------------------------------------------
  //
  // Used by the load-detail reassign dialog. Returns drivers whose
  // linkedClientId matches the path param. Excludes blocked users.
  //
  // Tenant: the client must be one of my active assignments. Cross-tenant
  // returns 404 (anti-enumeration; same policy as /loads/:id).
  //
  app.get(
    "/api/dispatch/clients/:clientId/drivers",
    requireRole("dispatcher"),
    ah((req, res) => {
      const me = getCurrentUser(req);
      if (!me) return res.status(401).json({ message: "Authentication required" });
      const clientId = String(req.params.clientId);

      // Tenant guard
      const assignments = storage.listAssignmentsForDispatcher(me.id);
      const isAssigned = assignments.some((a) => a.clientId === clientId);
      if (!isAssigned) {
        return res.status(404).json({ message: "Client not found" });
      }

      // Resolve client equipment once → nominal capacity for all its drivers.
      // Indexed point-read instead of a full clients-table scan + JS find.
      const client = storage.getClient(clientId);
      const nominalCapacity =
        client && NOMINAL_CAPACITY_BY_EQUIPMENT[client.equipment] !== undefined
          ? NOMINAL_CAPACITY_BY_EQUIPMENT[client.equipment]
          : null;

      const nowMs = Date.now();

      // Fleet per client is small, so per-driver queries (loads + last
      // check-in) are fine here. Revisit if a client ever has many drivers.
      const items = storage
        .listUsers({ role: "driver" })
        .filter((u) => u.linkedClientId === clientId && !u.blocked)
        .map((u) => {
          // Active (booked) loads → currentLoad + count. Use the dedicated
          // helper which applies ACTIVE_LOAD_SQL (booked_at IS NOT NULL AND
          // status NOT IN completed/cancelled AND deliveredAt IS NULL) — so
          // delivered/cancelled loads with a stale booked_at are excluded and
          // there's no 200-row cap dropping older still-active loads. Rows are
          // already scoped to this driver and ordered booked_at DESC.
          const bookedLoads = storage.listActiveBookedLoadsForDriver(u.id);
          const activeLoadsCount = bookedLoads.length;
          const cur = bookedLoads[0];
          const currentLoad = cur
            ? {
                id: cur.id,
                originCity: cur.originCity,
                originState: cur.originState,
                destinationCity: cur.destinationCity,
                destinationState: cur.destinationState,
                status: "booked" as const,
              }
            : null;

          // GPS last-known cache. Require lat, lng AND a timestamp to be useful.
          const hasGps =
            typeof u.lastLat === "number" &&
            typeof u.lastLng === "number" &&
            Boolean(u.lastLocationAt);
          const location = hasGps
            ? {
                lat: u.lastLat as number,
                lng: u.lastLng as number,
                source: u.lastLocationSource ?? null,
                accuracyM:
                  typeof u.lastLocationAccuracyM === "number"
                    ? u.lastLocationAccuracyM
                    : null,
                updatedAt: u.lastLocationAt as string,
              }
            : null;

          const online = Boolean(
            u.lastSeenAt && nowMs - new Date(u.lastSeenAt).getTime() < ONLINE_WINDOW_MS,
          );

          const capacity =
            nominalCapacity !== null
              ? {
                  total: nominalCapacity,
                  used: activeLoadsCount,
                  free: Math.max(nominalCapacity - activeLoadsCount, 0),
                }
              : null;

          const lc = storage.getLatestCheckinForDriver(u.id);
          const lastCheckin = lc
            ? { kind: lc.kind, lat: lc.lat, lng: lc.lng, createdAt: lc.createdAt }
            : null;

          return dispatchDriverSchema.parse({
            id: u.id,
            fullName: u.fullName,
            email: u.email,
            phone: u.phone ?? null,
            unitNumber: u.unitNumber ?? null,
            driverStatus: u.driverStatus ?? "available",
            online,
            lastSeenAt: u.lastSeenAt ?? null,
            location,
            currentLoad,
            activeLoadsCount,
            capacity,
            lastCheckin,
          });
        });

      return res.json({ items });
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/dispatch/loads/:id — reassign driver (Phase 4 P1)
  // -------------------------------------------------------------------------
  //
  // Body: { driverId: string | null }. Set to null to unassign.
  //
  // Tenant: load must belong to one of my assigned clients (404 otherwise).
  // Validation: if driverId not null, driver must exist, have role=driver,
  // not be blocked, and have linkedClientId === load.clientId.
  //
  // Audit: load.driver_reassigned with { from, to, byDispatcherId }.
  //
  app.patch(
    "/api/dispatch/loads/:id",
    requireRole("dispatcher"),
    ah((req, res) => {
      const me = getCurrentUser(req);
      if (!me) return res.status(401).json({ message: "Authentication required" });
      const id = String(req.params.id);

      // Parse body
      const patchSchema = z.object({
        driverId: z.string().min(1).nullable(),
        // Optimistic concurrency: the driverId the client saw when it opened the
        // reassign dialog. The atomic guard rejects the write if the load moved
        // since then (double-book / lost-update). Optional for backward compat —
        // when omitted we fall back to the server's current value (no guard),
        // but the UI sends it.
        expectedDriverId: z.string().min(1).nullable().optional(),
      });
      let body: z.infer<typeof patchSchema>;
      try {
        body = patchSchema.parse(req.body);
      } catch (e) {
        if (e instanceof ZodError) return send400Validation(res, e);
        throw e;
      }

      // Tenant + existence guard
      const load = storage.getLoad(id);
      if (!load) return res.status(404).json({ message: "Load not found" });
      if (!storage.loadIsVisibleToDispatcher(id, me.id)) {
        return res.status(404).json({ message: "Load not found" });
      }

      // If assigning to a driver, validate that driver
      if (body.driverId !== null) {
        const driver = storage.getUserById(body.driverId);
        if (!driver || driver.role !== "driver") {
          return res
            .status(400)
            .json({ message: "driverId must reference an existing driver" });
        }
        if (driver.blocked) {
          return res.status(400).json({ message: "Driver is blocked" });
        }
        const loadClientId = (load as any).clientId;
        if (!loadClientId) {
          return res
            .status(400)
            .json({ message: "Load has no clientId; cannot assign a driver" });
        }
        if (driver.linkedClientId !== loadClientId) {
          return res.status(400).json({
            message: "Driver is not linked to this load's client",
          });
        }

        // Billing gate (only on the re-book/assign path — unassign stays open so
        // an expired carrier can still clear a truck). An expired/canceled/
        // past-due-beyond-grace carrier must not be able to keep booking new
        // capacity. Same terminal/grace logic as requireActiveBilling, via the
        // shared billingBlockReason helper (one source of truth).
        const loadClient = storage.getClient(loadClientId) as
          | (Record<string, unknown> & {
              billingStatus?: string;
              trialEndsAt?: string;
              pastDueSince?: string;
            })
          | undefined;
        const blockReason = billingBlockReason(loadClient);
        if (blockReason) {
          return res.status(402).json({
            message:
              "Аккаунт перевозчика в режиме только для чтения (подписка истекла, отменена или просрочена). Продлите на /admin/billing, чтобы назначать водителей.",
            code: "billing_inactive",
            billingStatus: blockReason,
          });
        }
      }

      // Anti double-book (Корень #1): ASSIGNING a driver requires the
      // optimistic-concurrency token (the driverId the client saw). Without it
      // we'd have to read the current value and compare it to itself — a no-op
      // guard that lets two concurrent assigns both win (TOCTOU → same truck
      // double-booked). So reject an assign that omits expectedDriverId. The UI
      // always sends it. Unassign (driverId=null) is idempotent, so it stays
      // optional there.
      if (body.driverId !== null && body.expectedDriverId === undefined) {
        return res.status(400).json({
          message:
            "expectedDriverId is required when assigning a driver (optimistic concurrency).",
          code: "expected_driver_id_required",
        });
      }

      // The guard compares against the driverId the client expected; for an
      // unassign with no token we fall back to the current value (single-actor
      // clear, no concurrent writer = no conflict). The storage method audits
      // on success.
      const expected =
        body.expectedDriverId !== undefined
          ? body.expectedDriverId
          : (storage.getLoadDriverId(id) ?? null);

      const result = storage.reassignLoadDriver(
        id,
        expected,
        body.driverId,
        me.id,
      );

      if (!result.ok) {
        return res.status(409).json({
          message:
            "This load was reassigned by someone else. Refresh to see the current driver.",
          code: "reassign_conflict",
          actualDriverId: result.actual,
        });
      }

      return res.json(result.load);
    }),
  );
}
