# DispatchOS Admin API Spec (Phase 3 deliverable)

**Версия:** 1.0
**Дата:** 2026-05-12
**Для:** ИИ-бэкендера, реализует это в Phase 3.
**Зависимости:** все типы — из `shared/schema.ts` (см. v1.3.0-phase1).

---

## 0. Общие правила (читай это перед каждым endpoint)

### 0.1. Авторизация

Все endpoints под `/api/admin/*` ОБЯЗАТЕЛЬНО защищены `requireRole('admin')`. Если запрос приходит:

- без сессии → `401 { message: "Authentication required" }`
- с сессией другой роли (dispatcher, driver) → `403 { message: "Forbidden" }`
- с заблокированным пользователем → `403 { message: "Account is blocked" }`
- до bootstrap (нет admin в системе) → `401 { bootstrap: true }`

`requireRole` уже существует в `server/auth.ts` (Phase 1) — переиспользовать его, не писать заново.

### 0.2. Content-Type, body parsing

- Все POST/PATCH принимают `application/json`.
- Body валидируется через Zod-схемы из `shared/schema.ts`. На ошибку валидации:

```json
HTTP 400
{
  "message": "Validation failed",
  "issues": [
    { "path": ["email"], "message": "Invalid email" }
  ]
}
```

Используй `zod-validation-error` (уже в deps) для дружелюбных сообщений или собственный маппер `result.error.issues` → `issues[]`.

### 0.3. Пагинация (cursor-based)

Везде где `GET /api/admin/<resource>` возвращает список, формат:

**Request:**
```
GET /api/admin/users?limit=50&cursor=<opaque>&role=dispatcher&blocked=false&q=иван
```

| Param | Type | Default | Max | Описание |
|---|---|---|---|---|
| `limit` | int | 50 | 200 | Сколько вернуть |
| `cursor` | string | — | — | Opaque, ISO-timestamp из предыдущей страницы |
| `q` | string | — | — | Поисковый текст (по name/email — зависит от resource) |
| остальные | — | — | — | Фильтры (см. конкретный endpoint) |

**Response:**
```json
HTTP 200
{
  "items": [ /* UserPublic[], InviteX[], ... */ ],
  "nextCursor": "2026-05-10T18:23:11.123Z",
  "hasMore": true,
  "total": 142
}
```

- `nextCursor` — `null` если страница последняя.
- `total` — общее количество (без учёта пагинации, но С учётом фильтров). Допустимо `null` если подсчёт дорогой; UI это переживёт.
- Сортировка — по `created_at DESC` для всех списков (новое сверху). `cursor` хранит `created_at` последней строки на странице. Запрос следующей страницы: `WHERE created_at < cursor ORDER BY created_at DESC LIMIT N`.

**Требование к схеме:** добавить индекс `(created_at DESC)` на `users`, `invites`, `assignments`, `invoices`, и существующий `audit` таблицы. Это не блокер — без индекса будет медленно на 10k+ строк.

### 0.4. Audit events

Каждое мутирующее действие admin'а пишет audit event через существующий `storage.audit(eventType, entityType, entityId, payload)`. Список новых eventType'ов в этом доке — в конце каждого endpoint.

### 0.5. Ответы

- `2xx` JSON — успех
- `4xx { message: string, issues?: [] }` — клиентская ошибка
- `5xx { message: string }` — серверная ошибка (без stacktrace в production)

Никогда не возвращать `password*`, `*Hash`, `*Salt`, `totpSecret` напрямую — кроме как при bootstrap и reset-totp (там это сознательная отдача один раз пользователю).

### 0.6. Reserved URL prefixes

| Префикс | Владелец | Назначение |
|---|---|---|
| `/api/auth/*` | shared (Phase 1) | bootstrap, login, logout, status |
| `/api/me` | shared (Phase 1) | profile of current user |
| `/api/admin/*` | admin (Phase 3, эта спека) | управление системой |
| `/api/dispatch/*` | dispatcher (Phase 4) | scoped views + actions |
| `/api/me/*` | driver (Phase 4) | self-scoped data |
| `/api/health` | public | healthcheck |

Остальные endpoints v1.2.7 (`/api/clients`, `/api/loads`, …) пока — `requireRole.any()`. Phase 3 решит, как их разбить (предложение: оставить `/api/clients` и `/api/loads` доступными для всех ролей, но добавить filtering в Phase 3 для dispatcher/driver).

---

## 1. Users management

### 1.1. `GET /api/admin/users`

