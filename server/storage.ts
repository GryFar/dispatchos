import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  Assignment,
  BrokerRecord,
  Client,
  DocumentRecord,
  DriverLocation,
  InsertClient,
  InsertDocument,
  InsertLoad,
  Invite,
  Invoice,
  Load,
  UserPublic,
  UserRole,
} from "@shared/schema";

const sqlite = new Database(process.env.DISPATCHOS_DB_PATH || "dispatchos-unified.db");
sqlite.pragma("journal_mode = WAL");

sqlite.exec(`
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS loads (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS broker_records (
  id TEXT PRIMARY KEY,
  broker_mc TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_ingest (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_config (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ===========================================================================
-- Phase 1 tables: users, invites, assignments, invoices
-- ===========================================================================

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  blocked INTEGER NOT NULL DEFAULT 0,
  linked_client_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE INDEX IF NOT EXISTS users_role_idx ON users(role);
CREATE INDEX IF NOT EXISTS users_linked_client_idx ON users(linked_client_id);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  email TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by_user_id TEXT,
  linked_client_id TEXT,
  created_at TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS invites_email_idx ON invites(email);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  dispatcher_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  removed_at TEXT,
  removed_by_user_id TEXT
);

CREATE INDEX IF NOT EXISTS assignments_client_idx ON assignments(client_id);
CREATE INDEX IF NOT EXISTS assignments_dispatcher_idx ON assignments(dispatcher_user_id);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  flat_fee REAL NOT NULL,
  percent_fee REAL NOT NULL,
  gross_booked REAL NOT NULL,
  total_due REAL NOT NULL,
  status TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  sent_at TEXT,
  paid_at TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS invoices_client_week_idx ON invoices(client_id, week_start);

-- ===========================================================================
-- Phase 3: indexes for cursor-based pagination (created_at DESC ordering)
-- ===========================================================================
-- All admin list endpoints sort by created_at DESC and paginate with
-- WHERE created_at < :cursor ORDER BY created_at DESC LIMIT N. These indexes
-- keep that query fast as the tables grow past a few thousand rows.

CREATE INDEX IF NOT EXISTS users_created_at_idx ON users(created_at DESC);
CREATE INDEX IF NOT EXISTS invites_created_at_idx ON invites(created_at DESC);
CREATE INDEX IF NOT EXISTS assignments_created_at_idx ON assignments(created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_generated_at_idx ON invoices(generated_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_created_at_idx ON audit_events(created_at DESC);
`);

function now() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parsePayload<T>(row: { payload: string } | undefined): T | undefined {
  if (!row) return undefined;
  return JSON.parse(row.payload) as T;
}

function parsePayloads<T>(rows: Array<{ payload: string }>): T[] {
  return rows.map((row) => JSON.parse(row.payload) as T);
}

export const dispatchosDataRoot = path.resolve(process.env.DISPATCHOS_DATA_ROOT || "dispatchos_data");
export const uploadsRoot = path.join(dispatchosDataRoot, "uploads");
export const localDriveRoot = path.join(dispatchosDataRoot, "drive");
export const sessionsDbPath = path.join(dispatchosDataRoot, "sessions.db");

fs.mkdirSync(uploadsRoot, { recursive: true });
fs.mkdirSync(localDriveRoot, { recursive: true });

// ===========================================================================
// User row -> internal type with secret fields
// ===========================================================================

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  role: string;
  password_salt: string;
  password_hash: string;
  totp_secret: string | null;
  blocked: number;
  linked_client_id: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface UserInternal {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  passwordSalt: string;
  passwordHash: string;
  totpSecret?: string;
  blocked: boolean;
  linkedClientId?: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

function rowToUserInternal(row: UserRow | undefined): UserInternal | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role as UserRole,
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    totpSecret: row.totp_secret ?? undefined,
    blocked: Boolean(row.blocked),
    linkedClientId: row.linked_client_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? undefined,
  };
}

function toUserPublic(user: UserInternal, extras?: { assignedClientIds?: string[] }): UserPublic {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    blocked: user.blocked,
    twoFactorEnabled: Boolean(user.totpSecret),
    linkedClientId: user.role === "driver" ? user.linkedClientId : undefined,
    assignedClientIds: user.role === "dispatcher" ? (extras?.assignedClientIds ?? []) : undefined,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  };
}

// ===========================================================================
// Storage API
// ===========================================================================

