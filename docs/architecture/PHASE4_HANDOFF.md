# Phase 4 Handoff — Driver + Dispatcher Portals

**Кому:** AI который будет реализовывать Phase 4 в новой сессии.
**От:** Phase 3 Backend AI (текущая сессия, реализовала P0–P4 admin endpoints).
**Дата:** май 2026, после мерджа PR #5 (`phase3-backend-p3p4`) + hotfix.
**Задача:** дать тебе полный контекст так, чтобы ты не задавал клиенту (backend-разработчику) ни одного бизнес-вопроса и сразу мог кодить.

Этот документ **дополняет**, а не заменяет, исходный промпт от Founder в `docs/architecture/phase3-prompt.md`. Когда они конфликтуют — **этот документ важнее**, потому что промпт Founder писал ДО Phase 3 backend и не учёл реальный стек который сложился.

---

## 0. Самое важное на первой странице

### 0.1. Нумерация фаз — путаница, держи в голове

Founder использует разные нумерации в разных местах. Унифицируй:

| Что | Лендинг dispatchos.co | Промпт `phase3-prompt.md` | Этот handoff (правильно) |
|---|---|---|---|
| Admin portal frontend | Phase 2 | Phase 2 | Phase 2 |
| Admin portal backend | Phase 1-3 backend rewrite | Phase 1 (done) | **Phase 3** (P0–P4 в наших PR) |
| Driver + Dispatcher porталs | Phase 4-5 Portals | Phase 3 (sic) | **Phase 4** (то что ты сейчас делаешь) |
| Production launch | Phase 6 | — | Phase 5 |

В git-ветках и PR используй префикс **`phase4-`** (как было `phase3-` у Phase 3 backend). Не `phase3-driver-portal` как в промпте Founder'а — это запутает git history.

### 0.2. Что РЕАЛЬНО в репо develop сейчас

| Слой | Состояние |
|---|---|
| Backend Phase 1 (legacy v1.2.7) | ✓ Работает. Endpoints `/api/clients`, `/api/loads`, `/api/dispatch-board`, `/api/audit`, `/api/documents`, `/api/brokers`, `/api/telegram/command`, `/api/email/ingest`, `/api/integrations/status`, `/api/system/status`, `/api/portal/status`, `/api/reports/weekly`, `/api/backup/export`, `/api/health`. Auth: `/api/auth/login`, `/api/auth/bootstrap`, `/api/auth/logout`, `/api/auth/signup`, `/api/auth/status`, `/api/me`. **Не трогать кроме как additively.** |
| Backend Phase 3 admin (моя работа) | ✓ Полный — 18 endpoints под `/api/admin/*` + `/api/auth/signup`. Список в §1.3 ниже. Smoke 68/68 зелёный. |
| Frontend Phase 2 admin | ✓ 12 экранов в `client/src/pages/admin/*.tsx`. Полностью работает с backend. Тема — **зелёная** (hsl 158, primary teal), не оранжевая. Founder хочет перекраситъ — отдельная задача, не блокер. |
| Frontend Phase 4 driver | ✗ Только заглушка `PortalStub` в `client/src/App.tsx` для `/me/*`. Нужно построить. |
| Frontend Phase 4 dispatcher | ✗ Только заглушка `PortalStub` для `/dispatch/*`. Нужно построить. |
| Backend Phase 4 driver | ✗ Reserved prefix `/api/me/*`. Endpoints не реализованы. |
| Backend Phase 4 dispatcher | ✗ Reserved prefix `/api/dispatch/*`. Endpoints не реализованы. |
| Spec для Phase 4 | ⚠ Есть три файла в `docs/architecture/` (промпт + structure + design-system). Описаны ниже с реальностью. |

### 0.3. Стек — не менять

- Node 20, Express 5, TypeScript strict.
- **better-sqlite3** для persistence (НЕ Postgres, НЕ Cloudflare KV, НЕ Drizzle Postgres adapter).
- **express-session** с SQLite store. Cookie `dispatchos.sid`. **НЕ JWT.** Промпт Founder'а в этом месте устарел — см. §3.1.
- **pbkdf2** для паролей (`hashPassword` / `verifyPassword` в `server/auth.ts`).
- **TOTP (RFC 6238)** для 2FA. Secret BASE32, 6 цифр, 30s окно. `generateBase32Secret` / `buildOtpAuthUrl` / `verifyTotp` в `server/auth.ts`.
- **Zod** для валидации body. Схемы в `shared/schema.ts`.
- **React 18 + Vite** для фронта. **wouter с `useHashLocation`** — все маршруты после `#/` (см. `client/src/App.tsx`).
- **shadcn/ui + Tailwind + lucide-react** — UI блоки готовы.
- **TanStack Query** — `apiJson` helper в `client/src/lib/queryClient.ts`.

**Никаких новых зависимостей кроме крайней необходимости.** Если решишь что что-то новое нужно — спроси клиента словами «нужно npm install X потому что Y».

### 0.4. Quick-start если ты только что открыл репо

```bash
cd dispatchos-repo
npm install
npm run check    # 0 TS errors expected
npm run smoke    # 68/68 OK expected, ~30s
npm run dev      # http://127.0.0.1:5000
```

Если smoke не 68/68 — стой и разбирайся прежде чем кодить. Что-то сломано в master baseline.

---

## 1. Полная карта существующего кода

### 1.1. Структура файлов backend (актуально на момент handoff)

