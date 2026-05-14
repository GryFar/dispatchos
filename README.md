# DispatchOS

Dispatcher service platform for hot shot and car hauler owner-operators. Florida LLC. Russian-speaking team, US market.

## Status

**Phase 1 — Migration from v1.2.7 → v1.3.0 (multi-role architecture)**

See [`docs/architecture/migration-plan.md`](docs/architecture/migration-plan.md) for the full 6-phase plan by Vlad (12 May 2026).

## Repository Layout

This is a **monorepo**. Each portal is a separate frontend; the backend is shared.

```
dispatchos/
├── backend/                  # Node.js / Express / SQLite (Drizzle later → Postgres)
│   ├── shared/schema.ts      # Source of truth for all types — shared with all frontends
│   ├── server/               # routes, auth, storage, lib
│   └── scripts/              # smoke tests, seeds, migrations
│
├── frontend-admin/           # Owner / super admin portal
├── frontend-dispatcher/      # Internal dispatch team workspace
├── frontend-driver/          # Minimal driver UI (POD upload, check-ins)
├── frontend-client/          # Carrier-owner portal (their fleet, loads, billing)
│
├── shared/                   # Cross-frontend code: types, API client, design tokens
│   ├── types/
│   ├── api-client/
│   └── design-system/
│
└── docs/
    ├── api/                  # OpenAPI specs, endpoint references
    ├── architecture/         # Migration plan, role matrix, ADRs
    └── runbooks/             # Deploy, backup, incident response
```

## Roles & Ownership

| Area | Owner | Status |
|---|---|---|
| `backend/` | **Vlad** (Claude) | Phase 1 in progress |
| `frontend-admin/` | **Vlad** (own Computer) | Started |
| `frontend-dispatcher/` | **Founder** (Perplexity Computer) | Waiting for backend |
| `frontend-driver/` | **Founder** (Perplexity Computer) | Waiting for backend |
| `frontend-client/` | **Second AI** (Claude Design separate chat) | Phase 5 |
| `shared/design-system/` | **Claude Design** | Phase 2 |
| `shared/types/` | Synced from `backend/shared/schema.ts` | Auto |
| `docs/api/` | Vlad writes, others consume | — |

## Quick Start (when backend is uploaded)

```bash
git clone https://github.com/GryFar/dispatchos.git
cd dispatchos/backend
npm install
cp .env.example .env
# fill in .env values — see docs/runbooks/env-vars.md
npm run dev
```

## Communication

- **Telegram:** `DispatchOSDev` chat (team-only)
- **Issues:** GitHub Issues with labels `area:backend`, `area:frontend-*`, `phase:1`...`phase:6`
- **Decisions:** ADRs in `docs/architecture/adr/`
- **Urgent broken things:** Telegram, then issue

## Security

- ⚠️ No secrets in code. Use `.env`, never commit `.env.local`.
- ⚠️ No production data in repo. Use seed scripts for dev DB.
- ⚠️ All clients/brokers' PII stays in the running DB only.
- Main branch is protected. PRs only.
