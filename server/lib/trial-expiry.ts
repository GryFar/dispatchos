// ===========================================================================
// server/lib/trial-expiry.ts — daily check for expiring/expired trials
// ===========================================================================
//
// Two parallel mechanisms:
//   1. **Reminders**: alerts at T-7, T-3, T-1 days before trial ends.
//      Telegram + email to the owner. Anti-dupe via compliance_alerts_sent
//      reuse (kind = 'trial_reminder').
//
//   2. **Expiry transition**: when trialEndsAt is in the past AND the client
//      has no active Stripe subscription (or sub is canceled/past_due past
//      grace), flip billingStatus → 'expired'. Frontend gates write
//      operations behind this status.
//
// Read-only mode is enforced by middleware in server/auth.ts (added in this
// PR) — `requireActiveBilling` returns 402 on mutating endpoints when status
// is 'expired' or 'past_due' (with a 7-day grace period for past_due).
// ---------------------------------------------------------------------------

import { fetchWithTimeout } from "./fetch-timeout";
import { storage } from "../storage";
import { getIntegrationValue } from "./integration-config";
import { sendEmail } from "./email";

const REMINDER_DAYS = [7, 3, 1];

function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return Number.POSITIVE_INFINITY;
  return Math.ceil((ms - Date.now()) / (24 * 3600 * 1000));
}

interface NotifyContext {
  telegramBotToken: string | null;
  telegramChatId: string | null;
  resendFromEmail: string | null;
  ownerEmail: string | null;
}

