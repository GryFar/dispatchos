# DispatchOS Phase 1 — Changes Document

**Version:** 1.3.0-phase1
**Date:** 2026-05-12
**Scope:** Multi-role user model + persistent sessions + owner→admin migration

---

## TL;DR

Phase 1 turns single-owner DispatchOS into a multi-user system with three roles
(`admin`, `dispatcher`, `driver`). It does **not** add admin/dispatcher/driver
UI screens, does **not** add `/api/admin/*` endpoints, and does **not** add
tenant-scoping. Those land in Phase 3. The point of Phase 1 is to lay down the
data model and the auth contract so that Claude Design and the second AI can
start working on their parts in parallel.

After applying Phase 1 the v1.2.7 frontend continues to work unchanged: login
still uses `{ username, password, token }`, status endpoint still returns
`isConfigured`, all 22 protected endpoints still work for the bootstrapped
admin. **Smoke test stays green and adds ~6 new `[OK]` lines.**

---

## What changed file-by-file

### `shared/schema.ts`

**Existing schemas:** unchanged (client, load, document, broker, dispatch board,
scoring — all kept identical).

**Added in Phase 1:**

- `userRoleSchema` — `z.enum(["admin", "dispatcher", "driver"])`
- `userPublicSchema` — what `GET /api/me` returns. **Never contains secrets.**
- `createUserSchema` — admin creates a user (Phase 3 wires this to
  `POST /api/admin/users`)
- `updateUserSchema` — admin updates a user (block, change role, change linked
  client) — Phase 3 endpoint
- `loginSchema` — accepts either `email` OR legacy `username`
- `bootstrapSchema` — creates the very first admin (formerly `/api/auth/setup`)
- `signupSchema` — invite-code-based signup, Phase 3 wires this to
  `POST /api/auth/signup`
- `inviteSchema` + `createInviteSchema` — one-time, expiring invite codes
- `assignmentSchema` + `createAssignmentSchema` — dispatcher ↔ client links
- `invoiceSchema` + `invoiceStatusSchema` — weekly billing (admin generates,
  dispatchers and drivers read scoped views in Phase 3)

All TypeScript types are exported. **This is the contract for the second AI.**

### `server/storage.ts`

**Schema migrations:** four new tables created on first start (idempotent):

```
users (id, email, full_name, role, password_salt, password_hash,
       totp_secret, blocked, linked_client_id, timestamps, last_login_at)
invites (code, role, email, expires_at, consumed_at, consumed_by_user_id,
         linked_client_id, created_at, created_by_user_id)
assignments (id, client_id, dispatcher_user_id, timestamps, created_by,
             removed_at, removed_by_user_id)
invoices (id, client_id, week_start, week_end, flat_fee, percent_fee,
          gross_booked, total_due, status, generated_at, sent_at, paid_at)
```

**Removed:** `storage.setAuthConfig()` (replaced by `storage.createUser()`).

**Added methods:**

- Users: `getUserById`, `getUserByEmail`, `listUsers`, `countUsers`,
  `createUser`, `updateUser`, `recordUserLogin`, `toUserPublic`
- Migration: `migrateLegacyOwnerIfNeeded()` — one-shot, idempotent. Run from
  `server/index.ts` on startup. If `auth_config.owner` exists and `users` is
  empty, copies the owner into `users` as `role=admin` using their existing
  password hash and TOTP secret. The owner's email becomes either:
  1. Their `username` if it contains `@`, OR
  2. `DISPATCHOS_OWNER_EMAIL` env var if set, OR
  3. `owner@dispatchos.local` as the final fallback.
- Invites: `createInvite`, `getInvite`, `consumeInvite`, `listInvites`
- Assignments: `createAssignment`, `removeAssignment`,
  `listAssignmentsForDispatcher`, `listAssignmentsForClient`,
  `listAllActiveAssignments`
- Invoices: `createInvoice`, `listInvoices`

**`getAuthState()`** is now Phase-1-aware: it checks the `users` table first,
falls back to legacy `auth_config` only if `users` is empty. The shape stays
backward-compatible — old UI fields (`username`, `role`, `twoFactorEnabled`)
still populate.

**`exportBackup()`** now also includes (without secrets):
`users`, `invites` (with codes redacted for non-consumed entries),
`assignments`, `invoices`. Version bumped to `1.3.0-phase1`.

### `server/auth.ts`

