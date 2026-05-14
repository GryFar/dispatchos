# Contributing to DispatchOS

## Team

| Member | Handle | Area | Working hours |
|---|---|---|---|
| Founder | @GryFar | PM, Dispatcher+Driver portals | Late evening / overnight ET |
| Vlad | (TG: Влад Уволен) | Backend, Admin portal | His morning (~8am his TZ) |
| Хуесос | (TG handle) | Design review, QA | Weekday evenings (works full-time) |
| Claude Design | external chat | Design system, login flows | On-demand |
| Second AI | external chat (Phase 5) | Client portal | After Phase 4 |

## Branch Strategy

- `main` — **protected**. Production-ready. Tagged releases only.
- `develop` — integration branch. PRs from feature branches.
- `phase1-backend-roles`, `phase2-design-system`, `phase3-routes-refactor`, etc. — long-running phase branches.
- `feat/<short-desc>` — feature branches off `develop`.
- `fix/<short-desc>` — bugfix branches.

**Never push directly to `main`.** Tag releases as `v1.3.0-phase1`, etc.

## First-Time Setup (для Влада в первую очередь)

### Vlad — заливай v1.2.7 в `backend/` чтобы было с чем работать:

```bash
# 1. Клонируешь репо
git clone https://github.com/GryFar/dispatchos.git
cd dispatchos

# 2. Создаёшь ветку для baseline'а
git checkout -b phase0-v1.2.7-baseline

# 3. Распаковываешь свой dispatchos-v1.2.7.zip ВНУТРЬ backend/
unzip ~/Downloads/dispatchos-v1.2.7.zip -d backend/
# или копируешь содержимое — но в backend/, не в корень

# 4. Делаешь .env.example (без секретов!) — список 24 переменных из твоего аудита
# Положи в backend/.env.example

# 5. Коммитишь
git add backend/
git commit -m "phase 0: baseline dispatchos v1.2.7-vds-production import"
git tag pre-migration-v1.2.7
git push origin phase0-v1.2.7-baseline --tags

# 6. Открываешь PR в develop
gh pr create --base develop --head phase0-v1.2.7-baseline \
  --title "Phase 0: Baseline v1.2.7" \
  --body "Imports current production backend as starting point. No code changes."
```

После мерджа — начинаешь Phase 1 в новой ветке `phase1-backend-roles`.

## What Goes Where

| You change... | Type of PR |
|---|---|
| `backend/shared/schema.ts` | **HIGH-IMPACT** — breaks everyone. Announce in TG before merging. |
| `backend/server/routes/*.ts` | API change — update `docs/api/` in same PR. |
| `frontend-*/` | Per-portal change. Tag relevant owner. |
| `shared/design-system/` | Coordinate with Claude Design first. |
| `docs/` | Documentation — solo OK, no review needed for typo fixes. |

## Commit Messages

Use prefix tags:

- `backend:` `frontend-admin:` `frontend-dispatcher:` `frontend-driver:` `frontend-client:` `shared:` `docs:` `ci:`
- `phase1:` `phase2:` etc. — для milestone-привязанных коммитов

Example:
```
backend: add role-based middleware (phase1)

- requireRole(...roles) replaces requireAuth
- /api/me returns id, role, fullName, email
- backward-compat: existing endpoints unaffected
```

## Before Submitting a PR

1. Run smoke tests if backend: `cd backend && npm run smoke`
2. Lint: `npm run lint`
3. Type-check: `npm run typecheck`
4. Update relevant docs in `docs/`
5. If you touched `shared/schema.ts` — notify in TG before merging

## Code Review

- Backend PRs: Vlad reviews. Founder may review for architectural impact.
- Frontend PRs: Owner of that portal reviews. Founder approves merge.
- `shared/` PRs: Two approvals (Vlad + Founder).

## Releases

After Phase 4 (sync & integration):

```bash
git checkout main
git merge --ff-only develop
git tag v1.3.0-rc1
git push origin main --tags
gh release create v1.3.0-rc1 --notes-from-tag
```

## Don't

- ❌ Commit `.env.local`, `.env.production`, `*.db`, `node_modules/`
- ❌ Push real client/broker data in test fixtures
- ❌ Push directly to `main`
- ❌ Refactor things outside your area without coordinating in TG
- ❌ Break `backend/shared/schema.ts` without warning frontend teams

## Questions

Telegram chat `DispatchOSDev`. Tag `@GryFar` for blocking issues.
