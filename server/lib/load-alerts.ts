// ===========================================================================
// server/lib/load-alerts.ts — P0.4 / P0.5 matched-load push
// ===========================================================================
//
// The dispatch engine already scores every load (scoreLoadForClient). What was
// missing — the core product promise — is DELIVERY: nobody got pinged when a
// strong load matched their carrier. They had to sit on the dashboard. This
// module closes that: when a freshly-ingested load scores above threshold for a
// carrier, push a concise offer to that carrier's linked Telegram recipients
// (drivers + owner-operator), routed by each recipient's own chat_id — NOT the
// single hardcoded admin alert chat the other notifiers use.
//
// Design:
//  - Pure formatter + threshold logic (unit-testable, no I/O).
//  - notifyMatchedLoad() takes injectable deps (recipients / claim / send) so
//    tests run without a real Telegram or a live scorer. Cron wires the real
//    storage + fetch.
//  - Never throws. A push failure is logged and swallowed — load ingest must
//    not fail because Telegram is down.
//  - De-dup is atomic via storage.claimLoadAlert (UNIQUE (load_id, chat_id)),
//    so re-scoring the same load on a later poll never re-pings.

import { fetchWithTimeout } from "./fetch-timeout";
import { getIntegrationValue } from "./integration-config";
import { storage } from "../storage";
import type { Client, ScoredLoad } from "@shared/schema";

// Minimum dispatchScore (0..135 scale from scoreLoadForClient) to bother
// pinging. Overridable via env for tuning without a deploy. A 'skip' verdict is
// never pushed regardless of score.
const DEFAULT_MIN_ALERT_SCORE = 70;

export function matchAlertThreshold(): number {
  const raw = Number.parseInt(process.env.LOAD_ALERT_MIN_SCORE ?? "", 10);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 135) return raw;
  return DEFAULT_MIN_ALERT_SCORE;
}

/** A load is worth pushing if the scorer didn't say "skip" and it clears the bar. */
export function shouldAlertLoad(scored: ScoredLoad, threshold = matchAlertThreshold()): boolean {
  return scored.verdict !== "skip" && scored.dispatchScore >= threshold;
}

/** The driver bot is the one drivers connected their chat to (not the admin bot). */
export function resolveDriverBotToken(): string | null {
  return (
    getIntegrationValue("telegram_driver_bot", "TELEGRAM_DRIVER_BOT_TOKEN") ??
    process.env.TELEGRAM_DRIVER_BOT_TOKEN ??
    null
  );
}

function money(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "?";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function ppm(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "?";
  return `$${n.toFixed(2)}`;
}

const VERDICT_ICON: Record<string, string> = { book: "✅", negotiate: "🟡", skip: "🔴" };

/**
 * Compact offer message a driver/dispatcher can act on at a glance. Pure — no
 * I/O. Untrusted broker-supplied strings (cities, broker name) are stripped of
 * control chars; this text goes to Telegram (not an LLM), so plain escaping is
 * enough.
 */
export function formatMatchedLoadMessage(client: Client, scored: ScoredLoad): string {
  const clean = (s: unknown) => String(s ?? "").replace(/[\r\n\t]+/g, " ").trim();
  const lane =
    `${clean(scored.originCity) || "?"}, ${clean(scored.originState) || "?"} → ` +
    `${clean(scored.destinationCity) || "?"}, ${clean(scored.destinationState) || "?"}`;
  const icon = VERDICT_ICON[scored.verdict] ?? "•";
  const brokerName = (scored as ScoredLoad & { brokerName?: string }).brokerName;

  const lines = [
    `${icon} New load match · score ${scored.dispatchScore} · ${scored.verdict.toUpperCase()}`,
    clean(client.name) ? `Carrier: ${clean(client.name)}` : "",
    `Lane: ${lane}`,
    `Rate: ${money(scored.rate)}  ·  Net ${ppm(scored.netPpmTotal)}/mi`,
    `Miles: ${scored.loadedMiles} loaded + ${scored.deadheadMiles} deadhead`,
    brokerName ? `Broker: ${clean(brokerName)}` : "",
    scored.counterOffer ? `Suggested counter: ${money(scored.counterOffer)}` : "",
    scored.warnings?.length ? `⚠ ${scored.warnings.slice(0, 3).map(clean).join(" · ")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export interface NotifyDeps {
  /** Recipients for the carrier (defaults to storage lookup). */
  listRecipients: (clientId: string) => Array<{ userId: string; chatId: string; role: string }>;
  /** Atomically claim (load, chat); false = already alerted. */
  claim: (loadId: string, chatId: string, clientId: string, score: number) => boolean;
  /** Deliver text to one chat. Resolves {ok}. Must not throw. */
  send: (chatId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
}

export interface NotifyResult {
  loadId: string;
  clientId: string;
  recipients: number;
  sent: number;
  skipped: number; // already-alerted (deduped)
  errors: string[];
}

const realFetchSend =
  (token: string | null) =>
  async (chatId: string, text: string): Promise<{ ok: boolean; error?: string }> => {
    if (!token) return { ok: false, error: "driver bot token not configured" };
    try {
      const res = await fetchWithTimeout(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        },
      );
      if (!res.ok) return { ok: false, error: `tg ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  };

function defaultDeps(): NotifyDeps {
  const token = resolveDriverBotToken();
  return {
    listRecipients: (clientId) => storage.listTelegramRecipientsForClient(clientId),
    claim: (loadId, chatId, clientId, score) =>
      storage.claimLoadAlert({ loadId, chatId, clientId, dispatchScore: score }),
    send: realFetchSend(token),
  };
}

/**
 * Push one matched load to a carrier's linked recipients. Best-effort: returns
 * a result summary, never throws. Caller decides whether to gate on
 * shouldAlertLoad first (cron does).
 */
export async function notifyMatchedLoad(
  client: Client,
  scored: ScoredLoad,
  deps: NotifyDeps = defaultDeps(),
): Promise<NotifyResult> {
  const result: NotifyResult = {
    loadId: scored.id,
    clientId: client.id,
    recipients: 0,
    sent: 0,
    skipped: 0,
    errors: [],
  };

  let recipients: Array<{ userId: string; chatId: string; role: string }>;
  try {
    recipients = deps.listRecipients(client.id);
  } catch (err) {
    result.errors.push(`recipients: ${(err as Error).message}`);
    return result;
  }
  result.recipients = recipients.length;
  if (!recipients.length) return result;

  const text = formatMatchedLoadMessage(client, scored);

  for (const r of recipients) {
    let fresh: boolean;
    try {
      fresh = deps.claim(scored.id, r.chatId, client.id, scored.dispatchScore);
    } catch (err) {
      result.errors.push(`claim ${r.chatId}: ${(err as Error).message}`);
      continue;
    }
    if (!fresh) {
      result.skipped += 1;
      continue;
    }
    const sendRes = await deps.send(r.chatId, text);
    if (sendRes.ok) {
      result.sent += 1;
    } else {
      result.errors.push(`send ${r.chatId}: ${sendRes.error ?? "unknown"}`);
    }
  }
  return result;
}
