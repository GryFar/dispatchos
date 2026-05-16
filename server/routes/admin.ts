// ===========================================================================
// server/routes/admin.ts — Phase 3 admin API
// ===========================================================================
//
// All `/api/admin/*` endpoints live here. Each handler is wrapped in
// `requireRole('admin')` individually (not via a shared `app.use`) because
// these routes must be registered BEFORE the catch-all `app.use("/api", ...)`
// in `routes.ts` — and that catch-all enforces `requireRole.any()`, which
// would still allow dispatchers and drivers through. Per-route gating is the
// safer pattern.
//
// Phase 3 priority slices:
//   P0 (this file): users CRUD, invites CRUD (create+list), signup contract.
//   P1: assignments, reset-password, reset-totp, invite revoke.
//   P2: billing.
//   P3: dashboard stats.
//   P4: audit pagination extension.
//
// Open the spec at docs/api/admin-api-spec.md before changing any contract
// here. Cookie name, /api/me shape, and /api/auth/* response shapes are
// frozen — see Phase 1 in shared/schema.ts.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import type { Express, Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import {
  createInviteSchema,
  createUserSchema,
  updateUserSchema,
  userRoleSchema,
  type UserPublic,
} from "@shared/schema";
import { getCurrentUser, requireRole } from "../auth";
import { storage } from "../storage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Zod issues → `{ path, message }[]`, matching spec §0.2. */
function zodIssues(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path,
    message: issue.message,
  }));
}

function send400Validation(res: Response, error: ZodError) {
  return res.status(400).json({ message: "Validation failed", issues: zodIssues(error) });
}

/**
 * Wraps an async route handler so any thrown error reaches Express's error
 * middleware (which returns 500 with `{ message }`). Zod errors are mapped to
 * 400 with the spec's `{ message, issues }` shape inline.
 */
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

/** Compute the public base URL we embed in `signupUrl`. */
function publicBaseUrl(req: Request): string {
  const envUrl = (process.env.DISPATCHOS_PUBLIC_URL || "").trim();
  if (envUrl) return envUrl.replace(/\/+$/, "");
  // Fallback — Express respects `trust proxy` for protocol when configured
  // (see server/index.ts in VDS mode).
  const host = req.get("host") || "localhost:5000";
  const proto = req.protocol || "http";
  return `${proto}://${host}`;
}

/**
 * Build the signup URL we hand to the admin. Frontend uses wouter's hash
 * router (see client/src/App.tsx → `useHashLocation`), so the path lives
 * after `#/`. The `?code=` query is read by client/src/pages/signup.tsx.
 */
function buildSignupUrl(req: Request, code: string): string {
  return `${publicBaseUrl(req)}/#/signup?code=${encodeURIComponent(code)}`;
}

/**
 * Invite code alphabet: A–Z + 2–9, with I, O, L, U, 0, 1 removed. The result
 * is unambiguous when read aloud on a phone call or copied from a screenshot.
 * (Spec §2.1 mandates the `DOS-XXXX-XXXX-XXXX` shape and a CSPRNG source.)
 *
 * Three blocks × 4 chars × log2(30) ≈ 58.9 bits of entropy. Plenty for a
 * 72-hour one-time code given that consume requires the matching email when
 * email-locked, and admins rate-limit creation.
 */
const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // 30 chars: A–Z minus IOLU, 2–9 minus 01
function inviteBlock(): string {
  const bytes = crypto.randomBytes(4);
  let out = "";
  for (let i = 0; i < 4; i += 1) {
    out += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
  }
  return out;
}
function generateInviteCode(): string {
  return `DOS-${inviteBlock()}-${inviteBlock()}-${inviteBlock()}`;
}

/**
 * Stub password for the `POST /api/admin/users` flow. We intentionally write
 * a random salt and a random hash that is *not* the hash of any string — so
 * `verifyPassword` will always fail until an admin runs reset-password (P1)
 * or a separate signup-by-invite path replaces this user. Recorded in the
 * audit trail so we can later detect a "never-logged-in" stub.
 *
 * NOTE: spec §1.2 says "creates a user WITHOUT a password". The DB schema's
 * `NOT NULL` constraints on password_salt/password_hash force us to put
 * *something* there; we put a sentinel that cannot match a real input.
 */
function makeSentinelPasswordPair() {
  const salt = `unset-${crypto.randomBytes(8).toString("hex")}`;
  const hash = `unset-${crypto.randomBytes(16).toString("hex")}`;
  return { salt, hash };
}

/**
 * Admin "last admin" protection — block role-change-away-from-admin and
 * block toggling `blocked=true` on the last active admin. Returns an error
 * string if the operation would break the invariant, else undefined.
 *
 * Invariant: at least one user with `role = 'admin' AND blocked = false`
 * must exist at all times. Matches spec §1.4 errors.
 */
