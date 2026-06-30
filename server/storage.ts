import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { marketQualityFor } from "./lib/ai/lanes";
import type {
  ApprovalTask,
  ApprovalTaskStatus,
  ApprovalTaskType,
  Assignment,
  BrokerEvent,
  BrokerEventType,
  BrokerRecord,
  CheckinKind,
  Client,
  DocumentRecord,
  DriverDocument,
  DriverDocumentType,
  DriverExpense,
  DriverLocation,
  DriverStatus,
  Equipment,
  ExpenseCategory,
  FuelTransaction,
  InsertClient,
  InsertDocument,
  InsertLoad,
  Invite,
  Invoice,
  Load,
  LoadCheckin,
  PendingDoc,
  SignupLead,
  SignupLeadStatus,
  UserPublic,
  UserRole,
} from "@shared/schema";

function cryptoRandomId(): string {
  return crypto.randomBytes(12).toString("hex");
}

function rowToSignupLead(row: Record<string, unknown>): SignupLead {
  return {
    id: row.id as string,
    email: row.email as string,
    lang: (row.lang as string | null) ?? null,
    country: (row.country as string | null) ?? null,
    userAgent: (row.user_agent as string | null) ?? null,
    referer: (row.referer as string | null) ?? null,
    status: row.status as SignupLeadStatus,
    approvedInviteCode: (row.approved_invite_code as string | null) ?? null,
    reviewedByUserId: (row.reviewed_by_user_id as string | null) ?? null,
    reviewedAt: (row.reviewed_at as string | null) ?? null,
    rejectReason: (row.reject_reason as string | null) ?? null,
    createdAt: row.created_at as string,
    name: (row.name as string | null) ?? null,
    note: (row.note as string | null) ?? null,
  };
}

// SQL predicate for an "active" (booked-and-still-in-progress) load. booked_at
// is the booked marker (and the revenue-window key, so it's never cleared on
// delivery); delivery/cancellation state lives in the JSON payload. A load is
// active when it's booked and NOT completed/cancelled/delivered. COALESCE keeps
// loads with no status field (NULL) counted as active. Used by workload counts
// (NOT by revenue queries, which intentionally include delivered loads).
const ACTIVE_LOAD_SQL = `booked_at IS NOT NULL
  AND COALESCE(json_extract(payload, '$.status'), '') NOT IN ('completed', 'cancelled', 'canceled')
  AND json_extract(payload, '$.deliveredAt') IS NULL
  AND json_extract(payload, '$.delivered_at') IS NULL`;

function rowToFuelTransaction(row: Record<string, unknown>): FuelTransaction {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    clientId: (row.client_id as string | null) ?? null,
    loadId: (row.load_id as string | null) ?? null,
    stationName: (row.station_name as string | null) ?? null,
    stationLat: (row.station_lat as number | null) ?? null,
    stationLng: (row.station_lng as number | null) ?? null,
    fuelType: row.fuel_type as string,
    gallons: row.gallons as number,
    pricePerGallonCents: row.price_per_gallon_cents as number,
    totalCents: row.total_cents as number,
    odometerMiles: (row.odometer_miles as number | null) ?? null,
    receiptStoragePath: (row.receipt_storage_path as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    occurredAt: row.occurred_at as string,
    createdAt: row.created_at as string,
  };
}

