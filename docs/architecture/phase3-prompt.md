# Phase 3 — Prompt для Claude (backend)

**Скопируй этот промт в Claude / Cursor когда сядешь делать driver + dispatcher porals.**

---

You are continuing work on the DispatchOS monorepo (Florida-based dispatcher service for hot-shot and car-hauler trucking). Phase 1 (Core API, auth, billing engine) and Phase 2 (Admin portal — 12 screens, all live endpoints) are DONE and merged into `develop`. You are starting **Phase 3: Driver Portal + Dispatcher Portal**.

## Hard constraints (DO NOT deviate)

1. **Theme: dark everywhere.** Use design tokens from `docs/architecture/design-system.md` — black bg `#0a0e1a`, orange accent `#f59e0b`. NO light mode toggle in Phase 3. Admin portal will be recolored to match — do not block on that.
2. **Signup: hybrid only.** Public `/signup` does NOT exist. Flow: landing collects email → dispatcher approves in admin "Заявки" tab → invite generated via `POST /api/admin/invites` → email magic-link → user completes profile. NEVER add open self-registration.
3. **Roles & endpoints already defined** in `docs/architecture/role-matrix.md`. Use that EXACTLY:
   - Driver portal at `/d/*`, endpoints `/api/me/*`
   - Dispatcher portal at `/dp/*`, endpoints `/api/dispatch/*`
   - Both require auth, JWT in httpOnly cookie (same as admin)
4. **Tenant scoping is mandatory.** Every dispatcher endpoint MUST call `enforceTenantScope(req)` and filter by `assignments.dispatcherId = self.id`. Every driver endpoint MUST filter by `loads.driverId = self.id`. NO admin-level data leaks to dispatcher/driver views.
5. **Monolith layout** (no monorepo, no workspaces). Add to existing `client/`, `server/`, `shared/` in root.
6. **Mobile-first for driver, desktop-first for dispatcher.** Driver portal must work in a phone in a truck cabin — minimum touch target 44px, font-size 16px+. Dispatcher portal targeted at 1440px desktop with 2-monitor workflow.

## Phase 3 deliverables (in priority order)

### 3.1 Driver Portal MVP — Week 1

Build at `client/src/pages/driver/`:

- `/d` — Dashboard. Reads `GET /api/me/dashboard` (single endpoint returns everything). Sections:
  - Status card (color-coded: green=on-route, yellow=available, red=off-duty)
  - Today panel (next pickup or delivery)
  - 4 quick-action buttons: Upload POD / Send Receipt / Report Issue / Call Dispatcher
  - History (last 3 loads, tap to expand)
  - Bottom nav: Home / Loads / Documents / Profile
- `/d/loads` — List of own loads. Sort by date desc.
- `/d/loads/:id` — Load detail. Show route, broker contact, pickup/delivery, BOL preview, action buttons.
- `/d/loads/:id/pod` — Photo upload. Use `<input type="file" capture="environment">` for direct camera. Compress to <2MB before upload.
- `/d/documents` — Personal docs: CDL, medical, COI, W9. Show expiration with warning if <60 days.
- `/d/profile` — Read/edit name, phone, language. Logout button.

New endpoints needed (server/routes/me.ts):
```
GET    /api/me/dashboard          — aggregated view
GET    /api/me/loads
GET    /api/me/loads/:id
POST   /api/me/loads/:id/checkin  — POST { lat, lng, timestamp }
POST   /api/me/loads/:id/pod      — multipart, image
POST   /api/me/expenses           — multipart, image + amount + category
POST   /api/me/status             — { status: 'available' | 'on_route' | 'off_duty' }
POST   /api/me/issue              — { type, description, load_id? }
GET    /api/me/documents
PATCH  /api/me/profile
```

All endpoints REQUIRE `req.user.role === 'driver'` AND filter by `req.user.id`. Add to existing auth middleware.

### 3.2 Dispatcher Portal MVP — Week 2 (after 3.1 lands)