```
server/
├── index.ts              ─ Express app boot. Session middleware. НЕ ТРОГАТЬ.
├── auth.ts               ─ requireRole, hashPassword, verifyPassword,
│                           generateBase32Secret, buildOtpAuthUrl, verifyTotp,
│                           getCurrentUser. Эти helpers — твои друзья.
├── routes.ts             ─ Phase 1 endpoints (legacy v1.2.7) + auth + audit.
│                           1323 строк. Регистрирует registerAdminRoutes ПЕРЕД
│                           общим app.use("/api", requireRole.any()).
│                           ТЫ добавишь registerMeRoutes и registerDispatchRoutes
│                           ровно туда же.
├── routes/
│   └── admin.ts          ─ Все /api/admin/* (моя Phase 3). 1268 строк.
│                           Шаблон стиля — копируй паттерны отсюда.
│   ├── me.ts             ─ ТЫ создашь. /api/me/* (driver portal).
│   └── dispatch.ts       ─ ТЫ создашь. /api/dispatch/* (dispatcher portal).
├── storage.ts            ─ better-sqlite3 wrapper. 1872 строк. Все CRUD методы.
│                           ТЫ добавишь новые методы для signup_leads,
│                           load.driverId, expenses, issues, audit-of-driver-actions.
├── lib/
│   └── billing.ts        ─ Pure computeInvoiceForWeek (Phase 3 P2).
├── static.ts             ─ Static serving для dist/public. НЕ ТРОГАТЬ.
└── vite.ts               ─ Dev-mode Vite middleware. НЕ ТРОГАТЬ.

shared/
└── schema.ts             ─ Все Zod схемы и TypeScript типы. 654 строки.
                            ТЫ добавишь в конец новые схемы для leads, issues,
                            expenses, /api/me/dashboard responses и т.д.

scripts/
└── smoke.mjs             ─ End-to-end тесты. 1454 строки. ТЫ добавишь блок
                            P4 в конец.

client/src/
├── App.tsx               ─ Router config. РОВНО ТУТ ты заменишь PortalStub
│                           для /dispatch и /me на реальные роуты.
├── main.tsx              ─ window.location.hash инициализация. НЕ ТРОГАТЬ.
├── index.css             ─ CSS-переменные палитры. ЕСЛИ Founder хочет orange —
│                           меняешь здесь --primary, --accent. Иначе оставляешь.
├── pages/
│   ├── admin/            ─ 12 страниц (Phase 2). НЕ ТРОГАТЬ без явной задачи.
│   ├── login.tsx         ─ ⚠ В нём баг: при retry форма сбрасывает email.
│   │                       Не блокер для Phase 4, но клиент будет жаловаться.
│   │                       Документировано в §6.1.
│   ├── signup.tsx        ─ Принимает ?code=DOS-XXXX-XXXX-XXXX из URL.
│   ├── forgot-password.tsx
│   ├── not-found.tsx
│   ├── driver/           ─ ТЫ создашь. /d/*  страницы.
│   └── dispatcher/       ─ ТЫ создашь. /dp/* страницы.
├── components/
│   ├── ui/               ─ 50 shadcn компонентов. Используй их. Не дублируй.
│   ├── dispatch/         ─ 10 кастомных: DataTable, KpiCard, StatusBadge,
│   │                       RoleBadge, EmptyState, PageHeader, EndpointPending,
│   │                       ConfidenceDot, ThemeToggle, cells. Используй.
│   ├── role-gate.tsx     ─ <RoleGate allow={["dispatcher","admin"]}>…</RoleGate>
│   └── theme-provider.tsx
└── lib/
    ├── queryClient.ts    ─ apiJson<T>(method, url, body?), ApiError. Использовать
    │                       для ВСЕХ API вызовов.
    ├── use-auth.ts       ─ хук для /api/me и login state.
    ├── format.ts         ─ formatMoney, formatMoneyCents, formatRelativeAgo,
    │                       formatDateFull. Использовать.
    ├── density.tsx       ─ density mode для таблиц.
    ├── use-clipboard.ts  ─ copy-to-clipboard helper.
    ├── design-tokens.ts  ─ TS-типизированные токены.
    └── utils.ts          ─ cn() для className merging.

docs/
├── api/
│   └── admin-api-spec.md ─ Phase 3 admin спека от Founder. §11 содержит
│                           контракт POST /api/loads/:id/book как Phase 4 hook.
└── architecture/
    ├── design-system.md     ─ Палитра + tokens от Founder (16 мая).
    ├── phase3-prompt.md     ─ AI промпт от Founder. Часть полей УСТАРЕЛА.
    ├── phase3-structure.md  ─ Структура экранов Phase 4 от Founder.
    ├── role-matrix.md       ─ Роли + permissions (Phase 0).
    └── migration-plan.md    ─ План миграции (Phase 0).
```

### 1.2. Список ВСЕХ существующих endpoints (что НЕ переделывать)

#### Auth (`/api/auth/*`)
- `POST /api/auth/bootstrap` — создать первого admin. Response: `{ id, email, totpSecret, otpauthUrl, message }`. Refuses second call (409).
- `POST /api/auth/setup` — legacy alias на bootstrap.
- `POST /api/auth/login` — body `{ email, password, token? }`. Response success `{ ok, role, redirect }`. **Этот shape ЗАМОРОЖЕН** — фронт login.tsx и use-auth полагаются. На bad creds: 401 `{ message }`. На required-TOTP: 401 с message.
- `POST /api/auth/logout` — destroys session. Response `{ ok: true }`.
- `POST /api/auth/signup` — consume invite + create user + auto-login. Body `{ inviteCode, email, fullName, password }`. Response `{ id, email, role, totpSecret, otpauthUrl, redirect }`. **Phase 4: используй эту же модель для magic-link signup.** См. §3.2.
- `GET /api/auth/status` — quick state.
- `GET /api/me` — UserPublic shape: `{ id, email, fullName, role, blocked, twoFactorEnabled, assignedClientIds?, linkedClientId?, createdAt, updatedAt, lastLoginAt? }`. **Shape ЗАМОРОЖЕН.** Driver dashboard `GET /api/me/dashboard` — это **другой** endpoint, не путать.

#### Admin (`/api/admin/*` — моя Phase 3, не трогать)
P0:
- `GET /api/admin/users?limit&cursor&role&blocked&q` → `{ items, nextCursor, hasMore, total }`
- `POST /api/admin/users` → 201 UserPublic
- `GET /api/admin/users/:id`
- `PATCH /api/admin/users/:id`
- `POST /api/admin/invites` → `{ code, role, email, expiresAt, linkedClientId, createdAt, signupUrl }`
- `GET /api/admin/invites?status=active|expired|consumed|all&role&limit&cursor`

P1:
- `POST /api/admin/users/:id/reset-password` body `{ length? }` → `{ temporaryPassword, userId, email }` (one-shot)
- `POST /api/admin/users/:id/reset-totp` body `{ disable }` → discriminated `{ userId, totpSecret, otpauthUrl }` or `{ userId, totpDisabled: true }`
- `DELETE /api/admin/invites/:code` → 200 / 404 / 409 (already consumed)
- `GET /api/admin/assignments?dispatcherId&clientId&includeRemoved&limit&cursor`
- `POST /api/admin/assignments` body `{ clientId, dispatcherUserId }` → 201 / 409 `{ message, code: "duplicate_active" }`
- `DELETE /api/admin/assignments/:id` → 200 with `removedAt` filled / 409 (already removed)

P2 billing:
- `POST /api/admin/billing/preview` body `{ clientId, weekStart, weekEnd }` → `{ id:null, status:null, generatedAt:null, ...calc, breakdown: { loadCount, loads:[…] } }`
- `POST /api/admin/billing/generate` body `{ clientId, weekStart, weekEnd, status? }` → 201 Invoice / 409 `{ existingInvoiceId }`
- `GET /api/admin/billing/invoices?clientId&status&weekStart&weekEnd&limit&cursor`
- `PATCH /api/admin/billing/invoices/:id` body `{ status?, notes? }` → updated Invoice / 409 `{ from, to }`

P3:
- `GET /api/admin/dashboard/stats?period=week|month` → `{ mrr, users, loads, audit, integrations, system }` (см. dashboardStatsSchema)

P4:
- `GET /api/audit` — **DUAL MODE**: без query params → legacy `Event[]`; с любым из `{limit, cursor, eventType, entityType, actorId, entityId, since, until}` → `{ items, nextCursor, hasMore, total }` с `actorUserId` + `actorEmail` enrichment.

