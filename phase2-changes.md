# Phase 2 — Admin Portal + Design System v1.1

**Версия:** `v1.3.1-phase2`
**Дата:** 2026-05-14
**Автор:** Claude Design

Полный фронтенд admin-портала с дизайн-системой. Бэкенд не менялся (Phase 1 фундамент).
Следующий шаг — **Phase 3** (ИИ-бэкендер реализует `/api/admin/*` endpoints по `admin-api-spec.md`).

---

## Что в этом релизе

### Дизайн-система v1.1 (Polish A)
- **Цвета:** slate base + emerald primary, семантика `success/warning/destructive`
- **Шрифты:** Inter (UI) + JetBrains Mono (числа)
- **Density:** compact для таблиц (Loads/Brokers/Audit/Documents), comfortable для остального
- **Polish:** sidebar gradient + rail-индикатор, hover-lift на карточках, shimmer skeleton,
  staggered table rows, page fade-in, aurora background на auth, polished focus-rings
- **Темы:** light/dark/system, переключатель в topbar, хранится в localStorage
- **Файлы:** `client/src/index.css`, `tailwind.config.ts`, `client/src/components/dispatch/*`

### Каркас приложения
- `client/src/App.tsx` — wouter с hash routing, три role-spaces (`/admin/*`, `/dispatch/*`, `/me/*`),
  RootRedirect, NotFound
- `client/src/components/role-gate.tsx` — silent redirects по ролям
- `client/src/components/theme-provider.tsx` — next-themes wrapper
- `client/src/lib/use-auth.ts` — `useAuth()` hook через react-query на `/api/me`
- `client/src/lib/queryClient.ts` — `ApiError` class, `apiJson<T>()` helper, retry-policy
  (skip 401/403/404), staleTime 30s
- `client/src/lib/use-clipboard.ts` — copy с feedback

### Auth pages
- `pages/login.tsx` — двух-шаговый flow (email+pwd → если 401 "2fa" → TOTP step)
- `pages/signup.tsx` — invite-flow + TOTP QR display
- `pages/forgot-password.tsx` — stub (Phase 5)

### Admin portal — 12 экранов

| # | Экран | Endpoint | Источник |
|---|---|---|---|
| 1 | Dashboard | `GET /api/admin/dashboard/stats` | Phase 3 (P3) → fallback баннер |
| 2 | Users | `GET/POST/PATCH /api/admin/users`, reset-password, reset-totp | Phase 3 (P0/P1) → fallback |
| 3 | Invites (tab inside Users) | `GET/POST/DELETE /api/admin/invites` | Phase 3 (P0) → fallback |
| 4 | Assignments | `GET/POST/DELETE /api/admin/assignments` + `GET /api/admin/users?role=dispatcher` | Phase 3 (P1) → fallback |
| 5 | Clients | `GET/POST /api/clients` | **Live** (v1.2.7) |
| 6 | Loads | `GET /api/loads` | **Live** (v1.2.7) |
| 7 | Brokers | `GET /api/brokers`, `POST /api/broker/check` | **Live** (v1.2.7) |
| 8 | Documents | `GET /api/documents`, `GET /api/clients` | **Live** (v1.2.7) |
| 9 | Audit | `GET /api/audit` | **Live** (v1.2.7), готов к P4 пагинации |
| 10 | Backup | `GET /api/backup/export?redacted=...`, `GET /api/system/status` | **Live** (v1.2.7) |
| 11 | Billing | `GET/POST/PATCH /api/admin/billing/*` | Phase 3 (P2) → fallback |
| 12 | Settings (Integrations + Security) | `GET /api/integrations/status`, `/api/me` | **Live** (v1.2.7) |

**Все экраны Phase 3** при недоступности endpoint показывают `<EndpointPending>` — аккуратный
hero с emerald glow и описанием. Когда бэкендер выкатит реальный endpoint, баннер исчезнет автоматически.

### Legacy сохранён
`client/src/pages/admin/legacy-dashboard.tsx` — это бывший v1.2.7 App.tsx целиком,
доступен через `/admin/legacy-dashboard`. **Удалить после Phase 3**, когда новые экраны
полностью покрывают функционал.