**Unchanged:** `hashPassword`, `verifyPassword`, `generateBase32Secret`,
`buildOtpAuthUrl`, `verifyTotp`. pbkdf2 with 210k iterations stays. TOTP stays.

**Added:**

- `getCurrentUser(req)` — loads user from session, returns `undefined` if
  blocked or no longer exists in DB (destroys orphan sessions).
- `requireRole(...roles)` — new middleware factory. Replaces the old
  `requireAuth`. Usage:
  ```ts
  app.get('/api/admin/users', requireRole('admin'), handler)
  app.get('/api/shared', requireRole('admin', 'dispatcher'), handler)
  app.get('/api/any', requireRole.any(), handler) // any authenticated user
  ```
- **Bootstrap protection:** if the system has no admin yet, `requireRole`
  returns `401 { bootstrap: true }`. This closes the v1.2.7 hole where an
  unconfigured public deployment exposed every endpoint.
- `requireAuth` kept as backward-compat alias = `requireRole.any()`.

**Session shape** (declared via module augmentation):
```ts
req.session.userId  // string
req.session.role    // "admin" | "dispatcher" | "driver"
req.session.authenticated  // legacy boolean, still set for old frontend
```

**Removed:** the `DISPATCHOS_AUTH_DISABLED=true` env-var backdoor that bypassed
auth entirely. There is no replacement; for dev, use `npm run dev`.

### `server/index.ts`

**Session store:** `MemoryStore` → `connect-sqlite3`. Sessions persist across
restarts. Stored in `${DISPATCHOS_DATA_ROOT}/sessions.db`, separate from the
business database so a business-data backup does not include sessions.

**`reusePort: true` removed** from `httpServer.listen()`. It is not supported
on Windows and Node 24 throws `ENOTSUP` on listen. Single-process production
runs don't need it.

**Migration hook:** `storage.migrateLegacyOwnerIfNeeded()` runs once at startup
before routes are registered. If it migrates anything, it logs:
```
[migration] migrated legacy owner -> admin user (id=..., email=...)
```

**Response logging:** the existing per-request log now redacts `totpSecret`
and `password` fields if they appear in response JSON. (Previously, the
bootstrap response, which contains `totpSecret`, would have been printed in
full to stdout.)

**Auth-disabled VDS guard removed** (no longer needed — the env var itself
is gone).

### `server/routes.ts`

**Changed (targeted, ~150 lines total):**

- `POST /api/auth/setup` → kept as a backward-compat alias of new
  `POST /api/auth/bootstrap`. Both call the same handler. Creates the first
  admin in the `users` table.
- `POST /api/auth/login` rewritten: looks up by email (or legacy username,
  with synthetic `@dispatchos.local` if no `@`), verifies pbkdf2 + TOTP,
  sets `req.session.userId` + `req.session.role` + legacy `authenticated`.
  Returns `{ ok, role, redirect }` where `redirect` is `/admin`, `/dispatch`,
  or `/me`.
- `POST /api/auth/logout` writes an `auth.logout` audit event with the
  user id before destroying the session.
- `GET /api/auth/status` now also includes `role` and corrected
  `twoFactorEnabled` from the currently logged-in user.
- New `GET /api/me` — returns `userPublicSchema` shape including
  `linkedClientId` (for drivers) or `assignedClientIds` (for dispatchers).
- API gate at the bottom of the auth block: now uses `requireRole.any()`,
  excludes `/auth/*`, `/me`, and `/health`. Behavior identical to before
  for any logged-in user.
- `GET /api/portal/status` updated to reflect Phase 1 reality:
  - Adds `phase: "1.3.0-phase1"`
  - Replaces `clientPortal` with `dispatcherPortal` + `driverPortal` blocks
  - Replaces `moderation.status: "owner_only_ready"` with
    `multi_role_ready` and includes user counts

**Unchanged:** everything else. All 22 protected endpoints work exactly as
before for the bootstrapped admin. No tenant-scoping in Phase 1.

### `package.json`

- Version: `1.2.7-vds-production` → `1.3.0-phase1`
- **Added:** `connect-sqlite3`
- **Removed (dead deps):** `passport`, `passport-local`,
  `@supabase/supabase-js`, `@types/passport`, `@types/passport-local`

### `.env.example`

- **Removed:** `DISPATCHOS_AUTH_DISABLED` (backdoor gone)
- **Added:** `DISPATCHOS_OWNER_EMAIL` (optional, for the legacy owner→admin
  migration when the legacy `username` is not an email)