#### Phase 1 legacy (не ломать, можно расширять additively)
- `GET /api/clients`, `POST /api/clients`, `PATCH /api/clients/:id/location`
- `GET /api/loads` — список ВСЕХ загрузок. **Phase 4 предупреждение:** dispatcher НЕ должен иметь доступ к этому endpoint напрямую, только через `/api/dispatch/feed` с tenant scoping. Если фронт-Phase-2 куда-то его дёргает — оставь, это legacy admin использует.
- `POST /api/loads` — теперь принимает `clientId?` и `bookedAt?` (P2 extension).
- `POST /api/loads/import-csv`
- `GET /api/dispatch-board?clientId=…` — Phase 1 location-aware scoring. Это **другой** endpoint, не `/api/dispatch/dashboard` (твой Phase 4).
- `GET /api/audit`, `GET /api/backup/export`
- `POST /api/broker/check`, `GET /api/brokers`
- `POST /api/documents`, `POST /api/documents/upload`, `GET /api/documents`
- `POST /api/telegram/command` (принимает `/loc lat,lng`, `/yes`, `/no`, `/nego`)
- `POST /api/email/ingest`, `GET /api/email/ingest`
- `GET /api/drive/folder-plan`, `POST /api/drive/create-local-folders`
- `GET /api/integrations/status`, `GET /api/system/status`, `GET /api/portal/status`
- `GET /api/reports/weekly?clientId=…`
- `GET /api/health`

### 1.3. Что есть в storage.ts (методы которые ты будешь звать)

```typescript
// Users
storage.getUserById(id)              → UserInternal | undefined
storage.getUserByEmail(email)
storage.listUsers({ role?, includeBlocked? })  // sorted ASC by created_at
storage.listUsersPaginated({ limit?, cursor?, role?, blocked?, q? })
storage.toUserPublic(internal)       → UserPublic (strips secrets)
storage.createUser({...})            → UserInternal (audit "user.created")
storage.updateUser(id, patch, actorId)
storage.recordUserLogin(userId)

// Clients
storage.getClient(id), listClients(), insertClient(...)
storage.patchClientLocation(id, location)

// Loads
storage.getLoad(id), listLoads(), upsertLoad({...})
storage.listLoadsCreatedSince(iso)
storage.listBookedLoadsForClientWeek(clientId, weekStart, weekEnd)
storage.countLoadsSince(iso)
storage.grossBookedInWindow(weekStart, weekEnd)
// NB: load.clientId и load.bookedAt уже в схеме (P2). load.driverId — ДОБАВИШЬ ТЫ.

// Invites
storage.getInvite(code), listInvites({ includeConsumed? })
storage.createInviteWithCode({...})   // Phase 3 path — даёт DOS-XXXX-XXXX-XXXX код
storage.consumeInvite(code, userId)
storage.revokeInvite(code, revokedById)
storage.listInvitesPaginated({...})

// Assignments (dispatcher ↔ client M:N)
storage.getAssignmentById(id)
storage.findActiveAssignment(clientId, dispatcherUserId)
storage.createAssignment({clientId, dispatcherUserId, createdByUserId})
storage.removeAssignmentById(id, actorId)
storage.listAssignmentsPaginated({...})
storage.listAllActiveAssignments()    // ← ТЕБЕ ПРИГОДИТСЯ для dispatcher scoping

// Invoices
storage.getInvoice(id), findInvoiceForWeek(clientId, weekStart)
storage.createInvoice({...}), updateInvoice(id, {status?, notes?})
storage.listInvoicesPaginated({...})

// Documents
storage.getDocument(id), listDocuments(), insertDocument({...})

// Audit
storage.audit(eventType, entityType, entityId, payload)
storage.listAuditEvents(limit?)
storage.listAuditEventsPaginated({...})
storage.countAuditEventsSince(iso), countErrorEventsSince(iso)
storage.lastAuditEventAt()

// Brokers
storage.getBrokerByMc(mc), upsertBroker({...}), listBrokers()

// Backup
storage.exportBackup({ redacted? })
```

**Шаблон для добавления нового storage метода:** см. как сделан `removeAssignmentById` — он возвращает discriminated union `{notFound:true} | {alreadyRemoved:true} | {assignment}`, route layer мапит на HTTP 404/409/200. Это **рекомендуемый паттерн**.

### 1.4. Что есть в shared/schema.ts (использовать, не переопределять)

```
// Roles
userRoleSchema, UserRole

// User shapes
userPublicSchema, UserPublic        // ← shape /api/me. Заморожен.
createUserSchema, updateUserSchema
loginSchema, bootstrapSchema, signupSchema, signupResponseSchema

// Invites
inviteSchema, createInviteSchema

// Assignments
assignmentSchema, createAssignmentSchema

// Loads (Phase 1 + P2 extension)
loadSchema, insertLoadSchema                    // Phase 1 — узкий
loadBookingFieldsSchema { clientId?, bookedAt? }
loadWithBookingSchema, insertLoadWithBookingSchema  // P2 — strict superset

// Invoices
invoiceStatusSchema, invoiceSchema, invoicePreviewSchema, generateInvoiceSchema
patchInvoiceSchema

// Clients
clientSchema, insertClientSchema, clientStatusSchema, equipmentSchema

// Documents
documentSchema, documentTypeSchema, documentStatusSchema

// Drivers
driverLocationSchema, updateLocationSchema, locationSourceSchema

// Dashboard
dashboardStatsSchema, DashboardStats           // /api/admin/dashboard/stats

// Pagination
paginatedResponseSchema (generic)
auditEventSchema, auditFilterSchema

// Utilities
dateOnlySchema           // ^\d{4}-\d{2}-\d{2}$ regex — переиспользуй для bookedAt, weekStart и т.д.
```

**Phase 4 ТЫ добавишь** (в конец файла, в новый блок «PHASE 4 ADDITIONS»):
- `signupLeadSchema` — лид с лендинга
- `createIssueSchema`, `issueSchema`
- `createExpenseSchema`, `expenseSchema`
- `driverStatusSchema` enum `available | on_route | off_duty`
- `driverDashboardSchema` — shape `GET /api/me/dashboard`
- `dispatchDashboardSchema` — shape `GET /api/dispatch/dashboard`
- `loadStatusSchema` enum `available | booked | in_transit | at_delivery | delivered | cancelled`
- `bookLoadSchema` body для `POST /api/dispatch/loads/:id/book`
- `counterOfferSchema` для `POST /api/dispatch/loads/:id/counter`

Все **additive в конец**. Phase 1-3 типы НЕ переписывать.

### 1.5. shadcn UI компоненты — что у тебя есть

`client/src/components/ui/`:
accordion, alert-dialog, alert, aspect-ratio, avatar, badge, breadcrumb, button, calendar, card, carousel, chart, checkbox, collapsible, command, context-menu, dialog, drawer, dropdown-menu, form, hover-card, input-otp, input, label, menubar, navigation-menu, pagination, popover, progress, radio-group, resizable, scroll-area, select, separator, sheet, sidebar, skeleton, slider, switch, table, tabs, textarea, toast, toaster, toggle-group, toggle, tooltip.

