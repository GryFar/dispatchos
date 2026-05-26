// ===========================================================================
// server/lib/compliance-renewals.ts — UCR/IRP renewal calendar monitor
// ===========================================================================
//
// Killer feature #5 (roadmap 2026-05-26). Saves carriers $500-2000 in missed
// renewal penalties. Two filings are required and easy to forget:
//
//   • UCR — Unified Carrier Registration (49 CFR Part 367).
//       Annual fee scaled by fleet size. Due Sept 30 each year; enforcement
//       starts Jan 1 of the next year. Late fee + cannot legally operate
//       interstate without it. Filed at https://www.ucr.gov/
//
//   • IRP — International Registration Plan apportioned plates (49 CFR §1414).
//       Carrier picks a "base jurisdiction" and renews on the anniversary of
//       their first registration. Missed renewal = plates expire = roadside
//       OOS + late fees per truck. Most carriers renew at the state level
//       (e.g., FL DHSMV portal for Florida-based fleets).
//
// We don't file these for the carrier (that's a paid service). We track the
// expiry dates as ISO strings on the client row and fire alerts the same way
// insurance-monitor does: 60 / 30 / 14 / 7 / 1 / 0 / -1 / -7 days from due.
//
// Architecture:
//   • Per-client ISO date fields on `clients.payload`:
//       - ucrExpiresAt           (year-based deadline, e.g. "2026-09-30")
//       - irpExpiresAt           (anniversary date, set per fleet)
//       - ucrBaseState           (optional reference for the alert text)
//       - irpBaseJurisdiction    (state code, used in the alert URL)
//   • Anti-dupe via `compliance_alerts_sent` (schema mirror of insurance).
//   • Same notification channels as insurance: Telegram admin chat + owner
//     email. Localized via the active user's preferred_lang at audit time
//     (TODO V2-31 separate PR).
// ---------------------------------------------------------------------------

import { storage } from "../storage";
import { getIntegrationValue } from "./integration-config";
import { sendEmail } from "./email";

/** Alert thresholds in days-before-expiry. Mirrors insurance-monitor. */
const ALERT_THRESHOLDS: number[] = [60, 30, 14, 7, 1, 0, -1, -7];

export type ComplianceKind = "ucr" | "irp";

const KIND_LABEL: Record<ComplianceKind, string> = {
  ucr: "UCR (Unified Carrier Registration)",
  irp: "IRP apportioned plates",
};

const KIND_PORTAL_URL: Record<ComplianceKind, string> = {
  ucr: "https://www.ucr.gov/",
  // IRP is per-state; this is a fallback generic link. The alert message
  // also includes the carrier's `irpBaseJurisdiction` so the user can search.
  irp: "https://www.fmcsa.dot.gov/registration/international-registration-plan",
};

function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(fromIso).getTime();
  const b = new Date(toIso).getTime();
  return Math.round((b - a) / (24 * 3600 * 1000));
}

function thresholdFor(daysUntil: number): number | null {
  for (const t of ALERT_THRESHOLDS) {
    if (daysUntil === t) return t;
  }
  return null;
}

interface RenewalLine {
  kind: ComplianceKind;
  expiresAt: string;
  baseStateOrJurisdiction?: string;
}

/**
 * Read the two renewal dates from a client's payload. Returns at most two
 * lines (one per kind) — only those with a non-empty ISO date are included.
 *
 * The shape is read defensively because clients.payload is just JSON; we
 * cast through unknown to avoid coupling to a schema that may not yet have
 * the field declared in shared/schema.ts.
 */
export function readRenewalsFromClient(
  client: { payload?: unknown } & Record<string, unknown>,
): RenewalLine[] {
  const payload = (client.payload ?? client) as {
    ucrExpiresAt?: string;
    ucrBaseState?: string;
    irpExpiresAt?: string;
    irpBaseJurisdiction?: string;
  };
  const lines: RenewalLine[] = [];
  if (typeof payload.ucrExpiresAt === "string" && payload.ucrExpiresAt) {
    lines.push({
      kind: "ucr",
      expiresAt: payload.ucrExpiresAt,
      baseStateOrJurisdiction: payload.ucrBaseState,
    });
  }
  if (typeof payload.irpExpiresAt === "string" && payload.irpExpiresAt) {
    lines.push({
      kind: "irp",
      expiresAt: payload.irpExpiresAt,
      baseStateOrJurisdiction: payload.irpBaseJurisdiction,
    });
  }
  return lines;
}

export interface ComplianceAlertOutcome {
  clientId: string;
  clientName: string;
  kind: ComplianceKind;
  expiresAt: string;
  daysUntilExpiry: number;
  threshold: number;
  sentChannels: ("telegram" | "email")[];
  errors: string[];
}