Список пользователей с фильтрами.

**Auth:** `requireRole('admin')`

**Query params:**

| Param | Type | Описание |
|---|---|---|
| `limit` | int | до 200 |
| `cursor` | string | ISO datetime |
| `role` | `"admin"` \| `"dispatcher"` \| `"driver"` | фильтр |
| `blocked` | `"true"` \| `"false"` | фильтр |
| `q` | string | LIKE по email или fullName |

**Response 200:**
```json
{
  "items": [
    {
      "id": "usr_01HX...",
      "email": "ivan@example.com",
      "fullName": "Иван Петров",
      "role": "dispatcher",
      "blocked": false,
      "twoFactorEnabled": true,
      "assignedClientIds": ["cli_01...", "cli_02..."],
      "createdAt": "2026-04-15T10:00:00.000Z",
      "updatedAt": "2026-05-01T14:30:00.000Z",
      "lastLoginAt": "2026-05-12T09:15:00.000Z"
    }
  ],
  "nextCursor": "2026-04-15T10:00:00.000Z",
  "hasMore": true,
  "total": 7
}
```

**Implementation hint:** существующий `storage.listUsers()` нужно расширить параметрами `{ limit, cursor, role, blocked, q }` и вернуть `{ items, nextCursor, total }`. Не использовать `LIKE '%q%'` без индекса — для 100+ пользователей OK, для 10k+ нужен FTS.

---

### 1.2. `POST /api/admin/users`

Создаёт пользователя БЕЗ пароля. Пользователь получает доступ только через invite-flow.

**Auth:** `requireRole('admin')`

**Request body:** `createUserSchema` (см. shared/schema.ts)
```json
{
  "email": "new.dispatcher@example.com",
  "fullName": "Новый Диспетчер",
  "role": "dispatcher",
  "linkedClientId": null
}
```

**Response 201:** `UserPublic`

**Errors:**
- `400 { message: "Validation failed", issues: [...] }` — Zod
- `409 { message: "Email already in use" }` — email уникален
- `400 { message: "linkedClientId is only valid for role=driver" }` — если role≠driver и linkedClientId задан
- `400 { message: "linkedClientId references unknown client" }` — клиент не существует

**Audit:** `user.created` с `{ email, role, createdByAdminId }`

**Important:** этот endpoint **не отправляет email** — admin вручную делится invite-ссылкой. Phase 5 добавит email-нотификации.

**Альтернатива:** admin может сразу создать invite (`POST /api/admin/invites`), и пользователь сам введёт email при signup. Оба пути валидны. `POST /api/admin/users` нужен для случая "знаю email, хочу создать заглушку и потом выдать invite на этот email".

---

### 1.3. `GET /api/admin/users/:id`

Детали одного пользователя.

**Auth:** `requireRole('admin')`

**Response 200:** `UserPublic`
**Response 404:** `{ message: "User not found" }`

---

### 1.4. `PATCH /api/admin/users/:id`

Обновление полей пользователя.

**Auth:** `requireRole('admin')`

**Request body:** `updateUserSchema`
```json
{
  "fullName": "Иван Петров (обновлено)",
  "role": "dispatcher",
  "blocked": false,
  "linkedClientId": "cli_01..."
}
```

Все поля опциональны. Можно прислать только то, что меняется.

**Response 200:** `UserPublic` (обновлённый)

**Errors:**
- `404` — нет такого пользователя
- `400 { message: "Cannot change role of the last admin" }` — последнего admin'а нельзя разжаловать (count `role=admin AND blocked=false` >= 1)
- `400 { message: "Cannot block the last admin" }` — нельзя заблочить последнего
- `400 { message: "Cannot block yourself" }` — admin не может заблочить сам себя
- `400 { message: "linkedClientId is only valid for role=driver" }`

**Audit:** `user.updated` с `{ targetUserId, patch (без секретов), updatedByAdminId }`

---

### 1.5. `POST /api/admin/users/:id/reset-password`

Сбрасывает пароль пользователю, возвращает **временный пароль одной строкой**. Admin передаёт его пользователю любым каналом (Telegram, лично). При следующем логине UX покажет "Смените пароль" — но enforcement пока на стороне UI, не backend. (Phase 5: добавить `mustChangePassword` флаг и enforcement.)

**Auth:** `requireRole('admin')`

**Request body:** пусто, либо `{ "length": 16 }` (default 16, min 12, max 32)

