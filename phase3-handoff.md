# Phase 3 — Handoff to Backend AI

Это документ для **передачи** ИИ-бэкендеру. Скопируй текст ниже в первое сообщение
новой Claude-сессии вместе с архивом `dispatchos-v1.3.1-phase2.zip`.

---

## Промпт для бэкендера (копировать целиком)

> Ты — Claude Backend, реализуешь **Phase 3** проекта **DispatchOS** — внутренний
> диспетчерский сервис для русскоязычных US trucking-водителей.
>
> **Контекст проекта:**
> - Stack: Node 20, Express 5, TypeScript, Drizzle ORM, better-sqlite3, express-session,
>   pbkdf2 + TOTP. Без JWT, без OAuth.
> - Текущее состояние: Phase 1 (бэкенд multi-role, /api/auth/*, /api/me) и Phase 2
>   (frontend admin-портала, 12 экранов) уже сделаны. Frontend полностью построен и
>   вызывает endpoints, которые ты будешь реализовывать. На каждом неготовом endpoint
>   UI показывает баннер «Раздел будет доступен после Phase 3» — после твоей реализации
>   баннер исчезнет автоматически.
>
> **Твоя задача:**
> Реализовать все `/api/admin/*` endpoints по спецификации в файле
> `admin-api-spec.md` (он в корне проекта). 18 endpoints + `POST /api/auth/signup`.
>
> **Порядок (приоритеты в spec):**
> 1. **P0** (блокер для запуска): users CRUD, invites, signup. Без этого admin не может
>    ввести в систему ни одного диспетчера или водителя.
> 2. **P1**: assignments, reset password, reset TOTP, revoke invite.
> 3. **P2**: billing (preview + generate + invoice CRUD).
> 4. **P3**: dashboard/stats агрегатор.
> 5. **P4**: audit pagination extension.
>
> После каждого приоритета — покажи скриншот работающего UI (фронтенд уже подключён,
> просто кликай в браузере), потом переходи к следующему.
>
> **Жёсткие правила:**
> 1. **Не трогать `client/*`.** Это территория Phase 2. Если что-то сломано в UI — пиши мне.
> 2. **Не менять Phase 1 endpoint contracts:**
>    - `POST /api/auth/login` ответ — `{ ok: true, role, redirect }`
>    - `POST /api/auth/bootstrap` ответ — `{ id, email, totpSecret, otpauthUrl, ... }`
>    - `GET /api/me` ответ — `UserPublic` shape из `shared/schema.ts`
>    - `GET /api/auth/status` — без изменений
>    - Cookie name `dispatchos.sid` — без изменений
> 3. **Не трогать Phase 1 типы в `shared/schema.ts`.** Только добавлять новые в конец.
>    Phase 2 уже добавил `paginatedResponseSchema`, `dashboardStatsSchema`,
>    `invoicePreviewSchema` и др. — используй их, не дублируй.
> 4. **Не менять existing endpoints v1.2.7** (`/api/clients`, `/api/loads`, `/api/brokers`,
>    `/api/documents`, `/api/audit`). Их можно **расширять** (например, `/api/audit` с пагинацией
>    в P4), но не ломать backward-compat. Spec явно описывает что legacy формат должен остаться
>    работающим.
> 5. **Каждый мутирующий endpoint пишет audit event** через existing `storage.audit(...)`.
>    Event-types перечислены в spec в каждой секции.
> 6. **Auth:** все `/api/admin/*` под `requireRole('admin')`. `requireRole` уже в `server/auth.ts`.
> 7. **Валидация:** body через Zod-схемы из `shared/schema.ts`. На fail — 400 с
>    `{ message: "Validation failed", issues: [...] }`.
> 8. **Stack — не менять.** Никаких новых auth-механизмов, никаких JWT, никаких сторонних
>    DB. Только то что уже есть.
>
> **Verification:**
> - `npm run check` — 0 ошибок TS
> - `npm run smoke` — все 22+ Phase 1 теста зелёные
> - Каждый твой endpoint покрыт хотя бы 1 строкой в `scripts/smoke.mjs`
> - Frontend работает: кликнул «Создать invite» → код появился; кликнул «Сбросить пароль» →
>   временный пароль показался; и т.д.
>
> **Открытое решение, требующее моего согласия в начале P2:**
> В спеке раздел 4.1 описывает что для биллинга нужно знать **какой груз привязан к какому
> клиенту и когда был забронирован**. Сейчас в `loadSchema` нет ни `clientId`, ни `bookedAt`.
> Два пути:
> - **A:** добавить опциональные поля в `loadSchema` (`clientId?: string`, `bookedAt?: string`).
> - **B:** отдельная таблица `client_bookings (load_id, client_id, booked_at, booked_by_user_id)`.
>
> Спроси меня перед P2 какой путь выбираем.
>
> **Старт с P0.** Реализуй:
> - `POST /api/admin/users` — создать без пароля (для случая "знаю email, дам invite потом")
> - `GET /api/admin/users` — список с пагинацией и фильтрами
> - `GET /api/admin/users/:id` — детали
> - `PATCH /api/admin/users/:id` — обновление (с защитами от "снять admin-роль у последнего")
> - `POST /api/admin/invites` — создать invite (DOS-XXXX-XXXX-XXXX)
> - `GET /api/admin/invites` — список (active/expired/consumed/all)
> - `POST /api/auth/signup` — consume invite, автоматически логинит
>
> После P0 — покажи скриншот: захожу в `/#/admin/users` → создаю invite через UI → копирую
> код → ухожу из admin'а → захожу в `/#/signup?code=DOS-...` → регистрируюсь → попадаю в
> dispatcher или driver портал (показывается стаб «Phase 4 в работе»).

---

## Что в архиве `dispatchos-v1.3.1-phase2.zip`

Корень проекта со всем необходимым:
- `client/` — фронтенд Phase 2 (12 экранов admin)
- `server/` — бэкенд Phase 1 (не трогать без необходимости)
- `shared/schema.ts` — все типы, Phase 2 добавил Pagination, DashboardStats, InvoicePreview
- `admin-api-spec.md` — **главный документ** для бэкендера
- `phase1-changes.md` — что было в Phase 1
- `phase2-changes.md` — что добавлено в Phase 2
- `scripts/smoke.mjs` — health checks которые должны оставаться зелёными
- `package.json` v1.3.1-phase2
- `.gitignore` — без БД, без .env

**НЕ в архиве:** `node_modules/`, `dist/`, `*.db` (БД с твоим admin'ом).

---

## Что отдавать бэкендеру

1. Архив `dispatchos-v1.3.1-phase2.zip`
2. Промпт выше (скопировать в первое сообщение)
3. Опционально — указать что `admin-api-spec.md` главный документ, и пусть начнёт с его чтения

Этого хватит. Спека покрывает 90% его вопросов; на оставшиеся 10% он будет спрашивать
тебя в процессе.
