// ===========================================================================
// server/lib/insurance-monitor.ts — daily check for upcoming insurance expiry
// ===========================================================================
//
// One call to runInsuranceCheck() iterates every active client and, for each
// of the three insurance types, computes days-until-expiry. If that lands in
// our alert thresholds (14/7/3/1 days, or already-expired), AND we haven't
// already sent an alert for that exact (client, type, expires_at, threshold)
// — we send it via Telegram (admin alert chat) + email (owner).
//
// Why thresholds and not «every day under 14»: we want anti-spam. Sending
// once at T-14, once at T-7, once at T-3, once at T-1, once on the day, and
// then again as it goes past expiry would be the cleanest UX. We do exactly
// that here via ALERT_THRESHOLDS + an anti-dupe row per threshold.
// ---------------------------------------------------------------------------

import { fetchWithTimeout } from "./fetch-timeout";
import { storage } from "../storage";
import { getIntegrationValue } from "./integration-config";
import { sendEmail, escapeHtml } from "./email";
import { daysBetween } from "./date-utils";
import { pickAlertThreshold } from "./alert-thresholds";
import { resolveOwnerEmail } from "./owner-email";

/** Alert thresholds in days-before-expiry. 0 = expired today, -N = N days past. */
const ALERT_THRESHOLDS: number[] = [14, 7, 3, 1, 0, -1, -7];

type InsuranceField =
  | "cargoInsuranceExpiresAt"
  | "autoLiabilityExpiresAt"
  | "generalLiabilityExpiresAt";

const FIELD_TO_KEY: Record<InsuranceField, "cargo" | "auto_liability" | "general_liability"> = {
  cargoInsuranceExpiresAt: "cargo",
  autoLiabilityExpiresAt: "auto_liability",
  generalLiabilityExpiresAt: "general_liability",
};

const TYPE_LABEL: Record<string, string> = {
  cargo: "Cargo insurance",
  auto_liability: "Auto liability",
  general_liability: "General liability",
};

/**
 * True only when `value` begins with a real YYYY-MM-DD calendar date (extra
 * time/zone suffix allowed). We must validate before calling daysBetween():
 * daysBetween returns 0 for any unparseable string, which collides with the
 * "expires today" threshold (0) and would fire a false 🔴 СЕГОДНЯ alert for a
 * garbage value like "TBD".
 */
function isValidExpiryDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return false;
  const [, ys, ms, ds] = m;
  const y = Number(ys);
  const mo = Number(ms);
  const d = Number(ds);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  // Round-trip through Date.UTC to reject impossible days (e.g. 2026-02-30).
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d
  );
}

function buildHeadline(insuranceLabel: string, daysBefore: number): string {
  if (daysBefore > 0) {
    return `⚠️ ${insuranceLabel} истекает через ${daysBefore} дн.`;
  }
  if (daysBefore === 0) {
    return `🔴 ${insuranceLabel} истекает СЕГОДНЯ`;
  }
  return `🔴 ${insuranceLabel} ПРОСРОЧЕНА на ${Math.abs(daysBefore)} дн.`;
}

