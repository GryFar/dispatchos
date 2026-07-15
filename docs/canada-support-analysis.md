# Canada support — карта правок (анализ)

_Прочёс develop, июль 2026. Что US-захардкожено и что менять, по фазам._

## TL;DR
- **Схема НЕ мешает:** `state`/`originState`/`destinationState` = `z.string()` (без US-enum/regex) → провинции проходят валидацию **без правок**. `country` в схеме есть только на `signupLeadSchema` (маркетинг-лид), НЕ на карьере.
- **Фаза 1 (юрисдикции, ~недели):** общий список штат+провинция, геокодер, IFTA-bbox. Разблокирует кросс-бордер US-карьеров (возят в Канаду), в USD. Тумблер страны НЕ нужен.
- **Фаза 2 (валюта/compliance/единицы, ~месяцы):** CAD-биллинг, FMCSA→NSC, мили→км, `country`/`currency` на карьере. Только когда появится домашний CA-клиент.

---

## Фаза 1 — юрисдикции (кросс-бордер)

| # | Файл : строка | Что сейчас | Что сделать | Усилие |
|---|---|---|---|---|
| 1 | `client/.../dispatch/predictions.tsx:309`, `admin/load-source-new.tsx:54`, `admin/client-detail.tsx:65`, `driver/load-create.tsx:47` | `US_STATES` (50 штатов) захардкожен **в 4 копиях** | Свести в один `shared/jurisdictions.ts` = штаты **+ провинции** (ON,QC,BC,AB,MB,SK,NS,NB,NL,PE + YT,NT,NU); импортировать везде | S (дедуп + список) |
| 2 | `server/lib/geo-coords.ts` | `STATE_CENTROID` (50), `CITY_COORDS` (~40 US-метро), `STATE_NAME_TO_CODE` (US) — провинций нет. `normState` берёт любые 2 буквы, но `STATE_CENTROID["ON"]`=undefined → **null → (0,0)-баг дедхеда для CA** | Добавить центроиды провинций + крупные CA-города (Toronto, Mississauga, Windsor(!авто-хаб), Montreal, Vancouver, Calgary, Edmonton, Winnipeg, Halifax, Ottawa, Hamilton) + названия провинций в `STATE_NAME_TO_CODE` | **M (ключевое)** |
| 3 | `server/lib/ifta.ts:34` | `US_STATE_BBOX` (50). `lookupState` → null вне US → канадские мили/топливо **не привязываются к юрисдикции** | Добавить bbox провинций (IFTA = US+Canada; US-карьер в Канаде обязан отчитаться по провинциям). Переименовать в `JURISDICTION_BBOX` | M |
| 4 | `server/lib/parsers/broker-email.ts` (`parseCityState`), `sylectus.ts` | Штат `[A-Z]{2}` — **провинции уже матчатся** ✓; индекс `\d{5}` — US-only, но опционален → CA-адрес без индекса парсится норм | Опц.: добавить CA-индекс `A1A 1A1`. Низкий приоритет (коды провинций работают) | S (опц.) |
| 5 | `shared/schema.ts` (state-поля) | `z.string()` — не US-валидируется | **Ничего** — уже пермиссивно ✓ | — |

**Итог Фазы 1:** один общий список + геокодер + IFTA-bbox (+ опц. индекс). Скоринг/дедхед/IFTA начинают работать для канадских лейнов. Валюта остаётся USD (для кросс-бордер US-карьера это верно), FMCSA/биллинг не трогаем.

---

## Фаза 2 — валюта / compliance / единицы (домашняя Канада)

| # | Файл / зона | Что сейчас | Что сделать | Усилие |
|---|---|---|---|---|
| 6 | `client/src/lib/format.ts:11-22,63,77` | `moneyFormatter` захардкожен **USD**; `formatPpm`=`$…/mi`; `formatMiles`=`mi`. Вызовы передают только число (нет контекста валюты) | Добавить валюту в `formatMoney(value, currency)` + единицы; протянуть контекст валюты/единиц от карьера/груза. **Большой ripple** (каждый показ денег + биллинг) | **L** |
| 7 | `shared/schema.ts` (client/carrier) | `country`/`currency` на карьере **нет** (есть только на лиде) | Добавить `country` (US/CA) + `currency` (USD/CAD) + опц. `units` на клиента → драйвит биллинг-валюту, compliance, дефолт-единицы. Вот тут и «переключатель страны» | M |
| 8 | `server/lib/ai/enrich.ts`, `carrier-safety-profile.ts`, FMCSA-lookup, clearinghouse (routes/admin) | Всё на **FMCSA** (US MC/DOT, safety, clearinghouse) | Для CA-карьеров: скрыть/заменить FMCSA-вэттинг/safety/clearinghouse (у них NSC/провинциальное); Broker Trust Score (community) остаётся | L |
| 9 | Единицы: `formatMiles`, `formatPpm`, fuel-calc (MPG, `fuelPrice`/gallon), IFTA gallons | Мили/MPG/галлоны | Per-carrier единицы: мили↔км, галлоны↔литры, MPG↔L/100км | M |
| 10 | Stripe / биллинг | Прайсы USD, нет GST/HST | CAD Stripe-прайсы + Stripe Tax (GST/HST/PST) | M |
| 11 | i18n | Локаль `fr` уже есть | Довести fr до полноты + сделать выбираемой для CA (Квебек — двуязычность) | S–M |

---

## Рекомендация
1. **Делаем Фазу 1 сейчас** (пункты 1-3, опц. 4) — маленький самодостаточный блок, разблокирует кросс-бордер, риск минимальный, всё в моей зоне (`lib/`, парсеры, клиентские списки). Ветка `feat/canada-jurisdictions`.
2. **Фазу 2 — отдельным проектом**, когда будет реальный домашний CA-клиент (валюта/FMCSA/единицы/биллинг — это ripple по всему приложению + затрагивает биллинг-зону Никиты).

Тумблер «US/Canada» — это Фаза 2 (поле `country` на карьере), не Фаза 1.
