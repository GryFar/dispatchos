// Translation dictionary for DispatchOS.
//
// Two languages: ru (default, the team's working language) and en (for
// English-speaking carriers operating in US). Adding a third is just adding
// a new key per leaf.
//
// Convention:
//  - Keys are namespaced by surface (`nav.*`, `landing.*`, `login.*`).
//  - Values that need interpolation use `{name}` placeholders, resolved by
//    the `t()` helper at call-site.
//  - Missing keys fall back to the RU value at runtime (translations[
//    "ru"][key]) and surface a console.warn in dev so we catch drift.

export type Lang = "ru" | "en";

export const LANGS: { code: Lang; label: string; short: string }[] = [
  { code: "ru", label: "Русский", short: "RU" },
  { code: "en", label: "English", short: "EN" },
];

type Dict = Record<string, string>;

const ru: Dict = {
  // Common
  "common.login": "Войти",
  "common.loginCta": "Войти в систему",
  "common.signOut": "Выйти",
  "common.contact": "Связаться",
  "common.subscribe": "Подписаться",
  "common.email": "Email",
  "common.send": "Отправить",
  "common.sending": "Отправка...",
  "common.cancel": "Отмена",
  "common.save": "Сохранить",
  "common.close": "Закрыть",
  "common.loading": "Загрузка...",
  "common.error": "Ошибка",
  "common.success": "Готово",

  // Landing — header
  "landing.nav.features": "Возможности",
  "landing.nav.contact": "Связаться",
  "landing.nav.toHome": "На начало страницы",

  // Landing — hero
  "landing.hero.badge": "В работе с реальными перевозчиками",
  "landing.hero.titleA": "Операционная система для",
  "landing.hero.titleB": "диспатчера грузов",
  "landing.hero.subtitle":
    "DispatchOS объединяет inbound-загрузки, скоринг брокеров, GPS-трекинг водителей и compliance в один экран. Создано для car-hauler, hotshot и owner-operator команд — без enterprise-ценника.",
  "landing.hero.ctaLogin": "Войти в систему",
  "landing.hero.ctaDemo": "Запросить демо",

  // Landing — features
  "landing.feature.inbound.title": "Inbound из всех источников",
  "landing.feature.inbound.text":
    "Email-парсер ловит грузы из Sylectus, Hempstead и брокерских ratecon'ов. Telegram-бот водителя в комплекте.",
  "landing.feature.broker.title": "Broker Trust Score",
  "landing.feature.broker.text":
    "FMCSA SAFER + история платежей + сигналы от диспетчеров. Один экран — решение по тендеру.",
  "landing.feature.gps.title": "GPS и геофенсинг",
  "landing.feature.gps.text":
    "Traccar и OwnTracks ингест, авто-чекин в pickup/delivery, online-индикатор водителя.",
  "landing.feature.fuel.title": "Топливо и MPG",
  "landing.feature.fuel.text":
    "GasBuddy + EIA + crowdsource. Алерты на переплаты, реальный MPG, прогноз на маршруте.",
  "landing.feature.ifta.title": "IFTA и compliance",
  "landing.feature.ifta.text":
    "Квартальная отчётность по штатам, страховки, MCS-150, DQ-файлы — напоминалки по желанию клиента.",
  "landing.feature.ai.title": "AI-помощник",
  "landing.feature.ai.text":
    "Claude разбирает чеки, классифицирует BOL/POD, помогает в переговорах с брокером по email.",

  // Landing — trust strip
  "landing.trust.updates.label": "Свежие апдейты",
  "landing.trust.updates.value": "IFTA, Geofence, Insurance monitor",
  "landing.trust.updates.hint": "Май 2026",
  "landing.trust.montgomery.label": "Под Montgomery v. Caribe",
  "landing.trust.montgomery.value": "Carrier Safety Profile",
  "landing.trust.montgomery.hint": "paid add-on $50–100/мес",
  "landing.trust.small.label": "Для малых перевозчиков",
  "landing.trust.small.value": "1–50 trucks",
  "landing.trust.small.hint": "без per-user тарифов",

  // Landing — subscribe form
  "landing.subscribe.title": "Подписаться на рассылку",
  "landing.subscribe.subtitle": "Свежие апдейты продукта и индустриальные сигналы. Без спама.",
  "landing.subscribe.placeholder": "you@company.com",
  "landing.subscribe.cta": "Подписаться",
  "landing.subscribe.ok": "Спасибо — подписка оформлена.",
  "landing.subscribe.duplicate": "Вы уже подписаны. Никаких действий не требуется.",

  // Landing — contact inline + modal
  "landing.contact.title": "Связаться с командой",
  "landing.contact.subtitle":
    "Расскажите о вашем флоте и текущих болях — мы покажем как DispatchOS их решает.",
  "landing.contact.cta": "Открыть форму",
  "landing.contact.name": "Имя",
  "landing.contact.note": "Расскажите о флоте",
  "landing.contact.notePlaceholder":
    "Сколько трэков, какие лайны (car-hauler / hotshot / dry van...), какой главный pain.",
  "landing.contact.submit": "Отправить запрос",
  "landing.contact.ok": "Спасибо — мы свяжемся в течение суток.",

  // Landing — footer
  "landing.footer.copy":
    "© {year} DispatchOS. Создано для дальнобойщиков, диспетчеров и owner-operators в US.",

  // Login page
  "login.title": "Вход в DispatchOS",
  "login.email": "Email",
  "login.password": "Пароль",
  "login.totp": "6-значный код из Authenticator",
  "login.totpHint": "Введите 6-значный код из приложения Authenticator.",
  "login.submit": "Войти",
  "login.invalid": "Неверный email, пароль или код",
  "login.forgot": "Забыл пароль",

  // Language switcher itself
  "lang.switch": "Язык интерфейса",
  "lang.ru": "Русский",
  "lang.en": "English",
};