**Driver portal — что переиспользовать:**
- `Card` + `Button` (mobile-large variant) для status card на /d
- `Dialog` или `Drawer` (на mobile predпочесть Drawer) для action sheets
- `Tabs` для bottom-nav на /d
- `Avatar` для driver profile
- `Input` + `Form` для profile edit
- `Skeleton` для loading state
- `Toast` (через `useToast`) для feedback

**Dispatcher portal — что переиспользовать:**
- `Sidebar` (готовый компонент!) для left-rail с клиентами
- `Table` + `DataTable` (кастомный из `dispatch/`) для loads list
- `Tabs` для Pipeline / Active / Approvals 3-column
- `Sheet` для side-panel deталей
- `Command` (cmd-k поиск) для global search
- `DropdownMenu` для row actions

**Кастомные из `dispatch/`:**
- `KpiCard` — для метрик в driver dashboard и dispatcher header
- `StatusBadge` — для статусов loads/drivers (зелёный/жёлтый/красный)
- `RoleBadge` — для отображения роли в profile
- `PageHeader` — стандартный header страницы
- `EmptyState` — когда нет данных
- `EndpointPending` — баннер «endpoint не реализован» (для постепенной разработки)
- `DataTable` — generic с pagination

---

## 2. Конкретные решения для Phase 4 (приняты с клиентом)

В исходной сессии я предложил клиенту 7 дефолтов. Клиент **подтвердил все 7**. Вот они с обоснованием — НЕ переспрашивай у клиента, он на них уже сказал «ок».

### 2.1. Auth: session (НЕ JWT)

Промпт Founder'а в `phase3-prompt.md` строка ~34 говорит «JWT in httpOnly cookie». **Игнорируй.** Реально у нас:
- Session cookie `dispatchos.sid` (express-session + SQLite store).
- TOTP secret в users таблице, проверка через `verifyTotp(secret, token)`.
- `requireRole('admin' | 'dispatcher' | 'driver')` и `requireRole.any()` в `server/auth.ts`.

Использовать как есть. Не вводить JWT. Не вводить refresh tokens. Если когда-нибудь Founder скажет «нужен JWT» — это отдельная Phase, оценка ~1 неделя.

### 2.2. API response shape: плоский

Промпт Founder'а строка ~76 говорит `{ ok: true, data: ... }`. **Игнорируй.** Реальный паттерн:

- Success: плоский объект или массив. Например `{ id, email, role, totpSecret, otpauthUrl, redirect }` для signup. Или массив `[{...}, {...}]` для legacy GET /api/audit без query.
- Pagination: `{ items, nextCursor, hasMore, total }`.
- Error 4xx/5xx: `{ message }` или `{ message, issues:[{path,message}] }` (Zod) или `{ message, code: "duplicate_active", ... }`.
- Conflict 409 с context: добавляй полезные поля, например `{ message, existingInvoiceId }` или `{ message, from, to }`.

Никогда не оборачивать в `{ ok, data }`. Существующие 50+ endpoints все плоские, фронт ждёт плоские, не ломай.

### 2.3. Signup leads: SQLite

Промпт Founder'а упоминает «KV SUBSCRIBERS namespace». У нас Cloudflare KV нет — стек только SQLite. Создай таблицу `signup_leads`:

```sql
CREATE TABLE IF NOT EXISTS signup_leads (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  lang TEXT,                    -- "ua" | "ru" | "en"
  country TEXT,                 -- ISO-2 if known
  user_agent TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- "pending" | "approved" | "rejected" | "spam"
  approved_invite_code TEXT,    -- nullable, links to invites.code когда approved
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by_user_id TEXT
);

CREATE INDEX IF NOT EXISTS signup_leads_status_idx ON signup_leads(status, created_at DESC);
```

Endpoint:
- `POST /api/public/subscribe` body `{ email, lang? }` — **БЕЗ requireRole, ПУБЛИЧНЫЙ**. Регистрируется ДО `app.use("/api", requireRole.any())` gate в routes.ts. Дедуп по email (если уже есть pending — 200 с тем же id, не создавать дубль). Rate-limit можно отложить.
- `GET /api/dispatch/leads?status=pending&limit=50` — dispatcher видит lead'ы. requireRole `['dispatcher','admin']`.
- `POST /api/dispatch/leads/:id/approve` body `{ role: 'driver'|'dispatcher', linkedClientId? }` — создаёт invite через `storage.createInviteWithCode` (он уже есть), записывает в lead `status='approved'` + `approved_invite_code`, возвращает `{ leadId, invite: { code, signupUrl, expiresAt } }`. **Реальный email — НЕ слать (см. §2.4).**
- `POST /api/dispatch/leads/:id/reject` body `{ reason? }` — `status='rejected'`.
- `POST /api/dispatch/leads/:id/spam` — `status='spam'` (для будущей фильтрации спама).

### 2.4. Email magic-link: STUB

Промпт говорит «Cloudflare Email Routing → noreply@dispatchos.co». У нас email-стека нет. Делай так:

- `POST /api/dispatch/leads/:id/approve` создаёт invite (как в §2.3) и возвращает **signupUrl в ответе админу**, точно как `POST /api/admin/invites` уже делает в Phase 3.
- Dispatcher **копирует URL** и шлёт driver'у вручную (Telegram, WhatsApp, SMS — что использует).
- Никакой fetch на SendGrid / Mailgun / Cloudflare. Никакой queue.
- В audit логе пишется `lead.approved` с payload `{ leadId, inviteCode, role, approvedByUserId }`.

Когда Founder захочет реальный email — это отдельная задача +1-2 дня (выбрать провайдер, добавить env vars, шаблон письма, error handling).

### 2.5. Click-to-call (Twilio): SKIP

Кнопка «Позвонить диспетчеру» на driver dashboard:
```html
<a href={`tel:${dispatcherPhone}`}>Позвонить диспетчеру</a>
```
Native phone link. Без Twilio. Поле `phone` добавь опционально в users таблицу (миграция через PRAGMA pattern из §3.5).

### 2.6. Push notifications: SKIP

Driver polling `GET /api/me/dashboard` каждые 30 секунд через TanStack Query `refetchInterval`. Web Push / Service Worker — Phase 5+.

### 2.7. Onboarding документы (CDL/COI/W9): SOFT

Driver после signup может загрузить документы через `POST /api/me/documents`. Если документов нет — driver **виден диспетчеру**, но в pipeline помечен жёлтым «нет документов». Жёсткого block нет.

Реализация:
- `POST /api/me/documents` принимает multipart, image или PDF, поле `type` = `cdl | medical | coi | w9`.
- `GET /api/me/documents` возвращает мои документы.
- В `GET /api/dispatch/clients/:id` (где client — это driver через linkedClientId) поле `hasRequiredDocs: boolean` или `missingDocs: string[]`.
- Dispatcher dashboard tile «Approvals & Alerts» включает «У водителя X нет документа Y, истёк документ Z за 30 дней».

