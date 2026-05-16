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
  createAssignmentSchema,
  createInviteSchema,
  createUserSchema,
  dateOnlySchema,
  generateInvoiceSchema,
  invoiceStatusSchema,
  updateUserSchema,
  userRoleSchema,
  type UserPublic,
} from "@shared/schema";
import {
  buildOtpAuthUrl,
  generateBase32Secret,
  getCurrentUser,
  hashPassword,
  requireRole,
} from "../auth";
import { storage } from "../storage";
import { computeInvoiceForWeek } from "../lib/billing";

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
 * Generate a one-time temporary password for admin reset-password flow.
 * Spec §1.5: default length 16, range 12–32. CSPRNG source, base64url
 * alphabet trimmed to a configurable size (no padding, no = signs).
 *
 * Slicing `randomBytes(N).toString("base64url")` to N gives us roughly
 * `log2(64) * N = 6N` bits of entropy and a guaranteed N-char string.
 */
function generateTemporaryPassword(length = 16): string {
  if (length < 12 || length > 32) {
    throw new Error("Temp password length must be between 12 and 32");
  }
  return crypto.randomBytes(length).toString("base64url").slice(0, length);
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

  // =========================================================================
  // Phase 3 P1 — reset password / reset TOTP / revoke invite / assignments
  // =========================================================================

  // -------------------------------------------------------------------------
  // POST /api/admin/users/:id/reset-password
  // -------------------------------------------------------------------------
  //
  // Spec §1.5. Generates a one-time temp password, writes the new hash to
  // the users table, returns the plaintext temp password to the admin
  // *once* in the HTTP response body.
  //
  // The temp password is NEVER written to the audit log. The audit event
  // carries only the actor + target IDs and the explicit
  // `invalidated_sessions: false` flag so future log readers can see that
  // pre-existing sessions remained valid.
  //
  // UX decision (locked in for P1): pre-existing sessions are NOT
  // invalidated. A dispatcher who is mid-task does not get kicked when an
  // admin resets their password — they keep working until natural session
  // expiry (12h). The new password takes effect on next login. See spec
  // §1.5 "Phase 3 can NOT invalidate sessions" + Phase 5 TODO below.
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/users/:id/reset-password",
    admin,
    ah((req, res) => {
      const actor = getCurrentUser(req);
      if (!actor) return res.status(401).json({ message: "Authentication required" });

      // Body is optional: `{}` or `{ length: 16 }`. Validate inline rather
      // than pulling a one-off Zod schema into shared/schema.ts.
      const body = (req.body ?? {}) as { length?: unknown };
      let length = 16;
      if (body.length !== undefined) {
        const n = Number(body.length);
        if (!Number.isInteger(n) || n < 12 || n > 32) {
          return res.status(400).json({
            message: "Validation failed",
            issues: [{ path: ["length"], message: "length must be an integer between 12 and 32" }],
          });
        }
        length = n;
      }

      const target = storage.getUserById(String(req.params.id));
      if (!target) return res.status(404).json({ message: "User not found" });

      const temporaryPassword = generateTemporaryPassword(length);
      const { salt, hash } = hashPassword(temporaryPassword);
      const updated = storage.updateUser(
        target.id,
        { passwordSalt: salt, passwordHash: hash },
        actor.id,
      );
      if (!updated) return res.status(404).json({ message: "User not found" });

      // TODO(phase5): invalidate active sessions on password reset.
      // For now we record the current behaviour explicitly in the audit
      // event so it's auditable from the log without code archaeology.
      storage.audit("user.password_reset", "user", target.id, {
        targetUserId: target.id,
        resetByAdminId: actor.id,
        invalidated_sessions: false,
        // temporaryPassword intentionally omitted — never log credentials.
      });

      return res.json({
        temporaryPassword,
        userId: target.id,
        email: target.email,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/users/:id/reset-totp
  // -------------------------------------------------------------------------
  //
  // Spec §1.6. Two modes selected via `{ disable: boolean }`:
  //   disable=false (default) — generate a new TOTP secret + otpauthUrl,
  //                              return them to the admin once for handoff
  //   disable=true            — clear the TOTP secret entirely
  //
  // Response shape is discriminated by the presence of `totpDisabled`,
  // matching the frontend's `ResetTotpResponse` union in
  // client/src/pages/admin/users.tsx. NEVER include the secret in audit
  // payloads — only the binary fact (reset vs disabled).
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/users/:id/reset-totp",
    admin,
    ah((req, res) => {
      const actor = getCurrentUser(req);
      if (!actor) return res.status(401).json({ message: "Authentication required" });

      const body = (req.body ?? {}) as { disable?: unknown };
      let disable = false;
      if (body.disable !== undefined) {
        if (typeof body.disable !== "boolean") {
          return res.status(400).json({
            message: "Validation failed",
            issues: [{ path: ["disable"], message: "disable must be a boolean" }],
          });
        }
        disable = body.disable;
      }

      const target = storage.getUserById(String(req.params.id));
      if (!target) return res.status(404).json({ message: "User not found" });

      if (disable) {
        const updated = storage.updateUser(target.id, { totpSecret: null }, actor.id);
        if (!updated) return res.status(404).json({ message: "User not found" });
        storage.audit("user.totp_disabled", "user", target.id, {
          targetUserId: target.id,
          resetByAdminId: actor.id,
        });
        return res.json({ userId: target.id, totpDisabled: true });
      }

      const newSecret = generateBase32Secret();
      const updated = storage.updateUser(target.id, { totpSecret: newSecret }, actor.id);
      if (!updated) return res.status(404).json({ message: "User not found" });
      storage.audit("user.totp_reset", "user", target.id, {
        targetUserId: target.id,
        resetByAdminId: actor.id,
        // secret intentionally omitted.
      });
      return res.json({
        userId: target.id,
        totpSecret: newSecret,
        otpauthUrl: buildOtpAuthUrl(target.email, newSecret),
      });
    }),
  );

  // -------------------------------------------------------------------------
  // DELETE /api/admin/invites/:code — soft-revoke
  // -------------------------------------------------------------------------
  //
  // Spec §2.3. Sets `expiresAt = now()`, which moves the invite into the
  // "expired" filter bucket on GET /api/admin/invites. The actual code row
  // stays in the table for audit-trail visibility.
  //
  // Already-consumed invites cannot be revoked — they have a corresponding
  // user record and are immutable from this endpoint (use the user CRUD
  // endpoints to act on the resulting account).
  // -------------------------------------------------------------------------
  app.delete(
    "/api/admin/invites/:code",
    admin,
    ah((req, res) => {
      const actor = getCurrentUser(req);
      if (!actor) return res.status(401).json({ message: "Authentication required" });

      const result = storage.revokeInvite(String(req.params.code), actor.id);
      if ("notFound" in result) {
        return res.status(404).json({ message: "Invite not found" });
      }
      if ("alreadyConsumed" in result) {
        return res.status(409).json({ message: "Invite already consumed" });
      }
      return res.json({ code: result.invite.code, revokedAt: result.revokedAt });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/assignments
  // -------------------------------------------------------------------------
  //
  // Spec §3.1. Default `includeRemoved=false`; pass `?includeRemoved=true`
  // to see the soft-delete history (used for audit-trail screens and the
  // upcoming Phase 5 reports — by design, not a leak).
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/assignments",
    admin,
    ah((req, res) => {
      const limitRaw = req.query.limit;
      const limit = limitRaw === undefined ? undefined : Number(limitRaw);
      if (limit !== undefined && (!Number.isFinite(limit) || limit < 1 || limit > 200)) {
        return res.status(400).json({ message: "limit must be an integer between 1 and 200" });
      }
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
      const dispatcherId =
        typeof req.query.dispatcherId === "string" ? req.query.dispatcherId : undefined;
      const clientId =
        typeof req.query.clientId === "string" ? req.query.clientId : undefined;

      let includeRemoved = false;
      if (typeof req.query.includeRemoved === "string") {
        if (req.query.includeRemoved === "true") includeRemoved = true;
        else if (req.query.includeRemoved === "false") includeRemoved = false;
        else {
          return res
            .status(400)
            .json({ message: "includeRemoved must be 'true' or 'false'" });
        }
      }

      const page = storage.listAssignmentsPaginated({
        limit,
        cursor,
        dispatcherId,
        clientId,
        includeRemoved,
      });
      return res.json({
        items: page.items.map((a) => ({
          id: a.id,
          clientId: a.clientId,
          dispatcherUserId: a.dispatcherUserId,
          createdAt: a.createdAt,
          createdByUserId: a.createdByUserId,
          removedAt: a.removedAt ?? null,
          removedByUserId: a.removedByUserId ?? null,
        })),
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
        total: page.total,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/assignments
  // -------------------------------------------------------------------------
  //
  // Spec §3.2. Many-to-many: a client can have multiple active dispatcher
  // assignments (24h rotation). The duplicate guard is scoped to "active"
  // rows only — admins can re-assign a previously removed pair, and that
  // creates a fresh assignment with a new id.
  //
  // Duplicate response carries `code: "duplicate_active"` so the frontend
  // can react beyond just showing the message string (see
  // client/src/pages/admin/assignments.tsx).
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/assignments",
    admin,
    ah((req, res) => {
      const body = createAssignmentSchema.parse(req.body);
      const actor = getCurrentUser(req);
      if (!actor) return res.status(401).json({ message: "Authentication required" });

      const client = storage.getClient(body.clientId);
      if (!client) return res.status(404).json({ message: "Client not found" });

      const dispatcher = storage.getUserById(body.dispatcherUserId);
      if (!dispatcher) return res.status(404).json({ message: "Dispatcher not found" });
      if (dispatcher.role !== "dispatcher") {
        return res.status(400).json({ message: "User is not a dispatcher" });
      }

      const existingActive = storage.findActiveAssignment(body.clientId, body.dispatcherUserId);
      if (existingActive) {
        return res
          .status(409)
          .json({ message: "Assignment already exists", code: "duplicate_active" });
      }

      const created = storage.createAssignment({
        clientId: body.clientId,
        dispatcherUserId: body.dispatcherUserId,
        createdByUserId: actor.id,
      });
      // storage.createAssignment already emits a generic "assignment.created"
      // audit; we add an extra context payload for admin filtering.
      storage.audit("assignment.created.admin", "assignment", created.id, {
        assignmentId: created.id,
        clientId: created.clientId,
        dispatcherUserId: created.dispatcherUserId,
        createdByAdminId: actor.id,
      });
      return res.status(201).json({
        id: created.id,
        clientId: created.clientId,
        dispatcherUserId: created.dispatcherUserId,
        createdAt: created.createdAt,
        createdByUserId: created.createdByUserId,
        removedAt: null,
        removedByUserId: null,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // DELETE /api/admin/assignments/:id — soft-delete
  // -------------------------------------------------------------------------
  //
  // Spec §3.3. Sets `removedAt` + `removedByUserId`. The row stays in the
  // table; it remains queryable via GET /api/admin/assignments?includeRemoved=true
  // for audit-trail purposes. Re-creating the same (client, dispatcher) pair
  // afterwards is allowed and produces a fresh row with a new id.
  // -------------------------------------------------------------------------
  app.delete(
    "/api/admin/assignments/:id",
    admin,
    ah((req, res) => {
      const actor = getCurrentUser(req);
      if (!actor) return res.status(401).json({ message: "Authentication required" });

      const result = storage.removeAssignmentById(String(req.params.id), actor.id);
      if ("notFound" in result) {
        return res.status(404).json({ message: "Assignment not found" });
      }
      if ("alreadyRemoved" in result) {
        return res.status(409).json({ message: "Assignment already removed" });
      }
      const a = result.assignment;
      return res.json({
        id: a.id,
        clientId: a.clientId,
        dispatcherUserId: a.dispatcherUserId,
        createdAt: a.createdAt,
        createdByUserId: a.createdByUserId,
        removedAt: a.removedAt ?? null,
        removedByUserId: a.removedByUserId ?? null,
      });
    }),
  );

  // =========================================================================
  // Phase 3 P2 — billing (preview, generate, list, patch)
  // =========================================================================

  // -------------------------------------------------------------------------
  // POST /api/admin/billing/preview
  // -------------------------------------------------------------------------
  //
  // Spec §4.1. Computes the invoice using the shared billing.ts module but
  // does NOT persist. Response includes a `breakdown.loads` array of each
  // contributing load — the UI renders this as a table so the admin can sanity-
  // check what's being charged for.
  //
  // weekStart/weekEnd are required date-only strings (YYYY-MM-DD). Inclusive
  // on both ends. Anything timezone-related is intentionally out of scope —
  // see the rationale in shared/schema.ts above `dateOnlySchema`.
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/billing/preview",
    admin,
    ah((req, res) => {
      const body = generateInvoiceSchema.parse(req.body);

      // Stricter validation: date format + ordering. Zod's generateInvoiceSchema
      // only requires non-empty strings; bill math relies on dates being
      // sortable lexicographically, which only works for the YYYY-MM-DD shape.
      const wsCheck = dateOnlySchema.safeParse(body.weekStart);
      const weCheck = dateOnlySchema.safeParse(body.weekEnd);
      if (!wsCheck.success || !weCheck.success) {
        return res.status(400).json({
          message: "weekStart and weekEnd must be YYYY-MM-DD date strings",
        });
      }
      if (body.weekStart > body.weekEnd) {
        return res.status(400).json({ message: "weekStart must be <= weekEnd" });
      }

      const client = storage.getClient(body.clientId);
      if (!client) return res.status(404).json({ message: "Client not found" });

      const calc = computeInvoiceForWeek(body.clientId, body.weekStart, body.weekEnd);

      // Shape matches invoicePreviewSchema in shared/schema.ts: id/status/
      // generatedAt explicitly null so the frontend's discriminated union
      // narrows correctly.
      return res.json({
        id: null,
        clientId: calc.clientId,
        weekStart: calc.weekStart,
        weekEnd: calc.weekEnd,
        flatFee: calc.flatFee,
        percentFee: calc.percentFee,
        grossBooked: calc.grossBooked,
        totalDue: calc.totalDue,
        status: null,
        generatedAt: null,
        breakdown: calc.breakdown,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/billing/generate
  // -------------------------------------------------------------------------
  //
  // Spec §4.2. Same math as preview, plus storage.createInvoice. Enforces
  // the "one invoice per client per week" invariant — if an invoice already
  // exists with the same (clientId, weekStart) pair, returns 409 with the
  // existing invoice id so the admin can fetch or PATCH it instead.
  //
  // Optional `status: "draft" | "sent"` (default "draft"). When "sent" is
  // requested, storage.createInvoice also stamps sent_at to keep the
  // status timeline consistent without a follow-up PATCH.
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/billing/generate",
    admin,
    ah((req, res) => {
      const body = generateInvoiceSchema.parse(req.body);
      const actor = getCurrentUser(req);
      if (!actor) return res.status(401).json({ message: "Authentication required" });

      const wsCheck = dateOnlySchema.safeParse(body.weekStart);
      const weCheck = dateOnlySchema.safeParse(body.weekEnd);
      if (!wsCheck.success || !weCheck.success) {
        return res.status(400).json({
          message: "weekStart and weekEnd must be YYYY-MM-DD date strings",
        });
      }
      if (body.weekStart > body.weekEnd) {
        return res.status(400).json({ message: "weekStart must be <= weekEnd" });
      }

      const client = storage.getClient(body.clientId);
      if (!client) return res.status(404).json({ message: "Client not found" });

      const dup = storage.findInvoiceForWeek(body.clientId, body.weekStart);
      if (dup) {
        return res.status(409).json({
          message: "Invoice for this client and week already exists",
          existingInvoiceId: dup.id,
        });
      }

      const calc = computeInvoiceForWeek(body.clientId, body.weekStart, body.weekEnd);
      const invoice = storage.createInvoice({
        clientId: calc.clientId,
        weekStart: calc.weekStart,
        weekEnd: calc.weekEnd,
        flatFee: calc.flatFee,
        percentFee: calc.percentFee,
        grossBooked: calc.grossBooked,
        status: body.status,
      });
      // storage.createInvoice already emits `invoice.created` audit; we add
      // an admin-context event with the actor for traceability.
      storage.audit("invoice.created.admin", "invoice", invoice.id, {
        invoiceId: invoice.id,
        clientId: invoice.clientId,
        weekStart: invoice.weekStart,
        weekEnd: invoice.weekEnd,
        totalDue: invoice.totalDue,
        createdByAdminId: actor.id,
      });
      return res.status(201).json(invoice);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/billing/invoices
  // -------------------------------------------------------------------------
  //
  // Spec §4.3. Cursor pagination over generated_at DESC. Filters: clientId,
  // status (draft|sent|paid|void), weekStart (>=), weekEnd (<=).
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/billing/invoices",
    admin,
    ah((req, res) => {
      const limitRaw = req.query.limit;
      const limit = limitRaw === undefined ? undefined : Number(limitRaw);
      if (limit !== undefined && (!Number.isFinite(limit) || limit < 1 || limit > 200)) {
        return res.status(400).json({ message: "limit must be an integer between 1 and 200" });
      }
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
      const clientId =
        typeof req.query.clientId === "string" ? req.query.clientId : undefined;

      let status: "draft" | "sent" | "paid" | "void" | undefined;
      if (typeof req.query.status === "string") {
        const parsed = invoiceStatusSchema.safeParse(req.query.status);
        if (!parsed.success) {
          return res.status(400).json({
            message: "status must be one of draft|sent|paid|void",
          });
        }
        status = parsed.data;
      }

      const weekStart =
        typeof req.query.weekStart === "string" ? req.query.weekStart : undefined;
      const weekEnd =
        typeof req.query.weekEnd === "string" ? req.query.weekEnd : undefined;

      const page = storage.listInvoicesPaginated({
        limit,
        cursor,
        clientId,
        status,
        weekStart,
        weekEnd,
      });
      return res.json({
        items: page.items,
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
        total: page.total,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/admin/billing/invoices/:id
  // -------------------------------------------------------------------------
  //
  // Spec §4.4. Status transitions enforced in storage.updateInvoice (see
  // allowed table there). Notes can be edited independently. Forbidden
  // transitions return 409 with from/to for actionable client errors.
  //
  // NOTE: the frontend (client/src/pages/admin/billing.tsx) does not yet
  // call this endpoint as of Phase 2. We implement it per spec so that
  // future UI iterations (Phase 5 or a hotfix) can wire it without backend
  // churn.
  // -------------------------------------------------------------------------
  app.patch(
    "/api/admin/billing/invoices/:id",
    admin,
    ah((req, res) => {
      const body = (req.body ?? {}) as { status?: unknown; notes?: unknown };

      const patch: { status?: "draft" | "sent" | "paid" | "void"; notes?: string } = {};
      if (body.status !== undefined) {
        const parsed = invoiceStatusSchema.safeParse(body.status);
        if (!parsed.success) {
          return res.status(400).json({
            message: "Validation failed",
            issues: [{ path: ["status"], message: "must be one of draft|sent|paid|void" }],
          });
        }
        patch.status = parsed.data;
      }
      if (body.notes !== undefined) {
        if (typeof body.notes !== "string") {
          return res.status(400).json({
            message: "Validation failed",
            issues: [{ path: ["notes"], message: "must be a string" }],
          });
        }
        patch.notes = body.notes;
      }

      const result = storage.updateInvoice(String(req.params.id), patch);
      if ("notFound" in result) {
        return res.status(404).json({ message: "Invoice not found" });
      }
      if ("invalidTransition" in result) {
        return res.status(409).json({
          message: "Invalid status transition",
          from: result.from,
          to: result.to,
        });
      }
      return res.json(result.invoice);
    }),
  );
}