const en: Dict = {
  // Common
  "common.login": "Sign in",
  "common.loginCta": "Sign in",
  "common.signOut": "Sign out",
  "common.contact": "Contact",
  "common.subscribe": "Subscribe",
  "common.email": "Email",
  "common.send": "Send",
  "common.sending": "Sending...",
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.close": "Close",
  "common.loading": "Loading...",
  "common.error": "Error",
  "common.success": "Done",

  // Landing — header
  "landing.nav.features": "Features",
  "landing.nav.contact": "Contact",
  "landing.nav.toHome": "Back to top",

  // Landing — hero
  "landing.hero.badge": "In production with real carriers",
  "landing.hero.titleA": "An operating system for",
  "landing.hero.titleB": "freight dispatch",
  "landing.hero.subtitle":
    "DispatchOS unifies inbound loads, broker scoring, driver GPS tracking and compliance in a single screen. Built for car-hauler, hotshot and owner-operator teams — without the enterprise price tag.",
  "landing.hero.ctaLogin": "Sign in to the platform",
  "landing.hero.ctaDemo": "Request a demo",

  // Landing — features
  "landing.feature.inbound.title": "Inbound from every source",
  "landing.feature.inbound.text":
    "Email parser catches loads from Sylectus, Hempstead and broker ratecons. Driver Telegram bot included.",
  "landing.feature.broker.title": "Broker Trust Score",
  "landing.feature.broker.text":
    "FMCSA SAFER + payment history + dispatcher signals. One screen — one tender decision.",
  "landing.feature.gps.title": "GPS and geofencing",
  "landing.feature.gps.text":
    "Traccar and OwnTracks ingestion, auto check-in at pickup/delivery, live driver online indicator.",
  "landing.feature.fuel.title": "Fuel and MPG",
  "landing.feature.fuel.text":
    "GasBuddy + EIA + crowdsource. Overpay alerts, real-world MPG, route fuel forecast.",
  "landing.feature.ifta.title": "IFTA and compliance",
  "landing.feature.ifta.text":
    "Quarterly per-state reporting, insurance, MCS-150, DQ files — reminders your carrier opts into.",
  "landing.feature.ai.title": "AI co-pilot",
  "landing.feature.ai.text":
    "Claude parses receipts, classifies BOL/POD, and helps you negotiate with brokers over email.",

  // Landing — trust strip
  "landing.trust.updates.label": "Recent updates",
  "landing.trust.updates.value": "IFTA, Geofence, Insurance monitor",
  "landing.trust.updates.hint": "May 2026",
  "landing.trust.montgomery.label": "Per Montgomery v. Caribe",
  "landing.trust.montgomery.value": "Carrier Safety Profile",
  "landing.trust.montgomery.hint": "paid add-on $50–100/mo",
  "landing.trust.small.label": "Built for small fleets",
  "landing.trust.small.value": "1–50 trucks",
  "landing.trust.small.hint": "no per-user pricing",

  // Landing — subscribe form
  "landing.subscribe.title": "Subscribe to the newsletter",
  "landing.subscribe.subtitle": "Product updates and industry signals. No spam.",
  "landing.subscribe.placeholder": "you@company.com",
  "landing.subscribe.cta": "Subscribe",
  "landing.subscribe.ok": "Thanks — you're subscribed.",
  "landing.subscribe.duplicate": "You're already subscribed. Nothing to do here.",

  // Landing — contact inline + modal
  "landing.contact.title": "Talk to the team",
  "landing.contact.subtitle":
    "Tell us about your fleet and your current pains — we'll show how DispatchOS solves them.",
  "landing.contact.cta": "Open form",
  "landing.contact.name": "Name",
  "landing.contact.note": "Tell us about your fleet",
  "landing.contact.notePlaceholder":
    "How many trucks, which lanes (car-hauler / hotshot / dry van...), what's the biggest pain.",
  "landing.contact.submit": "Send request",
  "landing.contact.ok": "Thanks — we'll be in touch within a day.",

  // Landing — footer
  "landing.footer.copy":
    "© {year} DispatchOS. Built for truckers, dispatchers and owner-operators in the US.",

  // Login page
  "login.title": "Sign in to DispatchOS",
  "login.email": "Email",
  "login.password": "Password",
  "login.totp": "6-digit code from your authenticator",
  "login.totpHint": "Enter the 6-digit code from your Authenticator app.",
  "login.submit": "Sign in",
  "login.invalid": "Invalid email, password or 2FA code",
  "login.forgot": "Forgot password",

  // Language switcher itself
  "lang.switch": "Interface language",
  "lang.ru": "Русский",
  "lang.en": "English",
};

export const TRANSLATIONS: Record<Lang, Dict> = { ru, en };

/**
 * Resolve a translation key. Falls back to RU value, then to the key itself.
 * Supports {placeholder} interpolation.
 */
export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const dict = TRANSLATIONS[lang] || TRANSLATIONS.ru;
  let value = dict[key];
  if (value === undefined) {
    value = TRANSLATIONS.ru[key];
    if (value === undefined) {
      if (typeof console !== "undefined" && import.meta.env?.DEV) {
        console.warn(`[i18n] missing key: ${key}`);
      }
      return key;
    }
  }
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      value = value.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return value;
}