---

## 3. План Phase 4 — поэтапно

5 PR'ов в порядке очереди. Каждый — отдельная ветка от свежего `develop`. Каждый — самостоятельный PR на review клиенту. **Не пытайся делать всё в одном PR — клиент в Phase 3 настоял на постепенности.**

### 3.1. PR #1 — `phase4-driver-p0` (driver MVP backend + минимальный UI)

**Цель:** driver залогинен, видит свои грузы, может перейти в детальный экран. Без upload, без issues, без expenses.

**Backend:**
- Новый файл `server/routes/me.ts`. В нём `registerMeRoutes(app)`.
- Регистрация в `server/routes.ts` рядом с `registerAdminRoutes` (но ПОСЛЕ — порядок не важен, оба идут до общего gate).
- Endpoints:
  - `GET /api/me/dashboard` (requireRole `driver`) → агрегат всё для главного экрана. Shape:
    ```typescript
    {
      driver: { id, fullName, email, phone?, status: "available"|"on_route"|"off_duty" },
      currentLoad: Load | null,         // load.driverId == self.id AND status in ['booked','in_transit','at_delivery']
      todayPickup: { time, address, contact } | null,
      todayDelivery: { time, address, contact } | null,
      recentLoads: Load[3],             // последние 3 завершённых
      hasUnreadMessages: boolean,
      pendingDocs: { type, expiresAt }[],  // документы которые надо обновить
    }
    ```
  - `GET /api/me/loads?status=&limit=&cursor=` → cursor pagination. Scope: `loads.driver_id = self.id`.
  - `GET /api/me/loads/:id` → 404 если load.driver_id !== self.id (no leaking).
  - `POST /api/me/status` body `{ status: "available"|"on_route"|"off_duty" }` → updated User. Audit `driver.status_changed`.

- Storage extensions:
  - В loads таблице добавить колонку `driver_id TEXT` через `ensureLoadColumns()` (паттерн как в P2 hotfix — ALTER до создания индекса).
  - Добавить колонку `phone TEXT` в users.
  - Метод `storage.listLoadsForDriver(driverId, {limit, cursor, status?})`.
  - Метод `storage.updateLoadDriver(loadId, driverId, bookedByUserId)` — для dispatcher booking, но тут пока не зовётся.
  - Метод `storage.updateUserStatus(userId, status)` — простой UPDATE.

- Index: `CREATE INDEX IF NOT EXISTS loads_driver_id_idx ON loads(driver_id, created_at DESC);`

- Schema additions (в конец `shared/schema.ts`):
  - `driverStatusSchema = z.enum(["available","on_route","off_duty"])`
  - `loadStatusSchema = z.enum(["available","booked","in_transit","at_delivery","delivered","cancelled"])`
  - `driverDashboardSchema`
  - `updateDriverStatusSchema`

**Frontend:**
- `client/src/pages/driver/` — новая директория.
- Файлы:
  - `_shell.tsx` — общий layout: top bar с logo+menu, main, bottom nav. Mobile-first, max-width 720px центрирован.
  - `dashboard.tsx` (роут `/d`) — статус карточка + currentLoad + todayPanel + recent + 4 quick-action кнопки (заглушки кроме «Позвонить» — она работает через `tel:`).
  - `loads-list.tsx` (роут `/d/loads`) — список всех моих загрузок, сортировка по дате DESC.
  - `load-detail.tsx` (роут `/d/loads/:id`) — детали + кнопки (на P0 кнопки заглушки).
  - `profile.tsx` (роут `/d/profile`) — email, name, phone, language, кнопка Logout.