Build at `client/src/pages/dispatcher/`:

- `/dp` — Ops Dashboard. 3-column layout:
  - **Left sidebar:** my assigned clients with status badges
  - **Column 1: Load Pipeline** — AI suggestions from `GET /api/dispatch/suggestions` (Phase 3 returns stubbed suggestions, Phase 4-5 will add real AI). Card: route, $, broker, AI-score, deadhead, PPM. Actions: Book / Counter / Skip.
  - **Column 2: Active Loads** — `booked / in_transit / at_delivery` status. Real-time updates via polling every 30s.
  - **Column 3: Approvals & Alerts** — approval tasks, expiring docs, driver issues, fraud flags. Each with Resolve / Escalate / Snooze.
- `/dp/clients/:id` — Client detail (driver profile, history, current load, performance).
- `/dp/leads` — **NEW IMPORTANT** — list of signup leads from landing. Each row: email, ts, country, UA. Buttons: Approve (creates invite) / Reject / Spam.
- `/dp/messages` — broker comms threads.

New endpoints (server/routes/dispatch.ts):
```
GET   /api/dispatch/dashboard
GET   /api/dispatch/suggestions
POST  /api/dispatch/loads/:id/book
POST  /api/dispatch/loads/:id/counter
GET   /api/dispatch/clients
GET   /api/dispatch/clients/:id
GET   /api/dispatch/approvals
POST  /api/dispatch/approvals/:id/resolve
GET   /api/dispatch/alerts
POST  /api/dispatch/messages
GET   /api/dispatch/leads          ← reads from KV SUBSCRIBERS namespace
POST  /api/dispatch/leads/:id/approve   ← generates invite, sends email
```

All endpoints REQUIRE `req.user.role IN ('dispatcher', 'admin')` AND `enforceTenantScope(req)`.

### 3.3 Magic-link invite flow — embedded in 3.1/3.2

- New page `/i/:token` — public, no auth. Verifies token, shows form to complete profile.
- New endpoint `POST /api/auth/complete-signup` — public, validates token + completes user creation.
- Invite tokens: 32-byte crypto random, SHA-256 hashed in DB, 24h TTL.
- Email delivery via Cloudflare Email Routing OUT (configured for `noreply@dispatchos.co`). Templates in 3 languages (UA/RU/EN).

## Quality bar

- TypeScript strict, `npm run check` must pass with 0 errors.
- Smoke tests for every new endpoint in `scripts/smoke.mjs` style.
- No client-side localStorage for auth state (httpOnly cookie only).
- All forms validate with `zod` schemas in shared/.
- All API responses follow `{ ok: true, data: ... }` or `{ ok: false, error: { code, message } }` shape.
- Driver portal Lighthouse mobile score ≥90.

## NOT in Phase 3 (Phase 4+)

- Real AI suggestions (suggestions endpoint returns stub array)
- Stripe billing for clients
- WS real-time (polling 30s is fine)
- Push notifications (Phase 4)
- Native iOS/Android apps
- Multi-step onboarding wizard with KYC

## How to work

1. Create a feature branch `phase3-driver-portal` from `develop`.
2. Build driver portal first (3.1), open PR for review.
3. After merge, branch `phase3-dispatcher-portal` from `develop`, build 3.2.
4. Merge to `develop` after each PR review by the owner.
5. When both are stable on `develop`, branch `release/v1.4.0` → merge to `main` → tag.

When in doubt, ask in the project Telegram chat tagging the founder. Don't guess on product decisions.

---

**Reference files to read first:**
- `docs/architecture/role-matrix.md` — roles, endpoints, tenant scope
- `docs/architecture/design-system.md` — colors, typography, spacing, components
- `docs/architecture/phase3-structure.md` — detailed screen-by-screen breakdown
- `docs/api/openapi.yaml` — existing API spec (extend, don't break)
- `server/lib/auth.ts` — existing auth middleware pattern to reuse
