// Outbound email via Resend.
//
// Centralised helper so route code doesn't have to know about Resend specifics
// or HTML/text fallbacks. If RESEND_API_KEY is missing we degrade gracefully
// (log + return null) so dev environments work without the secret.

import { fetchWithTimeout } from "./fetch-timeout";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Override sender. Default: noreply@talk.dispatchos.co (verified domain). */
  from?: string;
  /** ReplyTo header. Defaults to dispatch@dispatchos.co for human follow-up. */
  replyTo?: string;
  /** Tags for Resend analytics (max 10, alphanumeric + dash). */
  tags?: Array<{ name: string; value: string }>;
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  error?: string;
}

const DEFAULT_FROM = "DispatchOS <noreply@talk.dispatchos.co>";
const DEFAULT_REPLY_TO = "dispatch@dispatchos.co";

/**
 * Escape a string for safe interpolation into HTML text or a double/single
 * quoted attribute value. Neutralises markup ("<", ">"), attribute breakout
 * (the quote chars) and entity injection ("&"). Use on EVERY dynamic value
 * placed into an outbound HTML email body.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  // Read via integration-config so admins can override the Fly secret
  // from the UI without redeploying.
  const { getIntegrationValue } = await import("./integration-config");
  const key = getIntegrationValue("resend", "RESEND_API_KEY");
  if (!key) {
    console.warn("[email] RESEND_API_KEY missing — skipping send", { to: input.to, subject: input.subject });
    return { ok: false, error: "no_api_key" };
  }

  try {
    const r = await fetchWithTimeout("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        from: input.from ?? DEFAULT_FROM,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
        reply_to: input.replyTo ?? DEFAULT_REPLY_TO,
        tags: input.tags,
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.error("[email] Resend non-OK", r.status, body.slice(0, 300));
      return { ok: false, error: `resend_${r.status}` };
    }
    const data = (await r.json()) as { id?: string };
    return { ok: true, id: data.id };
  } catch (err) {
    console.error("[email] fetch failed", err);
    return { ok: false, error: "network_error" };
  }
}

// ---------------------------------------------------------------------------
// Invite email template
// ---------------------------------------------------------------------------

export interface InviteEmailInput {
  to: string;
  signupUrl: string;
  role: "driver" | "dispatcher" | "admin";
  /** Inviter's first name, for the personal touch. */
  inviterName?: string;
  /** Plain language code (en / ru / uk). Defaults to en. */
  lang?: "en" | "ru" | "uk";
  /** ISO 8601 expiry timestamp. */
  expiresAt: string;
}

