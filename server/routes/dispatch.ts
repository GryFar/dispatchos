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
  resolveApprovalTaskSchema,
  type DispatchDashboard,
  type LoadFull,
  loadFullSchema,
} from "@shared/schema";
import { getCurrentUser, requireRole } from "../auth";
import { storage } from "../storage";

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
        recentLoads: loadsPeek.items.map((l) => toLoadFull(l)),
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
        limit: req.query.limit ? Number(req.query.limit) : undefined,
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

      return res.json({
        items: out.items.map((l) => toLoadFull(l)),
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
      return res.json(toLoadFull(load));
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
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
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

      // Filter drivers by linkedClientId, exclude blocked
      const allDrivers = storage.listUsers({ role: "driver" });
      const items = allDrivers
        .filter((u) => u.linkedClientId === clientId && !u.blocked)
        .map((u) => ({
          id: u.id,
          fullName: u.fullName,
          email: u.email,
          phone: u.phone ?? null,
          driverStatus: u.driverStatus ?? "available",
        }));

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
      }

      // Persist via upsertLoad (it mirrors driver_id column from payload).
      const previousDriverId = (load as any).driverId ?? null;
      const updated = storage.upsertLoad({
        ...load,
        driverId: body.driverId ?? undefined,
      } as any);

      // Audit
      storage.audit("load.driver_reassigned", "load", id, {
        actorUserId: me.id,
        from: previousDriverId,
        to: body.driverId,
      });

      return res.json(updated);
    }),
  );
}