export const storage = {
  // -------------------------------------------------------------------------
  // Legacy auth_config (single owner) - kept for backward compat
  // -------------------------------------------------------------------------

  getAuthConfig(): any | undefined {
    const row = sqlite.prepare("SELECT payload FROM auth_config WHERE id = 'owner'").get() as
      | { payload: string }
      | undefined;
    return parsePayload<any>(row);
  },

  getAuthState() {
    const userCount = (sqlite.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number }).c;
    if (userCount > 0) {
      // New-style: users table is the source of truth.
      const adminCount = (
        sqlite.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' AND blocked = 0").get() as { c: number }
      ).c;
      return {
        isConfigured: adminCount > 0,
        userCount,
        // Legacy fields kept for backward compat with old UI:
        username: undefined,
        role: adminCount > 0 ? ("admin" as const) : undefined,
        twoFactorEnabled: undefined,
      };
    }
    // Pre-Phase-1 fallback: check legacy auth_config row.
    const config = this.getAuthConfig();
    return {
      isConfigured: Boolean(config),
      userCount: 0,
      username: config?.username,
      role: config ? ("owner" as const) : undefined,
      twoFactorEnabled: Boolean(config?.totpSecret),
    };
  },

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  getUserById(id: string): UserInternal | undefined {
    const row = sqlite.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return rowToUserInternal(row);
  },

  getUserByEmail(email: string): UserInternal | undefined {
    const row = sqlite.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()) as
      | UserRow
      | undefined;
    return rowToUserInternal(row);
  },

  listUsers(filter?: { role?: UserRole; includeBlocked?: boolean }): UserInternal[] {
    let query = "SELECT * FROM users WHERE 1=1";
    const params: any[] = [];
    if (filter?.role) {
      query += " AND role = ?";
      params.push(filter.role);
    }
    if (!filter?.includeBlocked) {
      query += " AND blocked = 0";
    }
    query += " ORDER BY created_at ASC";
    const rows = sqlite.prepare(query).all(...params) as UserRow[];
    return rows.map((row) => rowToUserInternal(row)!).filter(Boolean);
  },

  countUsers(): number {
    return (sqlite.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number }).c;
  },

  /**
   * Cursor-paginated user listing for the admin UI. Sorted by `created_at DESC`
   * (newest first), so the cursor for the next page is the `created_at` of the
   * last row on the current page.
   *
   * NOTE: this is intentionally a NEW method rather than a `listUsers` overload.
   * `listUsers` is still used by Phase 1 code (`exportBackup`, `portal/status`)
   * and the smoke suite, and its `created_at ASC` ordering is part of that
   * contract.
   */
  listUsersPaginated(filter: {
    limit?: number;
    cursor?: string;
    role?: UserRole;
    blocked?: boolean;
    q?: string;
  }): { items: UserInternal[]; nextCursor: string | null; total: number } {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);

    const where: string[] = ["1=1"];
    const params: any[] = [];

    if (filter.role) {
      where.push("role = ?");
      params.push(filter.role);
    }
    if (filter.blocked !== undefined) {
      where.push("blocked = ?");
      params.push(filter.blocked ? 1 : 0);
    }
    if (filter.q && filter.q.trim()) {
      // Search by email OR full_name. LIKE without leading-wildcard would be
      // index-friendly; spec accepts %q% for the team's current scale (<100
      // users) and notes FTS as a future-Phase fix for 10k+.
      where.push("(LOWER(email) LIKE ? OR LOWER(full_name) LIKE ?)");
      const pattern = `%${filter.q.trim().toLowerCase()}%`;
      params.push(pattern, pattern);
    }

    // Count BEFORE applying the cursor — `total` reflects all rows matching
    // filters, not just rows on/after the current cursor (spec §0.3).
    const countQuery = `SELECT COUNT(*) as c FROM users WHERE ${where.join(" AND ")}`;
    const total = (sqlite.prepare(countQuery).get(...params) as { c: number }).c;

    if (filter.cursor) {
      where.push("created_at < ?");
      params.push(filter.cursor);
    }

    // Fetch limit+1 to determine `hasMore` without a second query.
    const listQuery = `SELECT * FROM users WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`;
    const rows = sqlite.prepare(listQuery).all(...params, limit + 1) as UserRow[];

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map((row) => rowToUserInternal(row)!).filter(Boolean);
    const nextCursor = hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1].created_at : null;

    return { items, nextCursor, total };
  },

  createUser(input: {
    email: string;
    fullName: string;
    role: UserRole;
    passwordSalt: string;
    passwordHash: string;
    totpSecret?: string;
    linkedClientId?: string;
    actorUserId?: string; // for audit
  }): UserInternal {
    const id = makeId("user");
    const timestamp = now();
    const email = input.email.toLowerCase();
    sqlite
      .prepare(
        `
        INSERT INTO users (
          id, email, full_name, role, password_salt, password_hash,
          totp_secret, blocked, linked_client_id, created_at, updated_at, last_login_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL)
      `,
      )
      .run(
        id,
        email,
        input.fullName,
        input.role,
        input.passwordSalt,
        input.passwordHash,
        input.totpSecret ?? null,
        input.linkedClientId ?? null,
        timestamp,
        timestamp,
      );
    this.audit("user.created", "user", id, {
      email,
      role: input.role,
      twoFactorEnabled: Boolean(input.totpSecret),
      actorUserId: input.actorUserId,
    });
    return this.getUserById(id)!;
  },

  updateUser(
    id: string,
    patch: {
      fullName?: string;
      role?: UserRole;
      blocked?: boolean;
      linkedClientId?: string | null;
      passwordSalt?: string;
      passwordHash?: string;
      totpSecret?: string | null;
    },
    actorUserId?: string,
  ): UserInternal | undefined {
    const existing = this.getUserById(id);
    if (!existing) return undefined;
    const sets: string[] = [];
    const params: any[] = [];
    if (patch.fullName !== undefined) {
      sets.push("full_name = ?");
      params.push(patch.fullName);
    }
    if (patch.role !== undefined) {
      sets.push("role = ?");
      params.push(patch.role);
    }
    if (patch.blocked !== undefined) {
      sets.push("blocked = ?");
      params.push(patch.blocked ? 1 : 0);
    }
    if (patch.linkedClientId !== undefined) {
      sets.push("linked_client_id = ?");
      params.push(patch.linkedClientId);
    }
    if (patch.passwordSalt !== undefined && patch.passwordHash !== undefined) {
      sets.push("password_salt = ?");
      params.push(patch.passwordSalt);
      sets.push("password_hash = ?");
      params.push(patch.passwordHash);
    }
    if (patch.totpSecret !== undefined) {
      sets.push("totp_secret = ?");
      params.push(patch.totpSecret);
    }
    if (sets.length === 0) return existing;
    sets.push("updated_at = ?");
    params.push(now());
    params.push(id);
    sqlite.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    this.audit("user.updated", "user", id, {
      patch: { ...patch, passwordSalt: undefined, passwordHash: undefined, totpSecret: undefined },
      actorUserId,
    });
    return this.getUserById(id);
  },

  recordUserLogin(id: string) {
    sqlite.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now(), id);
  },

  toUserPublic(user: UserInternal): UserPublic {
    if (user.role === "dispatcher") {
      const assignedClientIds = this.listAssignmentsForDispatcher(user.id).map((a) => a.clientId);
      return toUserPublic(user, { assignedClientIds });
    }
    return toUserPublic(user);
  },

  // -------------------------------------------------------------------------
  // Owner -> admin migration (one-shot, idempotent)
  // -------------------------------------------------------------------------
  //
  // If we find a legacy auth_config.owner row AND the users table is empty,
  // we copy the owner into users as role=admin. The owner's username becomes
  // the admin email (or, if no @, we fall back to DISPATCHOS_OWNER_EMAIL env
  // var or owner@dispatchos.local). The original auth_config row is left in
  // place but ignored from now on.
  //
  migrateLegacyOwnerIfNeeded(): { migrated: boolean; userId?: string; email?: string } {
    const userCount = this.countUsers();
    if (userCount > 0) return { migrated: false };
    const legacy = this.getAuthConfig();
    if (!legacy) return { migrated: false };

    let email = String(legacy.username || "").trim();
    if (!email.includes("@")) {
      email = process.env.DISPATCHOS_OWNER_EMAIL || "owner@dispatchos.local";
    }
    email = email.toLowerCase();

    const id = makeId("user");
    const timestamp = legacy.createdAt || now();
    sqlite
      .prepare(
        `
        INSERT INTO users (
          id, email, full_name, role, password_salt, password_hash,
          totp_secret, blocked, linked_client_id, created_at, updated_at, last_login_at
        ) VALUES (?, ?, ?, 'admin', ?, ?, ?, 0, NULL, ?, ?, NULL)
      `,
      )
      .run(
        id,
        email,
        legacy.username || "Owner",
        legacy.passwordSalt,
        legacy.passwordHash,
        legacy.totpSecret || null,
        timestamp,
        now(),
      );
    this.audit("user.migrated_from_owner", "user", id, {
      email,
      legacyUsername: legacy.username,
    });
    return { migrated: true, userId: id, email };
  },

  // -------------------------------------------------------------------------
  // Invites
  // -------------------------------------------------------------------------

  createInvite(input: {
    role: UserRole;
    email?: string;
    ttlHours?: number;
    linkedClientId?: string;
    createdByUserId: string;
  }): Invite {
    const code = `inv_${crypto.randomBytes(12).toString("hex")}`;
    const ttlMs = (input.ttlHours ?? 24 * 7) * 60 * 60 * 1000;
    const createdAt = now();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    sqlite
      .prepare(
        `
        INSERT INTO invites (
          code, role, email, expires_at, consumed_at, consumed_by_user_id,
          linked_client_id, created_at, created_by_user_id
        ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)
      `,
      )
      .run(
        code,
        input.role,
        input.email?.toLowerCase() ?? null,
        expiresAt,
        input.linkedClientId ?? null,
        createdAt,
        input.createdByUserId,
      );
    const invite: Invite = {
      code,
      role: input.role,
      email: input.email?.toLowerCase(),
      expiresAt,
      linkedClientId: input.linkedClientId,
      createdAt,
      createdByUserId: input.createdByUserId,
    };
    this.audit("invite.created", "invite", code, {
      role: input.role,
      email: input.email,
      createdByUserId: input.createdByUserId,
    });
    return invite;
  },

  getInvite(code: string): Invite | undefined {
    const row = sqlite.prepare("SELECT * FROM invites WHERE code = ?").get(code) as any;
    if (!row) return undefined;
    return {
      code: row.code,
      role: row.role,
      email: row.email ?? undefined,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at ?? undefined,
      consumedByUserId: row.consumed_by_user_id ?? undefined,
      linkedClientId: row.linked_client_id ?? undefined,
      createdAt: row.created_at,
      createdByUserId: row.created_by_user_id,
    };
  },

  consumeInvite(code: string, userId: string) {
    sqlite
      .prepare("UPDATE invites SET consumed_at = ?, consumed_by_user_id = ? WHERE code = ?")
      .run(now(), userId, code);
    this.audit("invite.consumed", "invite", code, { userId });
  },

  listInvites(filter?: { includeConsumed?: boolean }): Invite[] {
    let query = "SELECT * FROM invites";
    if (!filter?.includeConsumed) {
      query += " WHERE consumed_at IS NULL";
    }
    query += " ORDER BY created_at DESC";
    const rows = sqlite.prepare(query).all() as any[];
    return rows.map((row) => ({
      code: row.code,
      role: row.role,
      email: row.email ?? undefined,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at ?? undefined,
      consumedByUserId: row.consumed_by_user_id ?? undefined,
      linkedClientId: row.linked_client_id ?? undefined,
      createdAt: row.created_at,
      createdByUserId: row.created_by_user_id,
    }));
  },

  /**
   * Phase 3 invite creation. Unlike `createInvite`, the caller provides the
   * code (Phase 3 spec mandates `DOS-XXXX-XXXX-XXXX` format generated in the
   * routes layer so the same code can be embedded in the signup URL we return
   * to the admin). Throws if the code collides.
   */
  createInviteWithCode(input: {
    code: string;
    role: UserRole;
    email?: string;
    ttlHours?: number;
    linkedClientId?: string;
    createdByUserId: string;
  }): Invite {
    const ttlMs = (input.ttlHours ?? 72) * 60 * 60 * 1000;
    const createdAt = now();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    sqlite
      .prepare(
        `
        INSERT INTO invites (
          code, role, email, expires_at, consumed_at, consumed_by_user_id,
          linked_client_id, created_at, created_by_user_id
        ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)
      `,
      )
      .run(
        input.code,
        input.role,
        input.email?.toLowerCase() ?? null,
        expiresAt,
        input.linkedClientId ?? null,
        createdAt,
        input.createdByUserId,
      );
    const invite: Invite = {
      code: input.code,
      role: input.role,
      email: input.email?.toLowerCase(),
      expiresAt,
      linkedClientId: input.linkedClientId,
      createdAt,
      createdByUserId: input.createdByUserId,
    };
    // Audit (do NOT log linkedClientId payload as sensitive — but code is
    // already addressable by admin, so safe to include).
    this.audit("invite.created", "invite", input.code, {
      role: input.role,
      email: input.email,
      ttlHours: input.ttlHours ?? 72,
      linkedClientId: input.linkedClientId,
      createdByUserId: input.createdByUserId,
    });
    return invite;
  },

  /**
   * Cursor-paginated invite listing for the admin UI. Status semantics match
   * spec §2.2:
   *   active   = consumedAt IS NULL AND expiresAt >  now()
   *   expired  = consumedAt IS NULL AND expiresAt <= now()
   *   consumed = consumedAt IS NOT NULL
   *   all      = no status filter
   */
  listInvitesPaginated(filter: {
    limit?: number;
    cursor?: string;
    status?: "active" | "expired" | "consumed" | "all";
    role?: UserRole;
  }): { items: Invite[]; nextCursor: string | null; total: number } {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const status = filter.status ?? "active";

    const where: string[] = ["1=1"];
    const params: any[] = [];
    const nowIso = now();

    if (status === "active") {
      where.push("consumed_at IS NULL");
      where.push("expires_at > ?");
      params.push(nowIso);
    } else if (status === "expired") {
      where.push("consumed_at IS NULL");
      where.push("expires_at <= ?");
      params.push(nowIso);
    } else if (status === "consumed") {
      where.push("consumed_at IS NOT NULL");
    }
    if (filter.role) {
      where.push("role = ?");
      params.push(filter.role);
    }

    const countQuery = `SELECT COUNT(*) as c FROM invites WHERE ${where.join(" AND ")}`;
    const total = (sqlite.prepare(countQuery).get(...params) as { c: number }).c;

    if (filter.cursor) {
      where.push("created_at < ?");
      params.push(filter.cursor);
    }

    const listQuery = `SELECT * FROM invites WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`;
    const rows = sqlite.prepare(listQuery).all(...params, limit + 1) as any[];

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items: Invite[] = pageRows.map((row) => ({
      code: row.code,
      role: row.role,
      email: row.email ?? undefined,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at ?? undefined,
      consumedByUserId: row.consumed_by_user_id ?? undefined,
      linkedClientId: row.linked_client_id ?? undefined,
      createdAt: row.created_at,
      createdByUserId: row.created_by_user_id,
    }));
    const nextCursor = hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1].created_at : null;

    return { items, nextCursor, total };
  },

  /**
   * Soft-revoke an invite by setting expires_at = now(). Returns the revoked
   * invite, or `undefined` if not found, or `{ alreadyConsumed: true }` if it
   * was already consumed (the route layer maps that to HTTP 409).
   */
  revokeInvite(code: string, revokedByUserId: string):
    | { invite: Invite; revokedAt: string }
    | { notFound: true }
    | { alreadyConsumed: true } {
    const row = sqlite.prepare("SELECT * FROM invites WHERE code = ?").get(code) as any;
    if (!row) return { notFound: true };
    if (row.consumed_at) return { alreadyConsumed: true };
    const revokedAt = now();
    sqlite.prepare("UPDATE invites SET expires_at = ? WHERE code = ?").run(revokedAt, code);
    const invite: Invite = {
      code: row.code,
      role: row.role,
      email: row.email ?? undefined,
      expiresAt: revokedAt,
      consumedAt: undefined,
      consumedByUserId: undefined,
      linkedClientId: row.linked_client_id ?? undefined,
      createdAt: row.created_at,
      createdByUserId: row.created_by_user_id,
    };
    this.audit("invite.revoked", "invite", code, { code, revokedByUserId });
    return { invite, revokedAt };
  },

  // -------------------------------------------------------------------------
  // Assignments
  // -------------------------------------------------------------------------

  createAssignment(input: {
    clientId: string;
    dispatcherUserId: string;
    createdByUserId: string;
  }): Assignment {
    const id = makeId("asn");
    const createdAt = now();
    sqlite
      .prepare(
        `
        INSERT INTO assignments (
          id, client_id, dispatcher_user_id, created_at, created_by_user_id,
          removed_at, removed_by_user_id
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL)
      `,
      )
      .run(id, input.clientId, input.dispatcherUserId, createdAt, input.createdByUserId);
    const assignment: Assignment = {
      id,
      clientId: input.clientId,
      dispatcherUserId: input.dispatcherUserId,
      createdAt,
      createdByUserId: input.createdByUserId,
    };
    this.audit("assignment.created", "assignment", id, assignment);
    return assignment;
  },

  removeAssignment(id: string, removedByUserId: string) {
    sqlite
      .prepare("UPDATE assignments SET removed_at = ?, removed_by_user_id = ? WHERE id = ?")
      .run(now(), removedByUserId, id);
    this.audit("assignment.removed", "assignment", id, { removedByUserId });
  },

  listAssignmentsForDispatcher(dispatcherUserId: string): Assignment[] {
    const rows = sqlite
      .prepare(
        "SELECT * FROM assignments WHERE dispatcher_user_id = ? AND removed_at IS NULL ORDER BY created_at ASC",
      )
      .all(dispatcherUserId) as any[];
    return rows.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      dispatcherUserId: row.dispatcher_user_id,
      createdAt: row.created_at,
      createdByUserId: row.created_by_user_id,
    }));
  },

  listAssignmentsForClient(clientId: string): Assignment[] {
    const rows = sqlite
      .prepare(
        "SELECT * FROM assignments WHERE client_id = ? AND removed_at IS NULL ORDER BY created_at ASC",
      )
      .all(clientId) as any[];
    return rows.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      dispatcherUserId: row.dispatcher_user_id,
      createdAt: row.created_at,
      createdByUserId: row.created_by_user_id,
    }));
  },

  listAllActiveAssignments(): Assignment[] {
    const rows = sqlite
      .prepare("SELECT * FROM assignments WHERE removed_at IS NULL ORDER BY created_at ASC")
      .all() as any[];
    return rows.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      dispatcherUserId: row.dispatcher_user_id,
      createdAt: row.created_at,
      createdByUserId: row.created_by_user_id,
    }));
  },

  /**
   * Phase 3 (P1): fetch a single assignment by id, including the `removedAt`
   * fields if it has been soft-deleted. Returns undefined when the row does
   * not exist at all.
   */
  getAssignmentById(id: string): Assignment | undefined {
    const row = sqlite.prepare("SELECT * FROM assignments WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      clientId: row.client_id,
      dispatcherUserId: row.dispatcher_user_id,
      createdAt: row.created_at,
      createdByUserId: row.created_by_user_id,
      removedAt: row.removed_at ?? undefined,
      removedByUserId: row.removed_by_user_id ?? undefined,
    };
  },

  /**
   * Phase 3 (P1): find the active (not soft-deleted) assignment row for a
   * given client/dispatcher pair, if any. Used to enforce the "no duplicate
   * active" rule in POST /api/admin/assignments.
   *
   * NOTE: previously-removed pairs are intentionally NOT a conflict — admins
   * can re-assign after a remove.
   */
  findActiveAssignment(clientId: string, dispatcherUserId: string): Assignment | undefined {
    const row = sqlite
      .prepare(
        "SELECT * FROM assignments WHERE client_id = ? AND dispatcher_user_id = ? AND removed_at IS NULL LIMIT 1",
      )
      .get(clientId, dispatcherUserId) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      clientId: row.client_id,
      dispatcherUserId: row.dispatcher_user_id,
      createdAt: row.created_at,
      createdByUserId: row.created_by_user_id,
    };
  },

  /**
   * Phase 3 (P1): soft-delete by id with full return of the updated row.
   * Returns:
   *   - { notFound: true }       — no row with this id
   *   - { alreadyRemoved: true } — removed_at is already set
   *   - { assignment }           — successfully soft-deleted
   * Caller is expected to map these to 404/409/200.
   */
  removeAssignmentById(id: string, removedByUserId: string):
    | { assignment: Assignment }
    | { notFound: true }
    | { alreadyRemoved: true } {
    const existing = this.getAssignmentById(id);
    if (!existing) return { notFound: true };
    if (existing.removedAt) return { alreadyRemoved: true };
    const removedAt = now();
    sqlite
      .prepare("UPDATE assignments SET removed_at = ?, removed_by_user_id = ? WHERE id = ?")
      .run(removedAt, removedByUserId, id);
    this.audit("assignment.removed", "assignment", id, {
      assignmentId: id,
      removedByAdminId: removedByUserId,
    });
    return {
      assignment: {
        ...existing,
        removedAt,
        removedByUserId,
      },
    };
  },

  /**
   * Phase 3 (P1): cursor-paginated assignment list.
   *
   * Default behaviour matches spec §3.1: `includeRemoved=false` → only rows
   * with `removed_at IS NULL` are returned. Set `includeRemoved=true` for
   * the soft-delete history (used by audit-trail views and future Phase 5
   * reports — this is a feature, not a leak).
   */
  listAssignmentsPaginated(filter: {
    limit?: number;
    cursor?: string;
    dispatcherId?: string;
    clientId?: string;
    includeRemoved?: boolean;
  }): { items: Assignment[]; nextCursor: string | null; total: number } {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);

    const where: string[] = ["1=1"];
    const params: any[] = [];

    if (!filter.includeRemoved) {
      where.push("removed_at IS NULL");
    }
    if (filter.dispatcherId) {
      where.push("dispatcher_user_id = ?");
      params.push(filter.dispatcherId);
    }
    if (filter.clientId) {
      where.push("client_id = ?");
      params.push(filter.clientId);
    }

    const countQuery = `SELECT COUNT(*) as c FROM assignments WHERE ${where.join(" AND ")}`;
    const total = (sqlite.prepare(countQuery).get(...params) as { c: number }).c;

    if (filter.cursor) {
      where.push("created_at < ?");
      params.push(filter.cursor);
    }

    const listQuery = `SELECT * FROM assignments WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`;
    const rows = sqlite.prepare(listQuery).all(...params, limit + 1) as any[];

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items: Assignment[] = pageRows.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      dispatcherUserId: row.dispatcher_user_id,
      createdAt: row.created_at,
      createdByUserId: row.created_by_user_id,
      removedAt: row.removed_at ?? undefined,
      removedByUserId: row.removed_by_user_id ?? undefined,
    }));
    const nextCursor = hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1].created_at : null;

    return { items, nextCursor, total };
  },

  // -------------------------------------------------------------------------
  // Invoices (defined for contract; Phase 3 adds endpoints)
  // -------------------------------------------------------------------------

  createInvoice(input: {
    clientId: string;
    weekStart: string;
    weekEnd: string;
    flatFee: number;
    percentFee: number;
    grossBooked: number;
    notes?: string;
  }): Invoice {
    const id = makeId("inv");
    const totalDue = input.flatFee + input.percentFee;
    const generatedAt = now();
    sqlite
      .prepare(
        `
        INSERT INTO invoices (
          id, client_id, week_start, week_end, flat_fee, percent_fee,
          gross_booked, total_due, status, generated_at, sent_at, paid_at, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, NULL, NULL, ?)
      `,
      )
      .run(
        id,
        input.clientId,
        input.weekStart,
        input.weekEnd,
        input.flatFee,
        input.percentFee,
        input.grossBooked,
        totalDue,
        generatedAt,
        input.notes ?? null,
      );
    const invoice: Invoice = {
      id,
      clientId: input.clientId,
      weekStart: input.weekStart,
      weekEnd: input.weekEnd,
      flatFee: input.flatFee,
      percentFee: input.percentFee,
      grossBooked: input.grossBooked,
      totalDue,
      status: "draft",
      generatedAt,
      notes: input.notes,
    };
    this.audit("invoice.created", "invoice", id, invoice);
    return invoice;
  },

  listInvoices(filter?: { clientId?: string }): Invoice[] {
    let query = "SELECT * FROM invoices";
    const params: any[] = [];
    if (filter?.clientId) {
      query += " WHERE client_id = ?";
      params.push(filter.clientId);
    }
    query += " ORDER BY generated_at DESC";
    const rows = sqlite.prepare(query).all(...params) as any[];
    return rows.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      weekStart: row.week_start,
      weekEnd: row.week_end,
      flatFee: row.flat_fee,
      percentFee: row.percent_fee,
      grossBooked: row.gross_booked,
      totalDue: row.total_due,
      status: row.status,
      generatedAt: row.generated_at,
      sentAt: row.sent_at ?? undefined,
      paidAt: row.paid_at ?? undefined,
      notes: row.notes ?? undefined,
    }));
  },

  // -------------------------------------------------------------------------
  // Clients (unchanged from v1.2.7)
  // -------------------------------------------------------------------------

  listClients(): Client[] {
    const rows = sqlite
      .prepare("SELECT payload FROM clients ORDER BY created_at ASC")
      .all() as Array<{ payload: string }>;
    return parsePayloads<Client>(rows);
  },

  getClient(id: string): Client | undefined {
    const row = sqlite.prepare("SELECT payload FROM clients WHERE id = ?").get(id) as
      | { payload: string }
      | undefined;
    return parsePayload<Client>(row);
  },

  upsertClient(input: InsertClient): Client {
    const id = input.id || makeId("client");
    const existing = this.getClient(id);
    const client = { ...input, id } as Client;
    const timestamp = now();

    sqlite
      .prepare(
        `
        INSERT INTO clients (id, payload, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
      `,
      )
      .run(id, JSON.stringify(client), existing ? timestamp : timestamp, timestamp);

    this.audit(existing ? "client.updated" : "client.created", "client", id, client);
    return client;
  },

  updateClientLocation(id: string, location: Partial<DriverLocation>): Client | undefined {
    const client = this.getClient(id);
    if (!client) return undefined;

    const updated: Client = {
      ...client,
      currentLocation: {
        ...client.currentLocation,
        ...location,
        updatedAt: location.updatedAt || now(),
        availableAt: location.availableAt || client.currentLocation.availableAt,
      },
    };
    return this.upsertClient(updated);
  },

  // -------------------------------------------------------------------------
  // Loads (unchanged from v1.2.7)
  // -------------------------------------------------------------------------

  listLoads(): Load[] {
    const rows = sqlite
      .prepare("SELECT payload FROM loads ORDER BY created_at ASC")
      .all() as Array<{ payload: string }>;
    return parsePayloads<Load>(rows);
  },

  getLoad(id: string): Load | undefined {
    const row = sqlite.prepare("SELECT payload FROM loads WHERE id = ?").get(id) as
      | { payload: string }
      | undefined;
    return parsePayload<Load>(row);
  },

  upsertLoad(input: InsertLoad): Load {
    const id = input.id || makeId("load");
    const existing = this.getLoad(id);
    const load = { ...input, id } as Load;
    const timestamp = now();

    sqlite
      .prepare(
        `
        INSERT INTO loads (id, payload, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
      `,
      )
      .run(id, JSON.stringify(load), existing ? timestamp : timestamp, timestamp);

    this.audit(existing ? "load.updated" : "load.created", "load", id, load);
    return load;
  },

  // -------------------------------------------------------------------------
  // Audit + Documents + Brokers + Email (unchanged from v1.2.7)
  // -------------------------------------------------------------------------

  audit(eventType: string, entityType: string, entityId: string, payload: unknown) {
    sqlite
      .prepare(
        `
        INSERT INTO audit_events (id, event_type, entity_type, entity_id, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(makeId("audit"), eventType, entityType, entityId, JSON.stringify(payload), now());
  },

  listAuditEvents(limit = 50) {
    return sqlite
      .prepare(
        "SELECT id, event_type as eventType, entity_type as entityType, entity_id as entityId, payload, created_at as createdAt FROM audit_events ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit)
      .map((row: any) => ({ ...row, payload: JSON.parse(row.payload) }));
  },

  listDocuments(): DocumentRecord[] {
    const rows = sqlite
      .prepare("SELECT payload FROM documents ORDER BY created_at DESC")
      .all() as Array<{ payload: string }>;
    return parsePayloads<DocumentRecord>(rows);
  },

  upsertDocument(input: InsertDocument): DocumentRecord {
    const id = input.id || makeId("doc");
    const document = {
      ...input,
      id,
      createdAt: input.createdAt || now(),
    } as DocumentRecord;
    const timestamp = now();
    sqlite
      .prepare(
        `
        INSERT INTO documents (id, payload, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
      `,
      )
      .run(id, JSON.stringify(document), document.createdAt, timestamp);
    this.audit("document.saved", "document", id, document);
    return document;
  },

  saveUploadedDocument(
    input: InsertDocument,
    file: { originalname: string; filename: string; path: string },
  ): DocumentRecord {
    return this.upsertDocument({
      ...input,
      fileName: input.fileName || file.originalname,
      storageUrl: file.path,
      notes: [input.notes, `Stored locally as ${file.filename}`].filter(Boolean).join(" | "),
    });
  },

  listBrokerRecords(): BrokerRecord[] {
    const rows = sqlite
      .prepare("SELECT payload FROM broker_records ORDER BY updated_at DESC")
      .all() as Array<{ payload: string }>;
    return parsePayloads<BrokerRecord>(rows);
  },

  upsertBrokerRecord(record: BrokerRecord): BrokerRecord {
    const existing = sqlite
      .prepare("SELECT payload FROM broker_records WHERE broker_mc = ?")
      .get(record.brokerMc) as { payload: string } | undefined;
    const timestamp = now();
    sqlite
      .prepare(
        `
        INSERT INTO broker_records (id, broker_mc, payload, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(broker_mc) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
      `,
      )
      .run(record.id, record.brokerMc, JSON.stringify(record), existing ? timestamp : timestamp, timestamp);
    this.audit("broker.checked", "broker", record.brokerMc, record);
    return record;
  },

  saveEmailIngest(payload: unknown) {
    const id = makeId("email");
    sqlite
      .prepare("INSERT INTO email_ingest (id, payload, created_at) VALUES (?, ?, ?)")
      .run(id, JSON.stringify(payload), now());
    this.audit("email.ingested", "email", id, payload);
    return { id, ...(payload as object), createdAt: now() };
  },

  listEmailIngest(limit = 50) {
    return sqlite
      .prepare(
        "SELECT id, payload, created_at as createdAt FROM email_ingest ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit)
      .map((row: any) => ({ id: row.id, ...JSON.parse(row.payload), createdAt: row.createdAt }));
  },

  // -------------------------------------------------------------------------
  // Backup export
  // -------------------------------------------------------------------------

  exportBackup() {
    // Users included WITHOUT secrets. Sessions never included.
    const usersPublic = this.listUsers({ includeBlocked: true }).map((u) => this.toUserPublic(u));
    return {
      version: "1.3.0-phase1",
      exportedAt: now(),
      clients: this.listClients(),
      loads: this.listLoads(),
      documents: this.listDocuments(),
      brokerRecords: this.listBrokerRecords(),
      emailIngest: this.listEmailIngest(1000),
      auditEvents: this.listAuditEvents(1000),
      users: usersPublic,
      invites: this.listInvites({ includeConsumed: true }).map((i) => ({
        ...i,
        // code is itself a credential at creation time, but post-consume it's
        // safe; pre-consume invites in export = a potential leak. We strip
        // codes for non-consumed entries.
        code: i.consumedAt ? i.code : "[redacted]",
      })),
      assignments: this.listAllActiveAssignments(),
      invoices: this.listInvoices(),
      auth: {
        isConfigured: this.getAuthState().isConfigured,
        note: "Secrets, password hashes, and TOTP secrets are intentionally excluded from backup export.",
      },
    };
  },
};