export async function sendInviteEmail(input: InviteEmailInput): Promise<SendEmailResult> {
  const lang = input.lang ?? "en";
  const t = INVITE_COPY[lang];
  const roleName = t.roles[input.role];
  const inviter = input.inviterName ? `${input.inviterName} (DispatchOS)` : "DispatchOS";
  const expires = new Date(input.expiresAt).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    timeZoneName: "short",
  });

  const subject = t.subject.replace("{role}", roleName);

  // Escape every dynamic value before interpolating into the HTML body to
  // prevent HTML injection / stored-XSS (inviterName is user-controlled, and
  // signupUrl carries an external host + query string). The plain-text body
  // below uses the raw values intentionally.
  const inviterHtml = escapeHtml(inviter);
  const roleNameHtml = escapeHtml(roleName);
  const subjectHtml = escapeHtml(subject);
  const signupUrlHtml = escapeHtml(input.signupUrl);
  const html = `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${subjectHtml}</title></head>
<body style="margin:0;padding:0;background:#f7f6f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#28251D;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:12px;border:1px solid #D4D1CA;overflow:hidden;">
        <tr><td style="padding:32px 32px 8px;">
          <div style="font-size:13px;letter-spacing:1px;color:#7A7974;text-transform:uppercase;">DispatchOS</div>
          <h1 style="margin:16px 0 0;font-size:24px;line-height:1.3;color:#28251D;">${t.heading.replace("{role}", roleNameHtml)}</h1>
        </td></tr>
        <tr><td style="padding:24px 32px 8px;font-size:15px;line-height:1.6;color:#28251D;">
          <p style="margin:0 0 16px;">${t.greeting.replace("{inviter}", inviterHtml)}</p>
          <p style="margin:0 0 24px;">${t.body.replace("{role}", roleNameHtml)}</p>
          <p style="margin:0 0 32px;">
            <a href="${signupUrlHtml}" style="display:inline-block;background:#01696F;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:15px;">${t.cta}</a>
          </p>
          <p style="margin:0 0 8px;font-size:13px;color:#7A7974;">${t.expires.replace("{expires}", expires)}</p>
          <p style="margin:0 0 24px;font-size:13px;color:#7A7974;">${t.fallback}</p>
          <p style="margin:0;font-size:13px;color:#7A7974;word-break:break-all;"><a href="${signupUrlHtml}" style="color:#01696F;">${signupUrlHtml}</a></p>
        </td></tr>
        <tr><td style="padding:24px 32px;border-top:1px solid #D4D1CA;font-size:12px;color:#7A7974;">
          ${t.footer}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `${t.heading.replace("{role}", roleName)}`,
    "",
    t.greeting.replace("{inviter}", inviter),
    t.body.replace("{role}", roleName),
    "",
    `${t.cta}: ${input.signupUrl}`,
    "",
    t.expires.replace("{expires}", expires),
    "",
    t.footer,
  ].join("\n");

  return sendEmail({
    to: input.to,
    subject,
    html,
    text,
    tags: [
      { name: "type", value: "invite" },
      { name: "role", value: input.role },
      { name: "lang", value: lang },
    ],
  });
}

// ---------------------------------------------------------------------------
// Translations
// ---------------------------------------------------------------------------

interface InviteCopy {
  subject: string;
  heading: string;
  greeting: string;
  body: string;
  cta: string;
  expires: string;
  fallback: string;
  footer: string;
  roles: { driver: string; dispatcher: string; admin: string };
}

const INVITE_COPY: Record<"en" | "ru" | "uk", InviteCopy> = {
  en: {
    subject: "Your DispatchOS {role} invite",
    heading: "You're invited as a {role}",
    greeting: "Hi — {inviter} just invited you to DispatchOS.",
    body: "Click the button below to set up your {role} account and start receiving load offers. Takes about 2 minutes.",
    cta: "Complete signup",
    expires: "Invite expires {expires}.",
    fallback: "If the button doesn't work, copy and paste this URL into your browser:",
    footer: "DispatchOS — dispatcher service for hot-shot &amp; car hauler owner-operators. If you weren't expecting this, ignore this email.",
    roles: { driver: "driver", dispatcher: "dispatcher", admin: "administrator" },
  },
  ru: {
    subject: "Приглашение в DispatchOS ({role})",
    heading: "Вас пригласили как {role}",
    greeting: "Привет! {inviter} пригласил тебя в DispatchOS.",
    body: "Нажми кнопку ниже чтобы настроить аккаунт {role} и начать получать предложения грузов. Займёт около 2 минут.",
    cta: "Завершить регистрацию",
    expires: "Приглашение действительно до {expires}.",
    fallback: "Если кнопка не работает — скопируй ссылку в браузер:",
    footer: "DispatchOS — диспетчерский сервис для hot shot и car hauler owner-operators. Если ты не ожидал это письмо — просто игнорируй.",
    roles: { driver: "водитель", dispatcher: "диспетчер", admin: "администратор" },
  },
  uk: {
    subject: "Запрошення до DispatchOS ({role})",
    heading: "Вас запрошено як {role}",
    greeting: "Привіт! {inviter} запросив тебе до DispatchOS.",
    body: "Натисни кнопку нижче щоб налаштувати акаунт {role} і почати отримувати пропозиції вантажів. Займе близько 2 хвилин.",
    cta: "Завершити реєстрацію",
    expires: "Запрошення дійсне до {expires}.",
    fallback: "Якщо кнопка не працює — скопіюй посилання в браузер:",
    footer: "DispatchOS — диспетчерський сервіс для hot shot і car hauler owner-operators. Якщо ти не очікував цього листа — просто проігноруй.",
    roles: { driver: "водій", dispatcher: "диспетчер", admin: "адміністратор" },
  },
};
