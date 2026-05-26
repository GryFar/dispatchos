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
  "login.subtitle": "Используйте email и пароль. Если включён 2FA — также код из аутентификатора.",
  "login.email": "Email",
  "login.password": "Пароль",
  "login.totp": "Код из аутентификатора",
  "login.totpHint": "6 цифр из Google Authenticator / 1Password / Authy.",
  "login.totpAlert": "Введите 6-значный код из приложения-аутентификатора.",
  "login.submit": "Войти",
  "login.forgot": "Забыли пароль?",
  "login.noAccount": "Нет аккаунта?",
  "login.signupLink": "Войти по invite-коду",
  "login.errorInvalid": "Неверный email или пароль.",
  "login.errorBlocked": "Учётная запись заблокирована. Свяжитесь с администратором.",
  "login.errorRateLimit": "Слишком много попыток. Попробуйте через 15 минут.",
  "login.errorNetwork": "Не удалось подключиться к серверу.",
  "login.reasonBlocked": "Доступ к учётной записи приостановлен.",
  "login.reasonExpired": "Сессия истекла. Войдите снова.",

  // Auth shell (login/signup/forgot-password wrapper)
  "auth.shell.tagline": "DispatchOS — внутренний диспетчерский сервис. Доступ только по приглашениям.",

  // Signup page
  "signup.title": "Регистрация",
  "signup.subtitle": "Введите invite-код, полученный от администратора.",
  "signup.inviteCode": "Invite-код",
  "signup.fullName": "ФИО",
  "signup.fullNamePlaceholder": "Иван Петров",
  "signup.password": "Пароль (мин. 10 символов)",
  "signup.submit": "Создать аккаунт",
  "signup.haveAccount": "Уже есть аккаунт?",
  "signup.loginLink": "Войти",
  "signup.errorInvite": "Invite-код не найден, истёк или уже использован.",
  "signup.errorEmailTaken": "Этот email уже зарегистрирован.",
  "signup.strengthWeak": "Слабый",
  "signup.strengthMedium": "Средний",
  "signup.strengthGood": "Хороший",
  "signup.strengthStrong": "Сильный",
  "signup.validation.inviteRequired": "Введите invite-код",
  "signup.validation.emailInvalid": "Введите корректный email",
  "signup.validation.fullNameRequired": "Введите ФИО",
  "signup.validation.passwordMin": "Минимум 10 символов",
  "signup.validation.passwordMax": "Слишком длинный",
  "signup.validation.emailRequired": "Введите корректный email",
  "signup.validation.passwordRequired": "Введите пароль",
  "signup.totpTitle": "Настройте 2FA",
  "signup.totpSubtitle": "Отсканируйте QR-код в приложении Google Authenticator, 1Password или Authy.",
  "signup.totpManual": "Или введите секрет вручную:",
  "signup.totpWarning": "Сохраните секрет! Без него вы не сможете войти при потере телефона. Запишите его в менеджере паролей.",
  "signup.totpContinue": "Я отсканировал, продолжить",
  "signup.copyAria": "Копировать",
  "signup.createdTitle": "Аккаунт создан",
  "signup.createdBody": "Сейчас вы будете перенаправлены в портал.",
  "signup.createdContinue": "Продолжить",

  // Forgot password page
  "forgot.title": "Сброс пароля",
  "forgot.body": "Свяжитесь с администратором DispatchOS — он сбросит ваш пароль и выдаст временный. После входа с временным паролем смените его в настройках.",
  "forgot.note": "Самостоятельный сброс по email появится в следующем релизе.",
  "forgot.backToLogin": "Вернуться к входу",

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
  "login.subtitle": "Use your email and password. If 2FA is enabled — also the code from your authenticator app.",
  "login.email": "Email",
  "login.password": "Password",
  "login.totp": "Authenticator code",
  "login.totpHint": "6 digits from Google Authenticator / 1Password / Authy.",
  "login.totpAlert": "Enter the 6-digit code from your authenticator app.",
  "login.submit": "Sign in",
  "login.forgot": "Forgot password?",
  "login.noAccount": "No account?",
  "login.signupLink": "Sign in with an invite code",
  "login.errorInvalid": "Invalid email or password.",
  "login.errorBlocked": "Account is blocked. Contact your administrator.",
  "login.errorRateLimit": "Too many attempts. Try again in 15 minutes.",
  "login.errorNetwork": "Could not reach the server.",
  "login.reasonBlocked": "Account access has been suspended.",
  "login.reasonExpired": "Your session has expired. Please sign in again.",

  // Auth shell (login/signup/forgot-password wrapper)
  "auth.shell.tagline": "DispatchOS — internal dispatch platform. Access is invitation-only.",

  // Signup page
  "signup.title": "Create an account",
  "signup.subtitle": "Enter the invite code provided by your administrator.",
  "signup.inviteCode": "Invite code",
  "signup.fullName": "Full name",
  "signup.fullNamePlaceholder": "John Smith",
  "signup.password": "Password (min. 10 characters)",
  "signup.submit": "Create account",
  "signup.haveAccount": "Already have an account?",
  "signup.loginLink": "Sign in",
  "signup.errorInvite": "Invite code not found, expired, or already used.",
  "signup.errorEmailTaken": "This email is already registered.",
  "signup.strengthWeak": "Weak",
  "signup.strengthMedium": "Medium",
  "signup.strengthGood": "Good",
  "signup.strengthStrong": "Strong",
  "signup.validation.inviteRequired": "Enter the invite code",
  "signup.validation.emailInvalid": "Enter a valid email",
  "signup.validation.fullNameRequired": "Enter your full name",
  "signup.validation.passwordMin": "At least 10 characters",
  "signup.validation.passwordMax": "Too long",
  "signup.validation.emailRequired": "Enter a valid email",
  "signup.validation.passwordRequired": "Enter a password",
  "signup.totpTitle": "Set up 2FA",
  "signup.totpSubtitle": "Scan the QR code in Google Authenticator, 1Password, or Authy.",
  "signup.totpManual": "Or enter the secret manually:",
  "signup.totpWarning": "Save the secret! Without it you won't be able to sign in if you lose your phone. Store it in your password manager.",
  "signup.totpContinue": "I've scanned it, continue",
  "signup.copyAria": "Copy",
  "signup.createdTitle": "Account created",
  "signup.createdBody": "You'll be redirected to your portal in a moment.",
  "signup.createdContinue": "Continue",

  // Forgot password page
  "forgot.title": "Reset password",
  "forgot.body": "Contact your DispatchOS administrator — they will reset your password and issue a temporary one. After signing in with the temporary password, change it in your settings.",
  "forgot.note": "Self-service email reset is coming in the next release.",
  "forgot.backToLogin": "Back to sign in",

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
