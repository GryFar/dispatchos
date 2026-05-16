# Phase 3 — Driver & Dispatcher Portals: Structure Brief

**Готовится к созвону Никита ↔ Влад.**
Цель документа: зафиксировать структуру до начала вёрстки чтобы не переделывать.
База: [`role-matrix.md`](./role-matrix.md) — роли, permissions, endpoints уже определены.

---

## 1. Глобальные решения (зафиксированы)

| Что | Решение |
|---|---|
| Theme | **Dark везде.** `bg #0a0e1a`, `accent #f59e0b` (orange), `text #e8efe9`. Под лендинг. Admin портал перекрашиваем в эту же тему. |
| Signup водителя | **Hybrid.** Открытого `/signup` нет. Водитель оставляет email на лендинге → попадает в `signup_leads` KV → диспетчер видит в админке вкладку «Заявки» → одобряет → система генерит invite через `POST /api/admin/invites` → отправка email с magic link. |
| Signup диспетчера | **Invite-only из админки.** Никаких заявок. Owner вручную создаёт через инвайт. |
| Mobile-first для driver | Driver portal **в первую очередь mobile** (водитель в кабине, не за компом). Dispatcher portal — desktop-first (диспетчер за двумя мониторами). |
| Язык по умолчанию | По cookie `lang` (UA/RU/EN) — как на лендинге. Driver: дефолт = язык invite-letter. Dispatcher: выбор в профиле. |

---

## 2. Driver Portal (`/d/*`)

### 2.1 Главный экран `/d` (Dashboard)

**Иерархия экрана (mobile, сверху вниз):**

1. **Status card** — большая карточка наверху, цвет фона = текущий статус
   - `🟢 На грузе` — показывает текущий load: route, ETA, broker name, pickup/drop addresses, "Open BOL", "Check-in" CTA
   - `🟡 Свободен` — "Жду назначения", счётчик дней без груза, кнопка «Сообщить локацию» (отправит GPS диспетчеру)
   - `🔴 Off-duty` — HOS reset, кнопка «Готов брать» (переключение статуса)

2. **Сегодня (Today panel)**
   - Pickup или delivery сегодня — карточка с часами, адресом, контактом receiver
   - Если ничего сегодня — "Следующий груз через N дней"

3. **Quick actions row** (4 кнопки)
   - 📷 Загрузить POD/BOL фото
   - 💰 Прислать receipt (fuel, parking, repair)
   - ⚠️ Сообщить о проблеме (breakdown, accident, broker dispute)
   - 📞 Позвонить диспетчеру (one-tap, открывает Twilio dial)

4. **History panel (последние 3 рейса)** — компактный список: route, $, статус. Тап → детали.

5. **Bottom nav** (4 таба): Home / Loads / Documents / Profile

### 2.2 Endpoints (новые для Phase 3)

```
GET    /api/me/dashboard          — все данные главного экрана одним запросом
GET    /api/me/loads              — список рейсов водителя
GET    /api/me/loads/:id          — детали рейса
POST   /api/me/loads/:id/checkin  — push геолокации
POST   /api/me/loads/:id/pod      — multipart upload фото
POST   /api/me/expenses           — receipt с фото
POST   /api/me/status             — toggle on/off-duty
POST   /api/me/issue              — сообщить о проблеме (создаёт ApprovalTask для dispatcher)
GET    /api/me/documents          — личные доки (CDL, medical, COI, W9)
PATCH  /api/me/profile            — обновить лично данные
```

### 2.3 Что НЕ показываем водителю

- Внутренний AI-скор груза
- Брокерская маржа / commission
- Внутренние notes диспетчера
- Другие водители команды
- Брокерская риск-оценка (только summary через `🟢/🟡/🔴` если broker сомнительный)

---

## 3. Dispatcher Portal (`/dp/*`)

### 3.1 Главный экран `/dp` (Ops Dashboard)

**Layout (desktop, left-sidebar + main):**

**Left sidebar:**
- Аватар + имя диспетчера
- Список **моих клиентов-водителей** (только assignments где `dispatcherId = self.id`)
  - Каждый клиент: статус-индикатор `🟢/🟡/🔴`, текущий груз short summary
  - Бейдж непрочитанных сообщений
- Внизу sidebar: «+ Все клиенты команды» (для admin) или «Запросить assignment» (для dispatcher)

**Main area (3 колонки):**

1. **Колонка 1 — Pipeline (новые предложения грузов)**
   - AI-suggestions из `/api/dispatch/suggestions` для каждого свободного водителя
   - Карточка: route, $, broker, AI-score, deadhead, PPM
   - Кнопки: Book / Counter / Skip
   - Фильтры наверху: equipment, lane, min PPM

