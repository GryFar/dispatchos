# DispatchOS

Dispatcher service platform for hot shot and car hauler owner-operators. Florida LLC. Team in Florida + Odessa + Canada. Native Ukrainian, Russian, English.

## Status

**Phase 2 — Admin Portal** (in progress, owned by Vlad)

See [`docs/architecture/migration-plan.md`](docs/architecture/migration-plan.md) for the 6-phase plan.

## Repository Layout

This is a **monolith**. One backend + one frontend, side by side.

```
dispatchos/
├── package.json        ← monorepo root (or single project)
├── client/             ← React SPA (admin + future dispatcher/driver/client portals via routing)
├── server/             ← Node/Express/SQLite backend
├── shared/             ← shared types (schema.ts is source of truth)
├── scripts/            ← smoke tests, seeds, migrations
│
├── apps/
│   └── coming-soon/    ← Cloudflare Worker for dispatchos.co landing (independent, auto-deployed)
│
└── docs/
    ├── api/            ← OpenAPI specs
    ├── architecture/   ← migration plan, role matrix, ADRs
    └── runbooks/       ← deploy, backup, incident response
```

When `dispatcher` and `driver` portals are added (Phase 5), they live as routes inside `client/` (e.g. `client/src/pages/dispatch/*`, `client/src/pages/me/*`), not as separate sub-apps.

## Roles

| Area | Owner |
|---|---|
| `client/`, `server/`, `shared/` | **Vlad** (Snapakdominator) |
| `client/src/pages/dispatch/*` (future) | Computer |
| `client/src/pages/me/*` (future, driver) | Computer |
| `apps/coming-soon/` | Computer (auto-deploys via CF Workers Builds) |
| `docs/` | Shared |

## Branches

- `main` — production (PR only)
- `develop` — integration
- `phase0-...`, `phase1-...`, `phase2-frontend-admin`, etc. — phase branches

## Communication

- Telegram: `DispatchOSDev` chat
- Computer-bot: `@DispatchOS_Computer_Bot` (tag `Перплексити`)
- Issues: GitHub Issues with `area:*` and `phase:*` labels

## Live

- Landing: https://dispatchos.co (auto-deployed from `apps/coming-soon/` on push)
- App: not deployed yet (Phase 4+)