async function notify(opts: {
  clientName: string;
  clientId: string;
  insuranceLabel: string;
  expiresAt: string;
  daysBefore: number;
  ownerEmail: string | null;
  tgChatId: string | null;
  tgBotToken: string | null;
}): Promise<string[]> {
  const channels: string[] = [];
  const headline = buildHeadline(opts.insuranceLabel, opts.daysBefore);
  const lines = [
    headline,
    "",
    `Carrier: ${opts.clientName} (${opts.clientId})`,
    `Дата истечения: ${opts.expiresAt}`,
    "",
    `Обновите документ в DispatchOS → Клиенты → ${opts.clientName} → Профиль. Пока страховка просрочена — брокеры откажутся диспатчить грузы этому carrier'у.`,
  ];
  const body = lines.join("\n");

  // Telegram (admin alert chat).
  if (opts.tgBotToken && opts.tgChatId) {
    try {
      const r = await fetchWithTimeout(
        `https://api.telegram.org/bot${opts.tgBotToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: opts.tgChatId, text: body }),
        },
      );
      if (r.ok) channels.push("telegram");
      else console.error("[insurance-monitor] TG send failed:", await r.text());
    } catch (err) {
      console.error("[insurance-monitor] TG send error:", err);
    }
  }

  // Email (owner). Escape every tenant-supplied value (carrier name, id,
  // expiry) before interpolating into the HTML body — these come from the
  // client record and would otherwise allow HTML/markup injection into the
  // owner's alert email.
  if (opts.ownerEmail) {
    const safeName = escapeHtml(opts.clientName);
    const safeId = escapeHtml(opts.clientId);
    const safeExpiresAt = escapeHtml(opts.expiresAt);
    const safeHeadline = escapeHtml(headline);
    const html =
      `<p><strong>${safeHeadline}</strong></p>` +
      `<p>Carrier: ${safeName} (${safeId})<br>` +
      `Дата истечения: <strong>${safeExpiresAt}</strong></p>` +
      `<p>Обновите документ в DispatchOS → Клиенты → ${safeName} → Профиль. Пока страховка просрочена — брокеры откажутся диспатчить грузы этому carrier'у.</p>`;
    const result = await sendEmail({
      to: opts.ownerEmail,
      subject: headline,
      text: body,
      html,
    });
    if (result.ok) channels.push("email");
  }

  return channels;
}

export interface InsuranceCheckResult {
  totalClientsChecked: number;
  alertsSent: Array<{
    clientId: string;
    clientName: string;
    insuranceType: string;
    expiresAt: string;
    daysBefore: number;
    channels: string[];
  }>;
  skippedAsAlreadySent: number;
}

export async function runInsuranceCheck(
  todayIso: string = new Date().toISOString().slice(0, 10),
  ownerEmailOverride?: string | null,
): Promise<InsuranceCheckResult> {
  const clients = storage.listClients();
  const tgBotToken =
    getIntegrationValue("telegram_driver_bot", "TELEGRAM_DRIVER_BOT_TOKEN") ?? null;
  // Resolve the alert chat id through the same integration-config path as the
  // bot token (canonical telegram_driver_bot key) so an operator who configures
  // telegram via the admin UI — with no env var — still gets a chat id instead
  // of a silent null that suppresses all Telegram alerts. Mirrors
  // compliance-renewals / trial-expiry / inbound.
  const tgChatId =
    getIntegrationValue("telegram_driver_bot", "TELEGRAM_ALERT_CHAT_ID") ??
    process.env.TELEGRAM_ALERT_CHAT_ID ??
    null;

  // Owner email — unified resolver (override > integration > env > first admin).
  const ownerEmail = resolveOwnerEmail(ownerEmailOverride);

  const alertsSent: InsuranceCheckResult["alertsSent"] = [];
  let skipped = 0;

  for (const client of clients) {
    const fields: InsuranceField[] = [
      "cargoInsuranceExpiresAt",
      "autoLiabilityExpiresAt",
      "generalLiabilityExpiresAt",
    ];
    for (const f of fields) {
      const expiresAt = (client as unknown as Record<string, unknown>)[f] as
        | string
        | undefined;
      if (!expiresAt) continue;

      // Guard against unparseable values ("TBD", whitespace, free text): without
      // this, daysBetween() returns 0 for them, which pickAlertThreshold maps to
      // the "expires today" milestone and fires a spurious 🔴 СЕГОДНЯ alert.
      if (!isValidExpiryDate(expiresAt)) {
        console.warn(
          `[insurance-monitor] skipping unparseable ${f} for client ${client.id}:`,
          expiresAt,
        );
        continue;
      }

      const daysUntil = daysBetween(todayIso, expiresAt);
      const threshold = pickAlertThreshold(daysUntil, ALERT_THRESHOLDS);
      if (threshold === null) continue;

      const typeKey = FIELD_TO_KEY[f];
      if (
        storage.hasInsuranceAlertBeenSent(client.id, typeKey, expiresAt, threshold)
      ) {
        skipped++;
        continue;
      }

      const channels = await notify({
        clientName: client.name,
        clientId: client.id,
        insuranceLabel: TYPE_LABEL[typeKey] ?? typeKey,
        expiresAt,
        daysBefore: threshold,
        ownerEmail,
        tgChatId,
        tgBotToken,
      });
      if (channels.length > 0) {
        // Guard the SQLite write (which also emits the audit row): a
        // busy/locked/constraint throw here must not abort the whole pass and
        // skip every remaining (client, insurance-type). Log it and carry on —
        // the alert still gets reported in alertsSent below. Mirrors
        // compliance-renewals.ts.
        try {
          storage.recordInsuranceAlertSent({
            clientId: client.id,
            insuranceType: typeKey,
            expiresAt,
            daysBefore: threshold,
            channels,
          });
        } catch (err) {
          console.error(
            `[insurance-monitor] failed to record alert for client ${client.id} (${typeKey}):`,
            err,
          );
        }
      }

      alertsSent.push({
        clientId: client.id,
        clientName: client.name,
        insuranceType: typeKey,
        expiresAt,
        daysBefore: threshold,
        channels,
      });
    }
  }

  return {
    totalClientsChecked: clients.length,
    alertsSent,
    skippedAsAlreadySent: skipped,
  };
}