2. **Колонка 2 — Активные рейсы**
   - Все loads моих клиентов в статусах `booked / in_transit / at_delivery`
   - Real-time updates (WS) при check-in от водителя
   - Кнопки: Open BOL, Message broker, Update status

3. **Колонка 3 — Approvals & Alerts**
   - ApprovalTasks (грузы ждущие одобрения клиента)
   - Documents expiring (COI/CDL за 60 дней до)
   - Issues от водителей (breakdown, dispute)
   - Broker fraud flags
   - Каждый item с CTA: Resolve / Escalate / Snooze

**Top bar:**
- Глобальный поиск (load #, broker MC, driver name)
- Quick add (новый load / новый broker contact)
- Уведомления (badge с count)
- Switcher language

### 3.2 Endpoints (новые для Phase 3)

```
GET   /api/dispatch/dashboard        — главный экран
GET   /api/dispatch/suggestions      — AI-suggestions per truck
POST  /api/dispatch/loads/:id/book   — букнуть груз
POST  /api/dispatch/loads/:id/counter — counter-offer брокеру
GET   /api/dispatch/clients          — мои клиенты (с фильтром по assignment)
GET   /api/dispatch/clients/:id      — детали клиента
GET   /api/dispatch/approvals        — очередь approval tasks
POST  /api/dispatch/approvals/:id/resolve
GET   /api/dispatch/alerts           — все alerts с приоритетом
POST  /api/dispatch/messages         — отправить сообщение брокеру / водителю
GET   /api/dispatch/leads            — заявки с лендинга (для одобрения)
POST  /api/dispatch/leads/:id/approve — генерит invite и шлёт email
```

### 3.3 Что НЕ показываем диспетчеру

- Билинг engine (`/api/admin/billing/*`) — только admin
- Другие диспетчеры команды и их клиенты (только если admin даст view-permission)
- System health / integrations / API keys
- User management — нельзя создать другого user, только request к admin

---

## 4. Hybrid Signup Flow (детали)

```
[Landing] → user submits email → POST /api/subscribe → KV `sub:{email}`
                                                       ↓
[Admin "Заявки" tab] → reads KV `sub:*` + signup_leads
                       ↓
                  Диспетчер видит:
                  • email + ts + country + UA
                  • кнопки: Одобрить / Отклонить / В спам
                       ↓
[Approve clicked] → POST /api/admin/invites { email, role: "driver" | "dispatcher", lang }
                       ↓
                  Backend генерит invite_token (24h TTL)
                  Шлёт email с magic link: https://app.dispatchos.co/i/{token}
                       ↓
[User clicks magic link] → /i/{token} → форма доукомплектации (имя, MC если driver, phone, password)
                       ↓
                  POST /api/auth/complete-signup { token, ... }
                       ↓
                  User создан, redirect → /d (driver) или /dp (dispatcher)
```

**Безопасность:**
- Invite token: 32 байта random, hashed в БД (как password)
- TTL: 24 часа, после — лидер должен запросить новый
- Email только из домена `noreply@dispatchos.co` (DKIM проверен)
- Rate limit на `/api/admin/invites`: 10/мин на dispatcher

---

## 5. Open Questions для созвона

1. **Driver portal — нативное приложение или PWA?**
   PWA проще, мобильный браузер большинство водителей юзают. Native — позже на iOS/Android если будет MRR.

2. **Real-time updates (WS) или polling?**
   Phase 3 — polling 30s достаточно для MVP. WS добавим в Phase 4 если будет нагрузка.

3. **Twilio for click-to-call?**
   У нас connector подключен. Driver portal "Позвонить диспетчеру" → Twilio masking number. Затраты ~$1/мес/номер + $0.013/мин.

4. **Push notifications для driver?**
   Web Push API через service worker, бесплатно. Триггеры: new load assigned, broker message, approval needed.

5. **Onboarding wizard для нового водителя**
   После complete-signup — wizard: upload CDL → upload COI → upload W9 → done. Без этих 3 доков водитель не виден диспетчерам в pipeline.

6. **Phase 3 timeline?**
   Driver portal MVP (dashboard + loads + POD upload) — 1 неделя?
   Dispatcher portal MVP (pipeline + approvals) — 1.5 недели?

---

## 6. Что НЕ в Phase 3

- Биллинг для клиентов (Stripe subscribe) → Phase 4
- AI-suggestions реально работающий (сейчас stub) → Phase 4-5
- Client portal (carrier owner) → Phase 5
- Mobile native apps → Phase 6+
- Multi-language emails / SMS → Phase 4
- Полноценный chat-thread на load → Phase 4

---

*Документ для синхронизации Никита ↔ Влад. Правки приветствуются — рисуйте wireframes / ставьте комменты прямо в файл.*
