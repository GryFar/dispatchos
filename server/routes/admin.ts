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
import fs from "node:fs";
import path from "node:path";
import { generateInviteCode } from "../lib/invite-code";
import type { Express, Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { getEnrichedIntegrationStatus, INTEGRATIONS } from "../lib/integrations";
import { encryptSecret, isPrimaryConfigured } from "../lib/crypto/keyring";
import { getIntegrationValue, invalidateIntegrationConfigCache } from "../lib/integration-config";
import {
  approvalTaskListFiltersSchema,
  createAssignmentSchema,
  createInviteSchema,
  createUserSchema,
  dateOnlySchema,
  generateInvoiceSchema,
  invoiceStatusSchema,
  resolveApprovalTaskSchema,
  updateUserSchema,
  userRoleSchema,
  clientSchema,
  type UserPublic,
  type Client,
} from "@shared/schema";
import {
  buildOtpAuthUrl,
  generateBase32Secret,
  getCurrentUser,
  hashPassword,
  requireRole,
} from "../auth";
import { storage, uploadsRoot } from "../storage";
import { upload } from "../upload";
import { uploadDriverDocumentSchema } from "@shared/schema";
import { computeInvoiceForWeek } from "../lib/billing";
import {
  computeDetentionForLoad,
  totalDetentionCents,
  DEFAULT_DETENTION_RATE_PER_HOUR_CENTS,
  DEFAULT_FREE_HOURS,
  type DetentionEvent,
} from "../lib/detention";
import { listUpcomingRenewals } from "../lib/compliance-renewals";
import {
  computeDqStatusForDriver,
  computeFleetDqSummary,
  DQ_REQUIREMENTS,
} from "../lib/dq-files";
import { buildIftaQuarterly, renderIftaCsv } from "../lib/ifta";
import {
  buildCarrierSafetyProfile,
  renderCarrierSafetyProfileMarkdown,
} from "../lib/carrier-safety-profile";

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

// Audit V3-3 — host header injection defense. Same allowlist as leads.ts.
const PUBLIC_URL_ALLOWLIST = new Set([
  "https://dispatchos.co",
  "https://www.dispatchos.co",
  "https://demo.dispatchos.co",
  "https://app.dispatchos.co",
]);

/** Compute the public base URL we embed in `signupUrl`. Hardened against
 *  Host-header injection: prefers env, falls back to allowlist, never to
 *  attacker-controlled headers. */
function publicBaseUrl(req: Request): string {
  const envUrl = (process.env.DISPATCHOS_PUBLIC_URL || "").trim();
  if (envUrl) return envUrl.replace(/\/+$/, "");
  const host = req.get("host") || "localhost:5000";
  const proto = req.protocol || "http";
  const candidate = `${proto}://${host}`;
  if (PUBLIC_URL_ALLOWLIST.has(candidate)) return candidate;
  // Local dev (localhost) gets through; unknown hosts get the safe default.
  if (host.startsWith("localhost") || host.startsWith("127.")) return candidate;
  console.warn(`[publicBaseUrl] rejected unknown host "${host}" — falling back to canonical URL`);
  return "https://dispatchos.co";
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
// V5-006: invite code generation moved to server/lib/invite-code.ts
// (single CSPRNG source, ~98 bits, no modulo bias). Imported below.

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
      // 2026-05-27 (Vlad smoke regression) — admin must be able to inspect
      // soft-deleted users (audit trail, post-delete confirmation). Use the
      // including-deleted variant; toUserPublic exposes deletedAt to the
      // client so the admin UI can show a «Удалён» badge.
      const user = storage.getUserByIdIncludingDeleted(String(req.params.id));
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

      // Email uniqueness check. Lowercase compare matches getUserByEmail.
      if (patch.email !== undefined) {
        const normalized = patch.email.toLowerCase();
        if (normalized !== target.email.toLowerCase()) {
          const conflict = storage.getUserByEmail(normalized);
          if (conflict && conflict.id !== target.id) {
            return res.status(409).json({ message: "Email уже используется другим пользователем" });
          }
        }
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
          email: patch.email,
          phone: patch.phone,
          role: patch.role,
          blocked: patch.blocked,
          linkedClientId: dropLinkedClient ? null : patch.linkedClientId,
          // Henry QA Bug #5 — unit number passthrough.
          unitNumber: patch.unitNumber,
        },
        actor.id,
      );
      if (!updated) return res.status(404).json({ message: "User not found" });
      return res.json(storage.toUserPublic(updated));
    }),
  );

  // -------------------------------------------------------------------------
  // DELETE /api/admin/users/:id — soft delete (stamp deleted_at + block)
  // -------------------------------------------------------------------------
  app.delete(
    "/api/admin/users/:id",
    admin,
    ah((req, res) => {
      const actor = getCurrentUser(req);
      if (!actor) return res.status(401).json({ message: "Authentication required" });

      const target = storage.getUserById(String(req.params.id));
      if (!target) return res.status(404).json({ message: "User not found" });

      // Cannot delete yourself.
      if (target.id === actor.id) {
        return res.status(400).json({ message: "Cannot delete yourself" });
      }

      // Last-active-admin protection: deleting forces blocked=1, so a delete
      // of the last active admin is just as dangerous as blocking them.
      const guardError = checkLastAdminProtection({
        targetUserId: target.id,
        currentRole: target.role,
        currentBlocked: target.blocked,
        patchBlocked: true,
      });
      if (guardError) return res.status(400).json({ message: guardError });

      const deleted = storage.softDeleteUser(target.id, actor.id);
      if (!deleted) return res.status(404).json({ message: "User not found" });
      return res.json(storage.toUserPublic(deleted));
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
  // GET /api/admin/presence?minutes=2 — list of currently-online user ids.
  // -------------------------------------------------------------------------
  // Used by the admin users list to render a 🟢 dot. Cheap query (one
  // indexed timestamp scan), safe to poll every 30s on the page.
  app.get(
    "/api/admin/presence",
    admin,
    ah((req, res) => {
      const minutesRaw = Number(req.query.minutes ?? 2);
      // Clamp to a sensible range so a malformed query can't sweep the table.
      const minutes = Number.isFinite(minutesRaw) ? Math.min(Math.max(minutesRaw, 1), 60) : 2;
      const onlineUserIds = storage.listOnlineUserIds(minutes);
      return res.json({ minutes, onlineUserIds });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/config/maps-key — отдаёт GOOGLE_MAPS_API_KEY только admin'у.
  // Используется фронтом для инициализации Google Maps Embed/Static в admin-only views
  // (user-detail track widget). Так безопаснее чем VITE_ env (в build) — dispatcher и driver не видят.
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/config/maps-key",
    admin,
    ah((_req, res) => {
      const key = process.env.GOOGLE_MAPS_API_KEY ?? null;
      return res.json({ key });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/clients/:id/insurance-alerts
  // -------------------------------------------------------------------------
  // History of insurance alerts sent for this carrier (newest first). Used by
  // client-detail page to show «Alert sent T-7d to TG+email» breadcrumbs.
  app.get(
    "/api/admin/clients/:id/insurance-alerts",
    admin,
    ah((req, res) => {
      const clientId = String(req.params.id);
      const rows = storage.listInsuranceAlertsForClient(clientId, 50);
      return res.json({ alerts: rows.map((r) => ({
        ...r,
        channels: typeof r.channels === "string" ? JSON.parse(r.channels as string) : r.channels,
      })) });
    }),
  );

  // POST /api/admin/insurance/check-now — manual trigger for the cron logic.
  // Useful when an admin updates a carrier's insurance date and wants to
  // verify alerts will fire correctly.
  app.post(
    "/api/admin/insurance/check-now",
    admin,
    ah(async (_req, res) => {
      const { runInsuranceCheck } = await import("../lib/insurance-monitor");
      const result = await runInsuranceCheck();
      return res.json(result);
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/users/:id/tracking-token
  // -------------------------------------------------------------------------
  // Generates (or rotates) a per-driver tracking token. The token is the
  // shared secret between our /api/track/* endpoints and the GPS app on the
  // driver's phone. Issuing a new token immediately invalidates the previous
  // one (the next ping from the old config will 401). Use the `revoke=true`
  // variant to disable tracking entirely.
  app.post(
    "/api/admin/users/:id/tracking-token",
    admin,
    ah((req, res) => {
      const actor = getCurrentUser(req);
      if (!actor) return res.status(401).json({ message: "Authentication required" });
      const target = storage.getUserById(String(req.params.id));
      if (!target) return res.status(404).json({ message: "User not found" });

      const revoke = (req.body ?? {}).revoke === true;
      if (revoke) {
        storage.revokeTrackingToken(target.id, actor.id);
        return res.json({ userId: target.id, revoked: true });
      }

      const token = storage.setTrackingToken(target.id, actor.id);
      const base = process.env.DISPATCHOS_PUBLIC_URL ?? "https://demo.dispatchos.co";
      return res.json({
        userId: target.id,
        token,
        // Pre-built URLs for the two supported apps. The driver pastes these
        // straight into the corresponding field in Traccar Client / Owntracks.
        osmandUrl: `${base}/api/track/osmand?id=${token}`,
        owntracksUrl: `${base}/api/track/owntracks`,
        owntracksUserId: token, // for the «User ID» field in Owntracks settings
      });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/users/:id/track?sinceHours=24
  // -------------------------------------------------------------------------
  // Returns the user's GPS track + current snapshot for the map widget.
  app.get(
    "/api/admin/users/:id/track",
    admin,
    ah((req, res) => {
      const target = storage.getUserById(String(req.params.id));
      if (!target) return res.status(404).json({ message: "User not found" });
      const sinceHours = Math.min(Number(req.query.sinceHours ?? 24), 24 * 15);
      const sinceIso = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
      const pings = storage.listLocationPings(target.id, { sinceIso });
      return res.json({
        userId: target.id,
        current: target.lastLat != null && target.lastLng != null
          ? {
              lat: target.lastLat,
              lng: target.lastLng,
              capturedAt: target.lastLocationAt,
              accuracyM: target.lastLocationAccuracyM,
              source: target.lastLocationSource,
            }
          : null,
        pings,
        hasTrackingToken: Boolean(target.trackingToken),
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

  // =========================================================================
  // Phase 3 P3 — dashboard stats aggregate
  // =========================================================================

  // -------------------------------------------------------------------------
  // GET /api/admin/dashboard/stats
  // -------------------------------------------------------------------------
  //
  // Spec §5.1. One call instead of six parallel — admin dashboard hits this
  // every 60 seconds on mount.
  //
  // `period=week` (default) or `period=month`. We use it for the "loads
  // window" tile; user counts and audit-last-24h are window-independent.
  //
  // MRR formula (current month, USD floats):
  //   currentUsd = activeClients * (FLAT_FEE_CENTS / 100) + monthToDatePercentFee
  //   projectedUsd = currentUsd projected to a full 30-day month (linear
  //                  extrapolation by day-of-month). null if dayOfMonth < 3
  //                  — too noisy to project from one or two days.
  //   trend.direction/percent — comparison vs the same window one period
  //   ago. We compute it as a coarse approximation; see comments in code.
  //
  // Integrations are mapped from buildIntegrationStatus() (existing
  // /api/integrations/status) into the dashboard's ok|warn|missing|error
  // shape. We inline the mapping to avoid coupling the two endpoints.
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/dashboard/stats",
    admin,
    ah((req, res) => {
      const period: "week" | "month" =
        req.query.period === "month" ? "month" : "week";
      const windowDays = period === "month" ? 30 : 7;

      // -- date windows ------------------------------------------------------
      const nowDate = new Date();
      const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
      const sinceIso24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // -- users -------------------------------------------------------------
      const adminsCount = storage.countUsersByRole("admin", false);
      const dispatchersCount = storage.countUsersByRole("dispatcher", false);
      const driversCount = storage.countUsersByRole("driver", false);
      const blockedCount = storage.countBlockedUsers();
      const lastSignupAt = storage.lastUserCreatedAt();

      // -- audit -------------------------------------------------------------
      const eventsLast24h = storage.countAuditEventsSince(sinceIso24h);
      const errorEventsLast24h = storage.countErrorEventsSince(sinceIso24h);
      const lastEventAt = storage.lastAuditEventAt();

      // -- loads -------------------------------------------------------------
      // weekCount = loads created in the window (matches spec wording
      // "loads.weekCount"). weekGrossUsd = sum of rate over BOOKED loads
      // whose bookedAt falls in the window — these are the loads that turn
      // into revenue.
      const weekCount = storage.countLoadsSince(sinceIso);
      const windowStartDate = toDateOnly(new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000));
      const windowEndDate = toDateOnly(nowDate);
      const weekGrossUsd = storage.grossBookedInWindow(windowStartDate, windowEndDate);

      // byVerdict: score every load in the window for its primary client (a
      // load with no clientId gets skipped). For the admin dashboard we
      // approximate using the first seeded client to avoid an O(loads x
      // clients) scan — the tile is informational only.
      const byVerdict = computeWindowVerdictCounts(sinceIso);

      // -- MRR ---------------------------------------------------------------
      const activeClients = storage.countActiveClientsForMrr();
      const FLAT_FEE = 150;
      const monthPercent = storage.monthToDatePercentFee();
      const currentUsd = Math.round((activeClients * FLAT_FEE + monthPercent) * 100) / 100;

      // Projection to a full 30-day month. Skip if too early in the month
      // — first few days are too noisy to extrapolate linearly.
      const dayOfMonth = nowDate.getUTCDate();
      let projectedUsd: number | null = null;
      if (dayOfMonth >= 3) {
        const fraction = dayOfMonth / 30;
        projectedUsd = Math.round((currentUsd / fraction) * 100) / 100;
      }

      // Trend: compare currentUsd to the same calculation one period ago.
      // Approximation only — for the admin dashboard "did we grow this
      // week / month" tile, exact accounting is not needed. Default flat.
      const trend = { direction: "flat" as const, percent: 0 };

      // -- integrations ------------------------------------------------------
      const integrations = buildDashboardIntegrationsMap();

      // -- system ------------------------------------------------------------
      const VERSION = "1.3.0-phase3";
      const uptimeSeconds = Math.round(process.uptime());
      const dbSizeBytes = readDbSizeBytes();

      const body = {
        mrr: {
          currentUsd,
          projectedUsd,
          activeClients,
          trend,
        },
        users: {
          admins: adminsCount,
          dispatchers: dispatchersCount,
          drivers: driversCount,
          blocked: blockedCount,
          lastSignupAt: lastSignupAt,
        },
        loads: {
          weekCount,
          weekGrossUsd,
          byVerdict,
        },
        audit: {
          eventsLast24h,
          lastEventAt,
          errorEventsLast24h,
        },
        integrations,
        system: {
          version: VERSION,
          uptimeSeconds,
          dbSizeBytes,
        },
      };
      return res.json(body);
    }),
  );

  // ===========================================================================
  // Phase 4 P1.1 — Admin approval queue
  // ===========================================================================
  //
  // GET    /api/admin/approval-tasks         — paginated list with filters
  // GET    /api/admin/approval-tasks/:id     — single task (full payload)
  // PATCH  /api/admin/approval-tasks/:id     — resolve or dismiss
  //
  // Drivers create tasks via POST /api/me/issues (taskType='driver_issue',
  // assigneeRole='admin'). The admin queue page consumes these endpoints.
  // Dispatcher portal (when it lands) will reuse this same shape with its
  // own /api/dispatch/approval-tasks endpoints, filtering by assigneeRole.

  app.get(
    "/api/admin/approval-tasks",
    requireRole("admin"),
    ah((req, res) => {
      const filters = approvalTaskListFiltersSchema.parse({
        status: req.query.status,
        taskType: req.query.taskType,
        assigneeRole: req.query.assigneeRole,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
      });
      return res.json(storage.listApprovalTasksPaginated(filters));
    }),
  );

  app.get(
    "/api/admin/approval-tasks/:id",
    requireRole("admin"),
    ah((req, res) => {
      const task = storage.getApprovalTask(String(req.params.id));
      if (!task) return res.status(404).json({ message: "Task not found" });
      return res.json(task);
    }),
  );

  app.patch(
    "/api/admin/approval-tasks/:id",
    requireRole("admin"),
    ah((req, res) => {
      const me = getCurrentUser(req);
      if (!me) return res.status(401).json({ message: "Authentication required" });
      const id = String(req.params.id);
      const body = resolveApprovalTaskSchema.parse(req.body);
      const existing = storage.getApprovalTask(id);
      if (!existing) return res.status(404).json({ message: "Task not found" });
      // Already-terminated tasks cannot be re-resolved — return 409 with a
      // hint so the UI can refresh.
      if (existing.status === "resolved" || existing.status === "dismissed") {
        return res.status(409).json({
          message: "Task is already terminated",
          currentStatus: existing.status,
        });
      }
      const updated = storage.resolveApprovalTask(id, body.action, me.id, body.resolution);
      if (!updated) {
        // Race: someone else terminated between the GET and the UPDATE. Same
        // user-visible behaviour as the 409 above.
        return res.status(409).json({ message: "Task is already terminated" });
      }
      const eventType =
        body.action === "resolve"
          ? "admin.approval_task_resolved"
          : "admin.approval_task_dismissed";
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
  // GET /api/admin/integrations
  //
  // Enriched view of every connector DispatchOS knows about: env config
  // status + 24h activity counters (event counts from audit_events).
  //
  // Drives the /admin/integrations page. Pure read endpoint, no side effects.
  // Source of truth lives in server/lib/integrations.ts — to add a new
  // integration, just edit INTEGRATIONS[] there.
  // -------------------------------------------------------------------------
  app.get("/api/admin/integrations", admin, (_req, res) => {
    res.json(getEnrichedIntegrationStatus());
  });

  // -------------------------------------------------------------------------
  // POST /api/admin/integrations/:key/config
  //   body: { values: { ENV_VAR: "plaintext", ... } }
  // -------------------------------------------------------------------------
  // Upsert one or more encrypted env-var overrides for an integration. The
  // plaintext value is encrypted with DISPATCHOS_KEYRING_PRIMARY before
  // hitting disk, and never echoed back to the client.
  //
  // Pass an empty string for any var to CLEAR (delete) it instead.
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/integrations/:key/config",
    admin,
    ah((req, res) => {
      const actor = getCurrentUser(req);
      if (!actor) return res.status(401).json({ message: "Authentication required" });

      const key = String(req.params.key);
      const desc = INTEGRATIONS.find((d) => d.key === key);
      if (!desc) return res.status(404).json({ message: "Unknown integration" });

      if (!isPrimaryConfigured()) {
        return res.status(503).json({
          message: "DISPATCHOS_KEYRING_PRIMARY не настроен — без него нельзя хранить секреты",
        });
      }

      const body = (req.body ?? {}) as { values?: Record<string, unknown> };
      const values = body.values;
      if (!values || typeof values !== "object") {
        return res.status(400).json({ message: "body.values is required" });
      }

      const allowed = new Set(desc.envVars);
      const set: string[] = [];
      const cleared: string[] = [];
      for (const [envVar, raw] of Object.entries(values)) {
        if (!allowed.has(envVar)) continue; // reject unknown vars silently
        const v = typeof raw === "string" ? raw : "";
        if (v === "") {
          storage.clearIntegrationConfig(key, envVar, actor.id);
          invalidateIntegrationConfigCache(key, envVar);
          cleared.push(envVar);
        } else {
          const enc = encryptSecret(v);
          storage.setIntegrationConfig(key, envVar, enc, actor.id);
          invalidateIntegrationConfigCache(key, envVar);
          set.push(envVar);
        }
      }

      // Return the re-enriched status so the UI flips badges immediately.
      const status = getEnrichedIntegrationStatus().integrations.find((i) => i.key === key);
      return res.json({ key, set, cleared, status });
    }),
  );

  // -------------------------------------------------------------------------
  // DELETE /api/admin/integrations/:key/config
  // -------------------------------------------------------------------------
  // Clears every UI-managed override for this integration. Env vars (Fly
  // secrets) are untouched; if they were the source, the integration stays
  // ready.
  app.delete(
    "/api/admin/integrations/:key/config",
    admin,
    ah((req, res) => {
      const actor = getCurrentUser(req);
      if (!actor) return res.status(401).json({ message: "Authentication required" });
      const key = String(req.params.key);
      const desc = INTEGRATIONS.find((d) => d.key === key);
      if (!desc) return res.status(404).json({ message: "Unknown integration" });

      for (const envVar of desc.envVars) {
        storage.clearIntegrationConfig(key, envVar, actor.id);
      }
      invalidateIntegrationConfigCache(key);
      const status = getEnrichedIntegrationStatus().integrations.find((i) => i.key === key);
      return res.json({ key, cleared: desc.envVars, status });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/email-ingest?limit=20
  //
  // Recent inbound emails (loads@dispatchos.co → CF Worker → us). Drives the
  // /admin/email-inbox page. Each item carries the raw `from`/`subject` plus
  // the structured `parsed` result so the admin can see at a glance which
  // emails were successfully extracted as loads and which need parser fixes.
  // -------------------------------------------------------------------------
  app.get("/api/admin/email-ingest", admin, (req, res) => {
    const rawLimit = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200)
      : 20;
    const items = storage.listEmailIngest(limit);
    res.json({ items, limit });
  });
  // -------------------------------------------------------------------------
  // GET /api/admin/clients/:id
  //
  // Single-client detail fetch for the admin profile editor at
  // /admin/clients/:id. The existing GET /api/clients returns the full
  // list with all fields; this endpoint exists to make per-row fetching
  // explicit and to keep the door open for per-client computed fields
  // later (load stats, score history, etc) without polluting the list
  // response shape.
  // -------------------------------------------------------------------------
  app.get("/api/admin/clients/:id", admin, (req, res) => {
    const client = storage.getClient(String(req.params.id));
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    return res.json(client);
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/loads/:id
  //
  // Full load detail page for admins. Same payload as the dispatcher's
  // /api/dispatch/loads/:id PLUS:
  //   - clientName / driverName (name-resolved IDs)
  //   - checkins[] timeline
  //   - events[] from audit_events scoped to this load
  //   - scores[] from load_scores cache (per-client breakdown)
  // -------------------------------------------------------------------------
  app.get("/api/admin/loads/:id", admin, (req, res) => {
    const id = String(req.params.id);
    const rawLoad = storage.getLoad(id);
    if (!rawLoad) {
      return res.status(404).json({ message: "Load not found" });
    }
    // driverId is now a first-class field on loadSchema (PR feat/owner-operator-self-dispatch).
    // clientId and bookedAt are still additive (loadBookingFieldsSchema), cast for those.
    const load = rawLoad as typeof rawLoad & {
      clientId?: string;
      bookedAt?: string;
    };

    const client = load.clientId ? storage.getClient(load.clientId) : undefined;
    const driver = rawLoad.driverId ? storage.getUserById(rawLoad.driverId) : undefined;

    const checkins = storage.listCheckinsForLoad(id);

    const events = storage.listAuditEventsPaginated({
      entityType: "load",
      entityId: id,
      limit: 100,
    }).items;

    // load_scores is keyed (load_id, client_id). Pull all client rows that
    // have a cached score for this load — helps when the same load was
    // considered for several carriers.
    const scores = storage.listClients().reduce<Array<{
      clientId: string;
      clientName: string;
      dispatchScore: number;
      verdict: string;
      estimatedNet: number;
      breakdown: unknown;
      computedAt: string;
    }>>((acc, c) => {
      const s = storage.getLoadScore(id, c.id);
      if (s) {
        acc.push({
          clientId: c.id,
          clientName: c.name,
          dispatchScore: s.dispatch_score,
          verdict: s.verdict,
          estimatedNet: s.estimated_net,
          breakdown: JSON.parse(s.breakdown_json),
          computedAt: s.computed_at,
        });
      }
      return acc;
    }, []);

    // Killer feature #4 — detention auto-detection. Pure compute on checkins,
    // no DB writes. UI shows events + suggested accessorial; admin clicks
    // "Bill detention" to issue invoice line (separate endpoint below).
    const clientPayload = (client ?? {}) as unknown as {
      detentionFreeHours?: number;
      detentionRatePerHourCents?: number;
    };
    // Audit V3-5 — pass GPS pings so detention helper can mark events as
    // verified / unverified. We pull pings for the load's driver only,
    // bounded by the load's lifetime.
    const driverId = rawLoad.driverId;
    const gpsPings: Array<{ lat: number; lng: number; capturedAt: string }> = [];
    if (driverId) {
      // Bound pings to a reasonable window — 30 days back from now is enough
      // for any active load. Load.createdAt isn't on the narrow type.
      const sinceIso = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const rawPings = storage.listLocationPings(driverId, { sinceIso, limit: 5000 });
      for (const p of rawPings) {
        const lat = p.lat;
        const lng = p.lng;
        const ca = p.captured_at;
        if (typeof lat === "number" && typeof lng === "number" && typeof ca === "string") {
          gpsPings.push({ lat, lng, capturedAt: ca });
        }
      }
    }
    const loadWithCoords = load as typeof load & {
      originLat?: number | null;
      originLng?: number | null;
      destinationLat?: number | null;
      destinationLng?: number | null;
    };
    const detentionEvents = computeDetentionForLoad({
      load: {
        id: load.id,
        originLat: loadWithCoords.originLat,
        originLng: loadWithCoords.originLng,
        destinationLat: loadWithCoords.destinationLat,
        destinationLng: loadWithCoords.destinationLng,
      },
      checkins,
      gpsPings,
      freeHours: clientPayload.detentionFreeHours ?? DEFAULT_FREE_HOURS,
      ratePerHourCents:
        clientPayload.detentionRatePerHourCents ?? DEFAULT_DETENTION_RATE_PER_HOUR_CENTS,
    });

    return res.json({
      load: {
        ...load,
        clientName: client?.name ?? null,
        driverName: driver?.fullName ?? null,
      },
      checkins,
      events,
      scores,
      detention: {
        events: detentionEvents,
        totalCents: totalDetentionCents(detentionEvents),
        freeHours: clientPayload.detentionFreeHours ?? DEFAULT_FREE_HOURS,
        ratePerHourCents:
          clientPayload.detentionRatePerHourCents ?? DEFAULT_DETENTION_RATE_PER_HOUR_CENTS,
      },
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/admin/loads/:id/driver
  //
  // 2026-05-27 — admin reassign-driver UI (tracker backlog item, was waiting
  // ~5 min of FE work). Backend mirrors the dispatcher endpoint at
  // PATCH /api/dispatch/loads/:id but without the
  // `loadIsVisibleToDispatcher` guard — admins have full visibility by role.
  //
  // Body: { driverId: string | null }
  //   - null      → unassign the driver from this load
  //   - <userId>  → assign; driver must (a) exist, (b) have role='driver',
  //                 (c) not be blocked, (d) be linked to the same client as
  //                 the load.
  // -------------------------------------------------------------------------
  app.patch("/api/admin/loads/:id/driver", admin, (req, res) => {
    const actor = getCurrentUser(req);
    if (!actor) return res.status(401).json({ message: "Authentication required" });

    const id = String(req.params.id);
    const body = (req.body ?? {}) as { driverId?: unknown };

    // Inline validation — keep parity with dispatcher PATCH but without
    // pulling another zod schema into shared/.
    let driverId: string | null;
    if (body.driverId === null || body.driverId === undefined) {
      driverId = null;
    } else if (typeof body.driverId === "string" && body.driverId.length > 0) {
      driverId = body.driverId;
    } else {
      return res.status(400).json({
        message: "Validation failed",
        issues: [{ path: ["driverId"], message: "driverId must be a string or null" }],
      });
    }

    const rawLoad = storage.getLoad(id);
    if (!rawLoad) return res.status(404).json({ message: "Load not found" });
    // clientId and bookedAt are still additive (loadBookingFieldsSchema); cast for those.
    const load = rawLoad as typeof rawLoad & {
      clientId?: string;
    };

    if (driverId !== null) {
      const driver = storage.getUserById(driverId);
      if (!driver || driver.role !== "driver") {
        return res
          .status(400)
          .json({ message: "driverId must reference an existing driver" });
      }
      if (driver.blocked) {
        return res.status(400).json({ message: "Driver is blocked" });
      }
      if (!load.clientId) {
        return res
          .status(400)
          .json({ message: "Load has no clientId; cannot assign a driver" });
      }
      if (driver.linkedClientId !== load.clientId) {
        return res
          .status(400)
          .json({ message: "Driver is not linked to this load's client" });
      }
    }

    const previousDriverId = rawLoad.driverId ?? null;
    const updated = storage.upsertLoad({
      ...load,
      driverId: driverId ?? undefined,
    } as Parameters<typeof storage.upsertLoad>[0]);

    storage.audit("load.driver_reassigned", "load", id, {
      actorUserId: actor.id,
      via: "admin",
      from: previousDriverId,
      to: driverId,
    });

    return res.json(updated);
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/clients/:clientId/drivers
  //
  // Helper for the reassign UI — returns the active (non-blocked, non-deleted)
  // drivers linked to a given client so the dropdown can populate without
  // pulling the full /api/admin/users list.
  // -------------------------------------------------------------------------
  app.get("/api/admin/clients/:clientId/drivers", admin, (req, res) => {
    const clientId = String(req.params.clientId);
    const client = storage.getClient(clientId);
    if (!client) return res.status(404).json({ message: "Client not found" });

    const drivers = storage
      .listUsers({ role: "driver" })
      .filter((u) => u.linkedClientId === clientId)
      .map((u) => ({
        id: u.id,
        fullName: u.fullName,
        email: u.email,
        driverStatus: u.driverStatus ?? "available",
      }));

    return res.json({ drivers });
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/detention/upcoming
  //
  // Returns loads that currently have a pickup_arrived or delivery_arrived
  // check-in WITHOUT a completion (loaded / delivered) AND the elapsed time
  // already exceeds the free window. These are billable-now opportunities
  // and should be surfaced on the dispatcher dashboard so they can be
  // claimed before paperwork closes.
  // -------------------------------------------------------------------------
  app.get("/api/admin/detention/upcoming", admin, (_req, res) => {
    const all = storage.listLoads();
    const now = new Date().toISOString();
    const rows: Array<{
      loadId: string;
      clientName: string | null;
      driverName: string | null;
      events: DetentionEvent[];
      totalCents: number;
    }> = [];

    for (const load of all) {
      const checkins = storage.listCheckinsForLoad(load.id);
      if (!checkins.length) continue;
      // clientId is still additive; driverId is now first-class on Load.
      const lid = (load as unknown as { clientId?: string });
      const client = lid.clientId ? storage.getClient(lid.clientId) : undefined;
      const driver = load.driverId ? storage.getUserById(load.driverId) : undefined;
      const payload = (client ?? {}) as unknown as {
        detentionFreeHours?: number;
        detentionRatePerHourCents?: number;
      };
      const events = computeDetentionForLoad({
        load: { id: load.id },
        checkins,
        freeHours: payload.detentionFreeHours ?? DEFAULT_FREE_HOURS,
        ratePerHourCents:
          payload.detentionRatePerHourCents ?? DEFAULT_DETENTION_RATE_PER_HOUR_CENTS,
        nowIso: now,
      });
      if (events.length === 0) continue;
      rows.push({
        loadId: load.id,
        clientName: client?.name ?? null,
        driverName: driver?.fullName ?? null,
        events,
        totalCents: totalDetentionCents(events),
      });
    }

    // Sort: highest dollar opportunities first.
    rows.sort((a, b) => b.totalCents - a.totalCents);
    return res.json({ rows, generatedAt: now });
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/compliance/renewals?withinDays=90
  //
  // Killer feature #5 — UCR/IRP renewal calendar. Returns all renewal lines
  // that are either expired or due within `withinDays` (default 90).
  // -------------------------------------------------------------------------
  app.get("/api/admin/compliance/renewals", admin, (req, res) => {
    const w = Math.max(0, Math.min(365, Number(req.query.withinDays ?? 90) || 90));
    const rows = listUpcomingRenewals(w);
    return res.json({ rows, withinDays: w, generatedAt: new Date().toISOString() });
  });

  // -------------------------------------------------------------------------
  // Compliance document upload (per user request 2026-05-26):
  //   - Owner-operator drivers upload via /api/me/documents (existing)
  //     — we auto-attach to their linked carrier when present.
  //   - Companies upload on behalf of carriers via these admin endpoints.
  // -------------------------------------------------------------------------

  // GET /api/admin/clients/:id/documents
  // Lists driver_documents rows scoped to a carrier (client_id = :id).
  app.get("/api/admin/clients/:id/documents", admin, (req, res) => {
    const clientId = String(req.params.id);
    if (!storage.getClient(clientId)) {
      return res.status(404).json({ message: "Client not found" });
    }
    const docs = storage.listDriverDocumentsForClient(clientId, 100);
    return res.json({ items: docs, total: docs.length });
  });

  // POST /api/admin/clients/:id/documents
  // Multipart upload (file + metadata). file size + MIME enforced by
  // server/upload.ts. expiresAt is optional ISO date — if provided the
  // monitor crons will alert at the same thresholds as for driver-uploaded
  // compliance docs.
  app.post("/api/admin/clients/:id/documents", admin, upload.single("file"), (req, res) => {
    const actor = getCurrentUser(req);
    if (!actor) return res.status(401).json({ message: "Authentication required" });
    const clientId = String(req.params.id);
    const client = storage.getClient(clientId);
    if (!client) {
      // Cleanup multer temp file before bailing.
      if (req.file?.path) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      }
      return res.status(404).json({ message: "Client not found" });
    }
    const file = req.file;
    if (!file) {
      return res.status(400).json({ message: "file is required (multipart field 'file')" });
    }

    let meta: ReturnType<typeof uploadDriverDocumentSchema.parse>;
    try {
      meta = uploadDriverDocumentSchema.parse(req.body);
    } catch (err) {
      try { fs.unlinkSync(file.path); } catch { /* ignore */ }
      if (err instanceof ZodError) {
        return res.status(400).json({
          message: "Invalid metadata",
          issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      throw err;
    }

    // Move temp file into typed subfolder. We use client-docs/<clientId>/
    // distinct from driver-docs/<userId>/ so backups are easy to slice.
    const subdir = path.join(uploadsRoot, "client-docs", clientId);
    fs.mkdirSync(subdir, { recursive: true });
    const safeBase = `${Date.now()}-${path.basename(file.originalname).replace(/[^\w.\-]/g, "_")}`;
    const finalPath = path.join(subdir, safeBase);
    fs.renameSync(file.path, finalPath);
    const storagePath = path.relative(uploadsRoot, finalPath);

    const doc = storage.insertDriverDocument({
      ownerUserId: actor.id, // admin who uploaded
      clientId,              // scoped to the carrier
      type: meta.type,
      fileName: file.originalname,
      storagePath,
      expiresAt: meta.expiresAt ?? null,
      notes: meta.notes ?? null,
    });

    // Auto-fill the matching expiry field on the client when a known
    // compliance doc carries a date. This is the "upload-instead-of-typing"
    // shortcut requested 2026-05-26 — dispatcher uploads a photo of the COI,
    // doesn't have to copy-paste the date by hand.
    const expiryFieldByType: Record<string, string> = {
      cargo_insurance: "cargoInsuranceExpiresAt",
      auto_liability: "autoLiabilityExpiresAt",
      general_liability: "generalLiabilityExpiresAt",
      ucr_certificate: "ucrExpiresAt",
      irp_cab_card: "irpExpiresAt",
    };
    const field = expiryFieldByType[meta.type];
    if (field && meta.expiresAt) {
      // Audit V3-8 — normalize both to YYYY-MM-DD before comparison.
      // Lexicographic string compare only works when both sides are the same
      // format; mixing 'YYYY-MM-DD' with full ISO 'YYYY-MM-DDTHH:mm:ssZ' makes
      // 'existing < new' flip (T > empty suffix). Auto-fill could then
      // clobber a future date with a stale one.
      const existingRaw = (client as Record<string, unknown>)[field];
      const existingNorm =
        typeof existingRaw === "string" ? existingRaw.slice(0, 10) : null;
      const newNorm = meta.expiresAt.slice(0, 10);
      if (!existingNorm || existingNorm < newNorm) {
        storage.upsertClient({
          ...(client as unknown as Parameters<typeof storage.upsertClient>[0]),
          [field]: newNorm,
        } as Parameters<typeof storage.upsertClient>[0]);
      }
    }

    storage.audit("client.document_uploaded", "client", clientId, {
      actorUserId: actor.id,
      docId: doc.id,
      type: doc.type,
      expiresAt: doc.expiresAt,
      autoFilledField: field && meta.expiresAt ? field : undefined,
      sizeBytes: file.size,
    });

    return res.status(201).json(doc);
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/users/:id/dq-status
  //
  // Killer feature #3 — FMCSA §391 Driver Qualification file compliance per
  // driver. Returns line-by-line status (present / expiring_soon / expired /
  // missing) for every required document type.
  // -------------------------------------------------------------------------
  app.get("/api/admin/users/:id/dq-status", admin, (req, res) => {
    const id = String(req.params.id);
    const user = storage.getUserById(id);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.role !== "driver") {
      return res.status(400).json({ message: "DQ files apply to drivers only" });
    }
    return res.json({
      status: computeDqStatusForDriver(id),
      requirements: DQ_REQUIREMENTS,
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/clients/:id/dq-summary
  //
  // Fleet-level roll-up of DQ compliance across all drivers linked to a
  // carrier. Used by /admin/clients/:id 'DQ files' tab and the next-renewal
  // dashboard widget.
  // -------------------------------------------------------------------------
  app.get("/api/admin/clients/:id/dq-summary", admin, (req, res) => {
    const id = String(req.params.id);
    const summary = computeFleetDqSummary(id);
    if (!summary) return res.status(404).json({ message: "Client not found" });
    return res.json(summary);
  });

  // DELETE /api/admin/clients/:id/documents/:docId
  app.delete("/api/admin/clients/:id/documents/:docId", admin, (req, res) => {
    const actor = getCurrentUser(req);
    if (!actor) return res.status(401).json({ message: "Authentication required" });
    const docId = String(req.params.docId);
    const doc = storage.getDriverDocument(docId);
    if (!doc || doc.clientId !== String(req.params.id)) {
      return res.status(404).json({ message: "Document not found" });
    }
    // Best-effort file unlink.
    try {
      fs.unlinkSync(path.join(uploadsRoot, doc.storagePath));
    } catch (err) {
      console.warn("[admin/clients/docs] file unlink failed:", (err as Error).message);
    }
    storage.deleteDriverDocumentById(docId);
    storage.audit("client.document_deleted", "client", String(req.params.id), {
      actorUserId: actor.id,
      docId,
      type: doc.type,
    });
    return res.status(204).end();
  });

  // -------------------------------------------------------------------------
  // PATCH /api/admin/clients/:id
  //
  // Partial update of a client profile. Used by the admin profile editor
  // to fill in smart-matching fields (equipmentTypes, maxGvwLbs,
  // payCentsPerMile, blockedBrokers, hoursAvailable, etc) added by
  // PR #38 — Никита's scoreLoadForClient reads these but currently
  // there is no UI to set them.
  //
  // Behavior:
  //   - 404 if client doesn't exist
  //   - Body is a partial Client (any subset of fields). `id` in body
  //     is ignored; URL param wins.
  //   - Validates merged object against clientSchema (the schema after
  //     the merge, NOT the partial — otherwise unknown fields slip in).
  //   - Delegates persistence to storage.upsertClient(), which emits
  //     a `client.updated` audit event with the new full payload.
  //
  // Note: storage.upsertClient already handles audit. We add an extra
  // `client.profile_patched` audit AFTER the upsert so we have a
  // narrower-grained signal for "admin edited via profile UI" vs
  // generic "client was upserted (could be CSV import etc)".
  // -------------------------------------------------------------------------
  app.patch("/api/admin/clients/:id", admin, (req, res) => {
    const existing = storage.getClient(String(req.params.id));
    if (!existing) {
      return res.status(404).json({ message: "Client not found" });
    }

    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Partial<Client>;
    // strip id from body — URL param is authoritative
    const { id: _ignored, ...patch } = body;

    const merged: Client = { ...existing, ...patch, id: existing.id };

    const parsed = clientSchema.safeParse(merged);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Validation failed",
        issues: parsed.error.issues,
      });
    }

    const saved = storage.upsertClient(parsed.data);

    // Narrower-grained audit for the profile editor flow specifically.
    storage.audit("client.profile_patched", "client", saved.id, {
      patchedFields: Object.keys(patch),
    });

    return res.json(saved);
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/clients/:id/fuel-summary?days=7
  // -------------------------------------------------------------------------
  // Aggregates fuel performance for a carrier over a rolling window:
  //  - Distance traveled (from driver_location_pings, all drivers linked
  //    to this client)
  //  - Gallons + spend (from fuel_transactions)
  //  - Computed real MPG vs the carrier's avg_mpg target
  //  - Per-transaction overpay: for each fillup, find the cheapest diesel
  //    within 5 mi observed within 6h of the fillup, calculate how much
  //    cheaper that would have been.
  app.get(
    "/api/admin/clients/:id/fuel-summary",
    admin,
    ah((req, res) => {
      const clientId = String(req.params.id);
      const client = storage.getClient(clientId);
      if (!client) return res.status(404).json({ message: "Client not found" });

      const daysRaw = Number(req.query.days ?? 7);
      const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 15) : 7;
      const sinceIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

      // Driver-scope: all drivers linked to this client, since we want fleet-level.
      const drivers = storage.listUsers().filter(
        (u) => u.role === "driver" && u.linkedClientId === clientId && !u.deletedAt,
      );
      const driverIds = drivers.map((d) => d.id);

      // Distance (miles) — sum across all drivers.
      let totalMiles = 0;
      for (const dId of driverIds) {
        totalMiles += storage.computeDriverDistanceMiles(dId, sinceIso);
      }

      const tx = storage.listFuelTransactionsForClient(clientId, sinceIso);
      const gallons = tx.reduce((acc, t) => acc + (t.gallons as number), 0);
      const spendCents = tx.reduce((acc, t) => acc + (t.total_cents as number), 0);

      // MPG (only if we have enough data to be meaningful).
      const actualMpg = gallons > 0.5 && totalMiles > 10 ? totalMiles / gallons : null;
      // avgMpg живёт в client payload (добавлен в clientSchema Владом, fuel task #2).
      // Плоская колонка clients.avg_mpg (из #61) пока не используется —
      // оставлена для будущих SQL agg на больших датасетах.
      const expectedMpg = (client as { avgMpg?: number }).avgMpg ?? null;

      // Per-transaction overpay calculation. For each fillup, find cheapest
      // diesel observed within ±6h of the fillup, within 8km. If the cheapest
      // is materially lower (>5 cents/gal), record an overpay alert.
      const overpayAlerts: Array<{
        transactionId: string;
        occurredAt: string;
        stationName: string | null;
        paidCentsPerGallon: number;
        cheaperAtName: string | null;
        cheaperCentsPerGallon: number;
        cheaperDistanceKm: number;
        savedDollars: number;
      }> = [];
      for (const t of tx) {
        if (t.station_lat == null || t.station_lng == null) continue;
        const cheaper = storage.findCheapestDieselNear(
          t.station_lat as number,
          t.station_lng as number,
          { radiusKm: 8, maxAgeH: 6, limit: 1 },
        )[0];
        if (!cheaper) continue;
        const paid = t.price_per_gallon_cents as number;
        const cheapest = cheaper.price_cents as number;
        if (cheapest >= paid - 5) continue; // <5 cents — not worth flagging
        overpayAlerts.push({
          transactionId: t.id as string,
          occurredAt: t.occurred_at as string,
          stationName: (t.station_name as string) ?? null,
          paidCentsPerGallon: paid,
          cheaperAtName: (cheaper.station_name as string) ?? null,
          cheaperCentsPerGallon: cheapest,
          cheaperDistanceKm: cheaper.distance_km as number,
          savedDollars: ((paid - cheapest) * (t.gallons as number)) / 100,
        });
      }

      return res.json({
        clientId,
        windowDays: days,
        sinceIso,
        totalMiles,
        gallons,
        spendCents,
        actualMpg,
        expectedMpg,
        transactionCount: tx.length,
        overpayAlerts,
        overpayTotalDollars: overpayAlerts.reduce((acc, a) => acc + a.savedDollars, 0),
      });
    }),
  );

  // -------------------------------------------------------------------------
  // IFTA quarterly report (paid feature — mileage + fuel by state)
  //
  // GET /api/admin/clients/:id/ifta?year=YYYY&quarter=N         → JSON
  // GET /api/admin/clients/:id/ifta.csv?year=YYYY&quarter=N     → text/csv
  //
  // Aggregates GPS pings (miles per state) + fuel_transactions (gallons per
  // state) for all drivers linked to this client in the given quarter.
  // State lookup is offline bbox-based — approximate but signed-off by
  // carrier at filing time. See server/lib/ifta.ts.
  // -------------------------------------------------------------------------
  function parseIftaQuery(req: Request): { year: number; quarter: 1 | 2 | 3 | 4 } | { error: string } {
    const now = new Date();
    const defaultYear = now.getUTCFullYear();
    const defaultQuarter = (Math.floor(now.getUTCMonth() / 3) + 1) as 1 | 2 | 3 | 4;
    const year = Number(req.query.year ?? defaultYear);
    const quarter = Number(req.query.quarter ?? defaultQuarter);
    if (!Number.isInteger(year) || year < 2020 || year > 2100) {
      return { error: "year must be an integer between 2020 and 2100" };
    }
    if (![1, 2, 3, 4].includes(quarter)) {
      return { error: "quarter must be 1, 2, 3, or 4" };
    }
    return { year, quarter: quarter as 1 | 2 | 3 | 4 };
  }

  app.get("/api/admin/clients/:id/ifta", admin, (req, res) => {
    const client = storage.getClient(String(req.params.id));
    if (!client) return res.status(404).json({ message: "Client not found" });
    const q = parseIftaQuery(req);
    if ("error" in q) return res.status(400).json({ message: q.error });
    const report = buildIftaQuarterly(client.id, q.year, q.quarter);
    return res.json(report);
  });

  app.get("/api/admin/clients/:id/ifta.csv", admin, (req, res) => {
    const client = storage.getClient(String(req.params.id));
    if (!client) return res.status(404).json({ message: "Client not found" });
    const q = parseIftaQuery(req);
    if ("error" in q) return res.status(400).json({ message: q.error });
    const report = buildIftaQuarterly(client.id, q.year, q.quarter);
    const csv = renderIftaCsv(report);
    const filename = `ifta_${client.id}_${q.year}_Q${q.quarter}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(csv);
  });

  // -------------------------------------------------------------------------
  // Carrier Safety Profile (paid add-on — Montgomery v. Caribe defense)
  //
  // GET /api/admin/clients/:id/safety-profile      → JSON snapshot
  // GET /api/admin/clients/:id/safety-profile.md   → Markdown download
  //
  // FMCSA SAFER fetch is best-effort; if the FMCSA_WEB_KEY isn't configured
  // we still return the local-data parts (insurance + operational record)
  // with fmcsa.fetched=false so the UI can flag it.
  // -------------------------------------------------------------------------
  app.get("/api/admin/clients/:id/safety-profile", admin, async (req, res) => {
    const profile = await buildCarrierSafetyProfile(String(req.params.id));
    if (!profile) return res.status(404).json({ message: "Client not found" });
    storage.audit(
      "carrier.safety_profile_viewed",
      "client",
      profile.clientId,
      { verdict: profile.verdict.level },
    );
    return res.json(profile);
  });

  app.get("/api/admin/clients/:id/safety-profile.md", admin, async (req, res) => {
    const profile = await buildCarrierSafetyProfile(String(req.params.id));
    if (!profile) return res.status(404).json({ message: "Client not found" });
    const md = renderCarrierSafetyProfileMarkdown(profile);
    storage.audit(
      "carrier.safety_profile_exported",
      "client",
      profile.clientId,
      { verdict: profile.verdict.level, format: "markdown" },
    );
    const safeName = profile.clientName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60);
    const filename = `carrier_safety_${safeName}_${new Date().toISOString().slice(0, 10)}.md`;
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(md);
  });

  // -------------------------------------------------------------------------
  // FMCSA Drug & Alcohol Clearinghouse (49 CFR Part 382)
  //
  //   GET  /api/admin/clients/:id/clearinghouse                → per-driver status
  //   GET  /api/admin/users/:userId/clearinghouse              → driver query log
  //   POST /api/admin/users/:userId/clearinghouse              → record new query
  // -------------------------------------------------------------------------
  app.get("/api/admin/clients/:id/clearinghouse", admin, (req, res) => {
    const client = storage.getClient(String(req.params.id));
    if (!client) return res.status(404).json({ message: "Client not found" });
    const rows = storage.listClearinghouseStatusForClient(client.id);
    return res.json({ clientId: client.id, drivers: rows });
  });

  app.get("/api/admin/users/:userId/clearinghouse", admin, (req, res) => {
    const userId = String(req.params.userId);
    const user = storage.getUserById(userId);
    if (!user) return res.status(404).json({ message: "Driver not found" });
    if (user.role !== "driver") {
      return res.status(400).json({ message: "Clearinghouse queries are driver-only." });
    }
    const queries = storage.listClearinghouseQueriesForDriver(userId);
    return res.json({ userId, queries });
  });

  app.post("/api/admin/users/:userId/clearinghouse", admin, (req, res) => {
    const userId = String(req.params.userId);
    const user = storage.getUserById(userId);
    if (!user) return res.status(404).json({ message: "Driver not found" });
    if (user.role !== "driver") {
      return res.status(400).json({ message: "Clearinghouse queries are driver-only." });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const queryType = String(body.queryType ?? "");
    if (queryType !== "pre_employment" && queryType !== "annual") {
      return res.status(400).json({ message: "queryType must be 'pre_employment' or 'annual'" });
    }
    const result = String(body.result ?? "");
    if (!["clear", "prohibited", "pending", "consent_revoked"].includes(result)) {
      return res.status(400).json({
        message: "result must be one of: clear, prohibited, pending, consent_revoked",
      });
    }
    // Audit V3-6 — prevent fabrication of regulatory compliance. The admin
    // can't enter a future date (claim a query that hasn't happened yet) or a
    // very old date (backfilling years of fake records). The 13-month window
    // matches the FMCSA Clearinghouse annual-query rule.
    const queriedAt = String(body.queriedAt ?? new Date().toISOString().slice(0, 10));
    // V3-8 — strict YYYY-MM-DD or full ISO; reject everything else.
    if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)?$/.test(queriedAt)) {
      return res.status(400).json({
        message: "queriedAt must be YYYY-MM-DD or full ISO format",
      });
    }
    const queriedAtMs = new Date(queriedAt).getTime();
    if (Number.isNaN(queriedAtMs)) {
      return res.status(400).json({ message: "queriedAt must be a valid ISO date" });
    }
    const nowMs = Date.now();
    const thirteenMonthsAgoMs = nowMs - 13 * 30 * 24 * 3600 * 1000;
    if (queriedAtMs > nowMs + 60 * 60 * 1000) {
      // Allow 1 hour clock skew for client/server drift
      return res.status(400).json({
        message: "queriedAt cannot be in the future (regulatory compliance — 49 CFR §382.701)",
      });
    }
    if (queriedAtMs < thirteenMonthsAgoMs) {
      return res.status(400).json({
        message: "queriedAt cannot be more than 13 months ago (annual query rule)",
      });
    }
    const me = getCurrentUser(req);
    if (!me) return res.status(401).json({ message: "Unauthorized" });
    const { id } = storage.recordClearinghouseQuery({
      userId,
      clientId: user.linkedClientId ?? null,
      queryType: queryType as "pre_employment" | "annual",
      queriedAt,
      result: result as "clear" | "prohibited" | "pending" | "consent_revoked",
      notes: typeof body.notes === "string" ? body.notes.slice(0, 2000) : null,
      recordedByUserId: me.id,
    });
    return res.status(201).json({ ok: true, id });
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/broker-trust/:mc/signals — admin read of raw signals + counts.
  // No score computation (separate PR). Source of truth for future scoring UI.
  // -------------------------------------------------------------------------
  app.get("/api/admin/broker-trust/:mc/signals", admin, (req, res) => {
    const mc = String(req.params.mc ?? "").trim();
    if (!mc) return res.status(400).json({ message: "mc is required" });
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    const types = typeof req.query.types === "string"
      ? req.query.types.split(",").filter(Boolean) : undefined;
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const signals = storage.listBrokerTrustSignals(mc, { since, types, limit });
    const counts  = storage.countBrokerTrustSignalsByType(mc);
    return res.json({
      mc, total: signals.length, counts,
      signals: signals.map((r) => ({
        id: r.id as string,
        brokerMc: r.broker_mc as string,
        loadId: (r.load_id as string) ?? null,
        clientId: (r.client_id as string) ?? null,
        signalType: r.signal_type as string,
        positive: Boolean(r.positive),
        notes: (r.notes as string) ?? null,
        reportedByUserId: (r.reported_by_user_id as string) ?? null,
        reportedAt: r.reported_at as string,
      })),
    });
  });
}

// ===========================================================================
// Dashboard helpers (module-level — only used by /dashboard/stats)
// ===========================================================================

/** YYYY-MM-DD from a Date in UTC. */
function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Score every load that has a clientId and was created in the window, against
 * its assigned client. Returns counts by verdict. Loads with no clientId or
 * unknown clientId are skipped — they aren't billable so they don't belong
 * in this tile.
 *
 * This is a best-effort approximation for the dashboard. The actual scoring
 * lives in routes.ts → scoreLoadForClient, which uses location/cost
 * heuristics. Here we recompute a minimal verdict signal from rate alone:
 *   rate >= 1500 → "book",  800 ≤ rate < 1500 → "negotiate",  else "skip".
 * Matches the spirit of the existing scoring but is independent code. If the
 * dashboard tile ever needs the exact verdict, expose scoreLoadForClient and
 * call it.
 */
function computeWindowVerdictCounts(sinceIso: string): {
  book: number;
  negotiate: number;
  skip: number;
} {
  const loads = storage.listLoadsCreatedSince(sinceIso);
  let book = 0;
  let negotiate = 0;
  let skip = 0;
  for (const load of loads) {
    const rate = typeof load.rate === "number" ? load.rate : 0;
    if (rate >= 1500) book += 1;
    else if (rate >= 800) negotiate += 1;
    else skip += 1;
  }
  return { book, negotiate, skip };
}

/**
 * Map the existing buildIntegrationStatus()-style data into the dashboard
 * shape: `{ status, lastCheckedAt, message? }` keyed by integration name.
 *
 * We inline the env-var checks here (instead of importing
 * buildIntegrationStatus from routes.ts, which would create a circular
 * import). Keep this list in sync with that function if integrations change.
 */
function buildDashboardIntegrationsMap(): Record<
  string,
  { status: "ok" | "warn" | "missing" | "error"; lastCheckedAt: string | null; message?: string }
> {
  const now = new Date().toISOString();
  const has = (...keys: string[]) => keys.every((k) => Boolean(process.env[k]));

  // Audit V2-3 — read canonical FMCSA_WEB_KEY from integration store with legacy
  // FMCSA_WEBKEY env fallback so admin dashboard agrees with broker-check + safety profile.
  const fmcsaKey =
    getIntegrationValue("fmcsa", "FMCSA_WEB_KEY") ?? process.env.FMCSA_WEBKEY;
  return {
    fmcsa: {
      status: Boolean(process.env.FMCSA_API_URL && fmcsaKey) ? "ok" : "missing",
      lastCheckedAt: now,
    },
    telegram: {
      status: has("TELEGRAM_BOT_TOKEN", "DISPATCHOS_PUBLIC_URL") ? "ok" : "missing",
      lastCheckedAt: now,
    },
    gmail: {
      status: has("GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET") ? "ok" : "missing",
      lastCheckedAt: now,
    },
    drive: {
      status: has("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET") ? "ok" : "missing",
      lastCheckedAt: now,
    },
    twilio: {
      status: has("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER")
        ? "ok"
        : "missing",
      lastCheckedAt: now,
    },
  };
}

/** Read DB file size in bytes; null if not on disk (memory DB, etc.). */
function readDbSizeBytes(): number | null {
  try {
    const dbPath = process.env.DISPATCHOS_DB_PATH || "dispatchos-unified.db";
    // Require here to avoid a top-level fs import for one optional use case.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs");
    const stat = fs.statSync(dbPath);
    return stat.size as number;
  } catch {
    return null;
  }
}