function checkLastAdminProtection(opts: {
  targetUserId: string;
  currentRole: "admin" | "dispatcher" | "driver";
  currentBlocked: boolean;
  patchRole?: "admin" | "dispatcher" | "driver";
  patchBlocked?: boolean;
}): string | undefined {
  const willBeAdmin = opts.patchRole !== undefined ? opts.patchRole === "admin" : opts.currentRole === "admin";
  const willBeBlocked = opts.patchBlocked !== undefined ? opts.patchBlocked : opts.currentBlocked;
  const isStillActiveAdmin = willBeAdmin && !willBeBlocked;
  if (isStillActiveAdmin) return undefined; // nothing to check, this user remains an admin

  // The target user is leaving the "active admin" set. Make sure they aren't
  // the last one in it.
  const wasActiveAdmin = opts.currentRole === "admin" && !opts.currentBlocked;
  if (!wasActiveAdmin) return undefined;

  const activeAdmins = storage.listUsers({ role: "admin" }); // already filters blocked=0 by default
  const otherActiveAdmins = activeAdmins.filter((u) => u.id !== opts.targetUserId);
  if (otherActiveAdmins.length === 0) {
    if (opts.patchRole !== undefined && opts.patchRole !== "admin") {
      return "Cannot change role of the last admin";
    }
    if (opts.patchBlocked === true) {
      return "Cannot block the last admin";
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAdminRoutes(app: Express): void {
  const admin = requireRole("admin");

  // -------------------------------------------------------------------------
  // GET /api/admin/users
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/users",
    admin,
    ah((req, res) => {
      const limitRaw = req.query.limit;
      const limit = limitRaw === undefined ? undefined : Number(limitRaw);
      if (limit !== undefined && (!Number.isFinite(limit) || limit < 1 || limit > 200)) {
        return res.status(400).json({ message: "limit must be an integer between 1 and 200" });
      }

      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

      let role: "admin" | "dispatcher" | "driver" | undefined;
      if (typeof req.query.role === "string") {
        const parsed = userRoleSchema.safeParse(req.query.role);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ message: "role must be one of admin|dispatcher|driver" });
        }
        role = parsed.data;
      }

      let blocked: boolean | undefined;
      if (typeof req.query.blocked === "string") {
        if (req.query.blocked === "true") blocked = true;
        else if (req.query.blocked === "false") blocked = false;
        else {
          return res.status(400).json({ message: "blocked must be 'true' or 'false'" });
        }
      }

      const q = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : undefined;

      const page = storage.listUsersPaginated({ limit, cursor, role, blocked, q });
      const items: UserPublic[] = page.items.map((u) => storage.toUserPublic(u));
      return res.json({
        items,
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
        total: page.total,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/users
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/users",
    admin,
    ah((req, res) => {
      const body = createUserSchema.parse(req.body);
      const actor = getCurrentUser(req);
      if (!actor) return res.status(401).json({ message: "Authentication required" });

      if (body.linkedClientId !== undefined && body.linkedClientId !== null) {
        if (body.role !== "driver") {
          return res.status(400).json({ message: "linkedClientId is only valid for role=driver" });
        }
        if (!storage.getClient(body.linkedClientId)) {
          return res.status(400).json({ message: "linkedClientId references unknown client" });
        }
      }

      const existing = storage.getUserByEmail(body.email);
      if (existing) {
        return res.status(409).json({ message: "Email already in use" });
      }

      const { salt, hash } = makeSentinelPasswordPair();
      const created = storage.createUser({
        email: body.email,
        fullName: body.fullName,
        role: body.role,
        passwordSalt: salt,
        passwordHash: hash,
        linkedClientId: body.role === "driver" ? body.linkedClientId ?? undefined : undefined,
        actorUserId: actor.id,
      });
      // storage.createUser already emits a generic "user.created" audit; we add
      // a Phase 3-specific marker so admins can filter for stub-user creations.
      storage.audit("user.created.stub", "user", created.id, {
        email: created.email,
        role: created.role,
        createdByAdminId: actor.id,
        note: "Created without a real password; awaiting reset-password or signup-rebind.",
      });
      return res.status(201).json(storage.toUserPublic(created));
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/users/:id
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/users/:id",
    admin,
    ah((req, res) => {
      const user = storage.getUserById(String(req.params.id));
      if (!user) return res.status(404).json({ message: "User not found" });
      return res.json(storage.toUserPublic(user));
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/admin/users/:id
  // -------------------------------------------------------------------------
  app.patch(
    "/api/admin/users/:id",
    admin,
    ah((req, res) => {
      const patch = updateUserSchema.parse(req.body);
      const actor = getCurrentUser(req);
      if (!actor) return res.status(401).json({ message: "Authentication required" });

      const target = storage.getUserById(String(req.params.id));
      if (!target) return res.status(404).json({ message: "User not found" });

      // "Cannot block yourself" — admin-fat-finger guard (spec §1.4).
      if (patch.blocked === true && target.id === actor.id) {
        return res.status(400).json({ message: "Cannot block yourself" });
      }

      // linkedClientId is only meaningful for drivers.
      const effectiveRole = patch.role ?? target.role;
      if (patch.linkedClientId !== undefined && patch.linkedClientId !== null) {
        if (effectiveRole !== "driver") {
          return res.status(400).json({ message: "linkedClientId is only valid for role=driver" });
        }
        if (!storage.getClient(patch.linkedClientId)) {
          return res.status(400).json({ message: "linkedClientId references unknown client" });
        }
      }

      // Last-active-admin protection.
      const guardError = checkLastAdminProtection({
        targetUserId: target.id,
        currentRole: target.role,
        currentBlocked: target.blocked,
        patchRole: patch.role,
        patchBlocked: patch.blocked,
      });
      if (guardError) return res.status(400).json({ message: guardError });

      // If role is changing away from "driver", drop linkedClientId so we
      // don't leave a stale pointer in the row.
      const dropLinkedClient = patch.role !== undefined && patch.role !== "driver";

      const updated = storage.updateUser(
        target.id,
        {
          fullName: patch.fullName,
          role: patch.role,
          blocked: patch.blocked,
          linkedClientId: dropLinkedClient ? null : patch.linkedClientId,
        },
        actor.id,
      );
      if (!updated) return res.status(404).json({ message: "User not found" });
      return res.json(storage.toUserPublic(updated));
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/invites
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/invites",
    admin,
    ah((req, res) => {
      const body = createInviteSchema.parse(req.body);
      const actor = getCurrentUser(req);
      if (!actor) return res.status(401).json({ message: "Authentication required" });

      // role=admin invites are not allowed via this path; admins must be
      // created directly through POST /api/admin/users with role=admin.
      if (body.role === "admin") {
        return res
          .status(400)
          .json({ message: "role=admin invites are not allowed; create admins directly" });
      }

      if (body.linkedClientId !== undefined) {
        if (body.role !== "driver") {
          return res.status(400).json({ message: "linkedClientId is only valid for role=driver" });
        }
        if (!storage.getClient(body.linkedClientId)) {
          return res.status(400).json({ message: "linkedClientId references unknown client" });
        }
      }

      // Generate a code, retrying on the astronomically unlikely collision.
      // Three retries is plenty given ~59 bits of entropy.
      let code = generateInviteCode();
      for (let attempt = 0; attempt < 3 && storage.getInvite(code); attempt += 1) {
        code = generateInviteCode();
      }
      if (storage.getInvite(code)) {
        return res.status(500).json({ message: "Failed to allocate a unique invite code" });
      }

      const invite = storage.createInviteWithCode({
        code,
        role: body.role,
        email: body.email,
        ttlHours: body.ttlHours,
        linkedClientId: body.linkedClientId,
        createdByUserId: actor.id,
      });

      return res.status(201).json({
        code: invite.code,
        role: invite.role,
        email: invite.email ?? null,
        expiresAt: invite.expiresAt,
        linkedClientId: invite.linkedClientId ?? null,
        createdAt: invite.createdAt,
        signupUrl: buildSignupUrl(req, invite.code),
      });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/invites
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/invites",
    admin,
    ah((req, res) => {
      const limitRaw = req.query.limit;
      const limit = limitRaw === undefined ? undefined : Number(limitRaw);
      if (limit !== undefined && (!Number.isFinite(limit) || limit < 1 || limit > 200)) {
        return res.status(400).json({ message: "limit must be an integer between 1 and 200" });
      }

      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

      const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
      let status: "active" | "expired" | "consumed" | "all" | undefined;
      if (statusRaw !== undefined) {
        if (!["active", "expired", "consumed", "all"].includes(statusRaw)) {
          return res
            .status(400)
            .json({ message: "status must be one of active|expired|consumed|all" });
        }
        status = statusRaw as typeof status;
      }

      let role: "admin" | "dispatcher" | "driver" | undefined;
      if (typeof req.query.role === "string") {
        const parsed = userRoleSchema.safeParse(req.query.role);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ message: "role must be one of admin|dispatcher|driver" });
        }
        role = parsed.data;
      }

      const page = storage.listInvitesPaginated({ limit, cursor, status, role });
      return res.json({
        items: page.items.map((invite) => ({
          code: invite.code,
          role: invite.role,
          email: invite.email ?? null,
          expiresAt: invite.expiresAt,
          consumedAt: invite.consumedAt ?? null,
          consumedByUserId: invite.consumedByUserId ?? null,
          createdAt: invite.createdAt,
          createdByUserId: invite.createdByUserId,
          linkedClientId: invite.linkedClientId ?? null,
        })),
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
        total: page.total,
      });
    }),
  );
}