async function sendTelegram(
  ctx: NotifyContext,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!ctx.telegramBotToken || !ctx.telegramChatId) {
    return { ok: false, error: "telegram not configured" };
  }
  try {
    const res = await fetchWithTimeout(
      `https://api.telegram.org/bot${ctx.telegramBotToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: ctx.telegramChatId,
          text,
          disable_web_page_preview: true,
        }),
      },
    );
    if (!res.ok) {
      return { ok: false, error: `tg ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export interface TrialOutcome {
  clientId: string;
  clientName: string;
  /** 'reminder' (notification only) or 'expired' (status transitioned). */
  kind: "reminder" | "expired";
  trialEndsAt: string;
  daysUntil: number;
  channels: ("telegram" | "email")[];
  errors: string[];
}

/**
 * Run one full pass — iterate clients with billingStatus='trial', fire
 * reminders or transition to 'expired' as needed. Returns outcomes for logging.
 */
export async function runTrialExpiryCheck(): Promise<TrialOutcome[]> {
  const outcomes: TrialOutcome[] = [];

  const ctx: NotifyContext = {
    telegramBotToken:
      getIntegrationValue("telegram", "TELEGRAM_BOT_TOKEN") ??
      process.env.TELEGRAM_BOT_TOKEN ??
      null,
    telegramChatId:
      getIntegrationValue("telegram", "TELEGRAM_ALERT_CHAT_ID") ??
      process.env.TELEGRAM_ALERT_CHAT_ID ??
      null,
    resendFromEmail:
      getIntegrationValue("resend", "RESEND_FROM_EMAIL") ??
      process.env.RESEND_FROM_EMAIL ??
      null,
    ownerEmail:
      getIntegrationValue("notifications", "OWNER_EMAIL") ?? process.env.OWNER_EMAIL ?? null,
  };

  const clients = storage.listClients();
  for (const client of clients) {
    const c = client as Record<string, unknown> & {
      id: string;
      name: string;
      billingStatus?: "trial" | "active" | "past_due" | "canceled" | "expired";
      trialEndsAt?: string;
      stripeSubscriptionId?: string;
    };

    if (!c.trialEndsAt) continue;
    if (c.billingStatus !== "trial") continue;

    const days = daysUntil(c.trialEndsAt);

    // Expiry transition — only if no Stripe sub OR sub is gone.
    if (days <= 0) {
      // Don't flip to 'expired' if we have an active Stripe sub — webhook
      // will reconcile that to 'active' shortly.
      if (c.stripeSubscriptionId) {
        // Webhook should have flipped status already. Skip; next pass picks
        // it up if Stripe is silent.
        continue;
      }
      // Re-read FRESH right before the write. `client` is a snapshot from the
      // top of the loop; we've since awaited network I/O for earlier clients,
      // during which a Stripe webhook may have moved THIS client to active +
      // set a subscription id. Expiring on the stale snapshot would clobber a
      // paying customer to read-only. The re-read + write are synchronous (no
      // await between) so under single-process this fully closes the race.
      const fresh = storage.getClient(c.id) as
        | (Record<string, unknown> & { billingStatus?: string; stripeSubscriptionId?: string })
        | undefined;
      if (!fresh || fresh.billingStatus !== "trial" || fresh.stripeSubscriptionId) {
        continue;
      }
      storage.upsertClient({
        ...(fresh as unknown as Parameters<typeof storage.upsertClient>[0]),
        billingStatus: "expired",
      } as Parameters<typeof storage.upsertClient>[0]);
      const text = [
        `⏰ Trial expired for ${c.name}.`,
        `Account is now read-only. Upgrade at https://dispatchos.co/#/admin/billing`,
      ].join("\n");
      const sent: ("telegram" | "email")[] = [];
      const errors: string[] = [];
      const tg = await sendTelegram(ctx, text);
      if (tg.ok) sent.push("telegram");
      else if (tg.error) errors.push(`telegram: ${tg.error}`);
      if (ctx.ownerEmail) {
        try {
          const r = await sendEmail({
            from: ctx.resendFromEmail ?? undefined,
            to: ctx.ownerEmail,
            subject: `[DispatchOS] Trial expired — ${c.name}`,
            text,
            html: `<pre style="font-family:inherit;white-space:pre-wrap">${text.replace(
              /[<>&]/g,
              (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[ch]!),
            )}</pre>`,
          });
          if (r.ok) sent.push("email");
        } catch (err) {
          errors.push(`email: ${(err as Error).message}`);
        }
      }
      storage.audit("billing.trial_expired", "client", c.id, {
        trialEndsAt: c.trialEndsAt,
        channels: sent,
      });
      outcomes.push({
        clientId: c.id,
        clientName: c.name,
        kind: "expired",
        trialEndsAt: c.trialEndsAt,
        daysUntil: days,
        channels: sent,
        errors,
      });
      continue;
    }

    // Reminders.
    if (!REMINDER_DAYS.includes(days)) continue;
    if (
      storage.hasComplianceAlertBeenSent(c.id, "trial_reminder", c.trialEndsAt, days)
    ) {
      continue;
    }
    const text = [
      `⏳ Trial ends in ${days} day${days === 1 ? "" : "s"} for ${c.name}.`,
      `Upgrade now: https://dispatchos.co/#/admin/billing`,
    ].join("\n");
    const sent: ("telegram" | "email")[] = [];
    const errors: string[] = [];
    const tg = await sendTelegram(ctx, text);
    if (tg.ok) sent.push("telegram");
    else if (tg.error) errors.push(`telegram: ${tg.error}`);
    if (ctx.ownerEmail) {
      try {
        const r = await sendEmail({
          from: ctx.resendFromEmail ?? undefined,
          to: ctx.ownerEmail,
          subject: `[DispatchOS] Trial ends in ${days} day${days === 1 ? "" : "s"} — ${c.name}`,
          text,
          html: `<pre style="font-family:inherit;white-space:pre-wrap">${text.replace(
            /[<>&]/g,
            (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[ch]!),
          )}</pre>`,
        });
        if (r.ok) sent.push("email");
      } catch (err) {
        errors.push(`email: ${(err as Error).message}`);
      }
    }
    if (sent.length > 0) {
      storage.recordComplianceAlertSent({
        clientId: c.id,
        kind: "trial_reminder",
        expiresAt: c.trialEndsAt,
        daysBefore: days,
        channels: sent,
      });
      storage.audit("billing.trial_reminder", "client", c.id, {
        daysUntil: days,
        channels: sent,
      });
    }
    outcomes.push({
      clientId: c.id,
      clientName: c.name,
      kind: "reminder",
      trialEndsAt: c.trialEndsAt,
      daysUntil: days,
      channels: sent,
      errors,
    });
  }
  return outcomes;
}