**Response 200:**
```json
{
  "temporaryPassword": "Xk9j2pQm8aLz3vR4",
  "userId": "usr_01...",
  "email": "ivan@example.com"
}
```

**Errors:** `404` — нет user

**Audit:** `user.password_reset` с `{ targetUserId, resetByAdminId }`. **`temporaryPassword` в audit не пишем.**

**Implementation hint:** генерация temp пароля — мощный CSPRNG (`crypto.randomBytes`), 16 байт base64url с подгонкой длины. Hash → новые `passwordSalt` + `passwordHash` в users. **Все активные сессии этого пользователя должны быть инвалидированы** (delete from sessions where data LIKE '%userId%' — sqlite, либо trash session store по userId, либо просто перезаписать timestamp.)

Для Phase 3: можно НЕ инвалидировать сессии (это TODO для Phase 5, отметить в audit). Современные сессии всё равно перепроверяют user через `getCurrentUser()` при каждом запросе, а user с новым паролем спокойно ходит до session expiry.

---

### 1.6. `POST /api/admin/users/:id/reset-totp`

Сбрасывает TOTP-секрет. Возвращает новый secret + otpauthUrl (один раз — пользователь должен сразу занести в Google Authenticator). После reset — следующий логин потребует новый TOTP-код.

**Auth:** `requireRole('admin')`

**Request body:** `{ "disable": false }` — если `true`, то TOTP вообще отключается (passwordOnly login для этого user). Default `false`.

**Response 200 (disable=false):**
```json
{
  "userId": "usr_01...",
  "totpSecret": "JBSWY3DPEHPK3PXP",
  "otpauthUrl": "otpauth://totp/DispatchOS:ivan%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=DispatchOS"
}
```

**Response 200 (disable=true):**
```json
{ "userId": "usr_01...", "totpDisabled": true }
```

**Errors:** `404` — нет user

**Audit:** `user.totp_reset` или `user.totp_disabled` с `{ targetUserId, resetByAdminId }`. **secret в audit не писать.**

**Implementation hint:** `generateBase32Secret()` и `buildOtpAuthUrl()` уже в `server/auth.ts`. Просто перезаписать `totp_secret` в users.

---

## 2. Invites

### 2.1. `POST /api/admin/invites`

Создаёт одноразовый invite-код. Возвращает код один раз — admin передаёт его пользователю.

**Auth:** `requireRole('admin')`

**Request body:** `createInviteSchema`
```json
{
  "role": "driver",
  "email": "vasily@example.com",
  "ttlHours": 72,
  "linkedClientId": "cli_01..."
}
```

| Поле | Required | Описание |
|---|---|---|
| `role` | да | "dispatcher" \| "driver". Admin invites — НЕ через этот endpoint (создавать admin = `POST /api/admin/users` с role=admin). |
| `email` | нет | Если задано — invite привязан к email, signup с другого email отвергнут. |
| `ttlHours` | нет | default 72, max 30 * 24 = 720 |
| `linkedClientId` | нет | Только для `role=driver`. Если задано, при consume invite этот клиент привяжется к user. |

**Response 201:**
```json
{
  "code": "DOS-9X4K-2MN8-7QPR",
  "role": "driver",
  "email": "vasily@example.com",
  "expiresAt": "2026-05-15T10:00:00.000Z",
  "linkedClientId": "cli_01...",
  "createdAt": "2026-05-12T10:00:00.000Z",
  "signupUrl": "https://app.dispatchos.io/signup?code=DOS-9X4K-2MN8-7QPR"
}
```

`signupUrl` — формируется backend'ом на основе ENV (`PUBLIC_BASE_URL` или `req.protocol + req.host` если не задан).

**Errors:**
- `400 { message: "role=admin invites are not allowed; create admins directly" }`
- `400 { message: "linkedClientId is only valid for role=driver" }`
- `400 { message: "linkedClientId references unknown client" }`

**Audit:** `invite.created` с `{ code, role, email, ttlHours, createdByAdminId }`

**Implementation hint:** код генерации — `crypto.randomBytes(9).toString('base64url').toUpperCase()` + чанки по 4 с дефисами. Префикс `DOS-`. Хранить в `invites.code` как есть (без хеширования — это одноразовый код, не пароль).

---

### 2.2. `GET /api/admin/invites`

Список invite-кодов с фильтрами.

**Auth:** `requireRole('admin')`

**Query params:**