function rowToBrokerEvent(row: Record<string, unknown>): BrokerEvent {
  return {
    id: row.id as string,
    brokerMc: row.broker_mc as string,
    eventType: row.event_type as BrokerEventType,
    loadId: (row.load_id as string | null) ?? null,
    amountUsd: (row.amount_usd as number | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    loggedByUserId: row.logged_by_user_id as string,
    loggedAt: row.logged_at as string,
  };
}

const sqlite = new Database(process.env.DISPATCHOS_DB_PATH || "dispatchos-unified.db");

// Per-user daily AI request quota (free tier). Beyond it, purchased ai_credits
// are consumed (see consumeAiQuota). Haiku 4.5 ~ $0.003/call, so 50/day ~ $2/mo
// worst case; the cap is mainly anti-abuse, not per-user cost.
export const AI_DAILY_FREE_QUOTA = 50;
sqlite.pragma("journal_mode = WAL");
// better-sqlite3 defaults to a 0ms busy timeout, so a writer hitting a
// momentarily-locked DB (e.g. the 5-min load-sources poll upserting while a user
// request also writes) throws SQLITE_BUSY immediately instead of waiting. Give
// writers a 5s window to retry-wait before failing.
sqlite.pragma("busy_timeout = 5000");

/**
 * Checkpoint the WAL and close the DB cleanly on shutdown. Without this, every
 * Fly rolling deploy (SIGTERM) leaves a growing -wal that's never truncated and
 * risks corruption if SIGKILL lands mid-checkpoint. Safe to call once at exit.
 */
export function closeDatabase(): void {
  try {
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
  } catch (err) {
    console.error("[storage] wal_checkpoint failed:", err);
  }
  try {
    sqlite.close();
  } catch (err) {
    console.error("[storage] sqlite.close failed:", err);
  }
}

/**
 * Produce a CONSISTENT online snapshot of the live DB into destPath, without
 * locking the app. better-sqlite3's .backup() runs the SQLite online-backup
 * API on a separate connection and resolves a Promise when done, so this never
 * blocks the event loop for the duration of the copy. The destination directory
 * must already exist (the caller is responsible for mkdir). Re-uses the open
 * `sqlite` handle so backup callers never re-open the file.
 */
export async function backupDatabaseTo(destPath: string): Promise<void> {
  await sqlite.backup(destPath);
}

// Audit Critical #5 (2026-05-26): включаем FK enforcement на все будущие
// CREATE TABLE с FOREIGN KEY clauses. Существующие таблицы FK в DDL не имеют
// — этот флаг НИЧЕГО не ломает в текущей базе, но разблокирует возможность
// декларировать FK на новых таблицах и в будущих миграциях без сюрпризов.
// SQLite ships FK OFF by default; без этого PRAGMA REFERENCES clause — no-op.
sqlite.pragma("foreign_keys = ON");

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
  updated_at TEXT NOT NULL,
  client_id TEXT,
  booked_at TEXT
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
  last_login_at TEXT,
  subscription_ends_at TEXT
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
  created_by_user_id TEXT NOT NULL,
  subscription_days INTEGER
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

-- Keyset (seek) pagination: a unique PK tiebreaker after the order column makes
-- cursor pages stable when rows share a created_at/generated_at. These cover both
-- the keyset predicate and the ORDER BY (col DESC, pk DESC) in one index.
CREATE INDEX IF NOT EXISTS users_created_at_id_idx ON users(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS invites_created_at_code_idx ON invites(created_at DESC, code DESC);
CREATE INDEX IF NOT EXISTS assignments_created_at_id_idx ON assignments(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS invoices_generated_at_id_idx ON invoices(generated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_events_created_at_id_idx ON audit_events(created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS signup_leads (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  lang TEXT,
  country TEXT,
  user_agent TEXT,
  referer TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  approved_invite_code TEXT,
  reviewed_by_user_id TEXT,
  reviewed_at TEXT,
  reject_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signup_leads_status_created_idx
  ON signup_leads(status, created_at DESC);
CREATE INDEX IF NOT EXISTS signup_leads_created_at_id_idx
  ON signup_leads(created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS signup_leads_email_pending_idx
  ON signup_leads(email) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS broker_events (
  id TEXT PRIMARY KEY,
  broker_mc TEXT NOT NULL,
  event_type TEXT NOT NULL,
  load_id TEXT,
  amount_usd REAL,
  notes TEXT,
  logged_by_user_id TEXT NOT NULL,
  logged_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS broker_events_mc_logged_idx
  ON broker_events(broker_mc, logged_at DESC);
CREATE INDEX IF NOT EXISTS broker_events_load_idx
  ON broker_events(load_id) WHERE load_id IS NOT NULL;
`);

// ---------------------------------------------------------------------------
// Phase 3 P2: idempotent ALTER for existing DBs (Phase 1 / Phase 2 deployments).
// CREATE TABLE above only adds columns on fresh DBs; for an existing DB we
// detect missing columns via PRAGMA and ALTER. SQLite has no
// "ADD COLUMN IF NOT EXISTS", so we guard manually.
//
// IMPORTANT — this MUST run before any CREATE INDEX that references the new
// columns, otherwise SQLite errors out on a freshly-upgraded Phase 1/2 DB
// where the loads table doesn't yet have client_id / booked_at.
// ---------------------------------------------------------------------------
function ensureLoadBookingColumns() {
  const cols = sqlite.prepare("PRAGMA table_info(loads)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("client_id")) {
    sqlite.exec("ALTER TABLE loads ADD COLUMN client_id TEXT");
  }
  if (!names.has("booked_at")) {
    sqlite.exec("ALTER TABLE loads ADD COLUMN booked_at TEXT");
  }
}
ensureLoadBookingColumns();

// Phase 3 P2: indexed lookup for billing (loads filtered by client + week).
// Created AFTER ensureLoadBookingColumns so the columns are guaranteed to
// exist on both fresh and migrated databases.
sqlite.exec("CREATE INDEX IF NOT EXISTS loads_client_booked_idx ON loads(client_id, booked_at)");

// ---------------------------------------------------------------------------
// Phase 4 P0: idempotent ALTER for driver portal columns.
//
// Adds:
//   - loads.driver_id              — mirror of payload.driverId; drives
//                                     /api/me/loads tenant scoping and the
//                                     loads_driver_id_idx for fast cursor pages.
//   - users.phone                  — optional contact phone, surfaced in
//                                     UserPublic + dashboards.
//   - users.driver_status          — TEXT, NOT NULL DEFAULT 'available'. Only
//                                     meaningful for role='driver'; toUserPublic
//                                     hides it for other roles. We keep stale
//                                     values across role changes (cheap, see §2
//                                     of the Phase 4 handoff Q3 confirmation).
//
// Same PRAGMA pattern as ensureLoadBookingColumns: existing DBs (Vlad's
// dev DB has an admin row already) get ALTERed without dropping data; fresh
// DBs would already have the columns from CREATE TABLE — but since CREATE
// TABLE above is locked to the Phase 1 shape, the ALTER path is the source
// of truth and runs even on a freshly-created DB. CREATE INDEX must come
// AFTER these helpers, never inline above.
// ---------------------------------------------------------------------------
function ensureLoadDriverColumn() {
  const cols = sqlite.prepare("PRAGMA table_info(loads)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("driver_id")) {
    sqlite.exec("ALTER TABLE loads ADD COLUMN driver_id TEXT");
  }
}
ensureLoadDriverColumn();

// Phase 6 load_sources: dedup loads by upstream id. Both nullable so legacy
// CSV/manual loads keep working unchanged. UNIQUE partial index ensures
// dedup only on rows that came from an adapter.
function ensureLoadSourceColumns() {
  const cols = sqlite.prepare("PRAGMA table_info(loads)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("source_id")) {
    sqlite.exec("ALTER TABLE loads ADD COLUMN source_id TEXT");
  }
  if (!names.has("source_external_id")) {
    sqlite.exec("ALTER TABLE loads ADD COLUMN source_external_id TEXT");
  }
}
ensureLoadSourceColumns();
sqlite.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS loads_source_external_uq ON loads(source_id, source_external_id) WHERE source_id IS NOT NULL",
);

// email_ingest dedup: the messageId was only ever buried in the JSON payload, so
// replaying a POST /api/inbound/email (or a cron re-parse) minted a fresh row +
// downstream load every time. Promote messageId to a real nullable column with a
// UNIQUE partial index (only on rows that HAVE a messageId), so saveEmailIngest
// can be idempotent without rebuilding the table. Rows without a messageId keep
// inserting freely (NULLs are exempt from the partial index). The backfill stamps
// message_id from existing payloads exactly once, on the boot that adds the column.
function ensureEmailIngestMessageIdColumn() {
  const cols = sqlite.prepare("PRAGMA table_info(email_ingest)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "message_id")) {
    sqlite.exec("ALTER TABLE email_ingest ADD COLUMN message_id TEXT");
    // One-time backfill from the JSON payload for rows that predate this column.
    sqlite.exec(
      "UPDATE email_ingest SET message_id = json_extract(payload, '$.messageId') WHERE message_id IS NULL AND json_extract(payload, '$.messageId') IS NOT NULL",
    );
  }
}
ensureEmailIngestMessageIdColumn();
sqlite.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS email_ingest_message_id_uq ON email_ingest(message_id) WHERE message_id IS NOT NULL",
);

// Audit actor denormalization: the actor was only ever embedded in the JSON
// payload, so the audit log had to filter by actor in JS AFTER fetching a page —
// which made `total`, `hasMore` and `nextCursor` inaccurate when actorId was set.
// Promote the actor to a real column (+ index) so the filter runs in SQL. The
// backfill runs exactly once, on the boot that first adds the column.
// (pluckActorIdFromPayload is a hoisted function declaration, callable here.)
function ensureAuditActorColumn() {
  const cols = sqlite.prepare("PRAGMA table_info(audit_events)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("actor_user_id")) {
    sqlite.exec("ALTER TABLE audit_events ADD COLUMN actor_user_id TEXT");
    const rows = sqlite
      .prepare("SELECT id, payload FROM audit_events")
      .all() as Array<{ id: string; payload: string }>;
    const upd = sqlite.prepare("UPDATE audit_events SET actor_user_id = ? WHERE id = ?");
    const backfill = sqlite.transaction(() => {
      for (const r of rows) {
        let actor: string | null = null;
        try { actor = pluckActorIdFromPayload(JSON.parse(r.payload)); } catch { /* skip bad payload */ }
        if (actor) upd.run(actor, r.id);
      }
    });
    backfill();
  }
}
ensureAuditActorColumn();
sqlite.exec(
  "CREATE INDEX IF NOT EXISTS audit_events_actor_created_id_idx ON audit_events(actor_user_id, created_at DESC, id DESC)",
);

// Enforce "one invoice per client per week" at the DB level — the app-level
// pre-check (findOverlappingInvoice then insert) is TOCTOU-racy, so two
// concurrent generate calls could double-bill a carrier.
//
// The index is PARTIAL: it ignores voided invoices (WHERE status != 'void').
// A full unique index permanently blocked re-billing a (client, week) once any
// invoice existed for it — even a later-voided one — so voiding a wrong invoice
// made the carrier-week un-billable and the generate endpoint 500'd on the
// UNIQUE violation. Excluding void rows lets a voided week be re-billed while
// still blocking a duplicate of a live (non-void) invoice.
//
// Migration is idempotent (re-runnable every boot): drop the old full index if
// present, then create the partial one. This is safe because the old full index
// guaranteed no duplicate (client, week) rows exist at all, so the more lenient
// partial index always builds. Created defensively: a legacy DB that somehow
// holds duplicate non-void rows would reject the partial index, so we log and
// fall back to the app-level guard rather than crash on boot.
try {
  // Old index was the full UNIQUE(client_id, week_start). Drop it before
  // creating the partial replacement so the void-exclusion actually takes
  // effect on DBs that booted under the old DDL.
  sqlite.exec("DROP INDEX IF EXISTS invoices_client_week_uq");
  sqlite.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS invoices_client_week_uq ON invoices(client_id, week_start) WHERE status != 'void'",
  );
} catch (err) {
  console.warn(
    "[invoices] could not create partial UNIQUE(client_id, week_start) WHERE status != 'void' index — pre-existing duplicate non-void rows?",
    (err as Error).message,
  );
}

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS load_sources (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    adapter_key TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    config_json TEXT NOT NULL DEFAULT '{}',
    credentials_enc TEXT,
    credentials_iv TEXT,
    credentials_key_id TEXT,
    poll_interval_min INTEGER NOT NULL DEFAULT 5,
    last_polled_at TEXT,
    last_loads_found INTEGER NOT NULL DEFAULT 0,
    last_error_at TEXT,
    last_error_msg TEXT,
    failure_streak INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT
  )
`);
sqlite.exec("CREATE INDEX IF NOT EXISTS load_sources_adapter_status_idx ON load_sources(adapter_key, status)");
sqlite.exec("CREATE INDEX IF NOT EXISTS load_sources_client_idx ON load_sources(client_id)");
sqlite.exec("CREATE INDEX IF NOT EXISTS load_sources_poll_idx ON load_sources(status, last_polled_at)");

function ensureUserDriverColumns() {
  const cols = sqlite.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("phone")) {
    sqlite.exec("ALTER TABLE users ADD COLUMN phone TEXT");
  }
  if (!names.has("driver_status")) {
    // NOT NULL with literal default — existing rows backfill to 'available'.
    // (Per SQLite ALTER TABLE rules, NOT NULL is allowed when a literal
    //  DEFAULT is supplied.)
    sqlite.exec("ALTER TABLE users ADD COLUMN driver_status TEXT NOT NULL DEFAULT 'available'");
  }

  if (!names.has("telegram_chat_id")) {
    sqlite.exec("ALTER TABLE users ADD COLUMN telegram_chat_id TEXT");
  }
  if (!names.has("deleted_at")) {
    // Soft-delete marker. Nullable; set to ISO timestamp when an admin
    // removes a user. Kept for FK integrity with loads/audit/assignments.
    sqlite.exec("ALTER TABLE users ADD COLUMN deleted_at TEXT");
  }
  // Phase 7 — GPS tracking. Last-known position cached on the user row for
  // fast read on dashboards / cockpit. Full history lives in
  // driver_location_pings (15-day rolling window).
  if (!names.has("last_lat")) {
    sqlite.exec("ALTER TABLE users ADD COLUMN last_lat REAL");
  }
  if (!names.has("last_lng")) {
    sqlite.exec("ALTER TABLE users ADD COLUMN last_lng REAL");
  }
  if (!names.has("last_location_at")) {
    sqlite.exec("ALTER TABLE users ADD COLUMN last_location_at TEXT");
  }
  if (!names.has("last_location_accuracy_m")) {
    sqlite.exec("ALTER TABLE users ADD COLUMN last_location_accuracy_m REAL");
  }
  if (!names.has("last_location_source")) {
    // osmand | owntracks | telegram_live | crowdsource | manual
    sqlite.exec("ALTER TABLE users ADD COLUMN last_location_source TEXT");
  }
  if (!names.has("tracking_token")) {
    // Per-driver shared secret. Drivers paste this into Traccar Client /
    // Owntracks as the device id. We index on it for O(1) ping lookup.
    sqlite.exec("ALTER TABLE users ADD COLUMN tracking_token TEXT");
  }
  if (!names.has("last_seen_at")) {
    // Phase 7 — online presence. Every authenticated /api request bumps
    // this column (throttled in-process to 30s/user). Online =
    // (now - last_seen_at) < 2 minutes.
    sqlite.exec("ALTER TABLE users ADD COLUMN last_seen_at TEXT");
  }
  if (!names.has("last_used_totp_counter")) {
    // Audit High #11 — TOTP replay protection.
    // Stores the most-recently-accepted RFC 6238 counter for this user.
    // verifyTotp() rejects any code whose counter is <= this value,
    // preventing replay of an observed 6-digit code within its ±1 window.
    sqlite.exec("ALTER TABLE users ADD COLUMN last_used_totp_counter INTEGER");
  }
  if (!names.has("preferred_lang")) {
    // i18n — persisted UI language choice. NULL = user has not picked yet,
    // client falls back to localStorage / browser locale. 'ru' | 'en'.
    sqlite.exec("ALTER TABLE users ADD COLUMN preferred_lang TEXT");
  }
  // Henry QA Bug #5 — truck unit number. Only meaningful for role='driver';
  // dispatchers/admins see it in the user list and can set it on driver cards.
  // NULL = not assigned. Short free-form string (e.g. "Unit 42", "T-07").
  if (!names.has("unit_number")) {
    sqlite.exec("ALTER TABLE users ADD COLUMN unit_number TEXT");
  }
  // Session epoch — bumped on admin password/TOTP reset to invalidate all of a
  // user's existing sessions. getCurrentUser compares req.session.epoch to this;
  // a mismatch destroys the stale session. Default 0; legacy sessions (no epoch
  // in the cookie) read as 0 and match, so a deploy doesn't force re-login.
  if (!names.has("session_epoch")) {
    sqlite.exec("ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0");
  }
  // fix/totp-onboarding-verify (2026-05-27) — Henry's QA bug.
  // NULL = user has never successfully entered a TOTP code after signup.
  // New signups stay NULL until POST /api/auth/totp/confirm-signup succeeds.
  // Existing users who have logged in before are backfilled to created_at
  // (they obviously set up TOTP successfully at some point).
  if (!names.has("totp_confirmed_at")) {
    sqlite.exec("ALTER TABLE users ADD COLUMN totp_confirmed_at TEXT");
    // Backfill: anyone who has logged in at least once AND has a totp_secret
    // has clearly completed 2FA setup — auto-confirm them so they aren't
    // retroactively locked out by the new gate.
    sqlite.exec(`
      UPDATE users
      SET totp_confirmed_at = created_at
      WHERE totp_secret IS NOT NULL
        AND last_login_at IS NOT NULL
        AND totp_confirmed_at IS NULL
    `);
  }
  // feat/twilio-verify-phone-email — phone + email verification columns.
  if (!names.has("phone_verified")) {
    sqlite.exec(
      "ALTER TABLE users ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 0",
    );
    // Partial UNIQUE index: one verified number per account; unverified NULL unconstrained.
    sqlite.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS users_phone_verified_unique ON users(phone) WHERE phone_verified = 1",
    );
  }
  if (!names.has("phone_verified_at")) {
    sqlite.exec("ALTER TABLE users ADD COLUMN phone_verified_at TEXT");
  }
  if (!names.has("email_verified_at")) {
    sqlite.exec("ALTER TABLE users ADD COLUMN email_verified_at TEXT");
  }
}

// ---------------------------------------------------------------------------
// Phase 7.2 — Insurance expiry alert log (anti-duplicate)
// ---------------------------------------------------------------------------
// One row per (client, insurance_type, days_before) once an alert is sent.
// Cron checks existence here before sending to avoid spamming Tg/email every
// day for the same upcoming expiry. Rows persist for audit — don't expire.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS insurance_alerts_sent (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    insurance_type TEXT NOT NULL,  -- cargo | auto_liability | general_liability
    expires_at TEXT NOT NULL,      -- the expiry date the alert was about
    days_before INTEGER NOT NULL,  -- 14 | 7 | 3 | 1
    sent_at TEXT NOT NULL,
    channels TEXT NOT NULL         -- JSON array, e.g. ["telegram","email"]
  );
  CREATE INDEX IF NOT EXISTS insurance_alerts_lookup_idx
    ON insurance_alerts_sent(client_id, insurance_type, expires_at, days_before);

  -- Killer feature #5 — UCR/IRP renewal calendar. Same shape as insurance_alerts_sent.
  CREATE TABLE IF NOT EXISTS compliance_alerts_sent (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    kind TEXT NOT NULL,            -- ucr | irp
    expires_at TEXT NOT NULL,
    days_before INTEGER NOT NULL,
    sent_at TEXT NOT NULL,
    channels TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS compliance_alerts_lookup_idx
    ON compliance_alerts_sent(client_id, kind, expires_at, days_before);

  -- P0.4/P0.5 — matched-load push de-dup. One row per (load, chat) we alerted,
  -- so a high-score load is pushed to a given recipient at most once even if the
  -- poller re-scores it on a later run. UNIQUE backstops a race between two
  -- concurrent poll passes. Rows persist (cheap) — purge with loads if needed.
  CREATE TABLE IF NOT EXISTS load_alerts_sent (
    id TEXT PRIMARY KEY,
    load_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    dispatch_score INTEGER NOT NULL,
    sent_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS load_alerts_sent_unique_idx
    ON load_alerts_sent(load_id, chat_id);

  -- Pickup-reminder de-dup. One row per (load, driver) reminded, so the cron
  -- pings the assigned driver at most once as a load's pickup window approaches
  -- even though the cron re-runs and the load stays in the lead-time window.
  CREATE TABLE IF NOT EXISTS pickup_reminders_sent (
    id TEXT PRIMARY KEY,
    load_id TEXT NOT NULL,
    driver_id TEXT NOT NULL,
    pickup_at TEXT NOT NULL,
    sent_at TEXT NOT NULL
  );
  -- De-dup keyed on (load, driver, pickup_at): a load whose pickup window is
  -- RESCHEDULED (broker moves it / re-ingested with a new pickupAt) must produce
  -- a fresh reminder. The old 2-col index (load_id, driver_id) suppressed that
  -- forever; drop it so the 3-col index below applies on existing DBs too.
  DROP INDEX IF EXISTS pickup_reminders_sent_unique_idx;
  CREATE UNIQUE INDEX IF NOT EXISTS pickup_reminders_sent_unique_idx
    ON pickup_reminders_sent(load_id, driver_id, pickup_at);
`);

// ---------------------------------------------------------------------------
// Phase 7.1 — Integration configs (UI-editable secrets, encrypted at rest)
// ---------------------------------------------------------------------------
// One row per env-var-equivalent. Plain text NEVER stored. Values are read
// at runtime via getIntegrationValue() (server/lib/integration-config.ts)
// which falls back to process.env if the DB row is absent.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS integration_configs (
    integration_key TEXT NOT NULL,    -- 'fmcsa', 'twilio', etc — matches INTEGRATIONS registry
    env_var TEXT NOT NULL,            -- 'FMCSA_WEB_KEY', 'TWILIO_AUTH_TOKEN', ...
    value_enc TEXT NOT NULL,          -- ciphertext (base64)
    value_iv TEXT NOT NULL,           -- IV (base64)
    value_key_id TEXT NOT NULL,       -- which keyring slot used
    updated_at TEXT NOT NULL,
    updated_by_user_id TEXT,
    PRIMARY KEY (integration_key, env_var)
  );

  -- Onboarding wizard state machine (per user request 2026-05-26).
  -- One row per user that has started but not completed onboarding;
  -- row is preserved post-completion for audit + step revisits.
  CREATE TABLE IF NOT EXISTS onboarding_progress (
    user_id TEXT PRIMARY KEY,
    step INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL DEFAULT '{}',
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS onboarding_progress_completed_idx
    ON onboarding_progress(completed_at);

  -- Anti-fraud trial protection: one normalized MC docket = one account.
  -- clients live as JSON payload (no flat MC column), so we keep a dedicated
  -- registry with a PRIMARY KEY for a hard DB-level uniqueness guarantee.
  CREATE TABLE IF NOT EXISTS mc_account_registry (
    mc_normalized TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    claimed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mc_registry_user_idx
    ON mc_account_registry(user_id);

  CREATE TABLE IF NOT EXISTS stripe_processed_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT,
    processed_at TEXT NOT NULL
  );
`);
ensureUserDriverColumns();

// Per-user subscription columns (additive migration for existing DBs).
{
  const _ucols = new Set((sqlite.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!_ucols.has("subscription_ends_at")) sqlite.exec("ALTER TABLE users ADD COLUMN subscription_ends_at TEXT");
  const _icols = new Set((sqlite.prepare("PRAGMA table_info(invites)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!_icols.has("subscription_days")) sqlite.exec("ALTER TABLE invites ADD COLUMN subscription_days INTEGER");
}
// Compliance documents — add optional client_id scope so admins can attach a
// doc to the carrier instead of a specific user. NULL = per-driver only.
function ensureDriverDocumentsColumns() {
  const cols = sqlite.prepare("PRAGMA table_info(driver_documents)").all() as Array<{
    name: string;
  }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("client_id")) {
    sqlite.exec("ALTER TABLE driver_documents ADD COLUMN client_id TEXT");
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS driver_documents_client_idx ON driver_documents(client_id, created_at DESC) WHERE client_id IS NOT NULL",
    );
  }
}

// signup_leads: добавлены note и name для «Contact us» варианта lead-formы на landing.
{
  const cols = sqlite.prepare("PRAGMA table_info(signup_leads)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("note")) {
    sqlite.exec("ALTER TABLE signup_leads ADD COLUMN note TEXT");
  }
  if (!names.has("name")) {
    sqlite.exec("ALTER TABLE signup_leads ADD COLUMN name TEXT");
  }
}

sqlite.exec(
  "CREATE INDEX IF NOT EXISTS users_telegram_chat_id_idx ON users(telegram_chat_id)",
);

// ---------------------------------------------------------------------------
// FMCSA Drug & Alcohol Clearinghouse query log (paid compliance feature).
//
// 49 CFR Part 382 требует от carrier'а:
//   1. PRE-EMPLOYMENT full query при найме любого CDL driver'a
//   2. ANNUAL limited query на всех драйверов каждые 12 месяцев
// Штраф: $7,500/инцидент (FMCSA enforcement 2026).
//
// Сам запрос делается вручную на clearinghouse.fmcsa.dot.gov; мы
// фиксируем только факт выполнения и результат. Reminder cron выводит
// drivers у кого annual query старше 11 месяцев.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS clearinghouse_queries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,             -- driver this query is about
    client_id TEXT,                    -- carrier who initiated
    query_type TEXT NOT NULL,          -- 'pre_employment' | 'annual'
    queried_at TEXT NOT NULL,          -- ISO when the query was actually run on FMCSA
    result TEXT NOT NULL,              -- 'clear' | 'prohibited' | 'pending' | 'consent_revoked'
    valid_until TEXT NOT NULL,         -- pre_employment: indefinite (set to 9999-12-31); annual: queried_at + 12mo
    notes TEXT,                        -- free text (case ref, FMCSA query ID, etc.)
    recorded_by_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS clearinghouse_user_idx
    ON clearinghouse_queries(user_id, queried_at DESC);
  CREATE INDEX IF NOT EXISTS clearinghouse_client_idx
    ON clearinghouse_queries(client_id, queried_at DESC);
`);

// Indexes that depend on the new columns. Must follow ensureLoadDriverColumn
// so we don't reference a column that doesn't exist yet on migrated DBs.
sqlite.exec("CREATE INDEX IF NOT EXISTS loads_driver_id_idx ON loads(driver_id, created_at DESC)");
// Keyset pagination tiebreakers for the driver- and client-scoped load lists.
sqlite.exec("CREATE INDEX IF NOT EXISTS loads_driver_created_id_idx ON loads(driver_id, created_at DESC, id DESC)");
sqlite.exec("CREATE INDEX IF NOT EXISTS loads_client_created_id_idx ON loads(client_id, created_at DESC, id DESC)");
// Admin dashboard scans by created_at window (listLoadsCreatedSince/countLoadsSince)
// and by booked_at alone (grossBookedInWindow). The composite (client_id, booked_at)
// index can't serve a booked_at-only filter, so these were full table scans.
sqlite.exec("CREATE INDEX IF NOT EXISTS loads_created_at_idx ON loads(created_at)");
sqlite.exec("CREATE INDEX IF NOT EXISTS loads_booked_at_idx ON loads(booked_at) WHERE booked_at IS NOT NULL");
// Expression index for listLoadsDueForPickupReminder (cron) — avoids a full
// table scan of every load's payload.pickupAt on each reminder poll.
sqlite.exec("CREATE INDEX IF NOT EXISTS loads_pickup_at_idx ON loads(json_extract(payload, '$.pickupAt')) WHERE driver_id IS NOT NULL");

// ---------------------------------------------------------------------------
// Phase 5: smart-matching cache + history tables.
//   load_scores    — per-(load, client) cached score so we don't recompute on
//                    every cron poll. Invalidated when fuel/location updates.
//   broker_history — per-broker (mc) rolling on-time%, payment days, dispute
//                    rate. Fed by /yes /no /checkin and dispatcher actions.
//   lane_history   — per-(origin_state, dest_state) avg $/mi and volume.
//                    Drives next-load-potential signal in the scorer.
// ---------------------------------------------------------------------------
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS load_scores (
    load_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    dispatch_score INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    estimated_net INTEGER NOT NULL,
    breakdown_json TEXT NOT NULL,
    computed_at TEXT NOT NULL,
    PRIMARY KEY (load_id, client_id)
  )
`);
sqlite.exec("CREATE INDEX IF NOT EXISTS load_scores_client_score_idx ON load_scores(client_id, dispatch_score DESC)");
sqlite.exec("CREATE INDEX IF NOT EXISTS load_scores_computed_at_idx ON load_scores(computed_at)");

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS broker_history (
    mc TEXT PRIMARY KEY,
    name TEXT,
    loads_offered INTEGER NOT NULL DEFAULT 0,
    loads_accepted INTEGER NOT NULL DEFAULT 0,
    loads_completed INTEGER NOT NULL DEFAULT 0,
    loads_late INTEGER NOT NULL DEFAULT 0,
    disputes INTEGER NOT NULL DEFAULT 0,
    avg_payment_days REAL,
    last_load_at TEXT,
    updated_at TEXT NOT NULL
  )
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS lane_history (
    origin_state TEXT NOT NULL,
    destination_state TEXT NOT NULL,
    loads_seen INTEGER NOT NULL DEFAULT 0,
    sum_rate INTEGER NOT NULL DEFAULT 0,
    sum_miles INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT NOT NULL,
    dow_distribution TEXT,
    PRIMARY KEY (origin_state, destination_state)
  )
`);

// Additive migration: existing DBs created before dow_distribution gain it now.
try {
  sqlite.exec("ALTER TABLE lane_history ADD COLUMN dow_distribution TEXT");
} catch {
  // Column already exists — fine.
}

// ---------------------------------------------------------------------------
// Killer #4 — Predictive Load Hunting: lane watchlist.
// A dispatcher watches a lane (origin→dest state, optional city/equipment/min
// PPM). When a matching load lands we bump match_count + last_matched_at and
// emit an audit event. No TG alerts yet (dispatcher bot not wired).
// ---------------------------------------------------------------------------
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS lane_watchlist (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    origin_state TEXT NOT NULL,
    origin_city TEXT,
    destination_state TEXT NOT NULL,
    destination_city TEXT,
    min_ppm REAL,
    equipment TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    match_count INTEGER NOT NULL DEFAULT 0,
    last_matched_at TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL
  )
`);
sqlite.exec("CREATE INDEX IF NOT EXISTS idx_lane_watchlist_client ON lane_watchlist (client_id)");
sqlite.exec("CREATE INDEX IF NOT EXISTS idx_lane_watchlist_active ON lane_watchlist (active)");

// ---------------------------------------------------------------------------
// Phase 4 P1: new tables for driver operations
// ---------------------------------------------------------------------------
//
// Each is a plain CREATE TABLE IF NOT EXISTS — fresh DBs get them on startup,
// existing DBs gain them additively without losing data. All 4 tables use
// TEXT primary keys (makeId) to stay consistent with the rest of the schema.
//
//   - driver_documents — owner_user_id + type + storage_path + expires_at.
//                        File bytes live on disk under uploadsRoot/driver-docs/.
//                        Tenant-scoped via owner_user_id; never expose another
//                        driver's document.
//   - load_checkins    — load_id + driver_user_id + kind + lat/lng + notes.
//                        Append-only, no edits. Drives the load timeline.
//   - driver_expenses  — driver_user_id + load_id? + category + amount_cents +
//                        photo_storage_path?. Amount in cents (int) to avoid
//                        float drift in totals.
//   - approval_tasks   — generic queue: task_type + assignee_role + status +
//                        payload (JSON). For P1 only driver_issue is emitted.
//
// Indexes cover the hot query paths: list-by-owner with created_at DESC, and
// list-by-load for checkins/expenses.
// ---------------------------------------------------------------------------
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS ai_usage (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );
  CREATE TABLE IF NOT EXISTS ai_credits (
    user_id TEXT PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
  );
  -- Idempotency guard for AI credit-pack grants. The Stripe webhook handler
  -- dedupes by event.id, but that marker is UN-claimed when the handler throws
  -- AFTER the balance was already mutated (e.g. the audit write failed) — so a
  -- Stripe retry of the same invoice would re-run addAiCredits and DOUBLE-GRANT.
  -- This table records which Stripe invoice id was already credited, keyed on
  -- the invoice id (the stable real-world identity of the purchase), so the
  -- grant is idempotent across ANY number of (re)deliveries — independent of
  -- event.id churn. Claimed atomically in the SAME transaction as the balance
  -- bump, so partial states are impossible.
  CREATE TABLE IF NOT EXISTS ai_credit_grants (
    invoice_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    pack INTEGER NOT NULL,
    granted_at TEXT NOT NULL
  );
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS driver_documents (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    file_name TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    expires_at TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS driver_documents_owner_idx
    ON driver_documents(owner_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS driver_documents_owner_created_id_idx
    ON driver_documents(owner_user_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS driver_documents_expires_idx
    ON driver_documents(expires_at) WHERE expires_at IS NOT NULL;

  CREATE TABLE IF NOT EXISTS load_checkins (
    id TEXT PRIMARY KEY,
    load_id TEXT NOT NULL,
    driver_user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    lat REAL,
    lng REAL,
    notes TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS load_checkins_load_idx
    ON load_checkins(load_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS load_checkins_driver_idx
    ON load_checkins(driver_user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS driver_expenses (
    id TEXT PRIMARY KEY,
    driver_user_id TEXT NOT NULL,
    load_id TEXT,
    category TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    photo_storage_path TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS driver_expenses_driver_idx
    ON driver_expenses(driver_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS driver_expenses_driver_created_id_idx
    ON driver_expenses(driver_user_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS driver_expenses_load_idx
    ON driver_expenses(load_id) WHERE load_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS approval_tasks (
    id TEXT PRIMARY KEY,
    task_type TEXT NOT NULL,
    assignee_role TEXT NOT NULL,
    resolved_by_user_id TEXT,
    resolved_at TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    payload TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS approval_tasks_queue_idx
    ON approval_tasks(assignee_role, status, created_at DESC);
  CREATE INDEX IF NOT EXISTS approval_tasks_queue_id_idx
    ON approval_tasks(assignee_role, status, created_at DESC, id DESC);
`);
// Run additive driver_documents migrations AFTER the table exists. Previously
// this was invoked up near onboarding setup, before the CREATE TABLE below, so
// on a fresh DB it threw "no such table: driver_documents" at boot. Calling it
// here (post-create) keeps the ALTER idempotent on existing DBs and correct on
// new ones.
ensureDriverDocumentsColumns();

// ---------------------------------------------------------------------------
// Henry QA Bug #6+7 — Client contact person columns.
// ---------------------------------------------------------------------------
// The clients table primarily stores data as a JSON payload (per v1.2.7
// design). These flat columns mirror the contact-person fields for potential
// future SQL queries / joins. The JSON payload is always the source of truth
// for reads (getClient / listClients parse payload); these columns are
// populated on each upsertClient call for indexability.
function ensureClientContactColumns() {
  const cols = sqlite.prepare("PRAGMA table_info(clients)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("contact_person_name")) {
    sqlite.exec("ALTER TABLE clients ADD COLUMN contact_person_name TEXT");
  }
  if (!names.has("contact_person_email")) {
    sqlite.exec("ALTER TABLE clients ADD COLUMN contact_person_email TEXT");
  }
  if (!names.has("contact_person_phone")) {
    sqlite.exec("ALTER TABLE clients ADD COLUMN contact_person_phone TEXT");
  }
}
ensureClientContactColumns();

// Stripe charging: link a DispatchOS invoice row to the one-off Stripe invoice
// we create at generate/charge time so the invoice.payment_succeeded webhook can
// flip the row to 'paid'. Nullable — older rows (and rows that never got a charge
// initiated) simply have it NULL. Same PRAGMA/ALTER pattern as the columns above.
function ensureInvoiceStripeColumn() {
  const cols = sqlite.prepare("PRAGMA table_info(invoices)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("stripe_invoice_id")) {
    sqlite.exec("ALTER TABLE invoices ADD COLUMN stripe_invoice_id TEXT");
  }
}
ensureInvoiceStripeColumn();
// Lookup index for findInvoiceByStripeId (webhook reconciliation). Partial so it
// only covers rows that actually have a Stripe id.
sqlite.exec(
  "CREATE INDEX IF NOT EXISTS invoices_stripe_invoice_id_idx ON invoices(stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL",
);

// ---------------------------------------------------------------------------
// Phase 6.1 — Broker safety audit snapshots (SCOTUS Montgomery v. Caribe, 2026-05-14)
// ---------------------------------------------------------------------------
// SCOTUS 9-0 held that FAAAA does NOT preempt state negligent-hiring claims
// against freight brokers. Brokers can now be sued by accident victims for
// hiring unsafe motor carriers. To defend in court, brokers must prove that
// at the moment of booking they performed due-diligence vetting of the
// carrier (FMCSA authority, BOC-3, insurance, safety rating, out-of-service
// rate, crash history). This table is the immutable evidentiary record:
// every load booking writes one snapshot row capturing all vetting data we
// had at that timestamp. Rows are append-only (UPDATE/DELETE forbidden at
// app layer) so they remain admissible as a business record. Also feeds
// Killer #1 (Broker Trust Score) on read.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS broker_safety_audit_snapshots (
    id TEXT PRIMARY KEY,
    load_id TEXT,
    client_id TEXT,
    broker_mc TEXT NOT NULL,
    broker_name TEXT,
    -- FMCSA vetting at booking time
    fmcsa_authority_status TEXT,           -- ACTIVE | INACTIVE | NOT_AUTHORIZED | UNKNOWN
    fmcsa_bond_amount_cents INTEGER,       -- e.g. 7500000 = $75K
    fmcsa_bond_status TEXT,                -- ACTIVE | AT_RISK | SUSPENDED (FMCSA Jan-16-2026 rule)
    fmcsa_insurance_active INTEGER,        -- 1/0
    fmcsa_safety_rating TEXT,              -- SATISFACTORY | CONDITIONAL | UNSATISFACTORY | NOT_RATED
    fmcsa_oos_rate REAL,                   -- driver out-of-service %
    fmcsa_crash_rate REAL,                 -- crashes per power unit
    -- our internal performance signals (snapshot from broker_history at booking)
    internal_loads_completed INTEGER NOT NULL DEFAULT 0,
    internal_disputes INTEGER NOT NULL DEFAULT 0,
    internal_double_broker_flags INTEGER NOT NULL DEFAULT 0,
    internal_avg_payment_days REAL,
    -- computed score 0-100 (higher = safer; null if not enough data)
    trust_score INTEGER,
    risk_factors TEXT,                     -- JSON array of human-readable reasons
    -- evidentiary metadata
    raw_fmcsa_payload TEXT,                -- full FMCSA response JSON (frozen at booking)
    captured_at TEXT NOT NULL,             -- ISO timestamp when snapshot was taken
    captured_by_user_id TEXT,              -- dispatcher who booked the load
    captured_reason TEXT NOT NULL DEFAULT 'load_booking' -- load_booking | manual_audit | periodic
  );
  CREATE INDEX IF NOT EXISTS broker_safety_snapshots_mc_idx
    ON broker_safety_audit_snapshots(broker_mc, captured_at DESC);
  CREATE INDEX IF NOT EXISTS broker_safety_snapshots_load_idx
    ON broker_safety_audit_snapshots(load_id);
  CREATE INDEX IF NOT EXISTS broker_safety_snapshots_client_idx
    ON broker_safety_audit_snapshots(client_id, captured_at DESC);
`);

// ---------------------------------------------------------------------------
// Phase 7 — GPS tracking (Traccar Client / Owntracks / Telegram live / crowd)
// ---------------------------------------------------------------------------
// We accept pings from multiple sources via separate HTTP endpoints (see
// server/routes/track.ts). The schema is source-agnostic; `source` is a
// discriminator. We retain 15 days of pings (cleaned by cron) to enable
// fuel-stop forensics: «when the driver was at lat/lng on date X, the
// cheapest diesel within 5 miles was \$Y at station Z».
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS driver_location_pings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    accuracy_m REAL,           -- horizontal accuracy in meters, when reported
    speed_kmh REAL,            -- speed when reported (Traccar/Owntracks both have it)
    heading_deg REAL,          -- direction of travel
    battery_pct REAL,          -- device battery, for awareness
    source TEXT NOT NULL,      -- osmand | owntracks | telegram_live | crowdsource | manual
    captured_at TEXT NOT NULL, -- ISO timestamp from the device
    received_at TEXT NOT NULL  -- ISO timestamp when we wrote the row
  );
  CREATE INDEX IF NOT EXISTS driver_location_pings_user_time_idx
    ON driver_location_pings(user_id, captured_at DESC);
  CREATE INDEX IF NOT EXISTS driver_location_pings_captured_idx
    ON driver_location_pings(captured_at);
`);

// ---------------------------------------------------------------------------
// Phase 7 — Fuel price observations (multi-source crowd-and-scrape)
// ---------------------------------------------------------------------------
// One row = one observed price at one station at one moment. Sources have a
// priority on read (newest fresh observation by trusted source wins). 90-day
// retention. The station identity is best-effort (place_id from Google Maps
// when we have it, else (lat,lng,name) fuzzy match).
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS fuel_price_observations (
    id TEXT PRIMARY KEY,
    station_place_id TEXT,     -- Google Maps place_id when known; null = unmapped
    station_name TEXT,         -- 'Pilot', 'Loves', '7-Eleven', etc.
    station_brand TEXT,        -- normalized brand for filtering
    station_lat REAL NOT NULL,
    station_lng REAL NOT NULL,
    address TEXT,
    state TEXT,                -- 2-letter state code, for PADD lookups
    fuel_type TEXT NOT NULL,   -- diesel | gasoline_regular | gasoline_mid | gasoline_premium | def
    price_cents INTEGER NOT NULL, -- price per gallon in cents
    source TEXT NOT NULL,      -- gasbuddy | tomtom | eia | dispatchos_crowdsource
    source_confidence REAL NOT NULL, -- 0.0–1.0, primary 1.0, eia ~0.7
    observed_at TEXT NOT NULL, -- when the price was current at station
    received_at TEXT NOT NULL,
    reporter_user_id TEXT,     -- set when source=dispatchos_crowdsource
    raw_payload TEXT           -- vendor blob for forensics / re-parse
  );
  CREATE INDEX IF NOT EXISTS fuel_obs_station_time_idx
    ON fuel_price_observations(station_place_id, observed_at DESC);
  CREATE INDEX IF NOT EXISTS fuel_obs_geo_idx
    ON fuel_price_observations(station_lat, station_lng);
  CREATE INDEX IF NOT EXISTS fuel_obs_state_time_idx
    ON fuel_price_observations(state, fuel_type, observed_at DESC);
`);

// ---------------------------------------------------------------------------
// Phase 7 — Fuel transactions (driver-reported, derived from receipt photos)
// ---------------------------------------------------------------------------
// One row = one filled tank. We compute mileage between transactions to
// derive real MPG and compare against avg_mpg on the carrier. Receipt photo
// path may be set when source=crowdsource (driver photo of pump receipt).
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS fuel_transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,         -- driver who fueled
    client_id TEXT,                -- carrier they were driving for
    load_id TEXT,                  -- associated load if any
    station_place_id TEXT,
    station_name TEXT,
    station_lat REAL,
    station_lng REAL,
    fuel_type TEXT NOT NULL,
    gallons REAL NOT NULL,
    price_per_gallon_cents INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    odometer_miles INTEGER,        -- when reported / OCR'd
    receipt_storage_path TEXT,     -- relative to uploadsRoot
    notes TEXT,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS fuel_tx_user_time_idx
    ON fuel_transactions(user_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS fuel_tx_client_time_idx
    ON fuel_transactions(client_id, occurred_at DESC);
`);

// Carriers — add avg_mpg + fuel-related defaults. Migration-only ALTERs.
{
  const cols = sqlite.prepare("PRAGMA table_info(clients)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("avg_mpg")) {
    // Average miles per gallon for the carrier's primary equipment. Used to
    // estimate fuel cost per trip + flag overshooting on actual fills.
    sqlite.exec("ALTER TABLE clients ADD COLUMN avg_mpg REAL");
  }
  if (!names.has("fuel_tank_gallons")) {
    // Useful for ETA-to-empty given current consumption + last fill.
    sqlite.exec("ALTER TABLE clients ADD COLUMN fuel_tank_gallons REAL");
  }
}

// Broker Trust Score — Killer #1. Behavioural signals reported by dispatchers
// (or auto-collected): pays on time, honours ratecon, responds, fraud, etc.
// Distinct from broker_safety_audit_snapshots (FMCSA/legal). Append-mostly;
// the score is computed on read via server/lib/ai/broker-trust.ts.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS broker_trust_signals (
    id TEXT PRIMARY KEY,
    broker_mc TEXT NOT NULL,
    load_id TEXT,
    client_id TEXT,
    signal_type TEXT NOT NULL,
    positive INTEGER NOT NULL,
    value_json TEXT,
    notes TEXT,
    reported_by_user_id TEXT,
    reported_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS broker_trust_signals_mc_idx
    ON broker_trust_signals(broker_mc, reported_at DESC);
  CREATE INDEX IF NOT EXISTS broker_trust_signals_load_idx
    ON broker_trust_signals(load_id);
  -- Audit M5: automatic per-load lifecycle signals must count ONCE per load
  -- (a duplicate booked/completed/cancelled inflates the broker trust score).
  -- Collapse any existing duplicates, then a partial UNIQUE index makes the
  -- existing INSERT OR IGNORE idempotent. Manual signals are never deduped.
  DELETE FROM broker_trust_signals
  WHERE load_id IS NOT NULL
    AND signal_type IN ('load_booked','load_completed','load_cancelled_by_broker','load_refused_by_carrier')
    AND rowid NOT IN (
      SELECT MIN(rowid) FROM broker_trust_signals
      WHERE load_id IS NOT NULL
        AND signal_type IN ('load_booked','load_completed','load_cancelled_by_broker','load_refused_by_carrier')
      GROUP BY load_id, signal_type
    );
  CREATE UNIQUE INDEX IF NOT EXISTS broker_trust_signals_auto_dedup
    ON broker_trust_signals(load_id, signal_type)
    WHERE load_id IS NOT NULL
      AND signal_type IN ('load_booked','load_completed','load_cancelled_by_broker','load_refused_by_carrier');
`);



function now() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  // Crypto-grade random suffix (~48 bits) instead of Math.random(), so
  // concurrent inserts within the same millisecond don't hit the birthday bound.
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
}

// Fill the scorer inputs a source adapter may not provide, so every persisted
// source load is rankable (missing marketQuality/brokerScore/fraudRisk made
// dispatchScore NaN). Idempotent: keeps any value the adapter already set.
function ensureScoreableSourceLoad(payload: Record<string, unknown>): Record<string, unknown> {
  const p = payload;
  const marketQuality =
    typeof p.marketQuality === "number"
      ? p.marketQuality
      : marketQualityFor({
          originState: String(p.originState ?? ""),
          destinationState: String(p.destinationState ?? ""),
          equipment: (p.equipment as Equipment) ?? "open_car_hauler",
          pickupAt: typeof p.pickupAt === "string" ? p.pickupAt : undefined,
        });
  return {
    ...p,
    marketQuality,
    brokerScore: typeof p.brokerScore === "number" ? p.brokerScore : 50,
    fraudRisk: typeof p.fraudRisk === "number" ? p.fraudRisk : 0,
  };
}

// ---------------------------------------------------------------------------
// Cursor pagination helpers (keyset / "seek" pagination).
//
// A cursor encodes (orderValue, tiebreaker) so pagination stays stable even when
// many rows share an identical created_at/generated_at — now() is ms-precision
// and backfills stamp a whole batch with one ts, so ties are common. With a
// single-column `created_at < ?` cursor, a page boundary that lands inside a
// tied group silently drops every remaining row sharing that timestamp.
//
// Format is an opaque base64url string "<orderValue>\u0000<tiebreaker>". The
// frontend treats nextCursor as opaque (passes it back verbatim as ?cursor=),
// so the internal format is free to change while staying wire-compatible.
//
// TOLERANT decode: a legacy bare-timestamp cursor (no NUL separator) decodes to
// { orderValue: raw, tiebreaker: null }; callers then fall back to the old
// `orderCol < ?` predicate for that one request, so in-flight cursors keep
// working (and self-heal — the next cursor they receive is the new composite).
const CURSOR_SEP = "\u0000";

function encodeCursor(orderValue: string, tiebreaker: string): string {
  return Buffer.from(`${orderValue}${CURSOR_SEP}${tiebreaker}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { orderValue: string; tiebreaker: string | null } {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = decoded.indexOf(CURSOR_SEP);
    if (sep !== -1) {
      return { orderValue: decoded.slice(0, sep), tiebreaker: decoded.slice(sep + 1) };
    }
  } catch {
    /* fall through to legacy bare-timestamp handling */
  }
  return { orderValue: cursor, tiebreaker: null };
}

// Exported for unit tests (server/lib/cursor.test.ts).
export const __cursorInternals = { encodeCursor, decodeCursor };

/** Great-circle distance in km between two lat/lng pairs. Used by tracking +
 *  fuel-nearby lookups. Accurate to ~0.5% which is plenty for 5-50 km cones. */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function parsePayload<T>(row: { payload: string } | undefined): T | undefined {
  if (!row) return undefined;
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return undefined;
  }
}

function parsePayloads<T>(rows: Array<{ payload: string }>): T[] {
  // Skip (don't throw on) a single corrupted payload row — otherwise one bad
  // row 500s the entire list endpoint (dashboard, backup export, etc.).
  const out: T[] = [];
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.payload) as T);
    } catch {
      console.error("[storage] skipping corrupted payload row");
    }
  }
  return out;
}

/**
 * Phase 3 P4: extract the actor user id from an audit event payload.
 *
 * Different event types stash the actor under different keys. We probe
 * them in order of specificity. Returns null when no recognised key is
 * present (legacy v1.2.7 events, system-generated events).
 */
function pluckActorIdFromPayload(payload: any): string | null {
  if (!payload || typeof payload !== "object") return null;
  // P0/P1/P2 conventions
  const KEYS = [
    "actorUserId",
    "createdByAdminId",
    "resetByAdminId",
    "removedByAdminId",
    "createdByUserId",
    "removedByUserId",
    "userId",
  ];
  for (const key of KEYS) {
    const v = payload[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
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
  // Phase 4 P0 columns (added via ensureUserDriverColumns()).
  phone: string | null;
  driver_status: string | null;
  // Phase 4 P2: TG driver bot. Nullable until the driver links.
  telegram_chat_id: string | null;
  // Soft-delete marker (added via ensureUserDriverColumns()).
  deleted_at: string | null;
  // Phase 7 — GPS tracking cache (added via ensureUserDriverColumns()).
  last_lat: number | null;
  last_lng: number | null;
  last_location_at: string | null;
  last_location_accuracy_m: number | null;
  last_location_source: string | null;
  tracking_token: string | null;
  last_seen_at: string | null;
  // i18n — last UI language chosen ('ru' | 'en'). NULL until first choice.
  preferred_lang: string | null;
  // Henry QA Bug #5 — truck unit number. Drivers only; nullable.
  unit_number: string | null;
  // fix/totp-onboarding-verify — NULL until user enters a valid code after signup.
  totp_confirmed_at: string | null;
  // feat/twilio-verify-phone-email
  phone_verified: number | null;
  phone_verified_at: string | null;
  email_verified_at: string | null;
  // Per-user subscription end (ISO). NULL = no per-user subscription.
  subscription_ends_at: string | null;
  // Session invalidation epoch (bumped on admin password/TOTP reset).
  session_epoch: number | null;
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
  /** Bumped on admin password/TOTP reset to invalidate existing sessions. */
  sessionEpoch: number;
  linkedClientId?: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  // Phase 4 P0 fields. `driverStatus` is stored for all roles (cheap; column
  // is NOT NULL DEFAULT 'available') but only surfaced for role=driver via
  // toUserPublic. `phone` is per-user contact, any role.
  phone?: string;
  driverStatus?: DriverStatus;
  // Phase 4 P2: TG chat_id (string — TG IDs are int64 which overflows JS
  // number; we store as text everywhere).
  telegramChatId?: string;
  // Soft-delete marker. Set = removed by admin (distinct from blocked).
  deletedAt?: string;
  // Phase 7 GPS tracking — last-known location cache + shared secret.
  lastLat?: number;
  lastLng?: number;
  lastLocationAt?: string;
  lastLocationAccuracyM?: number;
  lastLocationSource?: string;
  trackingToken?: string;
  // Phase 7 presence — last authenticated /api hit.
  lastSeenAt?: string;
  // i18n — last UI language picked. NULL until first explicit choice.
  preferredLang?: "ru" | "en" | "es" | "fr";
  // Henry QA Bug #5 — truck unit number (drivers only). NULL = not assigned.
  unitNumber?: string;
  // fix/totp-onboarding-verify — NULL until confirmed; blocks login if NULL and totpSecret is set.
  totpConfirmedAt?: string;
  // feat/twilio-verify-phone-email
  phoneVerified: boolean;
  phoneVerifiedAt?: string;
  emailVerifiedAt?: string;
  // Per-user subscription end (ISO). Set at signup = now + invite.subscriptionDays.
  subscriptionEndsAt?: string;
}

// Phase 6 load_sources row mapper. Keep snake_case → camelCase consistent
// with how Vlad's admin layer expects to read these.
function rowToLoadSource(row: any) {
  return {
    id: row.id as string,
    clientId: row.client_id as string,
    adapterKey: row.adapter_key as string,
    label: row.label as string,
    status: row.status as string,
    configJson: row.config_json ? JSON.parse(row.config_json) : {},
    hasCredentials: Boolean(row.credentials_enc),
    credentialsEnc: row.credentials_enc as string | null,
    credentialsIv: row.credentials_iv as string | null,
    credentialsKeyId: row.credentials_key_id as string | null,
    pollIntervalMin: row.poll_interval_min as number,
    lastPolledAt: row.last_polled_at as string | null,
    lastLoadsFound: row.last_loads_found as number,
    lastErrorAt: row.last_error_at as string | null,
    lastErrorMsg: row.last_error_msg as string | null,
    failureStreak: row.failure_streak as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: row.created_by as string | null,
  };
}

function rowToUserInternal(row: UserRow | undefined): UserInternal | undefined {
  if (!row) return undefined;
  // driver_status is parsed defensively — anything not in the enum falls back
  // to undefined and toUserPublic skips it. New rows always carry a valid
  // value because storage.createUser writes 'available' explicitly.
  const rawStatus = row.driver_status;
  const driverStatus: DriverStatus | undefined =
    rawStatus === "available" || rawStatus === "on_route" || rawStatus === "off_duty"
      ? rawStatus
      : undefined;
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role as UserRole,
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    totpSecret: row.totp_secret ?? undefined,
    blocked: Boolean(row.blocked),
    sessionEpoch: (row.session_epoch as number | null) ?? 0,
    linkedClientId: row.linked_client_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? undefined,
    phone: row.phone ?? undefined,
    driverStatus,
    telegramChatId: row.telegram_chat_id ?? undefined,
    deletedAt: row.deleted_at ?? undefined,
    lastLat: row.last_lat ?? undefined,
    lastLng: row.last_lng ?? undefined,
    lastLocationAt: row.last_location_at ?? undefined,
    lastLocationAccuracyM: row.last_location_accuracy_m ?? undefined,
    lastLocationSource: row.last_location_source ?? undefined,
    trackingToken: row.tracking_token ?? undefined,
    lastSeenAt: row.last_seen_at ?? undefined,
    preferredLang:
      row.preferred_lang === "ru" ||
      row.preferred_lang === "en" ||
      row.preferred_lang === "es" ||
      row.preferred_lang === "fr"
        ? row.preferred_lang
        : undefined,
    unitNumber: row.unit_number ?? undefined,
    totpConfirmedAt: row.totp_confirmed_at ?? undefined,
    phoneVerified: row.phone_verified === 1,
    phoneVerifiedAt: row.phone_verified_at ?? undefined,
    emailVerifiedAt: row.email_verified_at ?? undefined,
    subscriptionEndsAt: row.subscription_ends_at ?? undefined,
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
    // Phase 4 additive: phone for any role, driverStatus only for role=driver.
    phone: user.phone,
    driverStatus: user.role === "driver" ? user.driverStatus ?? "available" : undefined,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
    lastSeenAt: user.lastSeenAt,
    deletedAt: user.deletedAt ?? null,
    preferredLang: user.preferredLang ?? null,
    // Henry QA Bug #5 — truck unit number. Only surfaced for role=driver;
    // admin UI reads it for all roles to show in user tables, but it is
    // semantically a driver-only field.
    unitNumber: user.unitNumber ?? null,
    // feat/twilio-verify-phone-email
    phoneVerifiedAt: user.phoneVerifiedAt ?? null,
    emailVerifiedAt: user.emailVerifiedAt ?? null,
    subscriptionEndsAt: user.subscriptionEndsAt ?? null,
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
    // Scope to non-deleted rows: auth lookups (getUserById/getUserByEmail) all
    // filter `deleted_at IS NULL`, so a soft-deleted admin cannot log in. If we
    // counted them here, isConfigured could report "configured" while no admin
    // can actually authenticate — a permanent bootstrap lockout.
    const userCount = (
      sqlite.prepare("SELECT COUNT(*) as c FROM users WHERE deleted_at IS NULL").get() as { c: number }
    ).c;
    if (userCount > 0) {
      // New-style: users table is the source of truth.
      const adminCount = (
        sqlite
          .prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' AND blocked = 0 AND deleted_at IS NULL")
          .get() as { c: number }
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

  // Audit High #20 — все single-row user lookups фильтруют по софт-дилиту.
  // До этого софт-удалённый юзер мог вернуться в session-lookup, TG-bot или
  // login-flow — фактически «un-delete» через бэкдор. listUsers уже был ОК.
  //
  // 2026-05-27 hotfix (Vlad smoke regression): admin inspection paths need
  // to see soft-deleted users (audit trail, post-delete UI confirmation).
  // Use `getUserByIdIncludingDeleted` for those. Default `getUserById`
  // STAYS strict — anything auth-adjacent must keep going through it.
  getUserById(id: string): UserInternal | undefined {
    const row = sqlite
      .prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL")
      .get(id) as UserRow | undefined;
    return rowToUserInternal(row);
  },

  /**
   * Same as getUserById but does NOT filter out soft-deleted rows.
   *
   * Use ONLY for admin inspection / audit display / post-delete returns.
   * Never for auth, session, TG-bot, dispatch flow, or anything that would
   * let a deleted user act as an active one.
   */
  getUserByIdIncludingDeleted(id: string): UserInternal | undefined {
    const row = sqlite
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(id) as UserRow | undefined;
    return rowToUserInternal(row);
  },

  getUserByEmail(email: string): UserInternal | undefined {
    const row = sqlite
      .prepare("SELECT * FROM users WHERE email = ? AND deleted_at IS NULL")
      .get(email.toLowerCase()) as UserRow | undefined;
    return rowToUserInternal(row);
  },

  // -------------------------------------------------------------------------
  // Phase 4 P2: TG driver bot lookups.
  //
  // chat_id is text (TG IDs are int64). The unique-ish index lets the webhook
  // resolve user from chat in O(1) on every message.
  // -------------------------------------------------------------------------
  getUserByTelegramChatId(chatId: string): UserInternal | undefined {
    // SECURITY (audit): exclude blocked accounts so a terminated/fraud-flagged
    // driver loses inbound bot control too. The outbound recipient query already
    // filters blocked = 0; the inbound command path must match.
    const row = sqlite
      .prepare("SELECT * FROM users WHERE telegram_chat_id = ? AND deleted_at IS NULL AND blocked = 0")
      .get(chatId) as UserRow | undefined;
    return rowToUserInternal(row);
  },

  setUserTelegramChatId(userId: string, chatId: string | null): UserInternal | undefined {
    sqlite
      .prepare("UPDATE users SET telegram_chat_id = ?, updated_at = ? WHERE id = ?")
      .run(chatId, now(), userId);
    return this.getUserById(userId);
  },

  // P0.5 — recipients for a carrier's matched-load push. Everyone linked to the
  // carrier (drivers + owner-operator, who is linked as a driver per #168) who
  // has connected the driver bot. Blocked/deleted users are excluded so a
  // removed driver stops getting offers. De-duped by chat_id in case two user
  // rows share one chat (rare, but the push path must not double-send).
  listTelegramRecipientsForClient(
    clientId: string,
  ): Array<{ userId: string; chatId: string; role: string }> {
    const rows = sqlite
      .prepare(
        `SELECT id, role, telegram_chat_id
           FROM users
          WHERE linked_client_id = ?
            AND telegram_chat_id IS NOT NULL
            AND telegram_chat_id != ''
            AND deleted_at IS NULL
            AND blocked = 0`,
      )
      .all(clientId) as Array<{ id: string; role: string; telegram_chat_id: string }>;
    const seen = new Set<string>();
    const out: Array<{ userId: string; chatId: string; role: string }> = [];
    for (const r of rows) {
      if (seen.has(r.telegram_chat_id)) continue;
      seen.add(r.telegram_chat_id);
      out.push({ userId: r.id, chatId: r.telegram_chat_id, role: r.role });
    }
    return out;
  },

  // P0.4 — atomic alert de-dup. Returns true exactly once per (load, chat); a
  // concurrent or repeat call returns false (UNIQUE index + INSERT OR IGNORE),
  // so a re-scored load never re-pings the same recipient.
  claimLoadAlert(input: {
    loadId: string;
    chatId: string;
    clientId: string;
    dispatchScore: number;
  }): boolean {
    const info = sqlite
      .prepare(
        `INSERT OR IGNORE INTO load_alerts_sent
           (id, load_id, chat_id, client_id, dispatch_score, sent_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        makeId("loadalert"),
        input.loadId,
        input.chatId,
        input.clientId,
        Math.round(input.dispatchScore),
        now(),
      );
    return info.changes > 0;
  },

  // Pickup reminders — loads assigned to a driver whose pickup time falls in
  // [fromIso, toIso]. pickupAt lives in the JSON payload; driver_id is a
  // mirrored column. ISO timestamps compare lexicographically = chronologically.
  listLoadsDueForPickupReminder(
    fromIso: string,
    toIso: string,
  ): Array<{ load: Load; driverId: string; pickupAt: string }> {
    const rows = sqlite
      .prepare(
        `SELECT payload, driver_id, json_extract(payload, '$.pickupAt') AS pickup_at
           FROM loads
          WHERE driver_id IS NOT NULL
            AND json_extract(payload, '$.pickupAt') >= ?
            AND json_extract(payload, '$.pickupAt') <= ?`,
      )
      .all(fromIso, toIso) as Array<{ payload: string; driver_id: string; pickup_at: string }>;
    const out: Array<{ load: Load; driverId: string; pickupAt: string }> = [];
    for (const r of rows) {
      try {
        const load = JSON.parse(r.payload) as Load;
        out.push({ load, driverId: r.driver_id, pickupAt: r.pickup_at });
      } catch {
        // skip a corrupt payload rather than failing the whole reminder pass
      }
    }
    return out;
  },

  // Atomic pickup-reminder de-dup. True exactly once per (load, driver).
  claimPickupReminder(input: { loadId: string; driverId: string; pickupAt: string }): boolean {
    const info = sqlite
      .prepare(
        `INSERT OR IGNORE INTO pickup_reminders_sent
           (id, load_id, driver_id, pickup_at, sent_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(makeId("pickrem"), input.loadId, input.driverId, input.pickupAt, now());
    return info.changes > 0;
  },

  /**
   * Release a claimed alert/reminder so the next poll retries it. Called when a
   * claim succeeded but the Telegram send FAILED transiently — otherwise the
   * de-dup row would permanently suppress the alert (the very "nobody got
   * pinged" failure this module exists to fix).
   */
  releaseLoadAlert(loadId: string, chatId: string): void {
    sqlite
      .prepare("DELETE FROM load_alerts_sent WHERE load_id = ? AND chat_id = ?")
      .run(loadId, chatId);
  },
  releasePickupReminder(loadId: string, driverId: string, pickupAt: string): void {
    sqlite
      .prepare(
        "DELETE FROM pickup_reminders_sent WHERE load_id = ? AND driver_id = ? AND pickup_at = ?",
      )
      .run(loadId, driverId, pickupAt);
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
    // Soft-deleted users are excluded from all default listings. They remain
    // in the table for FK integrity but never appear in lists/exports.
    query += " AND deleted_at IS NULL";
    query += " ORDER BY created_at ASC";
    const rows = sqlite.prepare(query).all(...params) as UserRow[];
    return rows.map((row) => rowToUserInternal(row)!).filter(Boolean);
  },

  countUsers(): number {
    return (sqlite.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number }).c;
  },

  /**
   * Live driver-seat count for a carrier (client). There is no persisted
   * `driver_seat_count` column — seats are derived so the figure can never
   * drift out of sync with reality. We count BOTH:
   *   - active linked drivers (not soft-deleted, not blocked), and
   *   - outstanding driver invites for this client (unconsumed, not expired),
   * so that issuing N pending invites can't be used to slip past the plan cap
   * before they're redeemed. Used by `canAddDriver` gating and surfaced in the
   * billing summary.
   */
  countDriverSeats(clientId: string): number {
    const activeDrivers = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS c FROM users
             WHERE role = 'driver'
               AND deleted_at IS NULL
               AND blocked = 0
               AND linked_client_id = ?`,
        )
        .get(clientId) as { c: number }
    ).c;
    const pendingInvites = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS c FROM invites
             WHERE role = 'driver'
               AND linked_client_id = ?
               AND consumed_at IS NULL
               AND expires_at > ?`,
        )
        .get(clientId, now()) as { c: number }
    ).c;
    return activeDrivers + pendingInvites;
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
    // Soft-deleted users never appear in the admin paginated listing.
    where.push("deleted_at IS NULL");
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
      const { orderValue, tiebreaker } = decodeCursor(filter.cursor);
      if (tiebreaker !== null) {
        where.push("(created_at < ? OR (created_at = ? AND id < ?))");
        params.push(orderValue, orderValue, tiebreaker);
      } else {
        where.push("created_at < ?");
        params.push(orderValue);
      }
    }

    // Fetch limit+1 to determine `hasMore` without a second query.
    const listQuery = `SELECT * FROM users WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`;
    const rows = sqlite.prepare(listQuery).all(...params, limit + 1) as UserRow[];

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map((row) => rowToUserInternal(row)!).filter(Boolean);
    const last = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.created_at, last.id) : null;

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
    // Phase 4 P0: driver_status column has a DEFAULT, but we set it explicitly
    // on creation so the value is predictable in tests and audits (Vlad's
    // request in the Q3 follow-up). For non-driver roles the value is dead
    // (toUserPublic skips it).
    sqlite
      .prepare(
        `
        INSERT INTO users (
          id, email, full_name, role, password_salt, password_hash,
          totp_secret, blocked, linked_client_id, created_at, updated_at, last_login_at,
          phone, driver_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, 'available')
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

  /**
   * Atomically create a user AND consume the single-use invite in one
   * transaction. If a concurrent signup already consumed the code, the whole
   * thing rolls back (no orphan user) and returns { alreadyConsumed: true }.
   * Closes the invite double-redemption race (two unlocked-invite signups
   * with different emails could otherwise both succeed).
   */
  createUserConsumingInvite(
    input: {
      email: string;
      fullName: string;
      role: UserRole;
      passwordSalt: string;
      passwordHash: string;
      totpSecret?: string;
      linkedClientId?: string;
      actorUserId?: string;
    },
    code: string,
  ): UserInternal | { alreadyConsumed: true } {
    const ALREADY = "__INVITE_ALREADY_CONSUMED__";
    const txn = sqlite.transaction(() => {
      const user = this.createUser(input);
      // Per-user subscription: clock starts now, lasts the invite's
      // subscriptionDays (default 30) -- this is what the user's countdown reads.
      const inviteRow = sqlite
        .prepare("SELECT subscription_days FROM invites WHERE code = ?")
        .get(code) as { subscription_days?: number | null } | undefined;
      const subDays = inviteRow?.subscription_days ?? 30;
      const subscriptionEndsAt = new Date(Date.now() + subDays * 24 * 3600 * 1000).toISOString();
      sqlite.prepare("UPDATE users SET subscription_ends_at = ? WHERE id = ?").run(subscriptionEndsAt, user.id);
      const r = sqlite
        .prepare(
          "UPDATE invites SET consumed_at = ?, consumed_by_user_id = ? WHERE code = ? AND consumed_at IS NULL",
        )
        .run(now(), user.id, code);
      if (r.changes === 0) throw new Error(ALREADY);
      this.audit("invite.consumed", "invite", code, { userId: user.id });
      return { ...user, subscriptionEndsAt };
    });
    try {
      return txn();
    } catch (e) {
      if (e instanceof Error && e.message === ALREADY) return { alreadyConsumed: true };
      throw e;
    }
  },

  updateUser(
    id: string,
    patch: {
      fullName?: string;
      email?: string;
      role?: UserRole;
      blocked?: boolean;
      linkedClientId?: string | null;
      passwordSalt?: string;
      passwordHash?: string;
      totpSecret?: string | null;
      // Phase 4 P2: settable by driver via TG bot (/status) or dispatcher.
      driverStatus?: DriverStatus;
      phone?: string | null;
      // Henry QA Bug #5 — truck unit number (drivers only).
      unitNumber?: string | null;
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
    if (patch.email !== undefined) {
      // Normalize to lowercase so getUserByEmail lookups stay consistent.
      sets.push("email = ?");
      params.push(patch.email.toLowerCase());
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
    if (patch.driverStatus !== undefined) {
      sets.push("driver_status = ?");
      params.push(patch.driverStatus);
    }
    if (patch.phone !== undefined) {
      sets.push("phone = ?");
      params.push(patch.phone);
    }
    if (patch.unitNumber !== undefined) {
      sets.push("unit_number = ?");
      params.push(patch.unitNumber);
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

  /**
   * Soft-delete a user: stamp deleted_at + force blocked=1. The row is kept
   * for FK integrity (loads.driver_id, audit_events.actor, assignments). The
   * user disappears from all default listings and can no longer authenticate.
   */
  softDeleteUser(id: string, actorUserId?: string): UserInternal | undefined {
    const existing = this.getUserById(id);
    if (!existing) return undefined;
    if (existing.deletedAt) return existing; // already deleted, idempotent
    const ts = now();
    sqlite
      .prepare("UPDATE users SET deleted_at = ?, blocked = 1, updated_at = ? WHERE id = ?")
      .run(ts, ts, id);
    this.audit("user.deleted", "user", id, {
      actorUserId,
      email: existing.email,
      role: existing.role,
    });
    // Must use the including-deleted variant — we just stamped deleted_at,
    // so the strict getUserById() would now return undefined and callers
    // (admin UI, smoke test) wouldn't get back the post-delete row.
    return this.getUserByIdIncludingDeleted(id);
  },

  recordUserLogin(id: string) {
    sqlite.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now(), id);
  },

  /** Audit High #11 — TOTP replay protection: last counter that was accepted. */
  getLastUsedTotpCounter(id: string): number | null {
    const row = sqlite
      .prepare("SELECT last_used_totp_counter FROM users WHERE id = ?")
      .get(id) as { last_used_totp_counter: number | null } | undefined;
    return row?.last_used_totp_counter ?? null;
  },

  /** Persist the counter that was just accepted so future codes ≤ it are rejected. */
  /**
   * Advance the TOTP replay counter, atomically. Returns true only if THIS call
   * advanced it — a concurrent login that already consumed the same counter
   * gets false, so the caller must reject it as a replay. Without the
   * conditional WHERE, two parallel logins with the same in-window code both
   * read the same minCounter, both verify, and both issue a session.
   */
  setLastUsedTotpCounter(id: string, counter: number): boolean {
    const r = sqlite
      .prepare(
        "UPDATE users SET last_used_totp_counter = ? WHERE id = ? AND (last_used_totp_counter IS NULL OR last_used_totp_counter < ?)",
      )
      .run(counter, id, counter);
    return r.changes > 0;
  },

  /**
   * Persist a freshly-confirmed TOTP secret and reset the replay counter to NULL
   * in ONE atomic write. The accepted counter from the OLD secret is meaningless
   * for a NEW, independent secret: on a 2FA rotation the user has already
   * authenticated with the old secret, so last_used_totp_counter is already at/
   * above the current time-window. Leaving it in place would make the new
   * secret's first code (same window) fail the setLastUsedTotpCounter replay
   * gate, blocking rotation entirely. Clearing it here re-bases replay protection
   * on the new secret's own history. Returns true if the user existed.
   */
  installTotpSecret(id: string, secret: string, actorUserId?: string): boolean {
    const existing = this.getUserById(id);
    if (!existing) return false;
    const r = sqlite
      .prepare(
        "UPDATE users SET totp_secret = ?, last_used_totp_counter = NULL, updated_at = ? WHERE id = ?",
      )
      .run(secret, now(), id);
    if (r.changes > 0) {
      // Audit parity with updateUser's mutation-path logging (secret redacted).
      this.audit("user.updated", "user", id, {
        patch: { totpSecret: undefined },
        actorUserId,
      });
    }
    return r.changes > 0;
  },

  /**
   * Fully tear down a user's 2FA in ONE atomic write — used by the admin
   * `reset-totp` "disable" path. Clears all three pieces of TOTP state:
   *   - totp_secret           → null  (2FA off)
   *   - totp_confirmed_at      → null  (so the user can self-service re-enroll;
   *                                     confirmTotpSetup's IS-NULL guard would
   *                                     otherwise treat them as already-confirmed
   *                                     and 409 every re-enrollment forever)
   *   - last_used_totp_counter → null  (re-base replay protection; a stale
   *                                     counter could lock the user out of the
   *                                     next secret's first in-window code)
   * updateUser({ totpSecret: null }) only touches the secret, leaving the other
   * two stale — hence this dedicated helper. Returns true if the user existed.
   */
  resetUserTotp(id: string, actorUserId?: string): boolean {
    const existing = this.getUserById(id);
    if (!existing) return false;
    const r = sqlite
      .prepare(
        "UPDATE users SET totp_secret = NULL, totp_confirmed_at = NULL, last_used_totp_counter = NULL, updated_at = ? WHERE id = ?",
      )
      .run(now(), id);
    if (r.changes > 0) {
      // Audit parity with updateUser's mutation-path logging (secret redacted).
      this.audit("user.updated", "user", id, {
        patch: { totpSecret: undefined },
        actorUserId,
      });
    }
    return r.changes > 0;
  },

  /**
   * Bump a user's session epoch — invalidates ALL of their existing sessions.
   * Called on admin password/TOTP reset: getCurrentUser compares the epoch
   * stamped into the session at login against this column and destroys any
   * session whose epoch is stale. Returns the new epoch.
   */
  bumpUserSessionEpoch(id: string): number {
    const r = sqlite
      .prepare(
        "UPDATE users SET session_epoch = session_epoch + 1, updated_at = ? WHERE id = ? RETURNING session_epoch",
      )
      .get(now(), id) as { session_epoch: number } | undefined;
    return r?.session_epoch ?? 0;
  },

  /** fix/totp-onboarding-verify — stamp totp_confirmed_at for a user who
   *  just entered a valid 6-digit code for the first time.
   *
   *  Single-use guard (hardening, Nikita's 🟡): the UPDATE is keyed on
   *  totp_confirmed_at IS NULL, so only the FIRST confirmation lands. A replayed
   *  pending-confirmation token (which is otherwise a stateless 10-min HMAC)
   *  therefore can't re-run this — firstConfirm is false on any repeat, even
   *  under a concurrent race (the column is the single arbiter, same pattern as
   *  claimMc). The TOTP minCounter already blocks code-reuse; this closes the
   *  remaining defense-in-depth gap so the token itself is one-shot.
   *
   *  Returns the user plus whether this call was the one that stamped it. */
  confirmTotpSetup(id: string): { user: UserInternal | undefined; firstConfirm: boolean } {
    const ts = now();
    const res = sqlite
      .prepare(
        "UPDATE users SET totp_confirmed_at = ?, updated_at = ? WHERE id = ? AND totp_confirmed_at IS NULL",
      )
      .run(ts, ts, id);
    return { user: this.getUserById(id), firstConfirm: res.changes === 1 };
  },

  /** feat/twilio-verify-phone-email — stamp phone_verified + phone_verified_at. */
  markPhoneVerified(userId: string, phoneE164: string): void {
    const ts = now();
    sqlite
      .prepare(
        "UPDATE users SET phone = ?, phone_verified = 1, phone_verified_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(phoneE164, ts, ts, userId);
  },

  /** feat/twilio-verify-phone-email — stamp email_verified_at. */
  markEmailVerified(userId: string): void {
    const ts = now();
    sqlite
      .prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?")
      .run(ts, ts, userId);
  },

  /** i18n — persist the user's UI language choice (cross-device). */
  setUserPreferredLang(id: string, lang: "ru" | "en" | "es" | "fr"): void {
    sqlite
      .prepare("UPDATE users SET preferred_lang = ?, updated_at = ? WHERE id = ?")
      .run(lang, now(), id);
  },

  // -------------------------------------------------------------------------
  // FMCSA Drug & Alcohol Clearinghouse query log (49 CFR Part 382).
  // -------------------------------------------------------------------------

  recordClearinghouseQuery(input: {
    userId: string;
    clientId?: string | null;
    queryType: "pre_employment" | "annual";
    queriedAt: string;
    result: "clear" | "prohibited" | "pending" | "consent_revoked";
    notes?: string | null;
    recordedByUserId: string;
  }): { id: string } {
    const id = makeId("chq");
    // pre_employment действует бессрочно (только при найме); annual = 12 месяцев.
    // Defense-in-depth: reject an unparseable queriedAt at the storage layer so a
    // garbage value can't (a) persist as the stored queried_at, or (b) make the
    // annual branch's v.toISOString() throw RangeError mid-insert. The route
    // layer already validates this, but the storage contract must be self-safe.
    const queriedAt = new Date(input.queriedAt);
    if (Number.isNaN(queriedAt.getTime())) {
      throw new Error(`recordClearinghouseQuery: invalid queriedAt "${input.queriedAt}"`);
    }
    let validUntil: string;
    if (input.queryType === "pre_employment") {
      validUntil = "9999-12-31T00:00:00.000Z";
    } else {
      const v = new Date(queriedAt);
      v.setUTCFullYear(v.getUTCFullYear() + 1);
      validUntil = v.toISOString();
    }
    sqlite.prepare(`
      INSERT INTO clearinghouse_queries (
        id, user_id, client_id, query_type, queried_at, result, valid_until,
        notes, recorded_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.userId,
      input.clientId ?? null,
      input.queryType,
      input.queriedAt,
      input.result,
      validUntil,
      input.notes ?? null,
      input.recordedByUserId,
      now(),
    );
    this.audit("clearinghouse.query_recorded", "user", input.userId, {
      queryType: input.queryType,
      result: input.result,
      validUntil,
    });
    return { id };
  },

  listClearinghouseQueriesForDriver(userId: string) {
    return sqlite
      .prepare(`
        SELECT * FROM clearinghouse_queries
        WHERE user_id = ?
        ORDER BY queried_at DESC
      `)
      .all(userId) as Array<Record<string, unknown>>;
  },

  /**
   * Статус D&A clearinghouse по каждому драйверу одного carrier'а.
   * Для UI list и для cron-reminder'а.
   */
  listClearinghouseStatusForClient(clientId: string) {
    return sqlite.prepare(`
      SELECT u.id AS user_id, u.full_name, u.email,
             (SELECT queried_at FROM clearinghouse_queries q
               WHERE q.user_id = u.id AND q.query_type = 'annual'
               ORDER BY q.queried_at DESC LIMIT 1) AS last_annual_at,
             (SELECT valid_until FROM clearinghouse_queries q
               WHERE q.user_id = u.id AND q.query_type = 'annual'
               ORDER BY q.queried_at DESC LIMIT 1) AS annual_valid_until,
             (SELECT result FROM clearinghouse_queries q
               WHERE q.user_id = u.id AND q.query_type = 'annual'
               ORDER BY q.queried_at DESC LIMIT 1) AS annual_result,
             (SELECT queried_at FROM clearinghouse_queries q
               WHERE q.user_id = u.id AND q.query_type = 'pre_employment'
               ORDER BY q.queried_at DESC LIMIT 1) AS pre_employment_at
      FROM users u
      WHERE u.role = 'driver'
        AND u.deleted_at IS NULL
        AND u.blocked = 0
        AND u.linked_client_id = ?
      ORDER BY annual_valid_until ASC NULLS FIRST, u.full_name ASC
    `).all(clientId) as Array<{
      user_id: string;
      full_name: string;
      email: string;
      last_annual_at: string | null;
      annual_valid_until: string | null;
      annual_result: string | null;
      pre_employment_at: string | null;
    }>;
  },

  // -------------------------------------------------------------------------
  // Phase 7.1 — Integration configs (encrypted secrets editable from UI)
  // -------------------------------------------------------------------------

  /** Returns the raw encrypted row for one (integrationKey, envVar). */
  getIntegrationConfigRaw(integrationKey: string, envVar: string):
    | { value_enc: string; value_iv: string; value_key_id: string; updated_at: string; updated_by_user_id: string | null }
    | undefined {
    return sqlite.prepare(`
      SELECT value_enc, value_iv, value_key_id, updated_at, updated_by_user_id
      FROM integration_configs WHERE integration_key = ? AND env_var = ?
    `).get(integrationKey, envVar) as
      | { value_enc: string; value_iv: string; value_key_id: string; updated_at: string; updated_by_user_id: string | null }
      | undefined;
  },

  /** Lists all env vars that are populated for a given integration. */
  listConfiguredIntegrationVars(integrationKey: string): Array<{ envVar: string; updatedAt: string; updatedBy: string | null }> {
    return (sqlite.prepare(`
      SELECT env_var as envVar, updated_at as updatedAt, updated_by_user_id as updatedBy
      FROM integration_configs WHERE integration_key = ?
      ORDER BY env_var ASC
    `).all(integrationKey)) as Array<{ envVar: string; updatedAt: string; updatedBy: string | null }>;
  },

  /** Upsert an encrypted integration secret. */
  setIntegrationConfig(
    integrationKey: string,
    envVar: string,
    enc: { ciphertext: string; iv: string; keyId: string },
    actorUserId?: string,
  ): void {
    sqlite.prepare(`
      INSERT INTO integration_configs (
        integration_key, env_var, value_enc, value_iv, value_key_id, updated_at, updated_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(integration_key, env_var) DO UPDATE SET
        value_enc = excluded.value_enc,
        value_iv = excluded.value_iv,
        value_key_id = excluded.value_key_id,
        updated_at = excluded.updated_at,
        updated_by_user_id = excluded.updated_by_user_id
    `).run(
      integrationKey, envVar,
      enc.ciphertext, enc.iv, enc.keyId,
      now(), actorUserId ?? null,
    );
    this.audit("integration.config_set", "integration", integrationKey, {
      envVar, actorUserId,
    });
  },

  /** Remove a single env var override. */
  clearIntegrationConfig(integrationKey: string, envVar: string, actorUserId?: string) {
    sqlite.prepare(
      "DELETE FROM integration_configs WHERE integration_key = ? AND env_var = ?"
    ).run(integrationKey, envVar);
    this.audit("integration.config_cleared", "integration", integrationKey, {
      envVar, actorUserId,
    });
  },

  // -------------------------------------------------------------------------
  // Phase 7.2 — Insurance expiry alert log
  // -------------------------------------------------------------------------

  /** Has an alert for (client, type, expires_at, days_before) already been sent? */
  hasInsuranceAlertBeenSent(
    clientId: string,
    insuranceType: string,
    expiresAt: string,
    daysBefore: number,
  ): boolean {
    const row = sqlite.prepare(`
      SELECT 1 FROM insurance_alerts_sent
      WHERE client_id = ? AND insurance_type = ? AND expires_at = ? AND days_before = ?
      LIMIT 1
    `).get(clientId, insuranceType, expiresAt, daysBefore);
    return Boolean(row);
  },

  /** Record that an insurance expiry alert was sent. */
  recordInsuranceAlertSent(input: {
    clientId: string;
    insuranceType: string;
    expiresAt: string;
    daysBefore: number;
    channels: string[];
  }): string {
    const id = makeId("insalert");
    sqlite.prepare(`
      INSERT INTO insurance_alerts_sent (
        id, client_id, insurance_type, expires_at, days_before, sent_at, channels
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.clientId, input.insuranceType, input.expiresAt,
      input.daysBefore, now(), JSON.stringify(input.channels),
    );
    this.audit("insurance.alert_sent", "client", input.clientId, {
      insuranceType: input.insuranceType,
      expiresAt: input.expiresAt,
      daysBefore: input.daysBefore,
      channels: input.channels,
    });
    return id;
  },

  /** History of alerts for a client (for client-detail UI). */
  listInsuranceAlertsForClient(clientId: string, limit = 20) {
    return sqlite.prepare(`
      SELECT * FROM insurance_alerts_sent
      WHERE client_id = ? ORDER BY sent_at DESC LIMIT ?
    `).all(clientId, limit) as Array<Record<string, unknown>>;
  },

  // -------------------------------------------------------------------------
  // Killer feature #5 — UCR/IRP renewal calendar
  // -------------------------------------------------------------------------

  /** Has an alert for (client, kind, expires_at, days_before) already been sent? */
  hasComplianceAlertBeenSent(
    clientId: string,
    kind: string,
    expiresAt: string,
    daysBefore: number,
  ): boolean {
    const row = sqlite.prepare(`
      SELECT 1 FROM compliance_alerts_sent
      WHERE client_id = ? AND kind = ? AND expires_at = ? AND days_before = ?
      LIMIT 1
    `).get(clientId, kind, expiresAt, daysBefore);
    return Boolean(row);
  },

  recordComplianceAlertSent(input: {
    clientId: string;
    kind: string;
    expiresAt: string;
    daysBefore: number;
    channels: string[];
  }): string {
    const id = makeId("compalert");
    sqlite.prepare(`
      INSERT INTO compliance_alerts_sent (
        id, client_id, kind, expires_at, days_before, sent_at, channels
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.clientId, input.kind, input.expiresAt,
      input.daysBefore, now(), JSON.stringify(input.channels),
    );
    return id;
  },

  listComplianceAlertsForClient(clientId: string, limit = 20) {
    return sqlite.prepare(`
      SELECT * FROM compliance_alerts_sent
      WHERE client_id = ? ORDER BY sent_at DESC LIMIT ?
    `).all(clientId, limit) as Array<Record<string, unknown>>;
  },

  // -------------------------------------------------------------------------
  // Onboarding wizard progress (per user request 2026-05-26)
  // -------------------------------------------------------------------------

  /** Read the user's onboarding row; returns null if they never started. */
  getOnboardingProgress(userId: string): {
    userId: string;
    step: number;
    data: Record<string, unknown>;
    startedAt: string;
    updatedAt: string;
    completedAt: string | null;
  } | null {
    const row = sqlite
      .prepare("SELECT * FROM onboarding_progress WHERE user_id = ?")
      .get(userId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      userId: row.user_id as string,
      step: Number(row.step ?? 0),
      data: JSON.parse((row.data as string) ?? "{}") as Record<string, unknown>,
      startedAt: row.started_at as string,
      updatedAt: row.updated_at as string,
      completedAt: (row.completed_at as string | null) ?? null,
    };
  },

  /** Insert or update onboarding row. Merges `data` shallowly so callers can
   *  send partial answers per step without losing prior keys. */
  upsertOnboardingProgress(
    userId: string,
    patch: { step?: number; data?: Record<string, unknown>; completed?: boolean },
  ): void {
    // Wrap read-modify-write in a transaction so two concurrent saves can't both
    // read the same `existing`, each merge against a stale base, and clobber the
    // other's keys. better-sqlite3 takes a write lock for the duration, so the
    // second caller sees the first's committed merge.
    const txn = sqlite.transaction(() => {
      const existing = this.getOnboardingProgress(userId);
      const ts = now();
      const mergedData = { ...(existing?.data ?? {}), ...(patch.data ?? {}) };
      const step = patch.step ?? existing?.step ?? 0;
      const completedAt = patch.completed ? ts : existing?.completedAt ?? null;
      if (existing) {
        sqlite
          .prepare(
            "UPDATE onboarding_progress SET step = ?, data = ?, updated_at = ?, completed_at = ? WHERE user_id = ?",
          )
          .run(step, JSON.stringify(mergedData), ts, completedAt, userId);
      } else {
        sqlite
          .prepare(
            "INSERT INTO onboarding_progress (user_id, step, data, started_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(userId, step, JSON.stringify(mergedData), ts, ts, completedAt);
      }
    });
    txn();
  },

  // -------------------------------------------------------------------------
  // Anti-fraud: per-MC account registry. One normalized MC = one account.
  // -------------------------------------------------------------------------
  getMcRegistryOwner(mcNormalized: string): { userId: string; claimedAt: string } | undefined {
    const row = sqlite
      .prepare("SELECT user_id, claimed_at FROM mc_account_registry WHERE mc_normalized = ?")
      .get(mcNormalized) as { user_id: string; claimed_at: string } | undefined;
    return row ? { userId: row.user_id, claimedAt: row.claimed_at } : undefined;
  },

  claimMc(mcNormalized: string, userId: string): { ok: boolean; conflictUserId?: string } {
    // V4-011: claim atomically via INSERT OR IGNORE against the mc_normalized
    // PRIMARY KEY, instead of check-then-insert (a TOCTOU race: two concurrent
    // claims could both pass the SELECT and the loser would crash on the PK
    // constraint). INSERT OR IGNORE makes the DB the single arbiter — exactly
    // one row wins. We then read back the owner to report the outcome:
    //   - inserted (changes>0) -> we own it now
    //   - ignored, owner == us  -> idempotent re-claim, ok
    //   - ignored, owner != us  -> genuine conflict
    const res = sqlite
      .prepare(
        "INSERT OR IGNORE INTO mc_account_registry (mc_normalized, user_id, claimed_at) VALUES (?, ?, ?)",
      )
      .run(mcNormalized, userId, now());
    if (res.changes > 0) return { ok: true };
    const owner = this.getMcRegistryOwner(mcNormalized);
    if (owner && owner.userId === userId) return { ok: true };
    return { ok: false, conflictUserId: owner?.userId };
  },

  releaseMcForUser(userId: string): void {
    sqlite.prepare("DELETE FROM mc_account_registry WHERE user_id = ?").run(userId);
  },
  /** V4-004: claim a Stripe event id. Returns true the FIRST time (process it),
      false if already seen (duplicate delivery — skip). Atomic via INSERT OR IGNORE. */
  markStripeEventProcessed(eventId: string, eventType: string): boolean {
    const r = sqlite
      .prepare(
        "INSERT OR IGNORE INTO stripe_processed_events (event_id, event_type, processed_at) VALUES (?, ?, ?)",
      )
      .run(eventId, eventType, now());
    return r.changes > 0;
  },

  /**
   * Release a claimed-but-failed Stripe event so a Stripe retry re-enters the
   * handler. Called from the webhook catch block: markStripeEventProcessed
   * claims the id BEFORE handling (to block concurrent duplicates), but if the
   * handler throws we must un-claim it — otherwise the retried delivery is
   * skipped as a "duplicate" and the event (a plan/seat/trial transition) is
   * silently lost forever.
   */
  unmarkStripeEventProcessed(eventId: string): void {
    sqlite
      .prepare("DELETE FROM stripe_processed_events WHERE event_id = ?")
      .run(eventId);
  },

  /**
   * Reverse lookup — returns the MC docket this user has claimed, if any.
   * Used by Audit v4 V4-003 to gate onboarding completion (no MC = no
   * trial). Returns undefined if the user has never claimed an MC.
   */
  findMcByUserId(userId: string): { mcNormalized: string; claimedAt: string } | undefined {
    const row = sqlite
      .prepare("SELECT mc_normalized, claimed_at FROM mc_account_registry WHERE user_id = ?")
      .get(userId) as { mc_normalized: string; claimed_at: string } | undefined;
    return row ? { mcNormalized: row.mc_normalized, claimedAt: row.claimed_at } : undefined;
  },

  /**
   * Phase 7 — presence: bump last_seen_at. Called from the /api middleware
   * on every authenticated request (throttled in-process to 30s/user). Does
   * NOT update updated_at because that would invalidate caches across the
   * stack for what is fundamentally a passive read marker.
   */
  touchUserPresence(id: string) {
    sqlite.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(now(), id);
  },

  /**
   * Phase 7 — presence: list users seen within the last `minutes` minutes.
   * Used by /api/admin/presence for the live online indicator on the users
   * list. Returns id-only set; the caller already has the user details.
   */
  listOnlineUserIds(minutes = 2): string[] {
    const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    return (sqlite
      .prepare("SELECT id FROM users WHERE last_seen_at >= ? AND deleted_at IS NULL")
      .all(cutoff) as Array<{ id: string }>).map((r) => r.id);
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

  /**
   * Atomically consume a single-use invite. Returns true only for the caller
   * that wins the `consumed_at IS NULL` race; a concurrent second redemption
   * gets false (and must be rejected). Without the conditional WHERE, an
   * unlocked invite could mint two accounts from one code.
   *
   * The WHERE clause also enforces `expires_at > now()` so expiry and
   * revocation (revokeInvite stamps expires_at = now()) are checked in the SAME
   * atomic statement — not left to a TOCTOU-racy route-level read. An expired
   * or revoked invite returns false, exactly like a double-redemption.
   */
  consumeInvite(code: string, userId: string): boolean {
    const ts = now();
    const res = sqlite
      .prepare(
        "UPDATE invites SET consumed_at = ?, consumed_by_user_id = ? WHERE code = ? AND consumed_at IS NULL AND expires_at > ?",
      )
      .run(ts, userId, code, ts);
    if (res.changes === 0) return false;
    this.audit("invite.consumed", "invite", code, { userId });
    return true;
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
    subscriptionDays?: number;
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
          linked_client_id, created_at, created_by_user_id, subscription_days
        ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
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
        input.subscriptionDays ?? 30,
      );
    const invite: Invite = {
      code: input.code,
      role: input.role,
      email: input.email?.toLowerCase(),
      expiresAt,
      linkedClientId: input.linkedClientId,
      createdAt,
      createdByUserId: input.createdByUserId,
      subscriptionDays: input.subscriptionDays ?? 30,
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
      const { orderValue, tiebreaker } = decodeCursor(filter.cursor);
      if (tiebreaker !== null) {
        where.push("(created_at < ? OR (created_at = ? AND code < ?))");
        params.push(orderValue, orderValue, tiebreaker);
      } else {
        where.push("created_at < ?");
        params.push(orderValue);
      }
    }

    const listQuery = `SELECT * FROM invites WHERE ${where.join(" AND ")} ORDER BY created_at DESC, code DESC LIMIT ?`;
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
    const last = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.created_at, last.code) : null;

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
  // Phase 4: Signup leads (hybrid signup flow)
  // -------------------------------------------------------------------------

  /**
   * Public-facing endpoint inserts here. Idempotent on email when status is
   * pending (we have a partial unique index). If a non-pending row exists for
   * the same email, we still allow a new pending row.
   */
  insertSignupLead(input: {
    email: string;
    lang?: string | null;
    country?: string | null;
    userAgent?: string | null;
    referer?: string | null;
    name?: string | null;
    note?: string | null;
  }): { lead: SignupLead; isNew: boolean } {
    const email = input.email.trim().toLowerCase();
    const existing = sqlite
      .prepare("SELECT * FROM signup_leads WHERE email = ? AND status = 'pending' LIMIT 1")
      .get(email) as Record<string, unknown> | undefined;
    if (existing) {
      // Дописываем новую note / name в существующий lead если юзер вернулся
      // и ввёл подробности (приоритетнее «Связаться» форма).
      if (input.note || input.name) {
        sqlite.prepare(
          `UPDATE signup_leads SET
             note = COALESCE(?, note),
             name = COALESCE(?, name)
           WHERE id = ?`,
        ).run(input.note ?? null, input.name ?? null, existing.id);
        this.audit("lead.note_updated", "signup_lead", String(existing.id), {
          email,
          hasNote: !!input.note,
          hasName: !!input.name,
        });
        const refreshed = this.getSignupLead(String(existing.id))!;
        return { lead: refreshed, isNew: false };
      }
      return { lead: rowToSignupLead(existing), isNew: false };
    }
    const id = `lead_${cryptoRandomId()}`;
    const createdAt = new Date().toISOString();
    sqlite.prepare(
      `INSERT INTO signup_leads (id, email, lang, country, user_agent, referer, status, created_at, name, note)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).run(
      id,
      email,
      input.lang ?? null,
      input.country ?? null,
      input.userAgent ?? null,
      input.referer ?? null,
      createdAt,
      input.name ?? null,
      input.note ?? null,
    );
    this.audit("lead.subscribed", "signup_lead", id, {
      email,
      lang: input.lang,
      hasNote: !!input.note,
      hasName: !!input.name,
    });
    const lead = this.getSignupLead(id)!;
    return { lead, isNew: true };
  },

  getSignupLead(id: string): SignupLead | undefined {
    const row = sqlite
      .prepare("SELECT * FROM signup_leads WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToSignupLead(row) : undefined;
  },

  listSignupLeadsPaginated(filter: {
    status?: SignupLeadStatus;
    limit?: number;
    cursor?: string;
  }): { items: SignupLead[]; nextCursor: string | null; hasMore: boolean; total: number } {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.cursor) {
      const { orderValue, tiebreaker } = decodeCursor(filter.cursor);
      if (tiebreaker !== null) {
        where.push("(created_at < ? OR (created_at = ? AND id < ?))");
        params.push(orderValue, orderValue, tiebreaker);
      } else {
        where.push("created_at < ?");
        params.push(orderValue);
      }
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = sqlite
      .prepare(
        `SELECT * FROM signup_leads ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as Record<string, unknown>[];
    const totalRow = filter.status
      ? (sqlite
          .prepare("SELECT COUNT(*) AS c FROM signup_leads WHERE status = ?")
          .get(filter.status) as { c: number })
      : (sqlite.prepare("SELECT COUNT(*) AS c FROM signup_leads").get() as { c: number });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(rowToSignupLead);
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
    return { items, nextCursor, hasMore, total: totalRow.c };
  },

  approveSignupLead(
    id: string,
    inviteCode: string,
    reviewerUserId: string,
  ): SignupLead | { notFound: true } | { alreadyReviewed: SignupLeadStatus } {
    const existing = this.getSignupLead(id);
    if (!existing) return { notFound: true };
    if (existing.status !== "pending") return { alreadyReviewed: existing.status };
    const reviewedAt = new Date().toISOString();
    // Conditional on status='pending' so two concurrent reviewers can't both win
    // the read-check and double-process (e.g. approve + reject). changes===0 means
    // someone else already transitioned it.
    const res = sqlite.prepare(
      `UPDATE signup_leads
       SET status = 'approved', approved_invite_code = ?, reviewed_by_user_id = ?, reviewed_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(inviteCode, reviewerUserId, reviewedAt, id);
    if (res.changes === 0) {
      const cur = this.getSignupLead(id);
      return cur ? { alreadyReviewed: cur.status } : { notFound: true };
    }
    this.audit("lead.approved", "signup_lead", id, {
      email: existing.email,
      inviteCode,
      reviewerUserId,
    });
    return this.getSignupLead(id)!;
  },

  rejectSignupLead(
    id: string,
    reviewerUserId: string,
    reason: string | null,
    spam = false,
  ): SignupLead | { notFound: true } | { alreadyReviewed: SignupLeadStatus } {
    const existing = this.getSignupLead(id);
    if (!existing) return { notFound: true };
    if (existing.status !== "pending") return { alreadyReviewed: existing.status };
    const reviewedAt = new Date().toISOString();
    const newStatus: SignupLeadStatus = spam ? "spam" : "rejected";
    const res = sqlite.prepare(
      `UPDATE signup_leads
       SET status = ?, reviewed_by_user_id = ?, reviewed_at = ?, reject_reason = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(newStatus, reviewerUserId, reviewedAt, reason, id);
    if (res.changes === 0) {
      const cur = this.getSignupLead(id);
      return cur ? { alreadyReviewed: cur.status } : { notFound: true };
    }
    this.audit(spam ? "lead.spam" : "lead.rejected", "signup_lead", id, {
      email: existing.email,
      reviewerUserId,
      reason,
    });
    return this.getSignupLead(id)!;
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
      const { orderValue, tiebreaker } = decodeCursor(filter.cursor);
      if (tiebreaker !== null) {
        where.push("(created_at < ? OR (created_at = ? AND id < ?))");
        params.push(orderValue, orderValue, tiebreaker);
      } else {
        where.push("created_at < ?");
        params.push(orderValue);
      }
    }

    const listQuery = `SELECT * FROM assignments WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`;
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
    const last = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.created_at, last.id) : null;

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
    /** Phase 3 P2: optional initial status (default "draft"). */
    status?: "draft" | "sent";
    /** Stripe charging: optional one-off Stripe invoice id, if a charge was
     *  initiated as part of generation. Usually set later via
     *  setInvoiceStripeId, but accepted here for atomic create+link callers. */
    stripeInvoiceId?: string;
  }): Invoice {
    const id = makeId("inv");
    // Round the sum to whole cents. billing.ts computes the canonical total in
    // integer cents; re-adding two dollar floats here (e.g. 150.00 + 12.34)
    // reintroduces float drift (…34000000003) — round it back to exact cents so
    // the stored/sent total matches the preview.
    const totalDue = Math.round((input.flatFee + input.percentFee) * 100) / 100;
    const generatedAt = now();
    const status: "draft" | "sent" = input.status ?? "draft";
    // If admin chose to send immediately, we also stamp sent_at — keeps the
    // status timeline consistent without a follow-up PATCH.
    const sentAt = status === "sent" ? generatedAt : null;
    sqlite
      .prepare(
        `
        INSERT INTO invoices (
          id, client_id, week_start, week_end, flat_fee, percent_fee,
          gross_booked, total_due, status, generated_at, sent_at, paid_at, notes,
          stripe_invoice_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
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
        status,
        generatedAt,
        sentAt,
        input.notes ?? null,
        input.stripeInvoiceId ?? null,
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
      status,
      generatedAt,
      sentAt: sentAt ?? undefined,
      notes: input.notes,
      stripeInvoiceId: input.stripeInvoiceId ?? undefined,
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
      stripeInvoiceId: row.stripe_invoice_id ?? undefined,
    }));
  },

  /** Phase 3 P2: fetch one invoice by id. Returns undefined if not found. */
  getInvoice(id: string): Invoice | undefined {
    const row = sqlite.prepare("SELECT * FROM invoices WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    return {
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
      stripeInvoiceId: row.stripe_invoice_id ?? undefined,
    };
  },

  /**
   * Audit H3: find a NON-VOID invoice for this client whose billed week
   * [week_start, week_end] OVERLAPS the requested [weekStart, weekEnd]. The
   * UNIQUE(client_id, week_start) index only blocks an identical week_start;
   * mis-aligned / overlapping windows (e.g. Mon-Sun vs Tue-Mon) slip past it
   * and would bill the shared loads twice. billing/generate uses this to 409.
   */
  findOverlappingInvoice(clientId: string, weekStart: string, weekEnd: string): Invoice | undefined {
    const row = sqlite
      .prepare(
        "SELECT * FROM invoices WHERE client_id = ? AND status != 'void' AND week_start <= ? AND week_end >= ? ORDER BY week_start ASC LIMIT 1",
      )
      .get(clientId, weekEnd, weekStart) as any;
    if (!row) return undefined;
    return {
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
      stripeInvoiceId: row.stripe_invoice_id ?? undefined,
    };
  },

  /**
   * Phase 3 P2: lookup an existing invoice for the same client + weekStart
   * combination, used to enforce the "one invoice per client per week" rule
   * (spec §4.2 → 409 Conflict).
   */
  findInvoiceForWeek(clientId: string, weekStart: string): Invoice | undefined {
    const row = sqlite
      .prepare("SELECT * FROM invoices WHERE client_id = ? AND week_start = ? LIMIT 1")
      .get(clientId, weekStart) as any;
    if (!row) return undefined;
    return {
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
      stripeInvoiceId: row.stripe_invoice_id ?? undefined,
    };
  },

  /**
   * Stripe charging: link a DispatchOS invoice to the one-off Stripe invoice we
   * created for it. Returns the updated invoice, or undefined if the id is
   * unknown. Idempotent at the SQL level (UPDATE sets the value either way).
   */
  setInvoiceStripeId(invoiceId: string, stripeInvoiceId: string): Invoice | undefined {
    const res = sqlite
      .prepare("UPDATE invoices SET stripe_invoice_id = ? WHERE id = ?")
      .run(stripeInvoiceId, invoiceId);
    if (res.changes === 0) return undefined;
    this.audit("invoice.stripe_linked", "invoice", invoiceId, {
      invoiceId,
      stripeInvoiceId,
    });
    return this.getInvoice(invoiceId);
  },

  /**
   * Stripe charging: reverse lookup a DispatchOS invoice by the Stripe invoice
   * id stamped on it. Used by the invoice.payment_succeeded webhook to flip the
   * row to 'paid'. Returns undefined when no row carries that Stripe id.
   */
  findInvoiceByStripeId(stripeInvoiceId: string): Invoice | undefined {
    const row = sqlite
      .prepare("SELECT * FROM invoices WHERE stripe_invoice_id = ? LIMIT 1")
      .get(stripeInvoiceId) as any;
    if (!row) return undefined;
    return {
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
      stripeInvoiceId: row.stripe_invoice_id ?? undefined,
    };
  },

  /**
   * Phase 3 P2: cursor-paginated invoice listing. Filters: clientId, status,
   * weekStart (>=), weekEnd (<=). Ordered by generated_at DESC (matches the
   * existing index from Phase 3 P0).
   */
  listInvoicesPaginated(filter: {
    limit?: number;
    cursor?: string;
    clientId?: string;
    status?: "draft" | "sent" | "paid" | "void";
    weekStart?: string;
    weekEnd?: string;
  }): { items: Invoice[]; nextCursor: string | null; total: number } {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);

    const where: string[] = ["1=1"];
    const params: any[] = [];
    if (filter.clientId) {
      where.push("client_id = ?");
      params.push(filter.clientId);
    }
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.weekStart) {
      where.push("week_start >= ?");
      params.push(filter.weekStart);
    }
    if (filter.weekEnd) {
      where.push("week_end <= ?");
      params.push(filter.weekEnd);
    }

    const countQuery = `SELECT COUNT(*) as c FROM invoices WHERE ${where.join(" AND ")}`;
    const total = (sqlite.prepare(countQuery).get(...params) as { c: number }).c;

    if (filter.cursor) {
      const { orderValue, tiebreaker } = decodeCursor(filter.cursor);
      if (tiebreaker !== null) {
        where.push("(generated_at < ? OR (generated_at = ? AND id < ?))");
        params.push(orderValue, orderValue, tiebreaker);
      } else {
        where.push("generated_at < ?");
        params.push(orderValue);
      }
    }

    const listQuery = `SELECT * FROM invoices WHERE ${where.join(" AND ")} ORDER BY generated_at DESC, id DESC LIMIT ?`;
    const rows = sqlite.prepare(listQuery).all(...params, limit + 1) as any[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items: Invoice[] = pageRows.map((row) => ({
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
      stripeInvoiceId: row.stripe_invoice_id ?? undefined,
    }));
    const last = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.generated_at, last.id) : null;
    return { items, nextCursor, total };
  },

  /**
   * Phase 3 P2: status / notes update.
   *
   * Allowed transitions (spec §4.4):
   *   draft  -> sent | void
   *   sent   -> paid | void
   *   paid   -> (immutable)
   *   void   -> (immutable)
   *
   * `notes` may be updated at any time, independently of status.
   *
   * Returns:
   *   - { notFound: true }       — no invoice with this id
   *   - { invalidTransition }    — current state forbids the requested status
   *   - { invoice }              — success, full updated row
   */
  updateInvoice(
    id: string,
    patch: { status?: "draft" | "sent" | "paid" | "void"; notes?: string },
  ):
    | { invoice: Invoice }
    | { notFound: true }
    | { invalidTransition: true; from: string; to: string } {
    const existing = this.getInvoice(id);
    if (!existing) return { notFound: true };

    const allowed: Record<string, Array<"draft" | "sent" | "paid" | "void">> = {
      draft: ["sent", "void"],
      sent: ["paid", "void"],
      paid: [],
      void: [],
    };

    const sets: string[] = [];
    const params: any[] = [];

    if (patch.status !== undefined && patch.status !== existing.status) {
      const okTransitions = allowed[existing.status];
      if (!okTransitions || !okTransitions.includes(patch.status)) {
        return {
          invalidTransition: true,
          from: existing.status,
          to: patch.status,
        };
      }
      sets.push("status = ?");
      params.push(patch.status);

      // Stamp side-channel timestamps. Idempotent: if sent_at or paid_at is
      // already set from a previous transition, we don't overwrite it.
      if (patch.status === "sent" && !existing.sentAt) {
        sets.push("sent_at = ?");
        params.push(now());
      }
      if (patch.status === "paid" && !existing.paidAt) {
        sets.push("paid_at = ?");
        params.push(now());
      }
    }
    if (patch.notes !== undefined) {
      sets.push("notes = ?");
      params.push(patch.notes);
    }

    if (sets.length === 0) {
      // Nothing to update — return current state as-is.
      return { invoice: existing };
    }

    params.push(id);
    // When the status is changing, make the write conditional on the status we
    // validated against, so two concurrent transitions can't both apply (TOCTOU).
    const statusChanging = patch.status !== undefined && patch.status !== existing.status;
    let whereSql = "id = ?";
    if (statusChanging) {
      whereSql += " AND status = ?";
      params.push(existing.status);
    }
    const res = sqlite.prepare(`UPDATE invoices SET ${sets.join(", ")} WHERE ${whereSql}`).run(...params);
    if (statusChanging && res.changes === 0) {
      const cur = this.getInvoice(id);
      return cur
        ? { invalidTransition: true, from: cur.status, to: patch.status! }
        : { notFound: true };
    }
    const updated = this.getInvoice(id)!;
    if (patch.status !== undefined && patch.status !== existing.status) {
      this.audit("invoice.status_changed", "invoice", id, {
        invoiceId: id,
        from: existing.status,
        to: patch.status,
      });
    }
    return { invoice: updated };
  },

  // -------------------------------------------------------------------------
  // Clients (unchanged from v1.2.7)
  // -------------------------------------------------------------------------

  listClients(opts?: { includeDeleted?: boolean }): Client[] {
    const rows = sqlite
      .prepare("SELECT payload FROM clients ORDER BY created_at ASC")
      .all() as Array<{ payload: string }>;
    const all = parsePayloads<Client>(rows);
    // Soft-delete: hide archived clients from the default listing. Pass
    // includeDeleted for admin tooling that needs the full set.
    return opts?.includeDeleted ? all : all.filter((c) => !c.deletedAt);
  },

  getClient(id: string): Client | undefined {
    const row = sqlite.prepare("SELECT payload FROM clients WHERE id = ?").get(id) as
      | { payload: string }
      | undefined;
    return parsePayload<Client>(row);
  },

  /**
   * Resolve client display names for a set of ids in ONE query — avoids the
   * full-table listClients() scan callers used to do just to look up a handful
   * of names (e.g. the dispatcher board render). Returns { id: name } only for
   * ids that exist and are NOT soft-deleted (mirrors listClients()'s deletedAt
   * filter). Unknown/archived ids are simply omitted (callers fall back to the
   * raw id). Empty input returns {} without touching the DB.
   *
   * The clients table stores data as a JSON payload (no flat `name` column), so
   * we read+parse payload — same pattern as listClients/getClient.
   */
  getClientNamesByIds(ids: string[]): Record<string, string> {
    if (ids.length === 0) return {};
    // De-dupe to keep the IN list tight and placeholders aligned.
    const unique = Array.from(new Set(ids));
    const placeholders = unique.map(() => "?").join(",");
    const rows = sqlite
      .prepare(`SELECT id, payload FROM clients WHERE id IN (${placeholders})`)
      .all(...unique) as Array<{ id: string; payload: string }>;
    const out: Record<string, string> = {};
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as { name?: unknown; deletedAt?: unknown };
        if (parsed.deletedAt) continue; // honor soft-delete, like listClients()
        if (typeof parsed.name === "string" && parsed.name.length > 0) {
          out[row.id] = parsed.name;
        }
      } catch {
        // Skip unparseable payloads — caller falls back to the raw id.
      }
    }
    return out;
  },

  /**
   * Soft-delete a client: stamp deletedAt in the payload. The row is kept for
   * FK integrity (loads.clientId, assignments, driver.linkedClientId) and
   * billing history — mirrors softDeleteUser. Idempotent: archiving an already
   * archived client is a no-op that returns it unchanged.
   */
  softDeleteClient(id: string, actorUserId?: string): Client | undefined {
    const existing = this.getClient(id);
    if (!existing) return undefined;
    if (existing.deletedAt) return existing; // already archived, idempotent
    // Cascade: archiving a carrier must also sever its live dispatcher
    // assignments. Dispatcher tenancy + the dispatch write-path guard key off
    // assignments with removed_at IS NULL only (they never join client.deletedAt),
    // so without this cascade a dispatcher keeps booking/billing loads for a
    // soft-deleted carrier. Run archive + assignment removal in one transaction
    // so they commit (or roll back) together.
    const ts = now();
    const txn = sqlite.transaction(() => {
      const updatedClient = this.upsertClient({
        ...(existing as unknown as InsertClient),
        deletedAt: ts,
      });
      const liveAssignments = this.listAssignmentsForClient(id);
      const removeStmt = sqlite.prepare(
        "UPDATE assignments SET removed_at = ?, removed_by_user_id = ? WHERE id = ? AND removed_at IS NULL",
      );
      for (const a of liveAssignments) {
        removeStmt.run(ts, actorUserId ?? null, a.id);
        this.audit("assignment.removed", "assignment", a.id, {
          removedByUserId: actorUserId ?? null,
          reason: "client_archived",
        });
      }
      this.audit("client.archived", "client", id, {
        actorUserId: actorUserId ?? null,
        cascadedAssignments: liveAssignments.length,
      });
      return updatedClient;
    });
    return txn();
  },

  /**
   * Restore a soft-deleted client: clear deletedAt so it reappears in
   * listClients(). Idempotent: restoring a non-archived client is a no-op.
   * getClient resolves archived clients by id, so this works even though
   * listClients hides them.
   */
  restoreClient(id: string, actorUserId?: string): Client | undefined {
    const existing = this.getClient(id);
    if (!existing) return undefined;
    if (!existing.deletedAt) return existing; // not archived, idempotent
    const updated = this.upsertClient({
      ...(existing as unknown as InsertClient),
      deletedAt: null,
    });
    this.audit("client.restored", "client", id, { actorUserId: actorUserId ?? null });
    return updated;
  },

  /**
   * P0.1 — provision a carrier when a user completes onboarding: create the
   * `clients` record, link the user (linkedClientId), and start the 14-day
   * trial. Previously onboarding-complete only wrote progress, so the carrier
   * never existed (dispatch board had nothing to score; requireActiveBilling
   * read a missing client). Atomic + idempotent (skips if already linked).
   */
  provisionCarrierFromOnboarding(
    userId: string,
    input: {
      persona: "owner_operator" | "fleet" | "enterprise";
      companyName?: string;
      planTier?: string;
    },
  ): Client | { skipped: "already_linked" | "user_not_found" | "no_mc" } {
    const user = this.getUserById(userId);
    if (!user) return { skipped: "user_not_found" };
    if (user.linkedClientId) return { skipped: "already_linked" };
    const claimed = this.findMcByUserId(userId);
    // Defense-in-depth: never mint a carrier without a claimed MC docket. The
    // route gates this too (V4-003), but keeping the invariant local means a
    // future call site can't accidentally create an mc:"" trial carrier.
    if (!claimed?.mcNormalized) return { skipped: "no_mc" };
    const nowIso = now();
    const planTier =
      input.planTier ||
      (input.persona === "owner_operator"
        ? "oo_basic"
        : input.persona === "fleet"
          ? "fleet_starter"
          : "enterprise");
    const txn = sqlite.transaction(() => {
      const created = this.upsertClient({
        name: input.companyName || user.fullName || "My Carrier",
        mc: claimed?.mcNormalized ?? "",
        equipment: "open_car_hauler",
        targetPpm: input.persona === "owner_operator" ? 2.5 : 2.2,
        minimumPpm: input.persona === "owner_operator" ? 2.0 : 1.9,
        mpg: 9,
        fuelPrice: 3.6,
        fixedCostPerMile: 0.4,
        preferredLanes: [],
        avoidStates: [],
        currentLocation: {
          city: "",
          state: "",
          lat: 39.8283,
          lng: -98.5795,
          source: "manual_checkin",
          updatedAt: nowIso,
          status: "empty",
          availableAt: nowIso,
        },
        persona: input.persona,
        ownerUserId: userId, // the onboarding user IS the account owner
        planTier,
        billingStatus: "trial",
        trialEndsAt: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
        onboardingCompletedAt: nowIso,
      } as InsertClient);
      this.updateUser(userId, { linkedClientId: created.id }, userId);
      this.audit("onboarding.carrier_provisioned", "client", created.id, {
        userId,
        persona: input.persona,
        planTier,
        trial: true,
      });
      return created;
    });
    return txn();
  },

  upsertClient(input: InsertClient): Client {
    const id = input.id || makeId("client");
    const existing = this.getClient(id);
    const client = { ...input, id } as Client;
    const timestamp = now();

    // Henry QA Bug #6+7: mirror contact person fields to flat columns for
    // potential future SQL queries. JSON payload remains the source of truth.
    sqlite
      .prepare(
        `
        INSERT INTO clients (id, payload, created_at, updated_at, contact_person_name, contact_person_email, contact_person_phone)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          payload = excluded.payload,
          updated_at = excluded.updated_at,
          contact_person_name = excluded.contact_person_name,
          contact_person_email = excluded.contact_person_email,
          contact_person_phone = excluded.contact_person_phone
      `,
      )
      .run(
        id,
        JSON.stringify(client),
        existing ? timestamp : timestamp,
        timestamp,
        (client as any).contactPersonName ?? null,
        (client as any).contactPersonEmail ?? null,
        (client as any).contactPersonPhone ?? null,
      );

    this.audit(existing ? "client.updated" : "client.created", "client", id, client);
    return client;
  },

  updateClientLocation(id: string, location: Partial<DriverLocation>): Client | undefined {
    const client = this.getClient(id);
    if (!client) return undefined;

    // Centralized coordinate guard. The GPS-ping seam (routes/track.ts) range-
    // and null-island-checks its writes, but the admin PATCH .../location route
    // and the Telegram /loc handler pipe lat/lng straight here, bypassing that
    // guard. Range-clamp + null-island validation belongs at this single write
    // chokepoint so a garbage fix (out-of-bounds, or the (0,0) "null island" a
    // chipset reports with no lock) can never poison the DB and wreck IFTA
    // bbox / miles-per-state aggregation regardless of which producer wrote it.
    const loc: Partial<DriverLocation> = { ...location };
    const lat = (loc as { lat?: number }).lat;
    const lng = (loc as { lng?: number }).lng;
    const hasCoords = typeof lat === "number" && typeof lng === "number";
    const inRange = hasCoords && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
    const isNullIsland = hasCoords && Math.abs(lat) < 0.01 && Math.abs(lng) < 0.01;
    if (hasCoords && (!inRange || isNullIsland || !Number.isFinite(lat) || !Number.isFinite(lng))) {
      // Drop the invalid coordinates from this write rather than persisting them
      // (and rather than throwing — callers treat the result as the updated
      // client). Any non-coordinate fields in `location` (city/state/source)
      // still apply.
      delete (loc as { lat?: number }).lat;
      delete (loc as { lng?: number }).lng;
    }

    const updated: Client = {
      ...client,
      currentLocation: {
        ...client.currentLocation,
        ...loc,
        updatedAt: loc.updatedAt || now(),
        availableAt: loc.availableAt || client.currentLocation.availableAt,
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

    // Phase 3 P2 + Phase 4 P0: mirror clientId / bookedAt / driverId from
    // the payload into dedicated SQLite columns. Billing (P2) uses client_id
    // + booked_at; driver portal (P4 P0) uses driver_id for tenant-scoped
    // listings. Payload JSON remains the source of truth (Phase 1 contract);
    // columns are a denormal index. Cast through `any` because Phase 1 Load
    // type doesn't yet declare these fields — they live in the additive
    // loadWithBookingSchema / loadFullSchema.
    const anyLoad = load as any;
    const clientIdCol = typeof anyLoad.clientId === "string" ? anyLoad.clientId : null;
    const bookedAtCol = typeof anyLoad.bookedAt === "string" ? anyLoad.bookedAt : null;
    const driverIdCol = typeof anyLoad.driverId === "string" ? anyLoad.driverId : null;
    const anyExisting = existing as any;
    const brokerMc = (anyLoad.brokerMc ?? anyLoad.broker_mc ?? "") as string;

    // Atomicity (V5): the load row, its audit event and the auto broker-trust
    // signals must all land together. Without a transaction, a failure after the
    // INSERT could leave a committed load with partial/duplicate trust signals
    // (which then skew the broker score). Wrap the whole write so it commits or
    // rolls back as one unit.
    const persist = sqlite.transaction(() => {
      sqlite
        .prepare(
          `
          INSERT INTO loads (id, payload, created_at, updated_at, client_id, booked_at, driver_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            payload    = excluded.payload,
            updated_at = excluded.updated_at,
            client_id  = excluded.client_id,
            booked_at  = excluded.booked_at,
            driver_id  = excluded.driver_id
        `,
        )
        .run(id, JSON.stringify(load), timestamp, timestamp, clientIdCol, bookedAtCol, driverIdCol);

      this.audit(existing ? "load.updated" : "load.created", "load", id, load);

      // Broker Trust auto write-paths — Killer Feature #1.
      if (brokerMc) {
        const rate = typeof anyLoad.rate === "number" ? anyLoad.rate : null;

        // A load has two terminal outcomes: completed (delivered) and cancelled.
        // The automatic trust signals must only fire on a LEGAL transition into
        // one of them — otherwise a cancelled load later re-upserted as delivered
        // would emit a spurious positive load_completed signal (inflating the
        // broker's score), and a delivered load flipped to cancelled would emit a
        // bogus negative. upsertLoad is also the ingest/import path, so we never
        // reject the write — we just skip the illegal signal and log it.
        const wasCompleted = anyExisting?.status === "completed" || !!(anyExisting?.deliveredAt ?? anyExisting?.delivered_at);
        const wasCancelled = anyExisting?.status === "cancelled";
        const isCompleted  = anyLoad.status === "completed" || !!(anyLoad.deliveredAt ?? anyLoad.delivered_at);
        const isCancelled  = anyLoad.status === "cancelled";

        // load_booked: bookedAt newly set for the first time
        if (!anyExisting?.bookedAt && !anyExisting?.booked_at && bookedAtCol) {
          this.appendBrokerTrustSignal({
            brokerMc, brokerName: (anyLoad.brokerName ?? null) as string | null,
            loadId: id, clientId: clientIdCol, signalType: "load_booked", positive: true,
            valueJson: rate !== null ? { rate } : undefined, source: "automatic",
          });
        }

        // load_completed: legal only when not already cancelled.
        if (!wasCompleted && isCompleted) {
          if (wasCancelled) {
            console.warn(`[broker-trust] skipping illegal load transition cancelled -> completed for load ${id}`);
          } else {
            this.appendBrokerTrustSignal({
              brokerMc, brokerName: (anyLoad.brokerName ?? null) as string | null,
              loadId: id, clientId: clientIdCol, signalType: "load_completed", positive: true,
              valueJson: rate !== null ? { rate } : undefined, source: "automatic",
            });
          }
        }

        // load_cancelled_by_broker: legal only when not already completed.
        if (!wasCancelled && isCancelled) {
          if (wasCompleted) {
            console.warn(`[broker-trust] skipping illegal load transition completed -> cancelled for load ${id}`);
          } else {
            this.appendBrokerTrustSignal({
              brokerMc, brokerName: (anyLoad.brokerName ?? null) as string | null,
              loadId: id, clientId: clientIdCol, signalType: "load_cancelled_by_broker", positive: false,
              notes: (anyLoad.cancelReason ?? anyLoad.cancel_reason ?? null) as string | null,
              source: "automatic",
            });
          }
        }
      }
    });
    persist();

    return load;
  },

  /**
   * Phase 3 P2 (billing): list loads for a client booked within a date range.
   * `weekStart`/`weekEnd` are inclusive date-only strings ("YYYY-MM-DD"). Uses
   * the (client_id, booked_at) index for O(log n + k) lookup; in-memory scans
   * are skipped entirely.
   *
   * Loads without a booking link (client_id IS NULL) are never returned here,
   * by design — they are not billable.
   */
  listBookedLoadsForClientWeek(
    clientId: string,
    weekStart: string,
    weekEnd: string,
  ): Load[] {
    // booked_at is a full ISO timestamp ("2026-06-14T15:30:00.000Z") but
    // weekEnd is a date-only string ("2026-06-14"). A naive `booked_at <=
    // weekEnd` drops every load booked ON the last day, because lexically
    // "2026-06-14T15:30:..." > "2026-06-14" — silently undercharging the
    // invoice. The week is meant to be INCLUSIVE on both ends, so compare the
    // upper bound against the start of the NEXT day instead.
    // Exclude cancelled loads: booked_at is never cleared on cancel (it is the
    // revenue-window key), so without this filter a booked-then-cancelled load
    // is still summed into grossBooked and charged the 3% success fee — a fee on
    // revenue that never existed. Delivered/completed loads stay billable by
    // design (they were real, dispatcher-earned bookings).
    const rows = sqlite
      .prepare(
        `SELECT payload FROM loads
         WHERE client_id = ? AND booked_at IS NOT NULL
           AND booked_at >= ? AND booked_at < date(?, '+1 day')
           AND COALESCE(json_extract(payload, '$.status'), '') NOT IN ('cancelled', 'canceled')
         ORDER BY booked_at ASC`,
      )
      .all(clientId, weekStart, weekEnd) as Array<{ payload: string }>;
    return parsePayloads<Load>(rows);
  },

  // -------------------------------------------------------------------------
  // Phase 4 P0: driver-scoped reads
  // -------------------------------------------------------------------------

  /**
   * Phase 4 P0: list loads assigned to a driver, newest first.
   *
   * Uses the (driver_id, created_at DESC) index for O(log n + k) lookup.
   * Cursor is the `created_at` of the last item on the previous page
   * (matches the listUsersPaginated / listInvitesPaginated convention).
   *
   * Driver tenancy is enforced HERE — every row returned has
   * `driver_id = :driverId`. Callers that pass `req.session.userId` and
   * `requireRole('driver')` cannot leak loads to another driver.
   */
  listLoadsForDriver(
    driverId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): { items: Load[]; nextCursor: string | null; total: number } {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

    const where: string[] = ["driver_id = ?"];
    const params: any[] = [driverId];

    // total is counted BEFORE applying the cursor, matching Phase 3 spec §0.3.
    const total = (sqlite
      .prepare(`SELECT COUNT(*) as c FROM loads WHERE ${where.join(" AND ")}`)
      .get(...params) as { c: number }).c;

    if (opts.cursor) {
      const { orderValue, tiebreaker } = decodeCursor(opts.cursor);
      if (tiebreaker !== null) {
        where.push("(created_at < ? OR (created_at = ? AND id < ?))");
        params.push(orderValue, orderValue, tiebreaker);
      } else {
        where.push("created_at < ?");
        params.push(orderValue);
      }
    }

    const rows = sqlite
      .prepare(
        `SELECT id, payload, created_at FROM loads
         WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, limit + 1) as Array<{ id: string; payload: string; created_at: string }>;

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map((r) => JSON.parse(r.payload) as Load);
    const last = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.created_at, last.id) : null;
    return { items, nextCursor, total };
  },

  /**
   * All ACTIVE (booked, not delivered/cancelled) loads for a driver. Used by
   * geofence auto-checkin, which must inspect every in-progress load — NOT just
   * the 20 most-recent of all loads (booked_at is never cleared, so once a
   * driver accumulates >20 lifetime loads, an older still-open load fell out of
   * that window and its arrival check-ins silently never fired). Bounded by the
   * driver's in-progress count (a handful), so no pagination needed.
   */
  listActiveBookedLoadsForDriver(driverId: string): Load[] {
    const rows = sqlite
      .prepare(
        `SELECT id, payload FROM loads
         WHERE driver_id = ? AND ${ACTIVE_LOAD_SQL}
         ORDER BY booked_at DESC`,
      )
      .all(driverId) as Array<{ payload: string }>;
    return parsePayloads<Load>(rows);
  },

  /**
   * Phase 4 P0: light-touch read of the driver_id column without parsing the
   * whole payload. Used by /api/me/loads/:id to authorise BEFORE returning
   * the load to a driver (so we 404 cleanly on cross-driver fetch).
   *
   * Returns:
   *   - undefined if the load doesn't exist
   *   - null      if the load exists but has no driver_id (e.g. unbooked)
   *   - the id    of the assigned driver otherwise
   */
  getLoadDriverId(loadId: string): string | null | undefined {
    const row = sqlite
      .prepare("SELECT driver_id FROM loads WHERE id = ?")
      .get(loadId) as { driver_id: string | null } | undefined;
    if (!row) return undefined;
    return row.driver_id;
  },

  /**
   * Atomically reassign a load's driver with optimistic concurrency.
   *
   * "Корень #1" — the dispatch reassign route did read-then-upsertLoad, a
   * TOCTOU: two concurrent PATCHes both read driver_id=X and both wrote, last
   * writer winning silently (double-book). Here the UPDATE is guarded by the
   * driver_id column (the indexed single arbiter, mirror of claimMc): it only
   * succeeds when the current driver_id still equals `expectedDriverId`. If
   * changes===0 someone moved it first — we return the actual value so the
   * caller can 409. Payload JSON (source of truth) and the booked_at mirror are
   * patched in the SAME transaction via json_set so the column and payload can
   * never diverge.
   *
   * expectedDriverId / newDriverId: null means "unassigned". booked_at is the
   * revenue-recognition marker: stamped ONCE on the first booking and then
   * IMMUTABLE — a later swap never re-stamps it (avoids a double success fee in
   * a later week) and an unassign never NULLs it (avoids dropping an already-
   * booked load out of the billing window).
   */
  reassignLoadDriver(
    loadId: string,
    expectedDriverId: string | null,
    newDriverId: string | null,
    actorUserId?: string,
  ): { ok: true; load: Load } | { ok: false; conflict: true; actual: string | null } {
    const ALREADY = "__LOAD_REASSIGN_CONFLICT__";
    const timestamp = now();
    const txn = sqlite.transaction(() => {
      // booked_at is the revenue-recognition marker and the billing-week key, so
      // it must be IMMUTABLE once set: stamp it ONLY on the first transition to
      // booked (existing booked_at IS NULL && a driver is being assigned). On a
      // driver SWAP we must not re-stamp it (that would migrate an already-billed
      // load into a later invoice week → double 3% success fee); on UNASSIGN we
      // must not NULL it (that would drop an already-booked load out of the
      // billing window → undercharge). In both of those cases we leave the
      // booked_at column and payload.$.bookedAt untouched.
      const existing = sqlite
        .prepare("SELECT booked_at FROM loads WHERE id = ?")
        .get(loadId) as { booked_at: string | null } | undefined;
      const stampBooked = newDriverId !== null && (existing?.booked_at ?? null) === null;
      // bookedAt is a date-only "YYYY-MM-DD" value by convention (billing week
      // boundaries + dateOnlySchema both require it; a full ISO timestamp fails
      // loadFullSchema and 400s every dispatcher/driver load view). `timestamp`
      // is full ISO, so slice to the calendar date.
      const bookedAt = stampBooked ? timestamp.slice(0, 10) : null;
      // Guard on the driver_id column. `IS` (not `=`) so NULL compares correctly
      // — `driver_id = NULL` is never true in SQL, but `driver_id IS NULL` is.
      // The booked_at column + payload.$.bookedAt are only written when stamping
      // a fresh booking; otherwise they're omitted from the SET so the existing
      // value survives the reassign.
      const res = sqlite
        .prepare(
          `
          UPDATE loads SET
            driver_id  = ?,
            ${stampBooked ? "booked_at  = ?," : ""}
            updated_at = ?,
            payload    = ${
              stampBooked
                ? `json_set(
                     json_set(payload, '$.driverId', ${newDriverId === null ? "json('null')" : "?"}),
                     '$.bookedAt', ?
                   )`
                : `json_set(payload, '$.driverId', ${newDriverId === null ? "json('null')" : "?"})`
            }
          WHERE id = ? AND driver_id IS ?
        `,
        )
        .run(
          ...[
            newDriverId,
            ...(stampBooked ? [bookedAt] : []),
            timestamp,
            ...(newDriverId === null ? [] : [newDriverId]),
            ...(stampBooked ? [bookedAt] : []),
            loadId,
            expectedDriverId,
          ],
        );
      if (res.changes === 0) throw new Error(ALREADY);
      this.audit("load.driver_reassigned", "load", loadId, {
        actorUserId: actorUserId ?? null,
        from: expectedDriverId,
        to: newDriverId,
      });
    });
    try {
      txn();
    } catch (e) {
      if (e instanceof Error && e.message === ALREADY) {
        return { ok: false, conflict: true, actual: this.getLoadDriverId(loadId) ?? null };
      }
      throw e;
    }
    const load = this.getLoad(loadId);
    if (!load) return { ok: false, conflict: true, actual: null };
    return { ok: true, load };
  },

  /**
   * Mark a load as delivered/completed. Stamps payload.$.deliveredAt = now()
   * and payload.$.status = 'completed' via the same json_set raw-SQL pattern as
   * reassignLoadDriver, so the column-free delivery state is written atomically.
   * ACTIVE_LOAD_SQL keys "active/billable" off json_extract(payload,
   * '$.deliveredAt') IS NULL, so flipping deliveredAt removes the load from the
   * active/billable set. booked_at is the immutable revenue-window key and is
   * NEVER cleared here (a delivered load was already billed for its booked
   * week). Idempotent: re-delivering an already-delivered load is harmless.
   * Returns the updated Load, or undefined if the load doesn't exist.
   *
   * Note: the loads table has no delivered_at mirror column (delivery state
   * lives only in the JSON payload), so there is no column to update — unlike
   * driver_id/booked_at which reassignLoadDriver mirrors.
   */
  markLoadDelivered(loadId: string): Load | undefined {
    const timestamp = now();
    const res = sqlite
      .prepare(
        `
        UPDATE loads SET
          updated_at = ?,
          payload    = json_set(
                         json_set(payload, '$.deliveredAt', ?),
                         '$.status', 'completed'
                       )
        WHERE id = ?
      `,
      )
      .run(timestamp, timestamp, loadId);
    if (res.changes === 0) return undefined;
    this.audit("load.delivered", "load", loadId, { deliveredAt: timestamp });
    return this.getLoad(loadId);
  },

  /**
   * Phase 4 P0: write a new driver status. Caller-side requireRole('driver')
   * + the route checks role==='driver' before calling, so non-driver writes
   * never reach this helper. We still hard-store anyway — column is NOT NULL.
   */
  updateUserStatus(userId: string, status: DriverStatus): UserInternal | undefined {
    const existing = this.getUserById(userId);
    if (!existing) return undefined;
    const timestamp = now();
    sqlite
      .prepare(`UPDATE users SET driver_status = ?, updated_at = ? WHERE id = ?`)
      .run(status, timestamp, userId);
    return this.getUserById(userId);
  },

  /**
   * Phase 4 P0: update driver-managed profile fields. Only fullName and phone
   * are user-editable — role, email, blocked, linkedClientId stay
   * admin-managed via updateUser. At least one field must be provided
   * (validated by the route schema).
   */
  updateUserProfileFields(
    userId: string,
    patch: { fullName?: string; phone?: string },
  ): UserInternal | undefined {
    const existing = this.getUserById(userId);
    if (!existing) return undefined;
    const sets: string[] = [];
    const params: any[] = [];
    if (patch.fullName !== undefined) {
      sets.push("full_name = ?");
      params.push(patch.fullName);
    }
    if (patch.phone !== undefined) {
      sets.push("phone = ?");
      params.push(patch.phone);
    }
    if (sets.length === 0) return existing; // no-op; route layer should have rejected
    sets.push("updated_at = ?");
    params.push(now());
    params.push(userId);
    sqlite
      .prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
    return this.getUserById(userId);
  },

  // -------------------------------------------------------------------------
  // Audit + Documents + Brokers + Email (unchanged from v1.2.7)
  // -------------------------------------------------------------------------

  audit(eventType: string, entityType: string, entityId: string, payload: unknown) {
    // Denormalize the actor out of the payload into its own column so the audit
    // log can filter by actor in SQL (accurate total/cursor). Source of truth for
    // the actor is still the payload; this column is a queryable mirror.
    const actorUserId = pluckActorIdFromPayload(payload);
    sqlite
      .prepare(
        `
        INSERT INTO audit_events (id, event_type, entity_type, entity_id, payload, created_at, actor_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(makeId("audit"), eventType, entityType, entityId, JSON.stringify(payload), now(), actorUserId);
  },

  listAuditEvents(limit = 50) {
    return sqlite
      .prepare(
        "SELECT id, event_type as eventType, entity_type as entityType, entity_id as entityId, payload, created_at as createdAt FROM audit_events ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit)
      .map((row: any) => ({ ...row, payload: JSON.parse(row.payload) }));
  },

  /**
   * Phase 3 P4: cursor-paginated audit listing with filters.
   *
   * Spec §6.1. Sorts by created_at DESC. The cursor is the created_at of
   * the last row on the previous page.
   *
   * `eventType` filter accepts a single string or an array; we OR them
   * together. Same for `entityType` (string only — spec didn't require
   * array form, keeping signature small).
   *
   * Note on actor enrichment: audit_events has no actor_user_id column —
   * the actor lives inside the JSON payload under varying keys depending
   * on the event type (createdByAdminId, resetByAdminId, removedByUserId,
   * createdByUserId, actorUserId, …). We pluck the first one we find and
   * resolve email via getUserById. Legacy events with none → `null`. This
   * matches the AuditEvent shape declared in shared/schema.ts.
   */
  listAuditEventsPaginated(filter: {
    limit?: number;
    cursor?: string;
    eventType?: string | string[];
    entityType?: string;
    actorId?: string;
    entityId?: string;
    since?: string;
    until?: string;
  }): {
    items: Array<{
      id: string;
      eventType: string;
      entityType: string;
      entityId: string | null;
      actorUserId: string | null;
      actorEmail: string | null;
      payload: Record<string, unknown> | null;
      createdAt: string;
    }>;
    nextCursor: string | null;
    total: number;
  } {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);

    const where: string[] = ["1=1"];
    const params: any[] = [];

    if (filter.eventType) {
      const types = Array.isArray(filter.eventType) ? filter.eventType : [filter.eventType];
      if (types.length > 0) {
        const placeholders = types.map(() => "?").join(",");
        where.push(`event_type IN (${placeholders})`);
        params.push(...types);
      }
    }
    if (filter.entityType) {
      where.push("entity_type = ?");
      params.push(filter.entityType);
    }
    if (filter.entityId) {
      where.push("entity_id = ?");
      params.push(filter.entityId);
    }
    if (filter.since) {
      where.push("created_at >= ?");
      params.push(filter.since);
    }
    if (filter.until) {
      where.push("created_at <= ?");
      params.push(filter.until);
    }
    if (filter.actorId) {
      // Now a real column (denormalized from payload) — filter in SQL so total
      // and the cursor stay accurate.
      where.push("actor_user_id = ?");
      params.push(filter.actorId);
    }

    const countQuery = `SELECT COUNT(*) as c FROM audit_events WHERE ${where.join(" AND ")}`;
    const total = (sqlite.prepare(countQuery).get(...params) as { c: number }).c;

    if (filter.cursor) {
      const { orderValue, tiebreaker } = decodeCursor(filter.cursor);
      if (tiebreaker !== null) {
        where.push("(created_at < ? OR (created_at = ? AND id < ?))");
        params.push(orderValue, orderValue, tiebreaker);
      } else {
        where.push("created_at < ?");
        params.push(orderValue);
      }
    }

    // Over-fetch by limit+1 to determine hasMore. All filters (including actorId)
    // are now in SQL, so total/hasMore/nextCursor are exact.
    const listQuery = `SELECT id, event_type as eventType, entity_type as entityType, entity_id as entityId, payload, created_at as createdAt, actor_user_id as actorUserId FROM audit_events WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`;
    const rows = sqlite.prepare(listQuery).all(...params, limit + 1) as any[];

    const hasMore = rows.length > limit;
    const pageRaw = hasMore ? rows.slice(0, limit) : rows;
    const lastRaw = pageRaw[pageRaw.length - 1];
    const nextCursor = hasMore && lastRaw ? encodeCursor(lastRaw.createdAt, lastRaw.id) : null;

    const items = pageRaw.map((row) => {
      const payload = row.payload ? JSON.parse(row.payload) : null;
      // actorUserId comes from the column now; fall back to the payload for any
      // pre-backfill row that somehow slipped through.
      const actorUserId = (row.actorUserId as string | null) ?? pluckActorIdFromPayload(payload);
      const actorEmail = actorUserId ? this.getUserById(actorUserId)?.email ?? null : null;
      return {
        id: row.id,
        eventType: row.eventType,
        entityType: row.entityType,
        entityId: row.entityId ?? null,
        actorUserId,
        actorEmail,
        payload: payload as Record<string, unknown> | null,
        createdAt: row.createdAt,
      };
    });

    return { items, nextCursor, total };
  },

  /**
   * Phase 3 P3 helper: count audit events in a recent time window.
   * Used by dashboard.stats for `eventsLast24h` etc. `since` is an ISO
   * datetime string.
   */
  countAuditEventsSince(since: string): number {
    return (
      sqlite
        .prepare("SELECT COUNT(*) as c FROM audit_events WHERE created_at >= ?")
        .get(since) as { c: number }
    ).c;
  },

  /**
   * Phase 3 P3 helper: count events that look like errors in a window.
   * We don't have a dedicated error flag — heuristic: event_type starts
   * with `error.` OR ends with `.error` OR `.failed`. Returns 0 for
   * baseline projects; the dashboard tile will simply say "Без ошибок".
   */
  countErrorEventsSince(since: string): number {
    return (
      sqlite
        .prepare(
          `SELECT COUNT(*) as c FROM audit_events
           WHERE created_at >= ?
             AND (event_type LIKE 'error.%' OR event_type LIKE '%.error' OR event_type LIKE '%.failed')`,
        )
        .get(since) as { c: number }
    ).c;
  },

  /** Phase 3 P3 helper: most recent audit event timestamp, or null. */
  lastAuditEventAt(): string | null {
    const row = sqlite
      .prepare("SELECT created_at FROM audit_events ORDER BY created_at DESC LIMIT 1")
      .get() as { created_at: string } | undefined;
    return row?.created_at ?? null;
  },

  /**
   * Phase 5 (Admin Integrations page): count audit events whose event_type
   * matches ANY of the given values in the last 24 hours, and return the
   * most recent timestamp among them. Used to display per-integration
   * activity counters in /api/admin/integrations.
   *
   * `eventTypes` is matched with exact equality (not LIKE), so callers must
   * list each variant explicitly. Empty list returns {count:0, lastAt:null}.
   */
  countAuditEventsByTypesIn24h(eventTypes: string[]): {
    count: number;
    lastAt: string | null;
  } {
    if (!eventTypes || eventTypes.length === 0) {
      return { count: 0, lastAt: null };
    }
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const placeholders = eventTypes.map(() => "?").join(",");
    const count = (
      sqlite
        .prepare(
          `SELECT COUNT(*) as c FROM audit_events
           WHERE created_at >= ? AND event_type IN (${placeholders})`,
        )
        .get(since, ...eventTypes) as { c: number }
    ).c;
    const lastRow = sqlite
      .prepare(
        `SELECT created_at FROM audit_events
         WHERE created_at >= ? AND event_type IN (${placeholders})
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(since, ...eventTypes) as { created_at: string } | undefined;
    return { count, lastAt: lastRow?.created_at ?? null };
  },

  /** Phase 3 P3 helper: user count by role, with optional blocked filter. */
  countUsersByRole(role: UserRole, includeBlocked = false): number {
    const query = includeBlocked
      ? "SELECT COUNT(*) as c FROM users WHERE role = ?"
      : "SELECT COUNT(*) as c FROM users WHERE role = ? AND blocked = 0";
    return (sqlite.prepare(query).get(role) as { c: number }).c;
  },

  /** Phase 3 P3 helper: count of blocked users across all roles. */
  countBlockedUsers(): number {
    return (
      sqlite.prepare("SELECT COUNT(*) as c FROM users WHERE blocked = 1").get() as { c: number }
    ).c;
  },

  /** Phase 3 P3 helper: most recent user.created_at, or null. */
  lastUserCreatedAt(): string | null {
    const row = sqlite
      .prepare("SELECT created_at FROM users ORDER BY created_at DESC LIMIT 1")
      .get() as { created_at: string } | undefined;
    return row?.created_at ?? null;
  },

  /**
   * Phase 3 P3 helper: list loads created in a time window (used by
   * dashboard verdict tile).
   */
  listLoadsCreatedSince(since: string): Load[] {
    const rows = sqlite
      .prepare("SELECT payload FROM loads WHERE created_at >= ? ORDER BY created_at DESC")
      .all(since) as Array<{ payload: string }>;
    return parsePayloads<Load>(rows);
  },

  /**
   * Phase 3 P3 helper: count of loads created in a time window.
   */
  /** Audit V2-10 — lightweight count helpers for /api/health.
   * Avoids loading every row + parsing JSON just to read `.length`. */
  countClients(): number {
    return (sqlite.prepare("SELECT COUNT(*) as c FROM clients").get() as { c: number }).c;
  },
  countLoads(): number {
    return (sqlite.prepare("SELECT COUNT(*) as c FROM loads").get() as { c: number }).c;
  },
  countDocuments(): number {
    return (sqlite.prepare("SELECT COUNT(*) as c FROM documents").get() as { c: number }).c;
  },
  countBrokerRecords(): number {
    return (sqlite.prepare("SELECT COUNT(*) as c FROM broker_records").get() as { c: number }).c;
  },
  countEmailIngest(): number {
    return (sqlite.prepare("SELECT COUNT(*) as c FROM email_ingest").get() as { c: number }).c;
  },

  countLoadsSince(since: string): number {
    return (
      sqlite
        .prepare("SELECT COUNT(*) as c FROM loads WHERE created_at >= ?")
        .get(since) as { c: number }
    ).c;
  },

  /**
   * Phase 3 P3 helper: gross USD of loads booked in a date-only window.
   * Uses the loads_client_booked_idx column added in P2. Sums load.rate
   * across rows where booked_at IS NOT NULL AND in range.
   */
  grossBookedInWindow(weekStart: string, weekEnd: string): number {
    // weekEnd is a date-only string (e.g. '2026-06-19') but booked_at is a full
    // ISO timestamp, so `booked_at <= weekEnd` excludes everything booked AFTER
    // midnight on the last day (the timestamp sorts lexically after the bare
    // date). Use `< date(weekEnd,'+1 day')` to include the whole last day —
    // same fix as listBookedLoadsForClientWeek.
    // Exclude cancelled loads from revenue: booked_at survives a cancellation
    // (it's the billing-week key), so without this filter a booked-then-cancelled
    // load keeps incurring the 3% success fee on revenue that never existed.
    // Delivered/completed loads remain billable by design.
    const rows = sqlite
      .prepare(
        `SELECT payload FROM loads
         WHERE booked_at IS NOT NULL AND booked_at >= ? AND booked_at < date(?, '+1 day')
           AND COALESCE(json_extract(payload, '$.status'), '') NOT IN ('cancelled', 'canceled')`,
      )
      .all(weekStart, weekEnd) as Array<{ payload: string }>;
    let sum = 0;
    for (const row of rows) {
      try {
        const load = JSON.parse(row.payload);
        if (typeof load.rate === "number") sum += load.rate;
      } catch {
        // skip corrupt rows
      }
    }
    return Math.round(sum * 100) / 100;
  },

  /**
   * Phase 3 P3 helper: count of active clients (any client with at least
   * one active (removed_at IS NULL) dispatcher assignment, OR with at
   * least one booked load in the last 30 days). We use this softer
   * definition because "active" in the MRR sense means "still on the
   * books and generating fees".
   */
  countActiveClientsForMrr(): number {
    const row = sqlite
      .prepare(
        `SELECT COUNT(DISTINCT client_id) as c FROM (
            SELECT client_id FROM assignments WHERE removed_at IS NULL
            UNION
            SELECT client_id FROM loads
            WHERE client_id IS NOT NULL
              AND booked_at IS NOT NULL
              AND booked_at >= date('now','-30 days')
         )`,
      )
      .get() as { c: number };
    return row.c;
  },

  /**
   * Phase 3 P3 helper: sum of percent_fee on invoices generated this
   * calendar month (status in 'sent' or 'paid'). Used as the variable
   * portion of currentUsd MRR.
   */
  monthToDatePercentFee(): number {
    const row = sqlite
      .prepare(
        `SELECT COALESCE(SUM(percent_fee), 0) as s FROM invoices
         WHERE status IN ('sent','paid')
           AND generated_at >= strftime('%Y-%m-01T00:00:00.000Z', 'now')`,
      )
      .get() as { s: number };
    return Math.round((row.s ?? 0) * 100) / 100;
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

  // -------------------------------------------------------------------------
  // Phase 4: Broker performance events (feeds AI brokers.ts)
  // -------------------------------------------------------------------------

  insertBrokerEvent(input: {
    brokerMc: string;
    eventType: BrokerEventType;
    loadId?: string | null;
    amountUsd?: number | null;
    notes?: string | null;
    loggedByUserId: string;
  }): BrokerEvent {
    const id = `bev_${cryptoRandomId()}`;
    const loggedAt = new Date().toISOString();
    const brokerMc = input.brokerMc.trim();
    sqlite
      .prepare(
        `INSERT INTO broker_events (id, broker_mc, event_type, load_id, amount_usd, notes, logged_by_user_id, logged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        brokerMc,
        input.eventType,
        input.loadId ?? null,
        input.amountUsd ?? null,
        input.notes ?? null,
        input.loggedByUserId,
        loggedAt,
      );
    this.audit("broker_event.logged", "broker_event", id, {
      brokerMc,
      eventType: input.eventType,
      loadId: input.loadId,
      amountUsd: input.amountUsd,
    });
    return {
      id,
      brokerMc,
      eventType: input.eventType,
      loadId: input.loadId ?? null,
      amountUsd: input.amountUsd ?? null,
      notes: input.notes ?? null,
      loggedByUserId: input.loggedByUserId,
      loggedAt,
    };
  },

  listBrokerEventsByMc(brokerMc: string, limit = 200): BrokerEvent[] {
    const rows = sqlite
      .prepare(
        `SELECT id, broker_mc, event_type, load_id, amount_usd, notes, logged_by_user_id, logged_at
         FROM broker_events WHERE broker_mc = ? ORDER BY logged_at DESC LIMIT ?`,
      )
      .all(brokerMc.trim(), Math.min(Math.max(limit, 1), 1000)) as Record<string, unknown>[];
    return rows.map(rowToBrokerEvent);
  },

  getBrokerEvent(id: string): BrokerEvent | undefined {
    const row = sqlite
      .prepare(
        `SELECT id, broker_mc, event_type, load_id, amount_usd, notes, logged_by_user_id, logged_at
         FROM broker_events WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToBrokerEvent(row) : undefined;
  },

  countBrokerEvents(brokerMc: string): number {
    const row = sqlite
      .prepare("SELECT COUNT(*) AS c FROM broker_events WHERE broker_mc = ?")
      .get(brokerMc.trim()) as { c: number };
    return row.c;
  },

  // Look up an ingest row by its stable email Message-ID. Used to make ingest
  // idempotent so a replayed POST (or cron re-parse) doesn't mint a duplicate.
  getEmailIngestByMessageId(messageId: string) {
    const row = sqlite
      .prepare(
        "SELECT id, payload, created_at as createdAt FROM email_ingest WHERE message_id = ?",
      )
      .get(messageId) as { id: string; payload: string; createdAt: string } | undefined;
    if (!row) return undefined;
    return { id: row.id, ...JSON.parse(row.payload), createdAt: row.createdAt };
  },

  saveEmailIngest(payload: unknown) {
    const messageId =
      payload && typeof payload === "object"
        ? (payload as { messageId?: unknown }).messageId
        : undefined;
    const hasMessageId = typeof messageId === "string" && messageId.length > 0;

    // Idempotency: if this email carries a Message-ID and we've already ingested
    // it, return the EXISTING row instead of inserting a duplicate. The UNIQUE
    // partial index on message_id guards against a race, but the explicit check
    // lets us return the original ingest id (callers key downstream loads on it).
    if (hasMessageId) {
      const existing = this.getEmailIngestByMessageId(messageId as string);
      if (existing) return existing;
    }

    const id = makeId("email");
    const createdAt = now();
    // ON CONFLICT closes the TOCTOU window: if a concurrent request inserted the
    // same messageId between our check and this write, the insert is a no-op and
    // we fall back to returning the row that won the race. The conflict target
    // must repeat the partial index's WHERE predicate so SQLite matches the
    // `WHERE message_id IS NOT NULL` partial UNIQUE index (a bare `(message_id)`
    // target does NOT match a partial index).
    const info = sqlite
      .prepare(
        "INSERT INTO email_ingest (id, payload, created_at, message_id) VALUES (?, ?, ?, ?) ON CONFLICT(message_id) WHERE message_id IS NOT NULL DO NOTHING",
      )
      .run(id, JSON.stringify(payload), createdAt, hasMessageId ? (messageId as string) : null);
    if (info.changes === 0 && hasMessageId) {
      const winner = this.getEmailIngestByMessageId(messageId as string);
      if (winner) return winner;
    }
    this.audit("email.ingested", "email", id, payload);
    return { id, ...(payload as object), createdAt };
  },

  // -------------------------------------------------------------------------
  // Phase 5 smart-matching helpers: load_scores, broker_history, lane_history.
  // All upsert-style — callers don't need to track if a row exists.
  // -------------------------------------------------------------------------
  upsertLoadScore(input: {
    loadId: string;
    clientId: string;
    dispatchScore: number;
    verdict: string;
    estimatedNet: number;
    breakdown: object;
  }) {
    sqlite.prepare(`
      INSERT INTO load_scores (load_id, client_id, dispatch_score, verdict, estimated_net, breakdown_json, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(load_id, client_id) DO UPDATE SET
        dispatch_score = excluded.dispatch_score,
        verdict        = excluded.verdict,
        estimated_net  = excluded.estimated_net,
        breakdown_json = excluded.breakdown_json,
        computed_at    = excluded.computed_at
    `).run(
      input.loadId,
      input.clientId,
      input.dispatchScore,
      input.verdict,
      input.estimatedNet,
      JSON.stringify(input.breakdown),
      now(),
    );
  },

  getLoadScore(loadId: string, clientId: string) {
    return sqlite.prepare("SELECT * FROM load_scores WHERE load_id = ? AND client_id = ?")
      .get(loadId, clientId) as { dispatch_score: number; verdict: string; estimated_net: number; breakdown_json: string; computed_at: string } | undefined;
  },

  topScoresForClient(clientId: string, limit = 25) {
    return sqlite.prepare(`
      SELECT load_id, dispatch_score, verdict, estimated_net, computed_at
      FROM load_scores
      WHERE client_id = ? AND verdict != 'skip'
      ORDER BY dispatch_score DESC LIMIT ?
    `).all(clientId, limit) as Array<{ load_id: string; dispatch_score: number; verdict: string; estimated_net: number; computed_at: string }>;
  },

  invalidateLoadScores(loadId?: string) {
    if (loadId) {
      sqlite.prepare("DELETE FROM load_scores WHERE load_id = ?").run(loadId);
    } else {
      sqlite.exec("DELETE FROM load_scores");
    }
  },

  // -------------------------------------------------------------------------
  // Phase 6.1 broker safety audit snapshots (SCOTUS legal evidence trail).
  // Append-only — there is NO update/delete API on purpose. Each snapshot is
  // an immutable business record of due-diligence vetting at booking time.
  // -------------------------------------------------------------------------
  recordBrokerSafetySnapshot(input: {
    loadId?: string | null;
    clientId?: string | null;
    brokerMc: string;
    brokerName?: string | null;
    fmcsaAuthorityStatus?: string | null;
    fmcsaBondAmountCents?: number | null;
    fmcsaBondStatus?: string | null;
    fmcsaInsuranceActive?: boolean | null;
    fmcsaSafetyRating?: string | null;
    fmcsaOosRate?: number | null;
    fmcsaCrashRate?: number | null;
    internalLoadsCompleted?: number;
    internalDisputes?: number;
    internalDoubleBrokerFlags?: number;
    internalAvgPaymentDays?: number | null;
    trustScore?: number | null;
    riskFactors?: string[];
    rawFmcsaPayload?: unknown;
    capturedByUserId?: string | null;
    capturedReason?: "load_booking" | "manual_audit" | "periodic";
  }): string {
    const id = makeId("bsas");
    sqlite.prepare(`
      INSERT INTO broker_safety_audit_snapshots (
        id, load_id, client_id, broker_mc, broker_name,
        fmcsa_authority_status, fmcsa_bond_amount_cents, fmcsa_bond_status,
        fmcsa_insurance_active, fmcsa_safety_rating, fmcsa_oos_rate, fmcsa_crash_rate,
        internal_loads_completed, internal_disputes, internal_double_broker_flags, internal_avg_payment_days,
        trust_score, risk_factors, raw_fmcsa_payload,
        captured_at, captured_by_user_id, captured_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.loadId ?? null,
      input.clientId ?? null,
      input.brokerMc,
      input.brokerName ?? null,
      input.fmcsaAuthorityStatus ?? null,
      input.fmcsaBondAmountCents ?? null,
      input.fmcsaBondStatus ?? null,
      input.fmcsaInsuranceActive == null ? null : input.fmcsaInsuranceActive ? 1 : 0,
      input.fmcsaSafetyRating ?? null,
      input.fmcsaOosRate ?? null,
      input.fmcsaCrashRate ?? null,
      input.internalLoadsCompleted ?? 0,
      input.internalDisputes ?? 0,
      input.internalDoubleBrokerFlags ?? 0,
      input.internalAvgPaymentDays ?? null,
      input.trustScore ?? null,
      input.riskFactors ? JSON.stringify(input.riskFactors) : null,
      input.rawFmcsaPayload ? JSON.stringify(input.rawFmcsaPayload) : null,
      now(),
      input.capturedByUserId ?? null,
      input.capturedReason ?? "load_booking",
    );
    return id;
  },

  getBrokerSafetySnapshot(id: string) {
    return sqlite.prepare("SELECT * FROM broker_safety_audit_snapshots WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
  },

  listBrokerSafetySnapshotsByMc(mc: string, limit = 50) {
    return sqlite.prepare(
      "SELECT * FROM broker_safety_audit_snapshots WHERE broker_mc = ? ORDER BY captured_at DESC LIMIT ?"
    ).all(mc, limit) as Array<Record<string, unknown>>;
  },

  listBrokerSafetySnapshotsByLoad(loadId: string) {
    return sqlite.prepare(
      "SELECT * FROM broker_safety_audit_snapshots WHERE load_id = ? ORDER BY captured_at DESC"
    ).all(loadId) as Array<Record<string, unknown>>;
  },

  // -------------------------------------------------------------------------
  // Broker Trust Score (Killer #1) — behavioural signals.
  // -------------------------------------------------------------------------
  recordBrokerTrustSignal(input: {
    brokerMc: string;
    loadId?: string | null;
    clientId?: string | null;
    signalType: string;
    positive: boolean;
    valueJson?: unknown;
    notes?: string | null;
    reportedByUserId?: string | null;
  }): string {
    const id = makeId("bts");
    const ts = now();
    sqlite.prepare(`
      INSERT INTO broker_trust_signals (
        id, broker_mc, load_id, client_id, signal_type, positive,
        value_json, notes, reported_by_user_id, reported_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.brokerMc,
      input.loadId ?? null,
      input.clientId ?? null,
      input.signalType,
      input.positive ? 1 : 0,
      input.valueJson !== undefined ? JSON.stringify(input.valueJson) : null,
      input.notes ?? null,
      input.reportedByUserId ?? null,
      ts,
      ts,
    );
    return id;
  },

  listBrokerTrustSignalsByMc(mc: string, limit = 500): Array<Record<string, unknown>> {
    return sqlite.prepare(
      "SELECT * FROM broker_trust_signals WHERE broker_mc = ? ORDER BY reported_at DESC LIMIT ?"
    ).all(mc, limit) as Array<Record<string, unknown>>;
  },

  listBrokerTrustSignalsByLoad(loadId: string): Array<Record<string, unknown>> {
    return sqlite.prepare(
      "SELECT * FROM broker_trust_signals WHERE load_id = ? ORDER BY reported_at DESC"
    ).all(loadId) as Array<Record<string, unknown>>;
  },

  // Distinct MC#s that have at least one signal, with aggregate counts —
  // powers the top/bottom leaderboard without loading every signal.
  listBrokerTrustMcSummaries(): Array<{ broker_mc: string; total: number; positives: number }> {
    return sqlite.prepare(`
      SELECT broker_mc,
             COUNT(*) as total,
             SUM(positive) as positives
      FROM broker_trust_signals
      GROUP BY broker_mc
    `).all() as Array<{ broker_mc: string; total: number; positives: number }>;
  },


  // -------------------------------------------------------------------------
  // Broker Trust MVP auto write-path helpers — Killer Feature #1.
  // appendBrokerTrustSignal — unified write entry point, source-tagged.
  // listBrokerTrustSignals  — filtered read for admin endpoint.
  // countBrokerTrustSignalsByType — per-MC type breakdown.
  // -------------------------------------------------------------------------

  /** Append a trust signal from any automatic write-path. */
  appendBrokerTrustSignal(input: {
    brokerMc: string;
    brokerName?: string | null;
    loadId?: string | null;
    clientId?: string | null;
    signalType: string;
    positive: boolean;
    valueJson?: unknown;
    notes?: string | null;
    reportedByUserId?: string | null;
    source: "automatic" | "dispatcher" | "driver" | "fmcsa" | "integration";
  }): string {
    const id = makeId("bts");
    const ts = now();
    const notesStr = input.notes ? `[${input.source}] ${input.notes}` : `[${input.source}]`;
    sqlite.prepare(`
      INSERT OR IGNORE INTO broker_trust_signals (
        id, broker_mc, load_id, client_id, signal_type, positive,
        value_json, notes, reported_by_user_id, reported_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.brokerMc, input.loadId ?? null, input.clientId ?? null,
      input.signalType, input.positive ? 1 : 0,
      input.valueJson !== undefined ? JSON.stringify(input.valueJson) : null,
      notesStr, input.reportedByUserId ?? null, ts, ts,
    );
    return id;
  },

  /** List signals for a broker MC with optional filters. */
  listBrokerTrustSignals(
    brokerMc: string,
    opts: { since?: string; types?: string[]; limit?: number } = {},
  ): Array<Record<string, unknown>> {
    const limit = Math.min(opts.limit ?? 200, 500);
    const where: string[] = ["broker_mc = ?"];
    const params: unknown[] = [brokerMc];
    if (opts.since) { where.push("reported_at >= ?"); params.push(opts.since); }
    if (opts.types && opts.types.length > 0) {
      where.push(`signal_type IN (${opts.types.map(() => "?").join(",")})`);
      params.push(...opts.types);
    }
    params.push(limit);
    return (sqlite.prepare(
      `SELECT * FROM broker_trust_signals WHERE ${where.join(" AND ")} ORDER BY reported_at DESC LIMIT ?`,
    ) as unknown as { all: (...a: unknown[]) => unknown[] }).all(...params) as Array<Record<string, unknown>>;
  },

  /** Count signals per signal_type for a broker MC. */
  countBrokerTrustSignalsByType(brokerMc: string): Record<string, number> {
    const rows = sqlite.prepare(
      `SELECT signal_type, COUNT(*) as cnt FROM broker_trust_signals WHERE broker_mc = ? GROUP BY signal_type`,
    ).all(brokerMc) as Array<{ signal_type: string; cnt: number }>;
    const result: Record<string, number> = {};
    for (const r of rows) result[r.signal_type] = r.cnt;
    return result;
  },

  // -------------------------------------------------------------------------
  // Phase 7 — GPS tracking storage helpers.
  // -------------------------------------------------------------------------

  /** Look up a user by their tracking_token. O(1) via the partial index that
   *  we create lazily here (only meaningful once at least one user has one). */
  getUserByTrackingToken(token: string): UserInternal | undefined {
    if (!token) return undefined;
    // Must go through rowToUserInternal (every other user lookup does) so the
    // result is a real UserInternal — camelCase fields + a boolean `blocked` —
    // not a raw snake_case row. Also: a blocked (terminated) driver's token
    // must stop working immediately, and tracking tokens are driver-only, so
    // gate on blocked=0 AND role='driver'. Without this a blocked ex-driver's
    // phone keeps writing GPS pings / auto-checkins on the public track path.
    const row = sqlite
      .prepare(
        "SELECT * FROM users WHERE tracking_token = ? AND deleted_at IS NULL AND blocked = 0 AND role = 'driver'",
      )
      .get(token) as UserRow | undefined;
    return rowToUserInternal(row);
  },

  /** Generate + persist a fresh tracking token for a driver. Returns the token. */
  setTrackingToken(userId: string, actorUserId?: string): string {
    // 32 bytes → 64 hex chars; URL-safe; non-guessable.
    const token = crypto.randomBytes(32).toString("hex");
    sqlite.prepare("UPDATE users SET tracking_token = ?, updated_at = ? WHERE id = ?")
      .run(token, now(), userId);
    this.audit("user.tracking_token_issued", "user", userId, { actorUserId });
    return token;
  },

  /** Clear a user's tracking token (revokes the URL the driver was using). */
  revokeTrackingToken(userId: string, actorUserId?: string) {
    sqlite.prepare("UPDATE users SET tracking_token = NULL, updated_at = ? WHERE id = ?")
      .run(now(), userId);
    this.audit("user.tracking_token_revoked", "user", userId, { actorUserId });
  },

  /**
   * Record a single location ping. Also updates the user's last_* cache so
   * the dashboard doesn't have to query the history table. We DO NOT audit
   * pings — they fire every few minutes and would flood audit_events.
   */
  recordLocationPing(input: {
    userId: string;
    lat: number;
    lng: number;
    accuracyM?: number | null;
    speedKmh?: number | null;
    headingDeg?: number | null;
    batteryPct?: number | null;
    source: "osmand" | "owntracks" | "telegram_live" | "crowdsource" | "manual";
    capturedAt: string;
  }): string {
    const id = makeId("ping");
    const receivedAt = now();
    sqlite.prepare(`
      INSERT INTO driver_location_pings (
        id, user_id, lat, lng, accuracy_m, speed_kmh, heading_deg, battery_pct,
        source, captured_at, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.userId, input.lat, input.lng,
      input.accuracyM ?? null, input.speedKmh ?? null,
      input.headingDeg ?? null, input.batteryPct ?? null,
      input.source, input.capturedAt, receivedAt,
    );
    sqlite.prepare(`
      UPDATE users SET
        last_lat = ?, last_lng = ?,
        last_location_at = ?, last_location_accuracy_m = ?,
        last_location_source = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.lat, input.lng,
      input.capturedAt, input.accuracyM ?? null,
      input.source, receivedAt, input.userId,
    );
    // Sync the carrier's currentLocation from this live GPS fix. Without it the
    // scorer (which reads client.currentLocation) kept using the stale manual
    // /loc position and IGNORED live GPS entirely — deadhead/ranking computed
    // from the wrong place, and "location confidence" nagged for /loc even while
    // fresh GPS was streaming. Owner-operators only (one driver == the carrier's
    // position); a fleet shares one carrier location across many drivers, so
    // auto-syncing from every driver would thrash it.
    const pinger = this.getUserById(input.userId);
    if (pinger?.linkedClientId) {
      const carrier = this.getClient(pinger.linkedClientId) as
        | (Client & { persona?: string; ownerUserId?: string })
        | undefined;
      if (carrier && (carrier.persona === "owner_operator" || carrier.ownerUserId === input.userId)) {
        const mappedSource: DriverLocation["source"] =
          input.source === "telegram_live"
            ? "telegram_live"
            : input.source === "manual"
              ? "manual_checkin"
              : "live_gps";
        this.updateClientLocation(pinger.linkedClientId, {
          lat: input.lat,
          lng: input.lng,
          updatedAt: input.capturedAt,
          source: mappedSource,
        });
      }
    }
    return id;
  },

  /** Recent track for a user. Default last 24h, capped at 5000 points. */
  listLocationPings(userId: string, opts: { sinceIso?: string; limit?: number } = {}) {
    const since = opts.sinceIso ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const limit = Math.min(opts.limit ?? 2000, 5000);
    return sqlite.prepare(`
      SELECT * FROM driver_location_pings
      WHERE user_id = ? AND captured_at >= ?
      ORDER BY captured_at ASC
      LIMIT ?
    `).all(userId, since, limit) as Array<Record<string, unknown>>;
  },

  /**
   * Keyset-paginated iterator over a driver's location pings in [startIso, endIso),
   * ordered by captured_at ASC. Unlike listLocationPings (capped at 5000 for the
   * driver portal), this returns EVERY ping in the window — required for the IFTA
   * quarterly report, where a driver pinging every ~5 min can produce >5000 pings
   * per quarter. Silently truncating those under-reports taxable miles in a legal
   * filing. Pages in batches of `batchSize` so we never hold an unbounded result
   * set in one prepared statement; ties on captured_at are disambiguated by id so
   * pagination can't loop or skip rows.
   */
  listLocationPingsInWindow(
    userId: string,
    startIso: string,
    endIso: string,
    batchSize = 5000,
  ): Array<{ lat: number; lng: number; captured_at: string }> {
    const out: Array<{ lat: number; lng: number; captured_at: string }> = [];
    const stmt = sqlite.prepare(`
      SELECT id, lat, lng, captured_at FROM driver_location_pings
      WHERE user_id = ?
        AND captured_at >= ?
        AND captured_at < ?
        AND (captured_at > ? OR (captured_at = ? AND id > ?))
      ORDER BY captured_at ASC, id ASC
      LIMIT ?
    `);
    let lastCaptured = startIso;
    let lastId = "";
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = stmt.all(
        userId,
        startIso,
        endIso,
        lastCaptured,
        lastCaptured,
        lastId,
        batchSize,
      ) as Array<{ id: string; lat: number; lng: number; captured_at: string }>;
      if (rows.length === 0) break;
      for (const r of rows) out.push({ lat: r.lat, lng: r.lng, captured_at: r.captured_at });
      const last = rows[rows.length - 1]!;
      lastCaptured = last.captured_at;
      lastId = last.id;
      if (rows.length < batchSize) break;
    }
    return out;
  },

  /**
   * Phase 7 — вычисляем пройденные мили по пингам водителя в окне
   * от sinceIso. Haversine попарно между последовательными пингами. Игнорируем
   * скачки > 200km (водитель отправился самолётом в другой штат — GPS noise).
   */
  computeDriverDistanceMiles(userId: string, sinceIso: string): number {
    const pings = sqlite.prepare(`
      SELECT lat, lng, captured_at FROM driver_location_pings
      WHERE user_id = ? AND captured_at >= ?
      ORDER BY captured_at ASC
    `).all(userId, sinceIso) as Array<{ lat: number; lng: number; captured_at: string }>;
    if (pings.length < 2) return 0;
    // Movement plausibility filters so stationary GPS jitter and teleport noise
    // don't inflate a legal (IFTA) tax mileage figure:
    //   - MIN_STEP_KM: ignore sub-50m steps — a parked truck's GPS drifts a few
    //     meters between pings, which would otherwise accumulate phantom miles.
    //   - MAX_STEP_KM: ignore single jumps > 200km (driver flew / GPS glitch).
    //   - MAX_SPEED_KMH: ignore steps whose implied speed exceeds 200 km/h given
    //     the captured_at delta (a teleport between two close-in-time pings).
    const MIN_STEP_KM = 0.05;
    const MAX_STEP_KM = 200;
    const MAX_SPEED_KMH = 200;
    let km = 0;
    for (let i = 1; i < pings.length; i++) {
      const step = haversineKm(pings[i - 1].lat, pings[i - 1].lng, pings[i].lat, pings[i].lng);
      if (step < MIN_STEP_KM || step > MAX_STEP_KM) continue;
      const dtMs = Date.parse(pings[i].captured_at) - Date.parse(pings[i - 1].captured_at);
      // When timestamps are usable, reject physically-impossible speeds; when
      // they're missing/non-monotonic (dtMs <= 0 or NaN) fall back to the
      // distance caps above rather than dropping the step.
      if (Number.isFinite(dtMs) && dtMs > 0) {
        const speedKmh = step / (dtMs / 3_600_000);
        if (speedKmh > MAX_SPEED_KMH) continue;
      }
      km += step;
    }
    return km * 0.621371;
  },

  /** Cron hook: drop pings older than the retention window (15 days). */
  purgeOldLocationPings(retainDays = 15): number {
    const cutoff = new Date(Date.now() - retainDays * 24 * 3600 * 1000).toISOString();
    const r = sqlite.prepare("DELETE FROM driver_location_pings WHERE captured_at < ?").run(cutoff);
    return r.changes ?? 0;
  },

  /**
   * Audit V2-7 — GDPR/CCPA retention for audit_events. The table carries PII
   * (emails, chatIds, lat/lng, broker MC) for telegram commands, lead form
   * subscriptions, and safety profile views. Without retention there's no
   * way to honour a "right to delete" request fully.
   * Default: 180 days.
   */
  purgeOldAuditEvents(retainDays = 180): number {
    const cutoff = new Date(Date.now() - retainDays * 24 * 3600 * 1000).toISOString();
    // Exempt financial events (invoice.* / billing.*) from the GDPR/CCPA
    // PII-minimization purge: who was charged what is a financial record that
    // typically requires multi-year retention (US tax ~7yr), so wiping it after
    // 180 days would leave billing history unreconstructable for a dispute,
    // chargeback, tax audit, or breach investigation. These rows reference an
    // invoice/client id, not raw PII, so retaining them is consistent with the
    // minimization intent.
    const r = sqlite
      .prepare(
        `DELETE FROM audit_events
           WHERE created_at < ?
             AND event_type NOT LIKE 'invoice.%'
             AND event_type NOT LIKE 'billing.%'`,
      )
      .run(cutoff);
    return r.changes ?? 0;
  },

  /**
   * Audit V2-7 / V2-21 — retention for inbound email payloads. CF forwarder
   * already caps each body at 32 KB but rows still pile up.
   * Default: 180 days.
   */
  purgeOldEmailIngest(retainDays = 180): number {
    const cutoff = new Date(Date.now() - retainDays * 24 * 3600 * 1000).toISOString();
    const r = sqlite.prepare("DELETE FROM email_ingest WHERE created_at < ?").run(cutoff);
    return r.changes ?? 0;
  },

  /**
   * Audit V2-29 — retention for fuel_price_observations. Schema comments
   * promise 90-day rolling window but only GPS pings were actually being
   * purged.
   */
  purgeOldFuelObservations(retainDays = 90): number {
    const cutoff = new Date(Date.now() - retainDays * 24 * 3600 * 1000).toISOString();
    const r = sqlite.prepare("DELETE FROM fuel_price_observations WHERE observed_at < ?").run(cutoff);
    return r.changes ?? 0;
  },

  // -------------------------------------------------------------------------
  // Phase 7 — Fuel price observations.
  // -------------------------------------------------------------------------

  recordFuelPriceObservation(input: {
    stationPlaceId?: string | null;
    stationName?: string | null;
    stationBrand?: string | null;
    stationLat: number;
    stationLng: number;
    address?: string | null;
    state?: string | null;
    fuelType: "diesel" | "gasoline_regular" | "gasoline_mid" | "gasoline_premium" | "def";
    priceCents: number;
    source: "gasbuddy" | "tomtom" | "eia" | "dispatchos_crowdsource";
    sourceConfidence: number;
    observedAt: string;
    reporterUserId?: string | null;
    rawPayload?: unknown;
  }): string {
    const id = makeId("fuelp");
    sqlite.prepare(`
      INSERT INTO fuel_price_observations (
        id, station_place_id, station_name, station_brand,
        station_lat, station_lng, address, state,
        fuel_type, price_cents, source, source_confidence,
        observed_at, received_at, reporter_user_id, raw_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.stationPlaceId ?? null, input.stationName ?? null, input.stationBrand ?? null,
      input.stationLat, input.stationLng, input.address ?? null, input.state ?? null,
      input.fuelType, input.priceCents, input.source, input.sourceConfidence,
      input.observedAt, now(), input.reporterUserId ?? null,
      input.rawPayload ? JSON.stringify(input.rawPayload) : null,
    );
    return id;
  },

  /** Recent fuel transactions for a client (carrier) in the given window. */
  // Write a driver's fuel purchase. This is the path that was missing: the
  // fuel_transactions table is read by IFTA (gallons-per-state) + MPG, but
  // nothing wrote driver purchases into it, so those reports were always empty.
  recordFuelTransaction(input: {
    userId: string;
    clientId?: string | null;
    loadId?: string | null;
    stationName?: string | null;
    stationLat?: number | null;
    stationLng?: number | null;
    fuelType: string;
    gallons: number;
    pricePerGallonCents: number;
    totalCents: number;
    odometerMiles?: number | null;
    receiptStoragePath?: string | null;
    notes?: string | null;
    occurredAt: string;
  }): string {
    const id = makeId("fueltx");
    sqlite.prepare(`
      INSERT INTO fuel_transactions (
        id, user_id, client_id, load_id, station_place_id, station_name,
        station_lat, station_lng, fuel_type, gallons, price_per_gallon_cents,
        total_cents, odometer_miles, receipt_storage_path, notes,
        occurred_at, created_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.userId, input.clientId ?? null, input.loadId ?? null,
      input.stationName ?? null, input.stationLat ?? null, input.stationLng ?? null,
      input.fuelType, input.gallons, input.pricePerGallonCents, input.totalCents,
      input.odometerMiles ?? null, input.receiptStoragePath ?? null, input.notes ?? null,
      input.occurredAt, now(),
    );
    return id;
  },

  getFuelTransaction(id: string): FuelTransaction | undefined {
    const row = sqlite
      .prepare("SELECT * FROM fuel_transactions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToFuelTransaction(row) : undefined;
  },

  listFuelTransactionsForClient(clientId: string, sinceIso: string) {
    return sqlite.prepare(`
      SELECT * FROM fuel_transactions
      WHERE client_id = ? AND occurred_at >= ?
      ORDER BY occurred_at DESC
    `).all(clientId, sinceIso) as Array<Record<string, unknown>>;
  },

  /** Recent fuel transactions for a single driver. */
  listFuelTransactionsForDriver(userId: string, sinceIso: string): FuelTransaction[] {
    const rows = sqlite.prepare(`
      SELECT * FROM fuel_transactions
      WHERE user_id = ? AND occurred_at >= ?
      ORDER BY occurred_at DESC
    `).all(userId, sinceIso) as Array<Record<string, unknown>>;
    // Shape here so callers don't re-fetch each row by id (was an N+1 with an
    // unsafe non-null assertion that 500'd if a row was deleted mid-request).
    return rows.map(rowToFuelTransaction);
  },

  /**
   * Cheapest diesel within `radiusKm` of (lat,lng), observed within `maxAgeH`
   * of the anchor time. The anchor defaults to NOW, but pass `anchorIso` to
   * compare against prices around a SPECIFIC past moment (e.g. when auditing a
   * historical fill-up — you want the prices that were observed around that
   * fill-up, not around now). The freshness filter is a TWO-SIDED window:
   * observed_at BETWEEN anchor - maxAgeH and anchor + maxAgeH.
   */
  findCheapestDieselNear(
    lat: number, lng: number,
    opts: { radiusKm?: number; maxAgeH?: number; limit?: number; anchorIso?: string } = {},
  ) {
    const radiusKm = opts.radiusKm ?? 8;     // ~5 miles
    const maxAgeH = opts.maxAgeH ?? 48;
    const limit = opts.limit ?? 10;
    // SQLite has no geo extension by default — we do a cheap bounding-box
    // pre-filter then refine in app with haversine. ~0.01° per km at the
    // equator (looser near poles); good enough for an 8km cone-pull.
    const dLat = radiusKm / 111;
    const dLng = radiusKm / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
    // Anchor the freshness window at anchorIso (the event being audited) or, by
    // default, now. A bad anchorIso (NaN) falls back to now so we never feed an
    // "Invalid Date" into the query.
    const anchorMs = opts.anchorIso ? new Date(opts.anchorIso).getTime() : Date.now();
    const anchor = Number.isFinite(anchorMs) ? anchorMs : Date.now();
    const windowMs = maxAgeH * 3600 * 1000;
    const lowerBound = new Date(anchor - windowMs).toISOString();
    const upperBound = new Date(anchor + windowMs).toISOString();
    const rows = sqlite.prepare(`
      SELECT * FROM fuel_price_observations
      WHERE fuel_type = 'diesel'
        AND observed_at BETWEEN ? AND ?
        AND station_lat BETWEEN ? AND ?
        AND station_lng BETWEEN ? AND ?
      ORDER BY observed_at DESC
      LIMIT 200
    `).all(lowerBound, upperBound, lat - dLat, lat + dLat, lng - dLng, lng + dLng) as Array<Record<string, unknown>>;
    // Refine: haversine distance, dedup by station_place_id (newest wins),
    // sort by price asc.
    const byStation = new Map<string, { row: Record<string, unknown>; distanceKm: number }>();
    for (const r of rows) {
      const key = (r.station_place_id as string) ?? `geo:${r.station_lat},${r.station_lng}`;
      const d = haversineKm(lat, lng, r.station_lat as number, r.station_lng as number);
      if (d > radiusKm) continue;
      const existing = byStation.get(key);
      if (!existing) byStation.set(key, { row: r, distanceKm: d });
    }
    return Array.from(byStation.values())
      .sort((a, b) => (a.row.price_cents as number) - (b.row.price_cents as number))
      .slice(0, limit)
      .map((e) => ({ ...e.row, distance_km: e.distanceKm })) as Array<Record<string, unknown> & { distance_km: number }>;
  },

  recordLaneObservation(originState: string, destState: string, rate: number, miles: number) {
    const o = originState.toUpperCase();
    const d = destState.toUpperCase();
    sqlite.prepare(`
      INSERT INTO lane_history (origin_state, destination_state, loads_seen, sum_rate, sum_miles, last_seen_at)
      VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT(origin_state, destination_state) DO UPDATE SET
        loads_seen     = loads_seen + 1,
        sum_rate       = sum_rate + excluded.sum_rate,
        sum_miles      = sum_miles + excluded.sum_miles,
        last_seen_at   = excluded.last_seen_at
    `).run(o, d, rate, miles, now());

    // Accumulate day-of-week distribution (0=Sun..6=Sat) for future predictions.
    const dow = new Date().getDay();
    const row = sqlite
      .prepare("SELECT dow_distribution FROM lane_history WHERE origin_state = ? AND destination_state = ?")
      .get(o, d) as { dow_distribution: string | null } | undefined;
    let dist: Record<string, number> = {};
    if (row?.dow_distribution) {
      try {
        dist = JSON.parse(row.dow_distribution) as Record<string, number>;
      } catch {
        dist = {};
      }
    }
    dist[String(dow)] = (dist[String(dow)] ?? 0) + 1;
    sqlite
      .prepare("UPDATE lane_history SET dow_distribution = ? WHERE origin_state = ? AND destination_state = ?")
      .run(JSON.stringify(dist), o, d);
  },

  // -------------------------------------------------------------------------
  // Phase 6 load_sources CRUD + cron picker.
  // The cron poller calls listLoadSourcesDueForPoll() every 5 min.
  // -------------------------------------------------------------------------
  createLoadSource(input: {
    clientId: string;
    adapterKey: string;
    label: string;
    configJson?: Record<string, unknown>;
    credentialsEnc?: string | null;
    credentialsIv?: string | null;
    credentialsKeyId?: string | null;
    pollIntervalMin?: number;
    status?: string;
    createdBy?: string;
  }) {
    const id = makeId("ls");
    const t = now();
    // Self-serve email source: auto-provision a unique inbound forwarding
    // address so the carrier just forwards their broker offer emails there — a
    // real, zero-API, zero-cost load source. The broker-email adapters scope
    // ingest to this address (configJson.inboundAddress), so each carrier only
    // sees their own mail. Domain is env-configurable.
    const config: Record<string, unknown> = { ...(input.configJson ?? {}) };
    if (input.adapterKey.includes("email") && !config.inboundAddress) {
      const domain = process.env.DISPATCHOS_INBOUND_DOMAIN || "inbound.dispatchos.co";
      config.inboundAddress = `loads+${id.replace(/^ls-/, "")}@${domain}`;
    }
    sqlite.prepare(`
      INSERT INTO load_sources (
        id, client_id, adapter_key, label, status, config_json,
        credentials_enc, credentials_iv, credentials_key_id,
        poll_interval_min, created_at, updated_at, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      input.clientId,
      input.adapterKey,
      input.label,
      input.status ?? "active",
      JSON.stringify(config),
      input.credentialsEnc ?? null,
      input.credentialsIv ?? null,
      input.credentialsKeyId ?? null,
      Math.max(1, Math.min(1440, input.pollIntervalMin ?? 5)),
      t,
      t,
      input.createdBy ?? null,
    );
    return this.getLoadSource(id);
  },

  getLoadSource(id: string) {
    const row = sqlite.prepare("SELECT * FROM load_sources WHERE id = ?").get(id) as any;
    return row ? rowToLoadSource(row) : undefined;
  },

  listLoadSources(filter?: { clientId?: string; status?: string; adapterKey?: string }) {
    let sql = "SELECT * FROM load_sources WHERE 1=1";
    const args: any[] = [];
    if (filter?.clientId) { sql += " AND client_id = ?"; args.push(filter.clientId); }
    if (filter?.status)   { sql += " AND status = ?";    args.push(filter.status); }
    if (filter?.adapterKey) { sql += " AND adapter_key = ?"; args.push(filter.adapterKey); }
    sql += " ORDER BY created_at DESC";
    const rows = sqlite.prepare(sql).all(...args) as any[];
    return rows.map(rowToLoadSource);
  },

  listLoadSourcesDueForPoll() {
    // SQLite datetime comparison via julianday. We pick active sources whose
    // last_polled_at is null OR older than (now - poll_interval_min minutes).
    const rows = sqlite.prepare(`
      SELECT * FROM load_sources
      WHERE status = 'active'
        AND (last_polled_at IS NULL
             OR julianday('now') - julianday(last_polled_at) > poll_interval_min / 1440.0)
      ORDER BY (last_polled_at IS NULL) DESC, last_polled_at ASC
    `).all() as any[];
    return rows.map(rowToLoadSource);
  },

  /**
   * Atomically claim a single due source for polling. Bumps last_polled_at to
   * NOW only if the row is STILL due (same window predicate as
   * listLoadSourcesDueForPoll), in one UPDATE. Returns true iff this caller won
   * the claim (changes === 1). If two overlapping cron runs both list the same
   * row, exactly one lease succeeds; the loser skips it, so the source is not
   * double-polled / double-alerted. The result is recorded later via
   * recordLoadSourcePoll (which re-stamps last_polled_at), so the early bump is
   * purely a lease, not the final timestamp.
   */
  leaseLoadSourceForPoll(id: string): boolean {
    const info = sqlite.prepare(`
      UPDATE load_sources
      SET last_polled_at = ?, updated_at = ?
      WHERE id = ?
        AND status = 'active'
        AND (last_polled_at IS NULL
             OR julianday('now') - julianday(last_polled_at) > poll_interval_min / 1440.0)
    `).run(now(), now(), id);
    return info.changes === 1;
  },

  updateLoadSource(id: string, patch: Record<string, unknown>) {
    const map: Record<string, string> = {
      label: "label",
      status: "status",
      configJson: "config_json",
      credentialsEnc: "credentials_enc",
      credentialsIv: "credentials_iv",
      credentialsKeyId: "credentials_key_id",
      pollIntervalMin: "poll_interval_min",
    };
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = map[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      args.push(k === "configJson" ? JSON.stringify(v ?? {}) : v);
    }
    if (sets.length === 0) return this.getLoadSource(id);
    sets.push("updated_at = ?");
    args.push(now());
    args.push(id);
    sqlite.prepare(`UPDATE load_sources SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    return this.getLoadSource(id);
  },

  /**
   * Record the outcome of one poll. On failure, bumps failure_streak and
   * auto-pauses at the 3-strike threshold.
   *
   * Returns the active->paused TRANSITION info so the cron caller can surface a
   * degraded count / fire an owner alert exactly ONCE (on the flip), never on
   * subsequent already-paused polls. The return shape is additive — existing
   * callers that ignore the return value are unaffected.
   */
  recordLoadSourcePoll(id: string, result: {
    loadsFound: number;
    errorMessage?: string | null;
  }): { justPaused: boolean; sourceId: string; clientId: string | null; label: string | null } {
    const t = now();
    // Read status BEFORE the update so we can detect the active->paused edge
    // (the streak/CASE is evaluated inside SQL, so we re-read after to compare).
    const before = sqlite
      .prepare("SELECT status, client_id, label FROM load_sources WHERE id = ?")
      .get(id) as { status: string; client_id: string; label: string } | undefined;
    if (result.errorMessage) {
      sqlite.prepare(`
        UPDATE load_sources
        SET last_polled_at = ?,
            last_error_at = ?,
            last_error_msg = SUBSTR(?, 1, 500),
            failure_streak = failure_streak + 1,
            status = CASE WHEN failure_streak + 1 >= 3 THEN 'paused' ELSE status END,
            updated_at = ?
        WHERE id = ?
      `).run(t, t, result.errorMessage, t, id);
    } else {
      sqlite.prepare(`
        UPDATE load_sources
        SET last_polled_at = ?,
            last_loads_found = ?,
            last_error_at = NULL,
            last_error_msg = NULL,
            failure_streak = 0,
            updated_at = ?
        WHERE id = ?
      `).run(t, result.loadsFound, t, id);
    }
    const after = sqlite
      .prepare("SELECT status FROM load_sources WHERE id = ?")
      .get(id) as { status: string } | undefined;
    const justPaused =
      before?.status === "active" && after?.status === "paused";
    return {
      justPaused,
      sourceId: id,
      clientId: before?.client_id ?? null,
      label: before?.label ?? null,
    };
  },

  /** Ops/health: how many load sources are currently auto-paused (or paused). */
  countPausedLoadSources(): number {
    return (
      sqlite
        .prepare("SELECT COUNT(*) as c FROM load_sources WHERE status = 'paused'")
        .get() as { c: number }
    ).c;
  },

  /**
   * Ops/health: the most recent successful poll heartbeat across all load
   * sources (max last_polled_at). Returns null if no source has ever polled.
   * Used by /api/health-deep to flag a stalled poller cron.
   */
  latestLoadSourcePollAt(): string | null {
    const row = sqlite
      .prepare("SELECT MAX(last_polled_at) as t FROM load_sources")
      .get() as { t: string | null };
    return row?.t ?? null;
  },

  /**
   * Upsert a Load coming from an adapter. Returns { id, inserted } so the
   * cron pipeline knows whether to fire scoreLoadForClient + TG alert.
   * For non-source loads (manual, CSV) keep using the existing storage.upsertLoad.
   */
  upsertLoadFromSource(input: {
    sourceId: string;
    sourceExternalId: string;
    clientId: string;
    payload: Record<string, unknown>;
  }): { id: string; inserted: boolean } {
    // Source adapters produce a normalized load but skip the manual-create
    // path's enrichment, so the scorer's lane/broker inputs were missing →
    // dispatchScore came out NaN and the load was unrankable. Fill them at this
    // single source-ingest chokepoint so every stored load is scoreable: real
    // lane marketQuality + neutral broker defaults (FMCSA scoring is the async
    // path's job, gated on a webkey).
    const base = ensureScoreableSourceLoad(input.payload);
    // Defense-in-depth: an empty sourceExternalId is NOT a real dedup identity —
    // the "WHERE source_external_id = ''" lookup below would match the prior ""
    // row and collapse every such load onto one record. Adapters are expected to
    // backstop to a stable per-row id (ingestId), so an empty key means a bug
    // upstream; insert as a fresh, never-matching row rather than silently
    // overwriting an unrelated load. Falling back to the new load id keeps the
    // row unique to this ingest.
    if (input.sourceExternalId === "") {
      const id = makeId("load");
      sqlite.prepare(`
        INSERT INTO loads (id, client_id, payload, source_id, source_external_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.clientId, JSON.stringify({ ...base, id }), input.sourceId, id, now(), now());
      return { id, inserted: true };
    }
    const existing = sqlite.prepare(
      "SELECT id, payload, booked_at, driver_id FROM loads WHERE source_id = ? AND source_external_id = ?",
    ).get(input.sourceId, input.sourceExternalId) as
      | { id: string; payload: string; booked_at: string | null; driver_id: string | null }
      | undefined;
    if (existing) {
      // Re-poll MUST NOT wipe booking state. The fresh adapter payload (`base`)
      // is a re-normalization of the upstream feed — it carries no
      // driverId/bookedAt/status/deliveredAt/negotiated rate. A blind
      // `payload = base` overwrite therefore erased an already-booked load's
      // assignment + revenue marker while the dedicated booked_at/driver_id
      // mirror columns (not in this UPDATE's SET) survived — a column-vs-payload
      // split-brain that re-bills at the feed rate and flips the load back to
      // 'available' in driver/dispatcher views. Merge the fresh feed fields OVER
      // the stored payload, then re-assert the booking-critical fields from the
      // existing payload so they always win.
      let prev: Record<string, unknown> = {};
      try { prev = JSON.parse(existing.payload) as Record<string, unknown>; } catch { /* corrupt → treat as empty */ }
      const isBooked = existing.booked_at !== null || existing.driver_id !== null;
      const merged: Record<string, unknown> = { ...base };
      if (isBooked) {
        // Booked load: the booking + negotiated rate are authoritative; never let
        // a feed re-poll move them. (rate is preserved only here, so an UNBOOKED
        // load still gets fresh feed pricing on re-poll.)
        for (const f of ["bookedAt", "driverId", "clientId", "status", "deliveredAt", "delivered_at", "rate"]) {
          if (prev[f] !== undefined) merged[f] = prev[f];
        }
      }
      merged.id = existing.id;
      sqlite.prepare(`
        UPDATE loads
        SET payload = ?, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(merged), now(), existing.id);
      return { id: existing.id, inserted: false };
    }
    const id = makeId("load");
    sqlite.prepare(`
      INSERT INTO loads (id, client_id, payload, source_id, source_external_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.clientId,
      JSON.stringify({ ...base, id }),
      input.sourceId,
      input.sourceExternalId,
      now(),
      now(),
    );
    return { id, inserted: true };
  },

  getLaneAvgPpm(originState: string, destState: string): { avgPpm: number; loadsSeen: number } | undefined {
    const row = sqlite.prepare(
      "SELECT loads_seen, sum_rate, sum_miles FROM lane_history WHERE origin_state = ? AND destination_state = ?",
    ).get(originState.toUpperCase(), destState.toUpperCase()) as { loads_seen: number; sum_rate: number; sum_miles: number } | undefined;
    if (!row || row.sum_miles === 0) return undefined;
    return { avgPpm: row.sum_rate / row.sum_miles, loadsSeen: row.loads_seen };
  },

  // -------------------------------------------------------------------------
  // Killer #4 — lane watchlist + predictions (dow distribution).
  // -------------------------------------------------------------------------
  createLaneWatch(input: {
    clientId: string;
    originState: string;
    originCity?: string | null;
    destinationState: string;
    destinationCity?: string | null;
    minPpm?: number | null;
    equipment?: string | null;
    createdBy?: string | null;
  }): { id: string } {
    const id = makeId("watch");
    sqlite.prepare(`
      INSERT INTO lane_watchlist (
        id, client_id, origin_state, origin_city, destination_state, destination_city,
        min_ppm, equipment, active, match_count, last_matched_at, created_by, created_at
      ) VALUES (?,?,?,?,?,?,?,?,1,0,NULL,?,?)
    `).run(
      id,
      input.clientId,
      input.originState.toUpperCase(),
      input.originCity ?? null,
      input.destinationState.toUpperCase(),
      input.destinationCity ?? null,
      typeof input.minPpm === "number" ? input.minPpm : null,
      input.equipment ?? null,
      input.createdBy ?? null,
      now(),
    );
    return { id };
  },

  listLaneWatchesByClient(clientId: string): any[] {
    return sqlite
      .prepare("SELECT * FROM lane_watchlist WHERE client_id = ? ORDER BY created_at DESC")
      .all(clientId);
  },

  listActiveLaneWatches(): any[] {
    return sqlite.prepare("SELECT * FROM lane_watchlist WHERE active = 1").all();
  },

  deleteLaneWatch(id: string, clientId: string): { deleted: boolean } {
    const res = sqlite
      .prepare("DELETE FROM lane_watchlist WHERE id = ? AND client_id = ?")
      .run(id, clientId);
    return { deleted: res.changes > 0 };
  },

  bumpLaneWatchMatch(id: string): void {
    sqlite
      .prepare("UPDATE lane_watchlist SET match_count = match_count + 1, last_matched_at = ? WHERE id = ?")
      .run(now(), id);
  },

  // Match a freshly-created load against active watches. State must match;
  // optional min_ppm / equipment filters narrow further. Bumps match_count +
  // emits an audit event per hit. Returns the watches that matched.
  matchLoadAgainstWatches(load: {
    id: string;
    originState: string;
    destinationState: string;
    rate: number;
    loadedMiles: number;
    equipment?: string | null;
  }): Array<{ id: string; clientId: string }> {
    const watches = this.listActiveLaneWatches() as Array<{
      id: string;
      client_id: string;
      origin_state: string;
      destination_state: string;
      min_ppm: number | null;
      equipment: string | null;
    }>;
    const o = load.originState.toUpperCase();
    const d = load.destinationState.toUpperCase();
    const ppm = load.loadedMiles > 0 ? load.rate / load.loadedMiles : 0;
    const matched: Array<{ id: string; clientId: string }> = [];
    for (const w of watches) {
      if (w.origin_state !== o || w.destination_state !== d) continue;
      if (typeof w.min_ppm === "number" && ppm < w.min_ppm) continue;
      if (w.equipment && load.equipment && w.equipment !== load.equipment) continue;
      this.bumpLaneWatchMatch(w.id);
      this.audit("watchlist.matched", "lane_watchlist", w.id, {
        loadId: load.id,
        clientId: w.client_id,
        lane: `${o}->${d}`,
        ppm: Math.round(ppm * 100) / 100,
      });
      matched.push({ id: w.id, clientId: w.client_id });
    }
    return matched;
  },

  getLanePrediction(originState: string, destState: string): {
    loadsSeen: number;
    avgPpm: number;
    dowDistribution: Record<string, number>;
  } | undefined {
    const row = sqlite.prepare(
      "SELECT loads_seen, sum_rate, sum_miles, dow_distribution FROM lane_history WHERE origin_state = ? AND destination_state = ?",
    ).get(originState.toUpperCase(), destState.toUpperCase()) as
      | { loads_seen: number; sum_rate: number; sum_miles: number; dow_distribution: string | null }
      | undefined;
    if (!row) return undefined;
    let dow: Record<string, number> = {};
    if (row.dow_distribution) {
      try {
        dow = JSON.parse(row.dow_distribution) as Record<string, number>;
      } catch {
        dow = {};
      }
    }
    return {
      loadsSeen: row.loads_seen,
      avgPpm: row.sum_miles > 0 ? row.sum_rate / row.sum_miles : 0,
      dowDistribution: dow,
    };
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
      // invite.* audit events carry the raw invite CODE as entityId. An
      // un-consumed code is a live credential (signup accepts it), and the
      // `invites` array above already redacts those — so scrub it here too,
      // or the backup defeats that redaction.
      auditEvents: this.listAuditEvents(1000).map((e) =>
        e.entityType === "invite" ? { ...e, entityId: "[redacted]" } : e,
      ),
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

  // =========================================================================
  // Phase 4 P1 — Driver documents
  // =========================================================================

  insertDriverDocument(input: {
    ownerUserId: string;
    /** Optional carrier scope. Set when admin uploads on behalf of a carrier. */
    clientId?: string | null;
    type: DriverDocumentType;
    fileName: string;
    storagePath: string;
    expiresAt: string | null;
    notes: string | null;
  }): DriverDocument {
    const id = makeId("ddoc");
    const ts = now();
    sqlite
      .prepare(
        `INSERT INTO driver_documents
         (id, owner_user_id, client_id, type, file_name, storage_path, expires_at, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.ownerUserId,
        input.clientId ?? null,
        input.type,
        input.fileName,
        input.storagePath,
        input.expiresAt,
        input.notes,
        ts,
        ts,
      );
    return {
      id,
      ownerUserId: input.ownerUserId,
      clientId: input.clientId ?? null,
      type: input.type,
      fileName: input.fileName,
      storagePath: input.storagePath,
      expiresAt: input.expiresAt,
      notes: input.notes,
      createdAt: ts,
      updatedAt: ts,
    };
  },

  listDriverDocumentsForUser(
    userId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): { items: DriverDocument[]; nextCursor: string | null; hasMore: boolean; total: number } {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where: string[] = ["owner_user_id = ?"];
    const params: Array<string | number> = [userId];
    if (opts.cursor) {
      const { orderValue, tiebreaker } = decodeCursor(opts.cursor);
      if (tiebreaker !== null) {
        where.push("(created_at < ? OR (created_at = ? AND id < ?))");
        params.push(orderValue, orderValue, tiebreaker);
      } else {
        where.push("created_at < ?");
        params.push(orderValue);
      }
    }
    params.push(limit + 1);
    const rows = sqlite
      .prepare(
        `SELECT * FROM driver_documents WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const items: DriverDocument[] = sliced.map((r) => ({
      id: r.id as string,
      ownerUserId: r.owner_user_id as string,
      clientId: (r.client_id as string | null) ?? null,
      type: r.type as DriverDocumentType,
      fileName: r.file_name as string,
      storagePath: r.storage_path as string,
      expiresAt: (r.expires_at as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    }));
    const total = (
      sqlite
        .prepare("SELECT COUNT(*) AS c FROM driver_documents WHERE owner_user_id = ?")
        .get(userId) as { c: number }
    ).c;
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      hasMore,
      total,
    };
  },

  getDriverDocument(id: string): DriverDocument | null {
    const row = sqlite
      .prepare("SELECT * FROM driver_documents WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      ownerUserId: row.owner_user_id as string,
      clientId: (row.client_id as string | null) ?? null,
      type: row.type as DriverDocumentType,
      fileName: row.file_name as string,
      storagePath: row.storage_path as string,
      expiresAt: (row.expires_at as string | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  },

  deleteDriverDocument(id: string, ownerUserId: string): boolean {
    const r = sqlite
      .prepare("DELETE FROM driver_documents WHERE id = ? AND owner_user_id = ?")
      .run(id, ownerUserId);
    return r.changes > 0;
  },

  /** Admin-scope delete by id only (no owner check). */
  deleteDriverDocumentById(id: string): boolean {
    const r = sqlite.prepare("DELETE FROM driver_documents WHERE id = ?").run(id);
    return r.changes > 0;
  },

  /** Compliance docs uploaded on behalf of a carrier (client_id set). */
  listDriverDocumentsForClient(clientId: string, limit = 50): DriverDocument[] {
    const rows = sqlite
      .prepare(
        "SELECT * FROM driver_documents WHERE client_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(clientId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      ownerUserId: r.owner_user_id as string,
      clientId: (r.client_id as string | null) ?? null,
      type: r.type as DriverDocumentType,
      fileName: r.file_name as string,
      storagePath: r.storage_path as string,
      expiresAt: (r.expires_at as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    }));
  },

  computePendingDocsForUser(userId: string, withinDays = 30): PendingDoc[] {
    const rows = sqlite
      .prepare(
        `SELECT id, type, expires_at FROM driver_documents
         WHERE owner_user_id = ? AND expires_at IS NOT NULL
         ORDER BY expires_at ASC`,
      )
      .all(userId) as Array<{ id: string; type: string; expires_at: string }>;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayMs = today.getTime();
    const result: PendingDoc[] = [];
    for (const r of rows) {
      const exp = new Date(`${r.expires_at}T00:00:00Z`);
      if (Number.isNaN(exp.getTime())) continue;
      const days = Math.round((exp.getTime() - todayMs) / (1000 * 60 * 60 * 24));
      let status: PendingDoc["status"];
      if (days <= 0) status = "expired";
      else if (days <= withinDays) status = "soon";
      else continue;
      result.push({
        id: r.id,
        type: r.type as DriverDocumentType,
        expiresAt: r.expires_at,
        daysUntilExpiry: days,
        status,
      });
    }
    return result;
  },

  // =========================================================================
  // Phase 4 P1 — Load check-ins
  // =========================================================================

  insertLoadCheckin(input: {
    loadId: string;
    driverUserId: string;
    kind: CheckinKind;
    lat: number | null;
    lng: number | null;
    notes: string | null;
  }): LoadCheckin {
    const id = makeId("chk");
    const ts = now();
    sqlite
      .prepare(
        `INSERT INTO load_checkins
         (id, load_id, driver_user_id, kind, lat, lng, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.loadId,
        input.driverUserId,
        input.kind,
        input.lat,
        input.lng,
        input.notes,
        ts,
      );
    return {
      id,
      loadId: input.loadId,
      driverUserId: input.driverUserId,
      kind: input.kind,
      lat: input.lat,
      lng: input.lng,
      notes: input.notes,
      createdAt: ts,
    };
  },

  listCheckinsForLoad(loadId: string): LoadCheckin[] {
    const rows = sqlite
      .prepare("SELECT * FROM load_checkins WHERE load_id = ? ORDER BY created_at ASC")
      .all(loadId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      loadId: r.load_id as string,
      driverUserId: r.driver_user_id as string,
      kind: r.kind as CheckinKind,
      lat: (r.lat as number | null) ?? null,
      lng: (r.lng as number | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      createdAt: r.created_at as string,
    }));
  },

  /**
   * Latest check-in across ALL of a driver's loads (not load-scoped). Used by
   * the dispatcher assign dialog to show "last activity". Returns null if the
   * driver has never checked in.
   */
  getLatestCheckinForDriver(driverUserId: string): LoadCheckin | null {
    const r = sqlite
      .prepare(
        "SELECT * FROM load_checkins WHERE driver_user_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(driverUserId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      loadId: r.load_id as string,
      driverUserId: r.driver_user_id as string,
      kind: r.kind as CheckinKind,
      lat: (r.lat as number | null) ?? null,
      lng: (r.lng as number | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      createdAt: r.created_at as string,
    };
  },

  // =========================================================================
  // Phase 4 P1 — Driver expenses
  // =========================================================================

  insertDriverExpense(input: {
    driverUserId: string;
    loadId: string | null;
    category: ExpenseCategory;
    amountCents: number;
    photoStoragePath: string | null;
    notes: string | null;
  }): DriverExpense {
    const id = makeId("exp");
    const ts = now();
    sqlite
      .prepare(
        `INSERT INTO driver_expenses
         (id, driver_user_id, load_id, category, amount_cents, photo_storage_path, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.driverUserId,
        input.loadId,
        input.category,
        input.amountCents,
        input.photoStoragePath,
        input.notes,
        ts,
      );
    return {
      id,
      driverUserId: input.driverUserId,
      loadId: input.loadId,
      category: input.category,
      amountCents: input.amountCents,
      photoStoragePath: input.photoStoragePath,
      notes: input.notes,
      createdAt: ts,
    };
  },

  listExpensesForUser(
    userId: string,
    opts: { limit?: number; cursor?: string; loadId?: string } = {},
  ): { items: DriverExpense[]; nextCursor: string | null; hasMore: boolean; total: number } {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where: string[] = ["driver_user_id = ?"];
    const params: Array<string | number> = [userId];
    if (opts.loadId) {
      where.push("load_id = ?");
      params.push(opts.loadId);
    }
    if (opts.cursor) {
      const { orderValue, tiebreaker } = decodeCursor(opts.cursor);
      if (tiebreaker !== null) {
        where.push("(created_at < ? OR (created_at = ? AND id < ?))");
        params.push(orderValue, orderValue, tiebreaker);
      } else {
        where.push("created_at < ?");
        params.push(orderValue);
      }
    }
    params.push(limit + 1);
    const rows = sqlite
      .prepare(
        `SELECT * FROM driver_expenses
         WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const items: DriverExpense[] = sliced.map((r) => ({
      id: r.id as string,
      driverUserId: r.driver_user_id as string,
      loadId: (r.load_id as string | null) ?? null,
      category: r.category as ExpenseCategory,
      amountCents: r.amount_cents as number,
      photoStoragePath: (r.photo_storage_path as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      createdAt: r.created_at as string,
    }));
    const countSql = opts.loadId
      ? "SELECT COUNT(*) AS c FROM driver_expenses WHERE driver_user_id = ? AND load_id = ?"
      : "SELECT COUNT(*) AS c FROM driver_expenses WHERE driver_user_id = ?";
    const countParams = opts.loadId ? [userId, opts.loadId] : [userId];
    const total = (sqlite.prepare(countSql).get(...countParams) as { c: number }).c;
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      hasMore,
      total,
    };
  },

  // =========================================================================
  // Phase 4 P1 — Approval tasks (issues queue)
  // =========================================================================

  createApprovalTask(input: {
    taskType: ApprovalTaskType;
    assigneeRole: UserRole;
    payload: Record<string, unknown>;
    createdByUserId: string;
  }): ApprovalTask {
    const id = makeId("task");
    const ts = now();
    sqlite
      .prepare(
        `INSERT INTO approval_tasks
         (id, task_type, assignee_role, resolved_by_user_id, resolved_at, status, payload, created_by_user_id, created_at)
         VALUES (?, ?, ?, NULL, NULL, 'open', ?, ?, ?)`,
      )
      .run(
        id,
        input.taskType,
        input.assigneeRole,
        JSON.stringify(input.payload),
        input.createdByUserId,
        ts,
      );
    return {
      id,
      taskType: input.taskType,
      assigneeRole: input.assigneeRole,
      resolvedByUserId: null,
      resolvedAt: null,
      status: "open",
      payload: input.payload,
      createdByUserId: input.createdByUserId,
      createdAt: ts,
    };
  },

  listApprovalTasksForRole(
    role: UserRole,
    opts: { status?: ApprovalTaskStatus; limit?: number } = {},
  ): ApprovalTask[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const rows = opts.status
      ? (sqlite
          .prepare(
            `SELECT * FROM approval_tasks
             WHERE assignee_role = ? AND status = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(role, opts.status, limit) as Array<Record<string, unknown>>)
      : (sqlite
          .prepare(
            `SELECT * FROM approval_tasks
             WHERE assignee_role = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(role, limit) as Array<Record<string, unknown>>);
    return rows.map((r) => ({
      id: r.id as string,
      taskType: r.task_type as ApprovalTaskType,
      assigneeRole: r.assignee_role as UserRole,
      resolvedByUserId: (r.resolved_by_user_id as string | null) ?? null,
      resolvedAt: (r.resolved_at as string | null) ?? null,
      status: r.status as ApprovalTaskStatus,
      payload: JSON.parse((r.payload as string) ?? "{}") as Record<string, unknown>,
      createdByUserId: r.created_by_user_id as string,
      createdAt: r.created_at as string,
    }));
  },
  // =========================================================================
  // Phase 4 P1.1 — Admin approval queue (read/update for the admin portal)
  // =========================================================================

  listApprovalTasksPaginated(filters: {
    status?: ApprovalTaskStatus;
    taskType?: ApprovalTaskType;
    assigneeRole?: UserRole;
    limit?: number;
    cursor?: string;
  } = {}): {
    items: Array<ApprovalTask & {
      createdByEmail: string | null;
      createdByFullName: string | null;
      resolvedByEmail: string | null;
    }>;
    nextCursor: string | null;
    hasMore: boolean;
    total: number;
  } {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filters.status) {
      where.push("t.status = ?");
      params.push(filters.status);
    }
    if (filters.taskType) {
      where.push("t.task_type = ?");
      params.push(filters.taskType);
    }
    if (filters.assigneeRole) {
      where.push("t.assignee_role = ?");
      params.push(filters.assigneeRole);
    }
    if (filters.cursor) {
      const { orderValue, tiebreaker } = decodeCursor(filters.cursor);
      if (tiebreaker !== null) {
        where.push("(t.created_at < ? OR (t.created_at = ? AND t.id < ?))");
        params.push(orderValue, orderValue, tiebreaker);
      } else {
        where.push("t.created_at < ?");
        params.push(orderValue);
      }
    }
    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `
      SELECT
        t.*,
        creator.email      AS creator_email,
        creator.full_name  AS creator_full_name,
        resolver.email     AS resolver_email
      FROM approval_tasks t
      LEFT JOIN users creator  ON creator.id  = t.created_by_user_id
      LEFT JOIN users resolver ON resolver.id = t.resolved_by_user_id
      ${whereClause}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT ?
    `;
    params.push(limit + 1);
    const rows = sqlite.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const items = sliced.map((r) => ({
      id: r.id as string,
      taskType: r.task_type as ApprovalTaskType,
      assigneeRole: r.assignee_role as UserRole,
      resolvedByUserId: (r.resolved_by_user_id as string | null) ?? null,
      resolvedAt: (r.resolved_at as string | null) ?? null,
      status: r.status as ApprovalTaskStatus,
      payload: JSON.parse((r.payload as string) ?? "{}") as Record<string, unknown>,
      createdByUserId: r.created_by_user_id as string,
      createdAt: r.created_at as string,
      createdByEmail: (r.creator_email as string | null) ?? null,
      createdByFullName: (r.creator_full_name as string | null) ?? null,
      resolvedByEmail: (r.resolver_email as string | null) ?? null,
    }));
    const totalWhere: string[] = [];
    const totalParams: Array<string | number> = [];
    if (filters.status) {
      totalWhere.push("status = ?");
      totalParams.push(filters.status);
    }
    if (filters.taskType) {
      totalWhere.push("task_type = ?");
      totalParams.push(filters.taskType);
    }
    if (filters.assigneeRole) {
      totalWhere.push("assignee_role = ?");
      totalParams.push(filters.assigneeRole);
    }
    const totalSql = `SELECT COUNT(*) AS c FROM approval_tasks ${
      totalWhere.length ? `WHERE ${totalWhere.join(" AND ")}` : ""
    }`;
    const total = (sqlite.prepare(totalSql).get(...totalParams) as { c: number }).c;
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      hasMore,
      total,
    };
  },

  getApprovalTask(id: string): ApprovalTask | null {
    const row = sqlite
      .prepare("SELECT * FROM approval_tasks WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      taskType: row.task_type as ApprovalTaskType,
      assigneeRole: row.assignee_role as UserRole,
      resolvedByUserId: (row.resolved_by_user_id as string | null) ?? null,
      resolvedAt: (row.resolved_at as string | null) ?? null,
      status: row.status as ApprovalTaskStatus,
      payload: JSON.parse((row.payload as string) ?? "{}") as Record<string, unknown>,
      createdByUserId: row.created_by_user_id as string,
      createdAt: row.created_at as string,
    };
  },

  resolveApprovalTask(
    id: string,
    action: "resolve" | "dismiss",
    resolverUserId: string,
    resolution?: string,
  ): ApprovalTask | null {
    const current = this.getApprovalTask(id);
    if (!current) return null;
    if (current.status === "resolved" || current.status === "dismissed") {
      return null;
    }
    const newStatus: ApprovalTaskStatus =
      action === "resolve" ? "resolved" : "dismissed";
    const ts = now();
    const newPayload = resolution
      ? { ...current.payload, resolution }
      : current.payload;
    // Conditional on the still-open status so two concurrent resolve/dismiss
    // calls can't both apply; changes===0 means another won the race.
    const res = sqlite
      .prepare(
        `UPDATE approval_tasks
         SET status = ?, resolved_by_user_id = ?, resolved_at = ?, payload = ?
         WHERE id = ? AND status = ?`,
      )
      .run(newStatus, resolverUserId, ts, JSON.stringify(newPayload), id, current.status);
    if (res.changes === 0) return null;
    return {
      ...current,
      status: newStatus,
      resolvedByUserId: resolverUserId,
      resolvedAt: ts,
      payload: newPayload,
    };
  },

  countOpenApprovalTasksForRole(role: UserRole): number {
    return (
      sqlite
        .prepare(
          "SELECT COUNT(*) AS c FROM approval_tasks WHERE assignee_role = ? AND status = 'open'",
        )
        .get(role) as { c: number }
    ).c;
  },
  // =========================================================================
  // Phase 4 P0 — Dispatcher tenant-scoping helpers
  // =========================================================================

  getActiveDispatcherForClient(clientId: string): { dispatcherUserId: string } | null {
    const row = sqlite
      .prepare(
        `SELECT dispatcher_user_id FROM assignments
         WHERE client_id = ? AND removed_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(clientId) as { dispatcher_user_id: string } | undefined;
    return row ? { dispatcherUserId: row.dispatcher_user_id } : null;
  },

  listAssignedClientsForDispatcher(dispatcherUserId: string): Array<{
    id: string;
    name: string;
    activeDriversCount: number;
    activeLoadsCount: number;
  }> {
    const assignments = this.listAssignmentsForDispatcher(dispatcherUserId);
    if (assignments.length === 0) return [];
    const clientIds = assignments.map((a) => a.clientId);
    const placeholders = clientIds.map(() => "?").join(",");

    // clients table stores data as a JSON payload (no flat `name` column).
    // Match the pattern used by listClients/getClient elsewhere in this file.
    const clientRows = sqlite
      .prepare(`SELECT id, payload FROM clients WHERE id IN (${placeholders})`)
      .all(...clientIds) as Array<{ id: string; payload: string }>;
    const clientNameById = new Map<string, string>();
    for (const row of clientRows) {
      try {
        const parsed = JSON.parse(row.payload) as { name?: unknown; deletedAt?: unknown };
        // Skip archived (soft-deleted) clients — this hand-rolled query reads
        // clients.payload directly and must honor the same deletedAt filter
        // that listClients() applies, or archived carriers leak into the
        // dispatcher's dashboard/list.
        if (parsed.deletedAt) continue;
        clientNameById.set(
          row.id,
          typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : row.id,
        );
      } catch {
        clientNameById.set(row.id, row.id);
      }
    }

    const driverCounts = new Map<string, number>();
    if (clientIds.length > 0) {
      // users.blocked is INTEGER 0/1 in this schema (no `blocked_at` column).
      const driverRows = sqlite
        .prepare(
          `SELECT linked_client_id AS cid, COUNT(*) AS c
           FROM users
           WHERE role = 'driver' AND blocked = 0
             AND linked_client_id IN (${placeholders})
           GROUP BY linked_client_id`,
        )
        .all(...clientIds) as Array<{ cid: string; c: number }>;
      for (const r of driverRows) driverCounts.set(r.cid, r.c);
    }
    const loadCounts = new Map<string, number>();
    if (clientIds.length > 0) {
      // "active" = booked-and-still-in-progress. booked_at is never cleared on
      // delivery (it's the revenue-window key, so it must stay), so a plain
      // `booked_at IS NOT NULL` count grows forever and overcounts the
      // dispatcher's current workload. Exclude completed/cancelled/delivered
      // loads (delivery state lives in the JSON payload, not a column).
      const loadRows = sqlite
        .prepare(
          `SELECT client_id AS cid, COUNT(*) AS c
           FROM loads
           WHERE client_id IN (${placeholders}) AND ${ACTIVE_LOAD_SQL}
           GROUP BY client_id`,
        )
        .all(...clientIds) as Array<{ cid: string; c: number }>;
      for (const r of loadRows) loadCounts.set(r.cid, r.c);
    }

    // Preserve assignment order; drop archived clients (not in the name map).
    return clientIds
      .filter((id) => clientNameById.has(id))
      .map((id) => ({
        id,
        name: clientNameById.get(id) ?? id,
        activeDriversCount: driverCounts.get(id) ?? 0,
        activeLoadsCount: loadCounts.get(id) ?? 0,
      }));
  },

  /**
   * Cockpit per-driver cards: active drivers linked to a carrier (role=driver,
   * not blocked/deleted). Name + status so the cockpit can render one card per
   * driver instead of one per carrier.
   */
  listDriversForClient(clientId: string): Array<{ id: string; fullName: string; driverStatus: string | null }> {
    return sqlite
      .prepare(
        "SELECT id, full_name AS fullName, driver_status AS driverStatus FROM users WHERE role = 'driver' AND blocked = 0 AND deleted_at IS NULL AND linked_client_id = ? ORDER BY full_name ASC",
      )
      .all(clientId) as Array<{ id: string; fullName: string; driverStatus: string | null }>;
  },

  // --- AI usage quota (persistent, per-user, per-day) + purchased credits ----
  consumeAiQuota(
    userId: string,
    dailyFree = AI_DAILY_FREE_QUOTA,
  ): { ok: boolean; source: "free" | "credit" | null; remainingToday: number; credits: number } {
    const day = new Date().toISOString().slice(0, 10);
    const tx = sqlite.transaction((): { ok: boolean; source: "free" | "credit" | null; remainingToday: number; credits: number } => {
      const row = sqlite
        .prepare("SELECT count FROM ai_usage WHERE user_id = ? AND day = ?")
        .get(userId, day) as { count: number } | undefined;
      const used = row?.count ?? 0;
      if (used < dailyFree) {
        sqlite
          .prepare("INSERT INTO ai_usage (user_id, day, count) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1")
          .run(userId, day);
        return { ok: true, source: "free", remainingToday: dailyFree - used - 1, credits: this.getAiCredits(userId) };
      }
      const credRow = sqlite
        .prepare("SELECT balance FROM ai_credits WHERE user_id = ?")
        .get(userId) as { balance: number } | undefined;
      const bal = credRow?.balance ?? 0;
      if (bal > 0) {
        sqlite
          .prepare("UPDATE ai_credits SET balance = balance - 1, updated_at = ? WHERE user_id = ?")
          .run(new Date().toISOString(), userId);
        return { ok: true, source: "credit", remainingToday: 0, credits: bal - 1 };
      }
      return { ok: false, source: null, remainingToday: 0, credits: 0 };
    });
    return tx();
  },

  getAiCredits(userId: string): number {
    const r = sqlite
      .prepare("SELECT balance FROM ai_credits WHERE user_id = ?")
      .get(userId) as { balance: number } | undefined;
    return r?.balance ?? 0;
  },

  addAiCredits(userId: string, amount: number): number {
    sqlite
      .prepare("INSERT INTO ai_credits (user_id, balance, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance, updated_at = excluded.updated_at")
      .run(userId, amount, new Date().toISOString());
    return this.getAiCredits(userId);
  },

  /**
   * Idempotent AI credit-pack grant, keyed on the Stripe invoice id.
   *
   * The webhook handler dedupes by event.id (markStripeEventProcessed), but that
   * claim is UN-claimed in the route catch block when the handler throws AFTER
   * the balance was already mutated (e.g. the audit write failed) — so a Stripe
   * retry of the SAME invoice would re-run the grant and double the credits for
   * free. This guards the money mutation on the invoice id itself, inside a
   * single transaction: we INSERT OR IGNORE a row into ai_credit_grants and only
   * bump the balance when WE win that insert (changes>0). Any subsequent
   * delivery of the same invoice — same event.id or not — finds the row already
   * present and is a no-op grant.
   *
   * Returns { granted, balance }: granted=false means this invoice was already
   * credited (skip the side effects / audit-as-duplicate); balance is always the
   * current authoritative balance either way.
   */
  grantAiCreditsForInvoice(
    invoiceId: string,
    userId: string,
    amount: number,
  ): { granted: boolean; balance: number } {
    const ts = new Date().toISOString();
    const tx = sqlite.transaction((): { granted: boolean; balance: number } => {
      const claim = sqlite
        .prepare(
          "INSERT OR IGNORE INTO ai_credit_grants (invoice_id, user_id, pack, granted_at) VALUES (?, ?, ?, ?)",
        )
        .run(invoiceId, userId, amount, ts);
      if (claim.changes === 0) {
        // Already credited for this invoice — do NOT bump the balance again.
        return { granted: false, balance: this.getAiCredits(userId) };
      }
      sqlite
        .prepare(
          "INSERT INTO ai_credits (user_id, balance, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance, updated_at = excluded.updated_at",
        )
        .run(userId, amount, ts);
      return { granted: true, balance: this.getAiCredits(userId) };
    });
    return tx();
  },

  getAiQuotaStatus(
    userId: string,
    dailyFree = AI_DAILY_FREE_QUOTA,
  ): { usedToday: number; dailyFree: number; remainingToday: number; credits: number } {
    const day = new Date().toISOString().slice(0, 10);
    const row = sqlite
      .prepare("SELECT count FROM ai_usage WHERE user_id = ? AND day = ?")
      .get(userId, day) as { count: number } | undefined;
    const used = row?.count ?? 0;
    return { usedToday: used, dailyFree, remainingToday: Math.max(0, dailyFree - used), credits: this.getAiCredits(userId) };
  },

  listLoadsForClientIds(
    clientIds: string[],
    opts: { limit?: number; cursor?: string; status?: "available" | "booked" } = {},
  ): { items: Load[]; nextCursor: string | null; hasMore: boolean; total: number } {
    if (clientIds.length === 0) {
      return { items: [], nextCursor: null, hasMore: false, total: 0 };
    }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const placeholders = clientIds.map(() => "?").join(",");
    const where: string[] = [`client_id IN (${placeholders})`];
    const params: Array<string | number> = [...clientIds];
    if (opts.status === "available") {
      where.push("booked_at IS NULL");
    } else if (opts.status === "booked") {
      where.push("booked_at IS NOT NULL");
    }
    if (opts.cursor) {
      const { orderValue, tiebreaker } = decodeCursor(opts.cursor);
      if (tiebreaker !== null) {
        where.push("(created_at < ? OR (created_at = ? AND id < ?))");
        params.push(orderValue, orderValue, tiebreaker);
      } else {
        where.push("created_at < ?");
        params.push(orderValue);
      }
    }
    params.push(limit + 1);
    const rows = sqlite
      .prepare(
        `SELECT id, payload, created_at FROM loads
         WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params) as Array<{ id: string; payload: string; created_at: string }>;
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const items: Load[] = parsePayloads<Load>(sliced);
    const lastRow = sliced[sliced.length - 1];
    const totalSql = `SELECT COUNT(*) AS c FROM loads WHERE client_id IN (${placeholders})${
      opts.status === "available"
        ? " AND booked_at IS NULL"
        : opts.status === "booked"
        ? " AND booked_at IS NOT NULL"
        : ""
    }`;
    const total = (sqlite.prepare(totalSql).get(...clientIds) as { c: number }).c;
    return {
      items,
      nextCursor: hasMore && lastRow ? encodeCursor(lastRow.created_at, lastRow.id) : null,
      hasMore,
      total,
    };
  },

  loadIsVisibleToDispatcher(loadId: string, dispatcherUserId: string): boolean {
    const row = sqlite
      .prepare(
        `SELECT 1 FROM loads l
         JOIN assignments a ON a.client_id = l.client_id
         WHERE l.id = ? AND a.dispatcher_user_id = ? AND a.removed_at IS NULL
         LIMIT 1`,
      )
      .get(loadId, dispatcherUserId);
    return Boolean(row);
  },

  listApprovalTasksForDispatcher(
    dispatcherUserId: string,
    opts: { status?: ApprovalTaskStatus; limit?: number; cursor?: string } = {},
  ): {
    items: Array<ApprovalTask & {
      createdByEmail: string | null;
      createdByFullName: string | null;
      resolvedByEmail: string | null;
    }>;
    nextCursor: string | null;
    hasMore: boolean;
    total: number;
  } {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where: string[] = [
      "t.assignee_role = 'dispatcher'",
      "json_extract(t.payload, '$.dispatcherUserId') = ?",
    ];
    const params: Array<string | number> = [dispatcherUserId];
    if (opts.status) {
      where.push("t.status = ?");
      params.push(opts.status);
    }
    if (opts.cursor) {
      const { orderValue, tiebreaker } = decodeCursor(opts.cursor);
      if (tiebreaker !== null) {
        where.push("(t.created_at < ? OR (t.created_at = ? AND t.id < ?))");
        params.push(orderValue, orderValue, tiebreaker);
      } else {
        where.push("t.created_at < ?");
        params.push(orderValue);
      }
    }
    params.push(limit + 1);
    const sql = `
      SELECT
        t.*,
        creator.email      AS creator_email,
        creator.full_name  AS creator_full_name,
        resolver.email     AS resolver_email
      FROM approval_tasks t
      LEFT JOIN users creator  ON creator.id  = t.created_by_user_id
      LEFT JOIN users resolver ON resolver.id = t.resolved_by_user_id
      WHERE ${where.join(" AND ")}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT ?
    `;
    const rows = sqlite.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const items = sliced.map((r) => ({
      id: r.id as string,
      taskType: r.task_type as ApprovalTaskType,
      assigneeRole: r.assignee_role as UserRole,
      resolvedByUserId: (r.resolved_by_user_id as string | null) ?? null,
      resolvedAt: (r.resolved_at as string | null) ?? null,
      status: r.status as ApprovalTaskStatus,
      payload: JSON.parse((r.payload as string) ?? "{}") as Record<string, unknown>,
      createdByUserId: r.created_by_user_id as string,
      createdAt: r.created_at as string,
      createdByEmail: (r.creator_email as string | null) ?? null,
      createdByFullName: (r.creator_full_name as string | null) ?? null,
      resolvedByEmail: (r.resolver_email as string | null) ?? null,
    }));
    const totalWhere = [
      "assignee_role = 'dispatcher'",
      "json_extract(payload, '$.dispatcherUserId') = ?",
    ];
    const totalParams: Array<string | number> = [dispatcherUserId];
    if (opts.status) {
      totalWhere.push("status = ?");
      totalParams.push(opts.status);
    }
    const total = (
      sqlite
        .prepare(`SELECT COUNT(*) AS c FROM approval_tasks WHERE ${totalWhere.join(" AND ")}`)
        .get(...totalParams) as { c: number }
    ).c;
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      hasMore,
      total,
    };
  },
};

// ---------------------------------------------------------------------------
// Broker Trust backfill — runs once at startup when signals is empty.
// ---------------------------------------------------------------------------
export function backfillBrokerTrustSignals(): { backfilled: number } {
  const signalCount = (sqlite.prepare("SELECT COUNT(*) AS c FROM broker_trust_signals").get() as { c: number }).c;
  const loadCount   = (sqlite.prepare("SELECT COUNT(*) AS c FROM loads").get() as { c: number }).c;
  if (signalCount > 0 || loadCount === 0) return { backfilled: 0 };

  const loadRows = sqlite.prepare("SELECT payload FROM loads").all() as Array<{ payload: string }>;
  let backfilled = 0;
  const ts = new Date().toISOString();
  const insertStmt = sqlite.prepare(`
    INSERT OR IGNORE INTO broker_trust_signals (
      id, broker_mc, load_id, client_id, signal_type, positive,
      value_json, notes, reported_by_user_id, reported_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  type Row = { sig: string; loadId: string; mc: string; cid: string | null; rate: number | null };
  const rows: Row[] = [];

  for (const row of loadRows) {
    try {
      const load = JSON.parse(row.payload) as Record<string, unknown>;
      const mc = ((load.brokerMc ?? load.broker_mc ?? "") as string).trim();
      if (!mc) continue;
      const loadId = (load.id ?? "") as string;
      const cid = (load.clientId ?? load.client_id ?? null) as string | null;
      const rate = typeof load.rate === "number" ? load.rate : null;
      if (load.bookedAt || load.booked_at)
        { rows.push({ sig: "load_booked", loadId, mc, cid, rate }); backfilled++; }
      if (load.status === "completed" || load.deliveredAt || load.delivered_at)
        { rows.push({ sig: "load_completed", loadId, mc, cid, rate }); backfilled++; }
    } catch { /* skip */ }
  }

  const doInsert = sqlite.transaction((batch: Row[]) => {
    for (const r of batch) {
      insertStmt.run(
        `bts_bf_${r.loadId}_${r.sig}`, r.mc, r.loadId, r.cid,
        r.sig, 1,
        r.rate !== null ? JSON.stringify({ rate: r.rate }) : null,
        "[automatic] backfill", null, ts, ts,
      );
    }
  });
  if (rows.length > 0) doInsert(rows);
  console.log(`[broker-trust] backfill: ${backfilled} signals from ${loadRows.length} loads`);
  return { backfilled };
}