- `client/src/App.tsx`:
  ```tsx
  <Route path="/d" nest>
    <RoleGate allow={["driver"]}>
      <DriverShell>
        <Switch>
          <Route path="/" component={DriverDashboard} />
          <Route path="/loads" component={DriverLoadsList} />
          <Route path="/loads/:id" component={DriverLoadDetail} />
          <Route path="/profile" component={DriverProfile} />
        </Switch>
      </DriverShell>
    </RoleGate>
  </Route>
  ```
  Заменяя существующий `<Route path="/me" nest>...PortalStub...</Route>`. **Внимание:** клиент использовал `/me` в App.tsx, Founder в промпте говорит `/d` — выбери одно. **Рекомендую `/d`** (как в промпте Founder'а), и в `/api/auth/login` redirect для role=driver уже `"/me"` — обнови на `"/d"` в server/routes.ts и фронт onLogin. ОДНО изменение в 2 местах, не ломает Phase 1.

- redirect после login: `/api/auth/login` для role=driver возвращает `redirect: "/d"` (сейчас `"/me"`). Поменяй в `server/routes.ts`.

**Smoke (добавь блок в конец `scripts/smoke.mjs`):**
- Создать invite role=driver linkedClientId=ivan-enclosed-01
- Signup как driver
- `GET /api/me/dashboard` под driver session — проверить shape, status, recentLoads array
- `GET /api/me/loads` — изначально пустой
- Создать load с driverId=driver.id, проверить что появился в `/api/me/loads`
- Другой driver (создать второго) НЕ видит первого driver'а loads — 0 leakage
- `POST /api/me/status` — status меняется
- admin делает PATCH /api/admin/users/:id чтобы driver не мог сам себе менять role (role не в schema /api/me/status, нет такого пути)

**Файлы которые ты МЕНЯЕШЬ в этом PR:**
- `shared/schema.ts` (+~80 строк additive)
- `server/storage.ts` (+~100 строк: 2 миграции колонок, 3 метода)
- `server/routes.ts` (~10 строк изменений: импорт + регистрация + login redirect)
- `server/routes/me.ts` (новый файл, ~250 строк)
- `client/src/App.tsx` (~20 строк изменений)
- `client/src/pages/driver/*.tsx` (5 файлов, ~500 строк суммарно)
- `scripts/smoke.mjs` (+~100 строк)

**Ожидание:** ~1000 строк кода. Smoke 68 → ~75 OK.

### 3.2. PR #2 — `phase4-driver-p1` (полный driver portal)

**Добавляет:**
- `POST /api/me/loads/:id/checkin` body `{ lat, lng, timestamp? }` — записывает локацию, audit `driver.checkin`.
- `POST /api/me/loads/:id/pod` multipart, image (compress на фронте до <2MB). Реюз `multer` (уже в deps).
- `POST /api/me/expenses` multipart, image + `{ amount, category, loadId?, description? }` — audit `driver.expense_filed`.
- `POST /api/me/issue` body `{ type: 'breakdown'|'accident'|'broker_dispute'|'other', description, loadId? }` → создаёт **approval task** для dispatcher (новая таблица `approval_tasks`).
- `GET /api/me/documents` + `POST /api/me/documents` (multipart).
- `PATCH /api/me/profile` body `{ fullName?, phone?, language? }`.

**Новые таблицы:**
- `expenses (id, driver_user_id, load_id, amount_usd, category, description, photo_doc_id, created_at)`
- `issues (id, driver_user_id, load_id, type, description, status, created_at, resolved_at)`
- `approval_tasks (id, kind, source_id, status, created_at, resolved_at)` — единая таблица для issues, broker fraud flags, expiring docs, etc. status `pending|resolved|escalated|snoozed`.

**Frontend:**
- `/d/loads/:id/pod` — фото upload с `<input type="file" capture="environment">`.
- `/d/expenses` (или модал) — форма expense.
- `/d/issues/new` — форма issue.
- `/d/documents` — таблица: тип, статус, expiresAt, кнопка upload.

**Smoke:** проверки на POD upload (multipart), expense с photo, issue создаёт approval_task, documents list/upload.

### 3.3. PR #3 — `phase4-dispatcher-p0` (dispatcher MVP backend + UI)

**Цель:** dispatcher видит свою тройную колонку (Pipeline / Active / Approvals), может Book/Counter/Skip на грузах, видит assigned клиентов.

**Backend:**
- Новый файл `server/routes/dispatch.ts`, экспортирует `registerDispatchRoutes(app)`.
- Endpoints:
  - `GET /api/dispatch/dashboard` (requireRole `['dispatcher','admin']`) → агрегат для главного экрана. Scope через assignments. Shape:
    ```typescript
    {
      myClients: [{ id, name, status, currentLoad? }],
      pipeline: ScoredLoad[],          // suggestions
      activeLoads: Load[],             // status in ['booked','in_transit','at_delivery']
      approvals: ApprovalTask[],
      counts: { pipeline, active, approvals }
    }
    ```
  - `GET /api/dispatch/feed?clientId?&limit&cursor` — feed загрузок по своим клиентам. Если clientId передан и НЕ в моих assignments → 403. Иначе все loads где `clientId` в моих assignments AND status='available'.
  - `GET /api/dispatch/suggestions` — на P0 возвращает заглушку (re-rank loads через существующий `scoreLoadForClient` из `server/routes.ts`). Phase 5 — реальный AI.
  - `POST /api/dispatch/loads/:id/book` body `{ driverId? }` — это РЕАЛИЗАЦИЯ Phase 4 hook из `admin-api-spec.md` §11. Логика:
    - 404 если load не существует
    - 403 если load.clientId не в моих assignments
    - 409 если load.driverId уже установлен и !== body.driverId → `{ code:"already_booked_for_other_driver" }`
    - 200 idempotent если load.driverId === body.driverId
    - Иначе UPDATE clientId+driverId+bookedAt+status='booked', audit `load.booked`
  - `POST /api/dispatch/loads/:id/counter` body `{ counterRate, note? }` — отправляет counter-offer (audit, не блокер).
  - `GET /api/dispatch/clients` — мои assignments expanded с client data.
  - `GET /api/dispatch/clients/:id` — детали клиента, его loads, drivers, performance.
  - `GET /api/dispatch/approvals` — approval_tasks для моих клиентов.
  - `POST /api/dispatch/approvals/:id/resolve` body `{ resolution? }`.
  - `GET /api/dispatch/alerts` — combined: expiring docs, fraud flags, driver issues, system warnings.

- **CRITICAL — tenant scoping паттерн.** Создай helper в начале `server/routes/dispatch.ts`:
  ```typescript
  /**
   * Returns the set of client_ids the current dispatcher has active assignments to.
   * Admins see ALL clients. Throws if user is not dispatcher/admin (но requireRole
   * already enforces).
   */
  function getScopedClientIds(req: Request): Set<string> {
    const user = getCurrentUser(req)!;
    if (user.role === 'admin') {
      return new Set(storage.listClients().map(c => c.id));
    }
    const assignments = storage.listAllActiveAssignments();
    return new Set(
      assignments
        .filter(a => a.dispatcherUserId === user.id)
        .map(a => a.clientId)
    );
  }
  ```
  Вызывай в КАЖДОМ endpoint и фильтруй данные через `if (!scopedClientIds.has(load.clientId)) return res.status(403)...` или `loads.filter(l => scopedClientIds.has(l.clientId))`.

**Frontend:**
- `client/src/pages/dispatcher/` — новая директория.
- Файлы:
  - `_shell.tsx` — desktop-layout, left sidebar 240px + main + top bar 56px.
  - `dashboard.tsx` (`/dp`) — 3-column layout с TanStack Query (refetchInterval=30000 для real-time).
  - `client-detail.tsx` (`/dp/clients/:id`).
- `client/src/App.tsx`:
  ```tsx
  <Route path="/dp" nest>
    <RoleGate allow={["dispatcher","admin"]}>
      <DispatcherShell>
        ...
      </DispatcherShell>
    </RoleGate>
  </Route>
  ```
  Заменяя существующий `<Route path="/dispatch" nest>`. login redirect для role=dispatcher с `/dispatch` на `/dp`.

**Smoke:** invite dispatcher, signup, assignment Ivan↔dispatcher через admin, `GET /api/dispatch/dashboard` под dispatcher, попытка POST /api/dispatch/loads/:id/book на load НЕ моего клиента → 403, book → success, idempotent re-book → 200, conflict re-book для другого driver → 409.

### 3.4. PR #4 — `phase4-dispatcher-p1` (polish dispatcher)

- Counter-offer flow с UI
- Approvals resolve/escalate/snooze
- Messages (если совсем простой thread — добавь endpoints `/api/dispatch/messages`, иначе перенеси в Phase 5)
- Alerts dashboard
- Global search (`Command` shadcn компонент)

### 3.5. PR #5 — `phase4-hybrid-signup` (lead-based onboarding)

Реализует §2.3 + §2.4. Создаёт публичный `POST /api/public/subscribe`, dispatcher tab `/dp/leads`, approve flow возвращает signupUrl админу.

После этого PR — Phase 4 deliverable complete. Можно объединить с PR #4 если объём небольшой.

---

## 4. Стилевые правила (из design-system.md от Founder)

### 4.1. Палитра — что менять и что нет

Founder хочет переход с **зелёной** (current Phase 2) на **оранжевую**:

| Token | Сейчас (Phase 2) | Founder хочет |
|---|---|---|
| `--primary` HSL | 158 64% 40% (teal/green) | hue 38, sat ~92%, lightness ~50% = `#f59e0b` orange |
| `--ring` | 158 64% 40% | 38 92% 50% |
| `--background` (dark) | 222 47% 7% | 222 47% 4% = `#0a0e1a` (чуть темнее) |

**Решение:** В Phase 4 driver/dispatcher страницах **сразу пиши** с оранжевыми токенами. В `index.css` добавь **новую `.dark` секцию** с orange palette, и Phase 4 routes её используют через `<div className="dark">` wrapper, либо переключи **глобально** в дефолте `:root` если согласен с клиентом перекрасить и админку.

Если клиент скажет «не перекрашивай админку, орандж только в driver/dispatcher» — оберни `DriverShell` и `DispatcherShell` в `<div className="dark theme-orange">`. Это локальный override.

### 4.2. Шрифты

- `Inter` для body — уже подключён через `<link>` в `index.css`.
- `JetBrains Mono` для $/PPM/MC/IDs — уже подключён.
- На driver mobile **минимум 16px** для body (`text-lg` в текущем tailwind config = 16px/24px) — это требование (читать в кабине грузовика).

### 4.3. Touch targets

Driver mobile — минимум 44px высоты для interactive elements. shadcn `Button size="lg"` = 48px — используй везде на driver mobile.

### 4.4. Иконки

`lucide-react` уже в deps. Стандартные:
- Driver dashboard: `Truck` для status, `MapPin` для location, `Phone` для call, `Camera` для POD upload, `DollarSign` для expense, `AlertTriangle` для issue.
- Dispatcher: `Users` для clients, `Inbox` для approvals, `Bell` для alerts, `Search` для global search.

---

## 5. Smoke test шаблоны

В `scripts/smoke.mjs` каждый Phase 4 блок выглядит так (псевдокод):

```javascript
// -------------------------------------------------------------------------
// Phase 4 — driver P0
// -------------------------------------------------------------------------

// 1. As admin, create driver invite linked to ivan-enclosed-01
const driverInvite = await request("/api/admin/invites", {
  method: "POST",
  body: { role: "driver", ttlHours: 24, linkedClientId: "ivan-enclosed-01" },
});

// 2. Switch to fresh cookie jar, signup as that driver
const adminCookieHeader = cookieHeader;
cookieHeader = "";
const driverSignup = await request("/api/auth/signup", {
  method: "POST",
  body: {
    inviteCode: driverInvite.code,
    email: "smoke.driver@example.com",
    fullName: "Smoke Driver",
    password: "SmokeDriver1!",
  },
});
if (driverSignup.role !== "driver") throw new Error(...);
if (driverSignup.redirect !== "/d") throw new Error(`expected redirect=/d, got ${driverSignup.redirect}`);

// 3. As driver, hit /api/me/dashboard
const dash = await request("/api/me/dashboard");
if (!dash.driver || dash.driver.id !== driverSignup.id) throw new Error(...);
if (!Array.isArray(dash.recentLoads)) throw new Error(...);

// 4. /api/me/loads — should be empty
const myLoads = await request("/api/me/loads");
if (myLoads.items.length !== 0) throw new Error(...);

// 5. Back to admin session — create a load for this driver
cookieHeader = adminCookieHeader;
const load = await request("/api/loads", {
  method: "POST",
  body: makeBookableLoad({
    rate: 1200,
    bookedAt: "2026-05-15",
    clientId: "ivan-enclosed-01",
    driverId: driverSignup.id,  // ← P4 P0 extension
  }),
});

// 6. Driver should now see it
cookieHeader = driverCookieHeader; // (saved similarly to adminCookieHeader above)
const myLoadsAfter = await request("/api/me/loads");
if (!myLoadsAfter.items.some(l => l.id === load.id)) throw new Error("driver did not see assigned load");

// 7. Cross-driver leakage check — create a SECOND driver, ensure they DON'T see first driver's load
// ... [more code]

console.log("[OK] driver P0 full flow");
```

Реюз helpers из существующего smoke (`request`, `cookieHeader`, `makeBookableLoad`).

---

## 6. Известные подводные камни

### 6.1. Login form bug (фронт Phase 2)

`client/src/pages/login.tsx` имеет баг: при первом submit с email+password (без TOTP) сервер требует TOTP, фронт показывает поле кода — **но при этом сбрасывает поле email на placeholder**. Это **визуальный баг**, форма уже без email, при повторном submit идёт 401.

**Workaround для тестирования:** клиент в Phase 3 логинился через PowerShell + cookie injection. У тебя это уже не должно быть проблемой если ты не трогаешь login.tsx — но если фронт driver/dispatcher unaffectedly работает после login, баг остаётся.

**Не блокер для Phase 4.** Фикс — отдельная задача. Если возьмёшься — корень проблемы в controlled input state в `login.tsx`, после первого 401 React сбрасывает value до default. Поправить: явно держать email/password в useState от первого submit, не reset.

### 6.2. Hash routing — критически важно

Все маршруты — после `#/`. URL:
- `http://127.0.0.1:5000/#/admin/users` (НЕ `/admin/users`)
- `http://127.0.0.1:5000/#/d/loads` (НЕ `/d/loads`)
- `http://127.0.0.1:5000/#/signup?code=DOS-XXXX-XXXX-XXXX` (НЕ `/signup?...`)

`useHashLocation` из `wouter/use-hash-location`. Для всех `signupUrl` в API ответах используй:
```typescript
function buildSignupUrl(req: Request, code: string): string {
  const envUrl = (process.env.DISPATCHOS_PUBLIC_URL || "").trim();
  const base = envUrl ? envUrl.replace(/\/+$/, "") : `${req.protocol}://${req.get("host")||"localhost:5000"}`;
  return `${base}/#/signup?code=${encodeURIComponent(code)}`;
}
```
(Этот helper уже есть в `server/routes/admin.ts`, можно скопировать или экспортировать.)

### 6.3. Date-only формат

`bookedAt`, `weekStart`, `weekEnd` — все `YYYY-MM-DD` без времени. `dateOnlySchema` в shared/schema валидирует regex. Сравнение строковое (ISO 8601 lexicographic).

**НЕ использовать `Date.now()` для bookedAt.** Преобразуй явно:
```typescript
const today = new Date().toISOString().slice(0, 10);  // "2026-05-17"
```

### 6.4. Window для better-sqlite3

В dev окружении на Windows ALTER TABLE требует **существующей колонки checked first via PRAGMA**. См. P2 hotfix в `server/storage.ts`:

```typescript
function ensureLoadBookingColumns() {
  const cols = sqlite.prepare("PRAGMA table_info(loads)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("client_id")) {
    sqlite.exec("ALTER TABLE loads ADD COLUMN client_id TEXT");
  }
  // ...
}
ensureLoadBookingColumns();

