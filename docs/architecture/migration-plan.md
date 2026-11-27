# DispatchOS Migration Plan: v1.2.7 → v1.3.0

**Author:** Backend dev
**Date:** 12 May 2026
**Status:** In progress

This document captures the full plan posted by the backend dev in the team Telegram chat on 12 May 2026.

## Team Roles

- **Founder (PM):** sets tasks, accepts deliverables, runs smoke tests, passes files between AIs.
- **Backend dev (Claude — backend):** splits the monolith, builds auth with roles, admin API, migrations, tests.
- **Claude Design (separate chat — frontend):** design system, login/signup/forgot-password, all Admin Portal UI, API spec.
- **Second AI (separate chat — Phase 5):** Dispatcher + Driver portals (UI and API).

## Phases

### Phase 0 — Preparation (1 day, founder)
- Snapshot of current `dispatchos-unified.db` if there's production data
- `git tag pre-migration-v1.2.7` on current code
- Run `npm run smoke` — confirm 28 endpoints work (baseline)
- Create `.env.example` with all 24 variables (list from audit)
- Decide two architectural questions:
  - **Single domain or subdomains?** (`dispatchos.co/admin` vs `admin.dispatchos.co`) — cookie config depends on this
  - **SQLite stays or migrate to Postgres?** Recommended: stay on SQLite for Phase 1-2, migrate to Postgres in Phase 3

**Deliverable:** fixed baseline + answers to two questions.

### Phase 1 — Backend foundation (2-3 days, backend dev)

**Goal:** turn single-owner backend into multi-user with roles, without breaking any existing endpoint.

What the backend dev does:
- Extends `shared/schema.ts`:
  - `userRoleSchema = z.enum(["admin","dispatcher","driver"])`
  - `userSchema` — id, email, fullName, role, passwordHash, passwordSalt, totpSecret?, blocked, createdAt, updatedAt
  - `inviteSchema` — code, role, email?, expiresAt, consumedAt?, createdBy
  - `assignmentSchema` — id, clientId, dispatcherId, createdAt
  - `invoiceSchema` — id, clientId, weekStart, weekEnd, flatFee, percentFee, grossBooked, status, generatedAt
- Extends `server/storage.ts`: new tables + methods (see TG message for full list)
- Migration hook: if `auth_config.owner` exists and `users.*` doesn't → copy owner to users with `role='admin'`
- Rewrites `server/auth.ts`: `requireRole(...roles)` middleware, `getCurrentUser(req)` helper
- Changes `server/index.ts`: MemoryStore → connect-sqlite3 (persistent sessions), removes `DISPATCHOS_AUTH_DISABLED` backdoor
- Adds to `server/routes.ts`:
  - `GET /api/me`
  - `/api/auth/login` now logs in any user (not just owner)
  - `/api/auth/signup` (new, by invite code)
- Extends `scripts/smoke.mjs`

**Not touched in this phase:**
- Existing 28 endpoints still work as before
- `routes.ts` stays monolithic — split happens in Phase 3
- No frontend changes

**Deliverable:** `dispatchos-v1.3.0-phase1.zip`, updated `shared/schema.ts`, `phase1-api-changes.md`, green smoke tests.

### Phase 2 — Frontend foundation (3-4 days, Claude Design — parallel)

Starts: after Phase 1 (when `shared/schema.ts` is finalized and `GET /api/me` works).

What Claude Design does:
- Day 1 (parallel with Phase 1): design tokens — `design-system.md`, `tailwind.config.ts`, `client/src/index.css`. Goes to second AI right away so all three portals are visually consistent.
- After Phase 1: login flow (`login.tsx`, `signup.tsx`, `forgot-password.tsx`)
- `client/src/App.tsx` is split: wouter Router, AuthGate stays as gate, routes for `/login`, `/signup`, `/admin/*`, `/dispatch/*`, `/me/*`
- Admin Portal — all 12 screens from spec
- `admin-api-spec.md` — OpenAPI-style spec of all `/api/admin/*` endpoints

### Phase 3 — Backend refactor (3-4 days, backend dev — parallel with Phase 2)

**Goal:** split `routes.ts` (1068 lines) into modules, extract pure functions, implement admin endpoints per Claude Design spec.

- Extract pure functions into `server/lib/`: scoring, brokers, csv, email, integrations, billing, drive, seed
- Split `routes.ts` into modules: `auth.ts`, `admin.ts`, `shared.ts`, `webhooks.ts`, `health.ts`, `index.ts`
- Implement new admin endpoints per `admin-api-spec.md`
- Tenant-scope for shared endpoints (dispatcher sees only assigned clients, driver sees only self)
- Cleanup: remove dead deps (passport, passport-local, @supabase/supabase-js)
- Decide Drizzle: real tables or remove `drizzle.config.ts`
- Add `credentials: "include"` to `client/src/lib/queryClient.ts`
- Extended smoke tests: `smokeAdmin()`, `smokeDispatcher()`, `smokeDriver()`, webhook test

**Deliverable:** `dispatchos-v1.3.0-phase3.zip`, full smoke coverage, `migration-notes.md`.

### Phase 4 — Sync & integration (1-2 days, both)

**Goal:** combine Claude Design frontend with the backend, run end-to-end.

Founder:
- Takes backend from Phase 3, frontend from Phase 2
- Merges into one repo
- Runs smoke tests
- Manual scenario: setup admin → invite dispatcher → invite driver → assign client → each logs in and sees their own data
- Brings concrete problems to relevant party

**Deliverable:** working merged build `dispatchos-v1.3.0-rc1`.

### Phase 5 — Dispatcher & Driver portals (2-3 weeks, second AI)

Starts: when Phase 4 is stable.

Second AI gets:
- Final `shared/schema.ts` with roles
- `dispatchos-v1.3.0-rc1` working build
- `design-system.md` + Tailwind tokens
- Doc from the backend dev: reserved endpoints (`/api/dispatch/*`, `/api/me/*`), shared endpoints with tenant-scope
- Doc from Claude Design: UI patterns, shadcn/ui components already styled

Zone:
- `client/src/pages/dispatch/*` — Dispatcher Portal
- `client/src/pages/me/*` — Driver Portal
- `server/routes/dispatcher.ts` — `/api/dispatch/*`
- `server/routes/driver.ts` — `/api/me/*`

Does **not** touch: `shared/schema.ts` without coordination, `/api/admin/*`, auth/sessions/login, pure functions in `server/lib/*`.

### Phase 6 — Production hardening (1 week, separate task)

After all three portals work:
- SQLite → Postgres migration (Drizzle for normalized tables)
- Hosting setup (VDS or Vercel + Neon — decided in Phase 0)
- Nginx + HTTPS + correct trust proxy + `cookieSecure=true`
- Backup automation (`/api/admin/backup/export` via cron + offsite copy)
- Real Telegram bot webhook setup
- FMCSA API key connected
- Error monitoring (at minimum — log rotation)

---

## Open Questions (Phase 0)

- [ ] Single domain or subdomains? *(affects cookie config — must decide before Phase 1)*
- [ ] SQLite stays in Phase 1-2 or jump straight to Postgres?
- [ ] Where will it be hosted? (VDS vs Vercel+Neon)