| Param | Type | Описание |
|---|---|---|
| `limit`, `cursor` | — | пагинация |
| `status` | `"active"` \| `"expired"` \| `"consumed"` \| `"all"` | default `"active"` |
| `role` | role | фильтр |

`active` = `consumedAt IS NULL AND expiresAt > now()`
`expired` = `consumedAt IS NULL AND expiresAt <= now()`
`consumed` = `consumedAt IS NOT NULL`

**Response 200:**
```json
{
  "items": [
    {
      "code": "DOS-9X4K-2MN8-7QPR",
      "role": "driver",
      "email": "vasily@example.com",
      "expiresAt": "2026-05-15T10:00:00.000Z",
      "consumedAt": null,
      "consumedByUserId": null,
      "createdAt": "2026-05-12T10:00:00.000Z",
      "createdByUserId": "usr_admin_01",
      "linkedClientId": "cli_01..."
    }
  ],
  "nextCursor": null,
  "hasMore": false,
  "total": 3
}
```

**Note:** возвращать `code` целиком в списке — это safe, потому что только admin его видит, а сам invite уже создан. Admin может скопировать код повторно из таблицы.

---

### 2.3. `DELETE /api/admin/invites/:code`

Отзыв invite (soft — выставляем `expiresAt = now()`).

**Auth:** `requireRole('admin')`

**Response 200:** `{ "code": "DOS-...", "revokedAt": "..." }`

**Errors:**
- `404 { message: "Invite not found" }`
- `409 { message: "Invite already consumed" }`

**Audit:** `invite.revoked` с `{ code, revokedByAdminId }`

---

## 3. Assignments (dispatcher ↔ client)

### 3.1. `GET /api/admin/assignments`

Список активных assignment'ов с фильтрами.

**Auth:** `requireRole('admin')`

**Query params:**

| Param | Описание |
|---|---|
| `limit`, `cursor` | пагинация |
| `dispatcherId` | фильтр |
| `clientId` | фильтр |
| `includeRemoved` | `"true"` \| `"false"` (default false) |

**Response 200:**
```json
{
  "items": [
    {
      "id": "asg_01...",
      "clientId": "cli_01...",
      "dispatcherUserId": "usr_disp_01",
      "createdAt": "2026-04-01T10:00:00.000Z",
      "createdByUserId": "usr_admin_01",
      "removedAt": null,
      "removedByUserId": null
    }
  ],
  "nextCursor": null,
  "hasMore": false,
  "total": 12
}
```

---

### 3.2. `POST /api/admin/assignments`

Назначает клиента на диспетчера. Many-to-many: один клиент может иметь несколько активных assignment'ов (24-часовая ротация — двое диспетчеров параллельно).

**Auth:** `requireRole('admin')`

**Request body:** `createAssignmentSchema`
```json
{ "clientId": "cli_01...", "dispatcherUserId": "usr_disp_01" }
```

**Response 201:** `Assignment` shape

**Errors:**
- `404 { message: "Client not found" }`
- `404 { message: "Dispatcher not found" }`
- `400 { message: "User is not a dispatcher" }` — role != dispatcher
- `409 { message: "Assignment already exists" }` — есть активное (removedAt IS NULL) с такой парой

**Audit:** `assignment.created` с `{ clientId, dispatcherUserId, createdByAdminId }`

---

### 3.3. `DELETE /api/admin/assignments/:id`

Soft-delete (выставляем `removedAt` + `removedByUserId`).

**Auth:** `requireRole('admin')`

**Response 200:** `Assignment` shape (с заполненным removedAt)

**Errors:** `404`, `409 { message: "Assignment already removed" }`

**Audit:** `assignment.removed` с `{ assignmentId, removedByAdminId }`

---

## 4. Billing

### 4.1. `POST /api/admin/billing/preview`

Считает инвойс БЕЗ записи в БД. Для UI "посмотреть перед отправкой".

**Auth:** `requireRole('admin')`

**Request body:**
```json
{
  "clientId": "cli_01...",
  "weekStart": "2026-05-05",
  "weekEnd": "2026-05-11"
}
```

`weekStart` / `weekEnd` — ISO date (без времени). Backend ресолвит как `weekStart 00:00 client TZ` … `weekEnd 23:59:59 client TZ`. Phase 3 может пока хардкодить `UTC` если client TZ не хранится — UI это потерпит.

