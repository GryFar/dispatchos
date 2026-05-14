# Contributing to DispatchOS

## Team

| Member | Telegram | GitHub | Area | TZ |
|---|---|---|---|---|
| Founder | @addictwests | GryFar | PM, Phase 5 portals | US ET (FL) |
| Vlad | @valaskes | Snapakdominator | Backend, Admin portal | Odessa, UA |
| Gena | @tikemyson228 | (TBD) | Design / QA | Canada |
| Claude (Vlad's) | — | — | Vlad's code agent | — |
| Computer | @DispatchOS_Computer_Bot | — | This agent | — |

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

Computer (`@DispatchOS_Computer_Bot` / tag `Перплексити`) reads the chat. Tag him for:
- `@Перплексити прогони smoke на phase1` — run smoke against a backend
- `@Перплексити проверь contract` — diff schema.ts vs real endpoint responses
- `@Перплексити собери клиента` — generate TS client from OpenAPI
