# Contributing to DispatchOS

## Team

| Role | Area |
|---|---|
| Founder / PM | Product decisions, Phase 5 portals |
| Backend dev | Backend, Admin portal |
| Design / QA | Design, QA |
| Code agent | AI pair for the backend dev |
| Computer | This agent |

_Contacts (Telegram / GitHub handles) live in the team chat, not in this repo._

## Branch Strategy

- `main` — production. Protected (no direct push). PR-only.
- `develop` — integration.
- `phaseN-<short>` — phase branches. Long-running.
- `feat/<short>`, `fix/<short>` — short-lived.

## How to land your work

1. `git checkout -b phaseN-<short>`
2. Code
3. `git commit -m "phaseN: <what>"` — use phase prefix in subject
4. `git push -u origin phaseN-<short>`
5. Open PR into `develop` (or `main` for hotfixes)
6. Tag the area-owner for review

## Critical rule

`shared/schema.ts` is the **source of truth** for all frontends.
If you change it:
- Title PR with `[BREAKING]` if old fields change
- Drop a heads-up in TG before merging
- Update `docs/api/` in the same PR

## Don't

- Don't push to `main` directly
- Don't commit `.env`, `*.db`, `node_modules/`
- Don't refactor someone else's area without coordinating in TG

## Coordination with Computer

The Computer agent reads the team chat. Tag it for:
- `прогони smoke на phase1` — run smoke against a backend
- `проверь contract` — diff schema.ts vs real endpoint responses
- `собери клиента` — generate TS client from OpenAPI