**Response 200:** `Invoice` shape но с `id` и `status` = `null`:
```json
{
  "id": null,
  "clientId": "cli_01...",
  "weekStart": "2026-05-05T00:00:00.000Z",
  "weekEnd": "2026-05-11T23:59:59.000Z",
  "flatFee": 150,
  "percentFee": 87.45,
  "grossBooked": 2915,
  "totalDue": 237.45,
  "status": null,
  "generatedAt": null,
  "breakdown": {
    "loadCount": 4,
    "loads": [
      { "loadId": "ld_01", "rate": 850, "originCity": "Houston", "destinationCity": "Dallas", "deliveredAt": "2026-05-07T..." }
    ]
  }
}
```

**Note:** `breakdown` — это плюс к `invoiceSchema`, **только для preview**. UI его рисует таблицей "за что счёт". Можно добавить в shared/schema как `invoicePreviewSchema` (см. Часть 4 ниже).

**Errors:** `404 client`, `400` если weekStart>=weekEnd

**Implementation hint:** использует тот же расчёт что и `/api/admin/billing/generate` (см. ниже), но без `storage.createInvoice()`. Лучше выделить расчёт в `server/lib/billing.ts` — пусть оба endpoint его вызывают.

**Source данных:** `grossBooked` = сумма `rate` всех `loads` для этого `clientId`, у которых `deliveryAt` (или какой-то "booked at" timestamp) лежит в `[weekStart, weekEnd]`. На сегодня в схеме `loadSchema` нет поля "booked"/"client owner" — это нужно решить в Phase 3:

- **Решение A (рекомендуемое):** добавить в `loadSchema` поле `clientId?: string` и `bookedAt?: string`. Когда диспетчер бронирует груз для клиента — он попадает в инвойс.
- **Решение B:** хранить отдельную таблицу `client_bookings (load_id, client_id, booked_at, booked_by_user_id)`.

Поднять с командой при старте Phase 3.

---

### 4.2. `POST /api/admin/billing/generate`

Генерирует и сохраняет инвойс в БД.

**Auth:** `requireRole('admin')`

**Request body:** то же что preview + опционально `{ "status": "draft" | "sent" }` (default `"draft"`)

**Response 201:** `Invoice` (с заполненным id и generatedAt)

**Errors:**
- `409 { message: "Invoice for this client and week already exists", existingInvoiceId: "inv_..." }`
- `404`, `400`

**Audit:** `invoice.created` с `{ invoiceId, clientId, weekStart, weekEnd, totalDue, createdByAdminId }`

---

### 4.3. `GET /api/admin/billing/invoices`

Список инвойсов.

**Auth:** `requireRole('admin')`

**Query params:** `limit`, `cursor`, `clientId`, `status` (Invoice status), `weekStart` (>=), `weekEnd` (<=)

**Response 200:** paginated `Invoice[]`

---

### 4.4. `PATCH /api/admin/billing/invoices/:id`

Изменение статуса (draft → sent → paid → void) или notes.

**Auth:** `requireRole('admin')`

**Request body:**
```json
{ "status": "sent", "notes": "Отправлен через Telegram" }
```

Разрешённые переходы:

```
draft  → sent
draft  → void
sent   → paid
sent   → void
paid   → (immutable)
void   → (immutable)
```

**Response 200:** `Invoice`

**Errors:** `404`, `400 { message: "Invalid status transition" }`

**Audit:** `invoice.status_changed` с `{ invoiceId, from, to }`

---

## 5. Dashboard aggregate

### 5.1. `GET /api/admin/dashboard/stats`

Возвращает агрегаты для главного экрана. Один запрос вместо шести параллельных.

**Auth:** `requireRole('admin')`

**Query params:**

| Param | Описание |
|---|---|
| `period` | `"week"` \| `"month"` (default `"week"`) — окно для расчёта rolling counts |

**Response 200:**
```json
{
  "mrr": {
    "currentUsd": 1200,
    "projectedUsd": 1500,
    "activeClients": 8,
    "trend": { "direction": "up", "percent": 12.5 }
  },
  "users": {
    "admins": 1,
    "dispatchers": 2,
    "drivers": 6,
    "blocked": 0,
    "lastSignupAt": "2026-05-09T14:23:00.000Z"
  },
  "loads": {
    "weekCount": 47,
    "weekGrossUsd": 41250,
    "byVerdict": { "book": 32, "negotiate": 10, "skip": 5 }
  },
  "audit": {
    "eventsLast24h": 184,
    "lastEventAt": "2026-05-12T13:21:00.000Z",
    "errorEventsLast24h": 2
  },
  "integrations": {
    "fmcsa": { "status": "ok", "lastCheckedAt": "2026-05-12T12:00:00.000Z" },
    "telegram": { "status": "ok", "lastCheckedAt": "2026-05-12T12:00:00.000Z" },
    "gmail": { "status": "warn", "lastCheckedAt": "2026-05-12T12:00:00.000Z", "message": "OAuth token expires in 3 days" },
    "drive": { "status": "ok", "lastCheckedAt": "2026-05-12T12:00:00.000Z" }
  },
  "system": {
    "version": "1.3.0-phase1",
    "uptimeSeconds": 432100,
    "dbSizeBytes": 12459872
  }
}
```

