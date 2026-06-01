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

import { storage } from "../storage";
import { getIntegrationValue } from "./integration-config";
import { sendEmail } from "./email";
import { daysBetween } from "./date-utils";
import { pickAlertThreshold } from "./alert-thresholds";

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
      const r = await fetch(
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

  // Email (owner).
  if (opts.ownerEmail) {
    const html =
      `<p><strong>${headline}</strong></p>` +
      `<p>Carrier: ${opts.clientName} (${opts.clientId})<br>` +
      `Дата истечения: <strong>${opts.expiresAt}</strong></p>` +
      `<p>Обновите документ в DispatchOS → Клиенты → ${opts.clientName} → Профиль. Пока страховка просрочена — брокеры откажутся диспатчить грузы этому carrier'у.</p>`;
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
  const tgChatId = process.env.TELEGRAM_ALERT_CHAT_ID ?? null;

  // Owner email: explicit override > env > first active admin user.
  let ownerEmail: string | null =
    ownerEmailOverride ?? process.env.DISPATCHOS_OWNER_EMAIL ?? null;
  if (!ownerEmail) {
    const owners = storage
      .listUsers()
      .filter((u) => u.role === "admin" && !u.blocked && !u.deletedAt);
    if (owners.length > 0) ownerEmail = owners[0].email;
  }

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
        storage.recordInsuranceAlertSent({
          clientId: client.id,
          insuranceType: typeKey,
          expiresAt,
          daysBefore: threshold,
          channels,
        });
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
