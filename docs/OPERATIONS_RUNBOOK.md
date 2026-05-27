# DispatchOS Operations Runbook

**Aудитория:** разработчики DispatchOS (в первую очередь Влад).
**Цель:** убрать любые блокеры — каждый «как сделать X» здесь, не в TG.
**Поддерживается:** Никита + AI ассистент. PR'ы welcome.

---

## 0. Quick reference

| Что | Где / Как |
|---|---|
| Прод URL | https://dispatchos.co + https://www.dispatchos.co |
| Demo / staging | https://demo.dispatchos.co (тот же Fly app) |
| Health endpoint | `curl https://dispatchos.co/api/health` |
| Fly app | `dispatchos-demo` |
| Default branch | `develop` (auto-deploy при push) |
| Live tracker | [Issue #48](https://github.com/GryFar/dispatchos/issues/48) |
| Markdown docs | `/docs/` + workspace y Никиты |

---

## 1. Локальный dev

### 1.1 Стартануть свежий клон

```bash
git clone https://github.com/GryFar/dispatchos.git
cd dispatchos
npm install
cp .env.example .env  # дополни секретами ниже
npm run dev           # порт 5000
```

### 1.2 Минимальный `.env` для dev / smoke

```bash
# Auth (smoke ожидает эти значения; production_secret обязателен)
DISPATCHOS_SESSION_SECRET=$(openssl rand -hex 32)
COOKIE_SECURE=false                  # smoke на localhost без TLS
NODE_ENV=development

# Rate limit — оба ВЫКЛЮЧЕНЫ по умолчанию начиная с #97/#98
# На dev/smoke оставляй так, иначе CI забанит сам себя
# DISPATCHOS_AUTH_RATE_LIMIT=on
# DISPATCHOS_RATE_LIMIT=on

# FMCSA SAFER (опционально; без него интеграция мокается)
# FMCSA_WEBKEY=<твой webkey с https://mobile.fmcsa.dot.gov/QCDevsite/>

# Stripe (только при работе над биллингом)
# STRIPE_SECRET_KEY=sk_test_...
# STRIPE_WEBHOOK_SECRET=whsec_...
# STRIPE_PRICE_OWNER_MONTHLY=price_...
# (+ 5 остальных PRICE_* — см. server/lib/stripe/config.ts)

# Resend (только для email-triggers)
# RESEND_API_KEY=re_...

# Anthropic (F2/F3 фичи)
# ANTHROPIC_API_KEY=sk-ant-...
```

### 1.3 Базовые команды

```bash
npm run dev           # vite + tsx watch backend
npm run check         # tsc — ОБЯЗАТЕЛЬНО перед PR, должен быть зелёный
npm run build         # prod build (tsc + vite + esbuild)
npm run smoke         # full smoke test (см. секцию 5)
npm run smoke -- --keep-db  # не сносить smoke.db (для дебага)
```

### 1.4 Тестовый bootstrap (свежая БД)

```bash
# 1) Запусти сервер
npm run dev

# 2) В другом терминале — создай первого admin'а
curl -sS -X POST http://localhost:5000/api/auth/bootstrap \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:5000" \
  -d '{"email":"admin@dev.local","password":"DevAdmin2026!","fullName":"Dev Admin"}'

# 3) Ответ содержит TOTP secret/qr — открой http://localhost:5000 → залогинься
#    Если 2FA включён в Audit v3 Critical pack, набей код из Google Authenticator
```

---

## 2. Rate-limit флаги

После #97/#98 **все per-IP ограничения выключены по умолчанию**. Включай только когда нужно (например, прод после набора real-IP diversity).

| Env var | Что включает | Default |
|---|---|---|
| `DISPATCHOS_RATE_LIMIT=on` | Глобальный `/api` 240/min лимитер | `off` |
| `DISPATCHOS_RATE_LIMIT_PER_MINUTE=240` | Cap для глобального (если включён) | 240 |
| `DISPATCHOS_AUTH_RATE_LIMIT=on` | Brute-force лимитер на `/api/auth/login` + `/api/me/totp/confirm` | `off` |
| `DISPATCHOS_AUTH_RATE_LIMIT_PER_15MIN=20` | Cap (per IP+email) для brute (если включён) | 20 |

**Включить в проде когда придёт время:**

```bash
flyctl secrets set DISPATCHOS_RATE_LIMIT=on DISPATCHOS_AUTH_RATE_LIMIT=on -a dispatchos-demo
```

---

## 3. Soft-delete / strict-user lookups (#78 + #103)

**Critical инвариант, держи в голове при любом patch'е storage.ts:**

| Lookup | Что фильтрует | Когда использовать |
|---|---|---|
| `getUserById(id)` | СТРОГО `deleted_at IS NULL` | **Любой auth/session/TG-bot/dispatch путь.** Default. |
| `getUserByIdIncludingDeleted(id)` | Всё, включая soft-deleted | **ТОЛЬКО** admin inspection / audit display / softDeleteUser return |
| `getUserByEmail`, `getUserByTelegramChatId` | СТРОГО `deleted_at IS NULL` | Auth-adjacent. Никогда не релакси. |
| `listUsers(filter)` | По умолчанию НЕ показывает soft-deleted (filter.includeDeleted=true для админ-листов) | UI/Reports |

**Правило простое:** новый код в auth-flow / session-hydration / TG-webhook ВСЕГДА строгий. Новый код в admin-routes — обычно через `getUserByIdIncludingDeleted`, но проверь чтобы не утекло в places где deleted user мог бы притвориться active (e.g. patch endpoints — там нужен extra guard на `existing.deletedAt`).

---

## 4. TOTP / 2FA flow

После #99:

1. Юзер POSTит `/api/auth/login` с `{email, password}` (без token)
2. Если у юзера `totpSecret`:
   - Сервер возвращает **401 + `{message: "2FA token required", code: "totp_required"}`**
   - Клиент должен распознать `code === "totp_required"` (а не парсить `message`!)
3. Юзер вводит 6-значный код → POSTит снова с `{email, password, token}`
4. Если код неверный → **401 + `{message: "Invalid 2FA token", code: "totp_invalid"}`**
5. Audit лог пишет `auth.login_failed` с `reason: "totp_required" | "bad_totp"`

**TOTP replay protection (#75):** `lastUsedTotpCounter` хранится в `users` таблице. Counter monotonically increases. Re-using старый код → reject. **В smoke**: для re-login в том же временном окне инкрементируй counter руками (`counter + 1`) — это уже сделано в Владовом smoke.mjs fix.

**TOTP window:** ±1 step (30s). До Audit High #12 было ±2.

---

## 5. Smoke test

`smoke.mjs` — fully end-to-end (старт сервера → bootstrap → login → admin operations → cleanup). **Обязательный gate перед merge** для security-sensitive PR'ов.

### 5.1 Запуск

```bash
npm run smoke
# Хочешь оставить .smoke.db и логи после прогона:
npm run smoke -- --keep-db
```

### 5.2 Известные требования (полные после Владова фикса)

- `DISPATCHOS_SESSION_SECRET` в env (не дефолтный)
- `COOKIE_SECURE=false` (нет TLS на localhost)
- `Origin` header в каждом запросе (CSRF guard #90 SameSite=Strict + Origin check)
- Для re-login в том же временном окне: TOTP counter+1 (Audit High #11 replay)
- Порядок инициализации БД: `ensureDriverDocumentsColumns()` ПОСЛЕ `CREATE TABLE` (фикс в Владовом PR)
- **Admin GET удалённого user'а** (smoke.mjs:766-768) возвращает row с `deletedAt` — это работает после #103

### 5.3 Что smoke покрывает (high-level)

1. Bootstrap первого admin'а
2. Login + TOTP setup + login с TOTP
3. Создание client, driver, dispatcher через admin API
4. Login каждой ролью (cross-portal)
5. Создание load (admin) → assign driver → driver checkpoints → completion
6. Audit log assertions
7. Soft-delete user → admin GET возвращает с `deletedAt`
8. Cleanup

### 5.4 Если smoke падает

| Симптом | Скорее всего причина | Фикс |
|---|---|---|
| `Invalid credentials` на bootstrap | `DISPATCHOS_SESSION_SECRET` дефолтный | Поставь свой в env |
| `CSRF token mismatch` или 403 на mutate | Нет Origin header в fetch | Добавь `Origin: http://localhost:5000` |
| `Invalid 2FA token` на re-login | TOTP replay (counter не увеличен) | Counter+1 в smoke.mjs |
| Admin GET deleted user → 404 | Запустил smoke на older `develop` без #103 | `git pull --ff-only origin develop` |
| `no such table: driver_documents` | DB init order | Уже починено Владом в его PR |
| Rate-limit 429 на 50+ запросов | Случайно включил `DISPATCHOS_RATE_LIMIT=on` | Убери из env |

---

## 6. Деплой

### 6.1 Default flow

```bash
git checkout develop
git pull --ff-only origin develop
# … твои изменения, коммит, push …
git push origin develop
# GH Actions автоматом задеплоит на Fly (~3-4 минуты)
```

Workflow: `.github/workflows/deploy.yml`. Trigger: push в `develop`. Деплой идёт на `dispatchos-demo` (один app, обслуживает оба домена).

### 6.2 Manual деплой (если GH Actions упал)

```bash
flyctl deploy --app dispatchos-demo --remote-only
```

### 6.3 Verify после деплоя

```bash
curl -fsS https://dispatchos.co/api/health
# {"ok":true,"service":"...","version":"...","clients":...}
```

Если health не возвращает 200 — `flyctl logs -a dispatchos-demo`.

### 6.4 Rollback

```bash
flyctl releases list -a dispatchos-demo  # узнай номер предыдущего релиза
flyctl deploy --image registry.fly.io/dispatchos-demo:deployment-XXXXX --app dispatchos-demo
```

Или (быстрее) — revert commit на `develop` + push → автодеплой назад.

---

## 7. Где что лежит в коде

| Слой | Файлы |
|---|---|
| Express setup, middleware, rate-limit, CSRF | `server/index.ts` |
| Auth handlers (login/signup/bootstrap/totp) | `server/routes.ts` (1015-1300) |
| Admin routes (users/clients/loads/...) | `server/routes/admin.ts` |
| Dispatcher routes | `server/routes/dispatch.ts` |
| Driver routes + TG bot webhook | `server/routes/driver.ts`, `server/routes/telegram.ts` |
| Billing (Stripe checkout/portal/webhook/cron) | `server/routes/billing.ts`, `server/lib/billing/` |
| Storage (single big file, SQLite + better-sqlite3) | `server/storage.ts` |
| Schema (zod types shared между client/server) | `shared/schema.ts` |
| FMCSA / SAFER / D&A | `server/lib/fmcsa/`, `server/lib/clearinghouse/` |
| Cron jobs (insurance/UCR-IRP/trial-expiry/...) | `server/cron/*.ts` + `.github/workflows/daily-cron.yml` |
| Audit event recording | `storage.audit(...)` — search для usage patterns |
| Client app (React + Vite) | `client/src/` |
| Admin pages | `client/src/pages/admin/` |
| Dispatch pages | `client/src/pages/dispatch/` |
| Driver portal | `client/src/pages/driver/` |
| Landing (public) | `client/src/pages/landing.tsx`, `login.tsx`, `signup.tsx` |
| i18n словарь | `client/src/lib/i18n/translations.ts` |

---

## 8. Audit статус (live, для backref'ов в commit'ах)

| Раунд | Total | Critical | High | Medium/Low |
|---|---|---|---|---|
| **v1** | 51 | 7/7 done | 13/13 done (включая GPS #13 и billing off-by-one #14 от Влада) | back-fill идёт |
| **v2** | 47 | 4/4 done (#82) | 7/13 quick wins (#85) | 6 Medium/Low в backlog |
| **v3** | 47 | 5/5 done (#90) | 2/13 done (#92 + #102) | V3-7, V3-9..V3-19 в backlog |

Файлы: `DispatchOS_Bug_Audit_2026-05-26.md`, `DispatchOS_Bug_Audit_v2_2026-05-26.md`, `DispatchOS_Security_Audit_v3_2026-05-26.md` в workspace Никиты — спроси если нужно.

---

## 9. Hot priorities (5/26 evening)

Из handoff документа в порядке полезности:

1. **Anti-fraud trial защита** — ✅ Влад начал (`feat/anti-fraud-mc-unique`)
2. **FMCSA SAFER autofill в wizard step 2** — комбинируй с #1
3. **Counterparty Vetting MVP** — broker пробив, design в `DispatchOS_Counterparty_Vetting_Design.md`
4. **i18n extension** — admin/dispatch/driver shells + TG bot + email templates
5. **Audit v3 оставшиеся High** — V3-7, V3-9..V3-19

---

## 10. Когда писать в TG

**Стоит писать:**
- Сломан прод (health 500, login не работает)
- Найден security регресс
- Нужно решение по приоритетам (что брать след.)
- Готов merge большой фичи — нужен ревью

**НЕ стоит писать:**
- «Как запустить smoke» → см. секция 5
- «Какие env флаги» → см. секция 2
- «Куда деплоится» → см. секция 6
- «Что в audit v3» → см. секция 8 + workspace docs

---

## 11. Trouble: Computer Bot не отвечает

AI ассистент (этот runbook писал он) тэгается через `@DispatchOS_Computer_Bot`. Если не отвечает 30+ минут:
1. Никита спит / занят — у него в кошельке кредиты на бота кончились
2. Сделай сам по runbook'у, заметь в #48 что разрулил
3. Утром Никита напишет

---

_Обновлено: 2026-05-27. PR'ы для актуализации welcome — особенно после каждой Audit находки и каждого «вот тут я застрял»._