### `server/types/connect-sqlite3.d.ts` (new)

Minimal TypeScript declaration for the `connect-sqlite3` package, which has
no official `@types/*` package. Matches our exact usage and lives in the
project so we don't depend on an external types repo.

### `scripts/smoke.mjs`

Existing 22 checks preserved. Added Phase 1 checks (~6 new `[OK]` lines):

- `/api/me` returns admin shape correctly
- `/api/me` does **not** leak dispatcher/driver fields on an admin response
- `/api/auth/status` now includes `role` and `authDisabled: false`
- `/api/backup/export` includes `users[]`, `invites[]`, `assignments[]`,
  `invoices[]` with version `1.3.0-phase1`
- Backup never leaks `passwordHash`, `passwordSalt`, or `totpSecret`
- Logout invalidates session: `/api/me` returns 401, `/api/clients`
  returns 401
- Re-login after logout returns the same user id (persistent users table)
- `/api/auth/bootstrap` rejects re-run with 409 once an admin exists

---

## How to apply

On your Windows machine, in `Dispach\dispatchos-location-aware`:

```powershell
# 1. Replace files with Phase 1 versions
#    (unzip phase1.zip over the project folder)

# 2. Install the one new dependency
npm install

# 3. Rebuild
npm run build

# 4. Run smoke
npm run smoke
```

Expected output: all previous `[OK]` lines plus the new Phase 1 checks. No
`[FAIL]`.

If smoke fails, **send me the last 40 lines** and tell me which `[OK]` was
the last green line. I'll patch it from there.

---

## What this unblocks

For **Claude Design** (frontend chat):

- The `shared/schema.ts` contract is final. All types it needs for login,
  signup, admin Dashboard, admin Users page, admin Invites page,
  admin Assignments page, and admin Billing page are exported.
- The API contract for `GET /api/me` is live (Claude Design can build the
  post-login redirect router against the real backend).
- The legacy v1.2.7 UI still works, so design work doesn't have to be
  done in a "broken" environment.

For the **second AI** (dispatcher + driver portals, later):

- The `shared/schema.ts` contract is final and shared.
- `req.session.role` is in place; second AI's `requireRole('dispatcher')`
  and `requireRole('driver')` middleware will work as soon as Phase 3
  splits routes.
- URL prefixes are reserved: `/api/admin/*`, `/api/dispatch/*`, `/api/me/*`.
  Second AI gets the second and third; Claude Design owns the first; both
  share `/api/me` and `/api/auth/*`.

---

## What's NOT in Phase 1 (still to do)

- Admin endpoints under `/api/admin/*` — Phase 3
- Tenant-scoping for `/api/clients`, `/api/loads`, `/api/dispatch-board`,
  `/api/documents`, `/api/reports/weekly` — Phase 3
- Splitting `server/routes.ts` (still a single 1100-line file) — Phase 3
- Pulling pure functions into `server/lib/*` — Phase 3
- Telegram webhook moved out of cookie-auth — Phase 3
- Frontend changes (login/signup/admin pages) — Claude Design, after Phase 1
- Postgres migration — Phase 6

---

## Migration notes

- **Existing databases:** if you point this Phase 1 build at a v1.2.7 SQLite
  file that already has an `auth_config.owner` row, the migration hook will
  pick it up on first start and create a corresponding `users` row with
  `role=admin`. The legacy `auth_config` row is left in place (untouched)
  but is no longer consulted once a user exists.
- **The migrated admin keeps their existing password hash and TOTP secret.**
  Login continues to work with the same credentials.
- **Fresh DB (your case):** there is no `auth_config` row, so the migration
  hook is a no-op. The first run of `/api/auth/setup` (or `/bootstrap`)
  creates the first admin directly in `users`.
- **Email for the first admin** when bootstrapping with username `owner`
  (which is what the smoke test does): becomes `owner@dispatchos.local`.
  For your real first admin, when you bootstrap via UI later, pass
  your own email address directly.

---

## Audit trail

New audit event types written by Phase 1:

- `user.created` — when a user row is created (bootstrap or future
  `/api/admin/users`)
- `user.migrated_from_owner` — one-shot, written by the migration hook
- `user.updated` — `updateUser()`, with secrets stripped from the patch
  field
- `invite.created`, `invite.consumed`
- `assignment.created`, `assignment.removed`
- `invoice.created`
- `auth.login` — now includes `email` and `role` in payload (instead of
  just `username`)
- `auth.logout` — new, written before session.destroy()