**Note:** integrations — переиспользует уже существующий `/api/integrations/status` под капотом. Status:

- `"ok"` — настроено и работает
- `"warn"` — настроено, но есть warning (например, токен скоро истечёт)
- `"missing"` — не настроено (нет API key / OAuth)
- `"error"` — настроено но не отвечает (последняя проверка failed)

**Implementation hint:** для MRR — простая формула `count(active clients) * 150 + sum(invoices.percent_fee where status in (sent, paid) and weekStart>=startOfMonth)`. Если процент дороги — оставить только `count * 150` и сразу пометить `projectedUsd` как `null`.

---

## 6. Audit — extension существующего

### 6.1. `GET /api/audit` (расширяется)

Текущий endpoint `/api/audit` (Phase 1) возвращает плоский список. Расширить:

**Query params (новые):**

| Param | Описание |
|---|---|
| `limit` | до 200, default 50 |
| `cursor` | ISO datetime (= `created_at` последнего event'а на странице) |
| `eventType` | exact match, e.g. `"user.created"`. Можно передать несколько через `?eventType=a&eventType=b` |
| `entityType` | `"user"` \| `"client"` \| `"load"` \| `"document"` \| `"broker"` \| `"invite"` \| `"assignment"` \| `"invoice"` \| `"auth"` |
| `actorId` | userId, чей actions смотрим |
| `entityId` | конкретный entity |
| `since` | ISO datetime, события с момента |
| `until` | ISO datetime, события до момента |

**Response 200:**
```json
{
  "items": [
    {
      "id": "evt_01...",
      "eventType": "user.created",
      "entityType": "user",
      "entityId": "usr_01...",
      "actorUserId": "usr_admin_01",
      "actorEmail": "admin@example.com",
      "payload": { "email": "ivan@...", "role": "dispatcher" },
      "createdAt": "2026-05-12T10:00:00.000Z"
    }
  ],
  "nextCursor": "2026-05-12T10:00:00.000Z",
  "hasMore": true,
  "total": 1842
}
```

**Backward-compat:** если cursor не передан и фильтров нет — возвращать **тот же** формат что v1.2.7 (для legacy UI). Простой путь: всегда возвращать новый формат, и поправить legacy UI чтобы он читал `.items` вместо корневого массива. Решение зависит от того, насколько ИИ-бэкендер хочет ломать v1.2.7. Я бы сделал так:

- `GET /api/audit` (без params) → legacy формат `Event[]` (для legacy dashboard)
- `GET /api/audit?limit=...` (с любым новым параметром) → новый формат `{items, nextCursor, ...}`

---

## 7. Сводная таблица всех endpoints

| Method | Path | Auth | Status |
|---|---|---|---|
| POST | `/api/admin/users` | admin | NEW Phase 3 |
| GET | `/api/admin/users` | admin | NEW Phase 3 |
| GET | `/api/admin/users/:id` | admin | NEW Phase 3 |
| PATCH | `/api/admin/users/:id` | admin | NEW Phase 3 |
| POST | `/api/admin/users/:id/reset-password` | admin | NEW Phase 3 |
| POST | `/api/admin/users/:id/reset-totp` | admin | NEW Phase 3 |
| POST | `/api/admin/invites` | admin | NEW Phase 3 |
| GET | `/api/admin/invites` | admin | NEW Phase 3 |
| DELETE | `/api/admin/invites/:code` | admin | NEW Phase 3 |
| POST | `/api/admin/assignments` | admin | NEW Phase 3 |
| GET | `/api/admin/assignments` | admin | NEW Phase 3 |
| DELETE | `/api/admin/assignments/:id` | admin | NEW Phase 3 |
| POST | `/api/admin/billing/preview` | admin | NEW Phase 3 |
| POST | `/api/admin/billing/generate` | admin | NEW Phase 3 |
| GET | `/api/admin/billing/invoices` | admin | NEW Phase 3 |
| PATCH | `/api/admin/billing/invoices/:id` | admin | NEW Phase 3 |
| GET | `/api/admin/dashboard/stats` | admin | NEW Phase 3 |
| GET | `/api/audit?...` | any auth (extended) | EXTEND Phase 3 |
| POST | `/api/auth/signup` | public (invite-locked) | NEW Phase 3 |

**Дополнительно (signup flow для invite-кодов):**

### `POST /api/auth/signup`

Регистрация по invite. Не требует существующей сессии.

**Auth:** none (но требует валидный invite)

**Request body:** `signupSchema`
```json
{
  "inviteCode": "DOS-9X4K-2MN8-7QPR",
  "email": "vasily@example.com",
  "fullName": "Василий Иванов",
  "password": "MyStr0ngPa$$w0rd"
}
```

**Response 201:**
```json
{
  "id": "usr_01...",
  "email": "vasily@example.com",
  "role": "driver",
  "totpSecret": "JBSWY3DPEHPK3PXP",
  "otpauthUrl": "otpauth://totp/DispatchOS:vasily%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=DispatchOS",
  "redirect": "/me"
}
```

**Important:** этот endpoint автоматически **логинит** пользователя (записывает `req.session.userId` + `req.session.role`). Фронт сразу делает redirect.

**TOTP setup:** Phase 3 решение — генерировать TOTP всегда (как сейчас для admin bootstrap), и UI после signup показывает QR-код. Если пользователь хочет login без TOTP, admin может потом сбросить через `/admin/users/:id/reset-totp` с `disable=true`.

**Errors:**
- `400 { message: "Invite not found or expired" }` — нет такого кода либо expiresAt<now() либо consumedAt!=null
- `400 { message: "Invite is locked to a different email" }` — invite.email задан и не совпадает
- `409 { message: "Email already in use" }`
- `400 { message: "Validation failed", issues: [...] }`

**Audit:** `invite.consumed` + `user.created` с `{ source: "invite", inviteCode, role }`

---

## 8. Phase 3 — рекомендуемый порядок реализации (приоритеты)

| Приоритет | Endpoints | Зачем |
|---|---|---|
| **P0** | `POST/GET/PATCH /api/admin/users`, `POST /api/auth/signup`, `POST /api/admin/invites`, `GET /api/admin/invites` | Без этого admin не может ввести в систему диспетчера и водителя. Блокер для запуска. |
| **P1** | `GET/POST/DELETE /api/admin/assignments`, `DELETE /api/admin/invites/:code`, `POST /api/admin/users/:id/reset-password`, `POST /api/admin/users/:id/reset-totp` | Операционка: блокировка, ротация TOTP, назначения. Без этого admin не управляет команду. |
| **P2** | `POST /api/admin/billing/preview`, `POST /api/admin/billing/generate`, `GET/PATCH /api/admin/billing/invoices/:id` | Деньги. Можно жить неделю-две без UI — генерировать инвойсы вручную в БД. |
| **P3** | `GET /api/admin/dashboard/stats` | Удобство, не блокер. Можно мокать в UI. |
| **P4** | `GET /api/audit` extension с пагинацией | Удобство. legacy формат работает. |

UI Admin готов к тому, что P2-P4 endpoints могут быть недоступны — на этих экранах вылетит баннер "endpoint not implemented in Phase 3 yet" (см. `client/src/lib/api.ts` в Phase 2 пакете).

---

## 9. Дополнения к `shared/schema.ts`

ИИ-бэкендер должен будет согласиться или отвергнуть. Я (Phase 2) добавил в `shared/schema.ts` следующее (см. diff в финальном архиве):

```ts
// Pagination response wrapper — used by all admin list endpoints.
export const paginatedResponseSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    total: z.number().nullable(),
  });

// For UI listing/filter state on Users page.
export const userListFiltersSchema = z.object({
  q: z.string().optional(),
  role: userRoleSchema.optional(),
  blocked: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});
export type UserListFilters = z.infer<typeof userListFiltersSchema>;

// Invoice preview response — includes the per-load breakdown.
export const invoicePreviewSchema = invoiceSchema
  .omit({ id: true, status: true, generatedAt: true })
  .extend({
    id: z.null(),
    status: z.null(),
    generatedAt: z.null(),
    breakdown: z.object({
      loadCount: z.number(),
      loads: z.array(z.object({
        loadId: z.string(),
        rate: z.number(),
        originCity: z.string(),
        destinationCity: z.string(),
        deliveredAt: z.string().optional(),
      })),
    }),
  });
export type InvoicePreview = z.infer<typeof invoicePreviewSchema>;

// Dashboard aggregate response (для GET /api/admin/dashboard/stats).
export const dashboardStatsSchema = z.object({
  mrr: z.object({
    currentUsd: z.number(),
    projectedUsd: z.number().nullable(),
    activeClients: z.number(),
    trend: z.object({
      direction: z.enum(["up", "down", "flat"]),
      percent: z.number(),
    }).optional(),
  }),
  users: z.object({
    admins: z.number(),
    dispatchers: z.number(),
    drivers: z.number(),
    blocked: z.number(),
    lastSignupAt: z.string().nullable(),
  }),
  loads: z.object({
    weekCount: z.number(),
    weekGrossUsd: z.number(),
    byVerdict: z.object({
      book: z.number(),
      negotiate: z.number(),
      skip: z.number(),
    }),
  }),
  audit: z.object({
    eventsLast24h: z.number(),
    lastEventAt: z.string().nullable(),
    errorEventsLast24h: z.number(),
  }),
  integrations: z.record(z.string(), z.object({
    status: z.enum(["ok", "warn", "missing", "error"]),
    lastCheckedAt: z.string().nullable(),
    message: z.string().optional(),
  })),
  system: z.object({
    version: z.string(),
    uptimeSeconds: z.number(),
    dbSizeBytes: z.number().nullable(),
  }),
});
export type DashboardStats = z.infer<typeof dashboardStatsSchema>;
```

Ничего из существующего я не менял. Только добавил выше.

---

## 10. Что МНЕ нужно от ИИ-бэкендера (двусторонний контракт)

1. Сохранить shape ответа `/api/auth/login` — `{ ok, role, redirect }`. Я на это полагаюсь.
2. Сохранить shape `/api/me` — `UserPublic`. Я на это полагаюсь.
3. Не менять имя cookie (`dispatchos.sid`) — иначе мои `credentials: "same-origin"` в fetch перестанут работать.
4. При invite consume — корректно ставить `req.session.userId` и `role` сразу. Frontend ждёт что после `/api/auth/signup` он может делать `/api/me` и получать данные.
5. Если в Phase 3 решено что какой-то endpoint выше не реализуется — сообщи мне до старта; я скрою соответствующий UI-блок.

— Claude Design

---

## 11. Phase 4 hooks (контракты, реализация позже)

Эти endpoints НЕ входят в Phase 3 deliverable. Они описаны здесь, чтобы Phase 4-разработчик (dispatcher portal) не изобретал свой shape и был совместим с уже существующими полями в `loadSchema`.

### `POST /api/loads/:id/book` — Phase 4

Привязать груз к клиенту (booking). Вызывается dispatcher'ом при бронировании, или admin'ом вручную.

**Auth:** `requireRole.any()` (dispatcher OR admin). Driver не имеет права книговать чужие грузы.

**Request body:**
```json
{ "clientId": "ivan-enclosed-01" }
```

**Behavior:**

| Состояние load | Результат |
|---|---|
| `load.clientId` не задан | UPDATE `clientId`, set `bookedAt = today (YYYY-MM-DD)`, audit `load.booked`, 200 |
| `load.clientId == body.clientId` | Idempotent: НЕ UPDATE, НЕ audit, 200 с текущими полями |
| `load.clientId != body.clientId` | 409 `{ message: "Load already booked for a different client", code: "already_booked_for_other_client", existingClientId: "..." }` |
| Load не существует | 404 |
| Body.clientId не существует | 404 |

**Response 200:**
```json
{ "loadId": "cd-10394", "clientId": "ivan-enclosed-01", "bookedAt": "2026-05-16" }
```

**Storage hint:** уже в Phase 3 P2 storage есть `upsertLoad`, который пишет `clientId`/`bookedAt` в payload + denormal колонки. `POST /api/loads/:id/book` — это просто read-modify-write через `getLoad` + `upsertLoad`.

**Audit:** `load.booked` с `{ loadId, clientId, dispatcherUserId | adminUserId, bookedAt }`. Идемпотентный повтор audit не пишет.

**Why date-only `bookedAt`:** см. комментарий к `dateOnlySchema` в `shared/schema.ts`. Если когда-нибудь понадобится per-second timestamp, добавь отдельную колонку `booked_at_ts`, не реюзай эту.
