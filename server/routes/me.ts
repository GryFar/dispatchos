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
import { ZodError } from "zod";
import {
  driverStatusSchema,
  loadFullSchema,
  updateDriverProfileSchema,
  updateDriverStatusSchema,
  type DriverDashboard,
  type LoadFull,
} from "@shared/schema";
import { getCurrentUser, requireRole } from "../auth";
import { storage } from "../storage";

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
  const today = new Date().toISOString().slice(0, 10);
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
      const page = storage.listLoadsForDriver(user.id, { limit: 20 });
      const loads = page.items.map(toLoadFull);

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

      const body: DriverDashboard = {
        driver: {
          id: user.id,
          fullName: user.fullName,
          email: user.email,
          phone: user.phone,
          status: user.driverStatus ?? "available",
        },
        currentLoad,
        todayPickup,
        todayDelivery,
        recentLoads,
        // P0 stubs — wired up properly in P1 (messages thread, documents).
        hasUnreadMessages: false,
        pendingDocs: [],
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
      if (statusFilter) {
        items = items.filter((l) => deriveLoadStatus(l) === statusFilter);
      }

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
      return res.json(toLoadFull(load));
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
}