// And CREATE INDEX must come AFTER this migration:
sqlite.exec("CREATE INDEX IF NOT EXISTS loads_client_booked_idx ON loads(client_id, booked_at)");
```

**Для Phase 4 — следуй тому же паттерну.** Любые ALTER + новые индексы выноси в отдельный `ensureX()` блок ПОСЛЕ основного `sqlite.exec(\`CREATE TABLE...\`)`, и **CREATE INDEX ставь после ALTER**, не внутри основного блока. Это спасает от падения dev-сервера на существующих БД.

### 6.5. Артефакты smoke и .gitignore

Каждый smoke run создаёт `smoke-${ts}.db*` файлы и `smoke-data-${ts}/`. Они не в `.gitignore` — будут вечно болтаться в `git status`. Не добавляй их в коммиты (используй явный `git add` только своих файлов). Hygiene-fix `.gitignore` — отдельная задача, можно сделать одним PR-у мерджем своих изменений.

### 6.6. Колонки в storage и их типы

SQLite типизация мягкая, но прикладной слой строгий. При INSERT всегда передавай `null` явно если поле опциональное:
```typescript
sqlite.prepare("INSERT INTO ... VALUES (?, ?, ?)").run(id, value, optionalField ?? null);
```

Иначе `undefined` падает.

### 6.7. `req.params.X` в Express 5

Типизирован как `string | string[]`. Везде делай `String(req.params.id)` чтобы избежать TS errors. Паттерн в `server/routes/admin.ts` уже применён везде.

### 6.8. Cookie auth для smoke / curl

Smoke использует `cookieHeader` переменную и swap'ит между jar'ами для multi-user тестов. Шаблон — см. P0 блок в smoke.mjs где admin logs in, потом cookieHeader = "" для signup нового dispatcher, потом swap обратно.

### 6.9. Audit события — соглашения

Phase 3 паттерн:
- `<entity>.<action>` — `user.created`, `invoice.status_changed`, `assignment.removed`
- payload — JSON с минимум `<actorKey>` (см. `pluckActorIdFromPayload` в `storage.ts`): `createdByAdminId`, `resetByAdminId`, `removedByUserId`, `actorUserId`, `createdByUserId`, `userId`.

Phase 4 — добавь свои:
- `lead.created` (driver registers email on landing)
- `lead.approved`, `lead.rejected`, `lead.marked_spam`
- `driver.status_changed` — payload `{ from, to, userId }`
- `driver.checkin` — `{ userId, loadId, lat, lng }`
- `driver.pod_uploaded` — `{ userId, loadId, documentId }`
- `driver.expense_filed` — `{ userId, amount, category }`
- `driver.issue_reported` — `{ userId, issueId, type }`
- `load.booked` — `{ loadId, clientId, driverId, bookedByUserId }`
- `load.counter_offered` — `{ loadId, counterRate, note?, dispatcherId }`
- `approval.resolved` — `{ taskId, resolution, resolvedByUserId }`

---

## 7. Что НЕ делать

1. **НЕ перепиши auth на JWT.** Если Founder спросит — это отдельная Phase, оценка 1 неделя.
2. **НЕ добавляй новые сторонние зависимости** (sendgrid, twilio sdk, cloudflare workers, redis, postgres) без явной просьбы клиента.
3. **НЕ ломай Phase 1 contracts** — `/api/clients`, `/api/loads`, `/api/dispatch-board`, `/api/audit`, `/api/me`, `/api/auth/*`. Можно расширять (additively), не менять shape.
4. **НЕ переписывай admin endpoints** — клиент жил с Phase 3 endpoints и UI готов работает.
5. **НЕ удаляй существующий PortalStub компонент** — он используется в `App.tsx` и может пригодиться для будущих /client/* portals.
6. **НЕ принимай решений за клиента.** Если что-то непонятно — спрашивай. НО на 7 пунктов в §2 он уже сказал «ок», их не переспрашивай.
7. **НЕ делай всё в одном PR.** Phase 3 шла 5 PR'ов, P4 тоже разбита на 5. Каждый PR — отдельный review.
8. **НЕ перекрашивай админку** в orange без явной задачи. Founder сказал «admin портал перекрашивается в эту же тему — не блокируй на этом», то есть это **разрешено** но не **обязательно**. Сначала делай Phase 4 driver/dispatcher с правильными цветами, к админке вернётся позже.
9. **НЕ используй localStorage для auth state** — только httpOnly cookie (session). Это правило из промпта Founder'а, тут он прав.
10. **НЕ забывай про tenant scoping** в КАЖДОМ dispatcher endpoint. Driver scoping — `userId`. Dispatcher scoping — через `getScopedClientIds(req)` helper. См. §3.3.

---

## 8. Workflow с клиентом

### 8.1. Кто клиент

- **Founder/PM:** принимает бизнес-решения. Контакты — в командном чате, не в репозитории.
- **Backend developer / твой клиент:** работает на Windows/PowerShell, у него dev-сервер, он делает скриншоты и кидает их тебе.
- **Дизайнер/QA:** до твоего trekа не дойдёт скорее всего.
- **Claude бэкенд-разработчика:** другой AI, делал Phase 2 frontend admin. **Не путать с тобой.**

### 8.2. Ритм работы

Из Phase 3:
1. Перед каждым PR — короткое сообщение «P4-DRX, план: A, B, C, вопросы: Y, Z. Если все ок — стартую». Клиент отвечает «ок» или меняет.
2. Кодишь — backend + frontend + smoke в одном архиве.
3. Отдаёшь tar.gz через outputs. Клиент распаковывает, прогоняет `npm run check + npm run smoke`, если ок — коммитит и пушит, открывает PR.
4. Ты не пушишь, не коммитишь, не открываешь PR — это делает клиент в его PowerShell. Ты только готовишь файлы.

### 8.3. Формат хэндоффа архива

Tarball с относительными путями от корня репо:
```bash
mkdir -p /tmp/phase4-out
cp --parents <changed-files> /tmp/phase4-out/
cd /tmp/phase4-out && tar czf /home/claude/phase4-pX.tar.gz <dirs>
cp /home/claude/phase4-pX.tar.gz /mnt/user-data/outputs/
```

Клиент распакует через:
```powershell
tar -xzf phase4-pX.tar.gz -C .
git status     # должно показать только твои файлы
```

### 8.4. Коммит-сообщения

Стиль из Phase 3:
```
phaseN: PX <short summary>

Подробный список изменений. Backend endpoints. Frontend pages.
Storage migrations. Smoke +N assertions.
Phase 1 contracts unchanged.

npm run check: 0 errors. npm run smoke: NN/NN OK.
```

Клиент копирует целиком в `git commit -m "..."`.

---

## 9. Финальная мини-шпаргалка

При старте новой сессии — клиент скажет тебе одну фразу типа «погнали Phase 4 driver P0». Не задавай ему вопросы по §2 (7 решений) и §6 (подводные камни) — они зафиксированы.

**Сделай (примерно в таком порядке):**

1. Прочитай этот документ целиком.
2. Прочитай `docs/architecture/phase3-prompt.md`, `phase3-structure.md`, `design-system.md` для контекста, но **игнорируй конфликты с этим документом** (handoff приоритетнее).
3. Открой `server/routes/admin.ts` — это шаблон стиля для твоих новых routes.
4. Открой `client/src/pages/admin/users.tsx` — шаблон стиля для твоих новых pages.
5. Скажи клиенту: «прочитал handoff, стартую P4-driver-p0 со следующим планом: [список]. ОК?»
6. После «ок» — кодь до зелёного `npm run check + npm run smoke`.
7. Соберёшь архив, отдашь, дашь клиенту коммит-сообщение.
8. Подождёшь скриншот UI или подтверждение PR merged.
9. Следующий приоритет.

---

*Этот документ — финальное состояние знаний Phase 3 AI на момент handoff. Если что-то здесь устарело — клиент скажет. Удачи. — Phase 3 Backend AI, май 2026.*