### shared/schema.ts — additive
В конец добавлено (Phase 1 контракты не менялись):
- Pagination: `paginatedResponseSchema<T>`, `paginationParamsSchema`
- Filters: `userListFiltersSchema`, `inviteListFiltersSchema`, `assignmentListFiltersSchema`,
  `invoiceListFiltersSchema`, `auditListFiltersSchema`
- Billing: `generateInvoiceSchema`, `invoicePreviewSchema`
- Dashboard: `integrationHealthSchema`, `dashboardStatsSchema`
- Audit: `auditEventSchema`
- Auth responses: `loginResponseSchema`, `signupResponseSchema`

### package.json
- Версия: `1.3.0-phase1` → `1.3.1-phase2`
- Добавлено: `@dnd-kit/core ^6.3.1`, `@dnd-kit/sortable ^10.0.0`, `@dnd-kit/utilities ^3.2.2`
- Остальное без изменений

### admin-api-spec.md (в корне проекта)
Полная спека всех `/api/admin/*` endpoint'ов для Phase 3 ИИ-бэкендера. 18 endpoints + signup,
с request/response shapes, error codes, audit events, приоритетами P0–P4.

---

## Что НЕ менялось

- `server/*` — ни строчки. Phase 3 — территория ИИ-бэкендера.
- Phase 1 endpoint contracts: `/api/auth/login`, `/api/auth/bootstrap`, `/api/auth/logout`,
  `/api/me`, `/api/auth/status` — все сохранены as-is.
- Phase 1 типы в `shared/schema.ts` — только добавлено в конец.
- shadcn/ui компоненты в `client/src/components/ui/*` — не трогал.
- Cookie name `dispatchos.sid`, session middleware — без изменений.
- Auth flow (pbkdf2 + TOTP + session cookie) — без изменений.

---

## Verify после распаковки

```bash
npm install              # должно поставиться, новые deps — @dnd-kit/*
npm run check            # tsc --noEmit — 0 ошибок
npm run build            # client + server должны собраться
npm run smoke            # 22 чека из Phase 1 — все зелёные
npm run dev              # localhost:5000
```

Если БД пустая — bootstrap admin:

```powershell
Invoke-RestMethod -Uri "http://localhost:5000/api/auth/bootstrap" `
  -Method POST -ContentType "application/json" `
  -Body '{"email":"admin@example.com","fullName":"Admin","password":"changeme1234"}'
```

Сохрани `totpSecret` из ответа в Google Authenticator / 2FAS / 1Password.

Затем `http://localhost:5000/#/login`:
- email: `admin@example.com`
- password: `changeme1234`
- token: 6 цифр из аутентификатора

После логина — `/#/admin`. 

---

## Что увидишь

**Live-экраны (работают сразу):**
- Дашборд → `EndpointPending` (Phase 3)
- Клиенты → реальные клиенты из БД (если есть) + кнопка «Добавить клиента»
- Грузы → реальные грузы с фильтрами по equipment и PPM range
- Брокеры → реальные брокеры + кнопка «Проверить брокера» (FMCSA check)
- Документы → реальный архив с фильтрами
- Audit log → реальные события
- Backup → две кнопки скачивания JSON
- Настройки → Интеграции (read-only) + Безопасность (текущий профиль)
- Legacy дашборд → v1.2.7 целиком как было

**Phase 3 экраны (показывают баннер «после Phase 3»):**
- Пользователи + Invites (все CRUD)
- Назначения (drag-n-drop board)
- Биллинг (инвойсы)

После того как Phase 3 ИИ-бэкендер реализует endpoints — баннеры исчезнут, экраны оживут.

---

## Следующий шаг — Phase 3

1. Создать новый чат с Claude
2. Приложить:
   - `dispatchos-v1.3.1-phase2.zip` (этот архив)
   - `admin-api-spec.md` (или указать что он внутри проекта)
3. Указать промпт (см. внутренний документ `phase3-handoff.md` если он создан, иначе по
   шаблону: "Ты Claude Backend, реализуешь Phase 3 по `admin-api-spec.md`. P0 → P1 → P2 → P3 → P4.
   Не трогать `client/*`, Phase 1 contracts, cookie name.")

Бэкендер работает по `admin-api-spec.md` (35 KB спеки, 18 endpoints + signup). Когда он
закончит P0 (Users + Invites + Signup) — баннеры в Users и Assignments исчезнут.