interface NotifyContext {
  telegramBotToken: string | null;
  telegramChatId: string | null;
  resendApiKey: string | null;
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
    const res = await fetch(
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
      const body = await res.text().catch(() => "");
      return { ok: false, error: `tg ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function buildAlertText(line: {
  clientName: string;
  kind: ComplianceKind;
  expiresAt: string;
  daysUntilExpiry: number;
  baseStateOrJurisdiction?: string;
}): string {
  const label = KIND_LABEL[line.kind];
  const url = KIND_PORTAL_URL[line.kind];
  const where = line.baseStateOrJurisdiction
    ? ` (${line.kind === "ucr" ? "base state" : "jurisdiction"} ${line.baseStateOrJurisdiction})`
    : "";
  const when =
    line.daysUntilExpiry > 0
      ? `expires in ${line.daysUntilExpiry} day${line.daysUntilExpiry === 1 ? "" : "s"}`
      : line.daysUntilExpiry === 0
        ? "expires TODAY"
        : `expired ${Math.abs(line.daysUntilExpiry)} day${Math.abs(line.daysUntilExpiry) === 1 ? "" : "s"} ago`;
  return [
    `⚠️ ${line.clientName} — ${label}${where} ${when}.`,
    `Due: ${line.expiresAt}`,
    `Renew: ${url}`,
  ].join("\n");
}

/**
 * Run one full pass — iterate clients, for each renewal line check if a
 * threshold fires and we haven't already sent that alert. Returns the list
 * of alerts that were actually dispatched this pass.
 */
export async function runComplianceRenewalsCheck(): Promise<ComplianceAlertOutcome[]> {
  const outcomes: ComplianceAlertOutcome[] = [];
  const todayIso = new Date().toISOString().slice(0, 10); // YYYY-MM-DD for date math

  const ctx: NotifyContext = {
    telegramBotToken:
      getIntegrationValue("telegram", "TELEGRAM_BOT_TOKEN") ??
      process.env.TELEGRAM_BOT_TOKEN ??
      null,
    telegramChatId:
      getIntegrationValue("telegram", "TELEGRAM_ALERT_CHAT_ID") ??
      process.env.TELEGRAM_ALERT_CHAT_ID ??
      null,
    resendApiKey:
      getIntegrationValue("resend", "RESEND_API_KEY") ?? process.env.RESEND_API_KEY ?? null,
    resendFromEmail:
      getIntegrationValue("resend", "RESEND_FROM_EMAIL") ??
      process.env.RESEND_FROM_EMAIL ??
      null,
    ownerEmail:
      getIntegrationValue("notifications", "OWNER_EMAIL") ?? process.env.OWNER_EMAIL ?? null,
  };

  const clients = storage.listClients();
  for (const client of clients) {
    const lines = readRenewalsFromClient(client as Record<string, unknown>);
    for (const line of lines) {
      // ISO-8601 date or datetime; treat both as midnight UTC for comparison.
      const expiresIsoDate = line.expiresAt.slice(0, 10);
      const daysUntil = daysBetween(todayIso, expiresIsoDate);
      const threshold = thresholdFor(daysUntil);
      if (threshold === null) continue;

      if (
        storage.hasComplianceAlertBeenSent(
          client.id,
          line.kind,
          line.expiresAt,
          threshold,
        )
      ) {
        continue;
      }

      const text = buildAlertText({
        clientName: client.name,
        kind: line.kind,
        expiresAt: line.expiresAt,
        daysUntilExpiry: daysUntil,
        baseStateOrJurisdiction: line.baseStateOrJurisdiction,
      });

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
            subject: `[DispatchOS] ${client.name} — ${KIND_LABEL[line.kind]} renewal`,
            text,
            html: `<pre style="font-family:inherit;white-space:pre-wrap">${text.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!))}</pre>`,
          });
          if (r.ok) sent.push("email");
          else if (r.error) errors.push(`email: ${r.error}`);
        } catch (err) {
          errors.push(`email: ${(err as Error).message}`);
        }
      }

      if (sent.length > 0) {
        storage.recordComplianceAlertSent({
          clientId: client.id,
          kind: line.kind,
          expiresAt: line.expiresAt,
          daysBefore: threshold,
          channels: sent,
        });
        storage.audit("compliance.renewal_alert", "client", client.id, {
          kind: line.kind,
          expiresAt: line.expiresAt,
          daysBefore: threshold,
          channels: sent,
        });
      }

      outcomes.push({
        clientId: client.id,
        clientName: client.name,
        kind: line.kind,
        expiresAt: line.expiresAt,
        daysUntilExpiry: daysUntil,
        threshold,
        sentChannels: sent,
        errors,
      });
    }
  }
  return outcomes;
}

/**
 * Read-only: report rows for the admin compliance dashboard. No DB writes,
 * no notifications. Used by GET /api/admin/compliance/renewals.
 */
export function listUpcomingRenewals(withinDays = 90): Array<{
  clientId: string;
  clientName: string;
  kind: ComplianceKind;
  expiresAt: string;
  daysUntilExpiry: number;
  baseStateOrJurisdiction?: string;
  status: "expired" | "due_soon" | "ok";
}> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const rows: Array<{
    clientId: string;
    clientName: string;
    kind: ComplianceKind;
    expiresAt: string;
    daysUntilExpiry: number;
    baseStateOrJurisdiction?: string;
    status: "expired" | "due_soon" | "ok";
  }> = [];
  for (const client of storage.listClients()) {
    for (const line of readRenewalsFromClient(client as Record<string, unknown>)) {
      const days = daysBetween(todayIso, line.expiresAt.slice(0, 10));
      // Only surface what's relevant to a dispatcher: expired OR due within window.
      if (days > withinDays) continue;
      rows.push({
        clientId: client.id,
        clientName: client.name,
        kind: line.kind,
        expiresAt: line.expiresAt,
        daysUntilExpiry: days,
        baseStateOrJurisdiction: line.baseStateOrJurisdiction,
        status: days < 0 ? "expired" : days <= 14 ? "due_soon" : "ok",
      });
    }
  }
  rows.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
  return rows;
}
