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
import type { Client, Load, ScoredLoad } from "@shared/schema";

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
  /** Release a claim (so the next poll retries) after a transient send failure. */
  release?: (loadId: string, chatId: string) => void;
  /** Deliver text to one chat. Resolves {ok}. Must not throw. */
  send: (chatId: string, text: string) => Promise<SendResult>;
}

export interface NotifyResult {
  loadId: string;
  clientId: string;
  recipients: number;
  sent: number;
  skipped: number; // already-alerted (deduped)
  errors: string[];
}

/** A send outcome. `permanent` = retrying THIS chat is pointless (bot blocked /
 *  chat not found), so the caller should keep the de-dup claim (stop retrying)
 *  rather than releasing it. Transient failures (429/5xx/network/timeout) leave
 *  permanent falsy → caller releases the claim so the next poll retries. */
type SendResult = { ok: boolean; error?: string; permanent?: boolean };

const realFetchSend =
  (token: string | null) =>
  async (chatId: string, text: string): Promise<SendResult> => {
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
      // 400 (chat not found) / 403 (bot blocked or kicked) are permanent for this
      // chat — no point retrying. Everything else (429 rate-limit, 5xx) is transient.
      if (!res.ok) return { ok: false, error: `tg ${res.status}`, permanent: res.status === 400 || res.status === 403 };
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
    release: (loadId, chatId) => storage.releaseLoadAlert(loadId, chatId),
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
      // Transient failure: release the claim so the next poll retries instead of
      // permanently suppressing this alert. Permanent (bot blocked / chat gone):
      // keep the claim so we don't hammer a dead chat forever.
      if (!sendRes.permanent) deps.release?.(scored.id, r.chatId);
    }
  }
  return result;
}

/** Max loads listed in a batch message before collapsing to "+N more". */
const BATCH_MAX_LINES = 6;

/**
 * One compact digest for several matched loads. Pure. Used when a single poll
 * surfaces multiple qualifying loads for a carrier — sending one message instead
 * of N avoids notification fatigue (which makes carriers mute the bot, breaking
 * the whole alert promise).
 */
export function formatMatchedLoadsBatchMessage(client: Client, loads: ScoredLoad[]): string {
  const clean = (s: unknown) => String(s ?? "").replace(/[\r\n\t]+/g, " ").trim();
  const sorted = [...loads].sort((a, b) => b.dispatchScore - a.dispatchScore);
  const shown = sorted.slice(0, BATCH_MAX_LINES);
  const header =
    `🚚 ${loads.length} new matched load${loads.length === 1 ? "" : "s"}` +
    (clean(client.name) ? ` · ${clean(client.name)}` : "");
  const lines = shown.map((l) => {
    const icon = VERDICT_ICON[l.verdict] ?? "•";
    const lane =
      `${clean(l.originCity) || "?"}, ${clean(l.originState) || "?"} → ` +
      `${clean(l.destinationCity) || "?"}, ${clean(l.destinationState) || "?"}`;
    return `${icon} ${l.dispatchScore} ${l.verdict.toUpperCase()} · ${lane} · ${money(l.rate)} (${ppm(l.netPpmTotal)}/mi)`;
  });
  const more =
    loads.length > shown.length ? [`…+${loads.length - shown.length} more on the board`] : [];
  return [header, ...lines, ...more].join("\n");
}

/**
 * Push a batch of matched loads to a carrier's recipients as ONE message each
 * (rich format for a single load, digest for several). Dedup stays per
 * (load, chat): each recipient only sees loads not already alerted to them, so
 * a re-poll never re-pings. Best-effort, never throws. result.sent counts
 * MESSAGES delivered; result.skipped counts deduped (load, chat) pairs.
 */
export async function notifyMatchedLoadsBatch(
  client: Client,
  scoredLoads: ScoredLoad[],
  deps: NotifyDeps = defaultDeps(),
): Promise<NotifyResult> {
  const result: NotifyResult = {
    loadId: scoredLoads[0]?.id ?? "",
    clientId: client.id,
    recipients: 0,
    sent: 0,
    skipped: 0,
    errors: [],
  };
  if (!scoredLoads.length) return result;

  let recipients: Array<{ userId: string; chatId: string; role: string }>;
  try {
    recipients = deps.listRecipients(client.id);
  } catch (err) {
    result.errors.push(`recipients: ${(err as Error).message}`);
    return result;
  }
  result.recipients = recipients.length;
  if (!recipients.length) return result;

  for (const r of recipients) {
    const fresh: ScoredLoad[] = [];
    for (const l of scoredLoads) {
      let ok: boolean;
      try {
        ok = deps.claim(l.id, r.chatId, client.id, l.dispatchScore);
      } catch (err) {
        result.errors.push(`claim ${r.chatId}/${l.id}: ${(err as Error).message}`);
        continue;
      }
      if (ok) fresh.push(l);
      else result.skipped += 1;
    }
    if (!fresh.length) continue;
    const text =
      fresh.length === 1
        ? formatMatchedLoadMessage(client, fresh[0]!)
        : formatMatchedLoadsBatchMessage(client, fresh);
    const sendRes = await deps.send(r.chatId, text);
    if (sendRes.ok) result.sent += 1;
    else {
      result.errors.push(`send ${r.chatId}: ${sendRes.error ?? "unknown"}`);
      // One failed digest claimed up to BATCH_MAX_LINES+ loads — release ALL of
      // them on a transient failure so the next poll re-sends, instead of
      // silently dropping the whole batch for this recipient.
      if (!sendRes.permanent) {
        for (const l of fresh) deps.release?.(l.id, r.chatId);
      }
    }
  }
  return result;
}

// ===========================================================================
// Pickup reminders — ping the assigned driver before a load's pickup window.
// ===========================================================================

/** Hours of lead time before pickup to remind. Env-tunable. */
export function pickupReminderLeadHours(): number {
  const raw = Number.parseFloat(process.env.DISPATCHOS_PICKUP_REMINDER_LEAD_HOURS ?? "");
  if (Number.isFinite(raw) && raw > 0 && raw <= 48) return raw;
  return 3;
}

function clean(s: unknown): string {
  return String(s ?? "").replace(/[\r\n\t]+/g, " ").trim();
}

/** Compact pickup reminder a driver can act on. Pure — no I/O. */
export function formatPickupReminderMessage(load: Load, pickupAtIso: string, nowMs: number): string {
  const pickupMs = new Date(pickupAtIso).getTime();
  const mins = Number.isFinite(pickupMs) ? Math.round((pickupMs - nowMs) / 60000) : NaN;
  const when =
    !Number.isFinite(mins)
      ? "soon"
      : mins <= 0
        ? "now"
        : mins < 60
          ? `in ${mins} min`
          : `in ${Math.round(mins / 60)}h`;
  const origin = `${clean(load.originCity) || "?"}, ${clean(load.originState) || "?"}`;
  const dest = `${clean(load.destinationCity) || "?"}, ${clean(load.destinationState) || "?"}`;
  const brokerName = (load as Load & { brokerName?: string }).brokerName;
  return [
    `⏰ Pickup ${when}`,
    `Load: ${origin} → ${dest}`,
    `Pickup at: ${clean(pickupAtIso)}`,
    brokerName ? `Broker: ${clean(brokerName)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface PickupReminderDeps {
  claim: (loadId: string, driverId: string, pickupAt: string) => boolean;
  release?: (loadId: string, driverId: string, pickupAt: string) => void;
  send: (chatId: string, text: string) => Promise<SendResult>;
}

function defaultPickupDeps(): PickupReminderDeps {
  const token = resolveDriverBotToken();
  return {
    claim: (loadId, driverId, pickupAt) =>
      storage.claimPickupReminder({ loadId, driverId, pickupAt }),
    release: (loadId, driverId, pickupAt) =>
      storage.releasePickupReminder(loadId, driverId, pickupAt),
    send: realFetchSend(token),
  };
}

/**
 * Remind one assigned driver about an upcoming pickup. Best-effort, never
 * throws. Returns 'sent' | 'skipped' (already reminded) | 'error'.
 */
export async function notifyPickupReminder(
  load: Load,
  driverId: string,
  chatId: string,
  pickupAtIso: string,
  nowMs: number,
  deps: PickupReminderDeps = defaultPickupDeps(),
): Promise<"sent" | "skipped" | "error"> {
  let fresh: boolean;
  try {
    fresh = deps.claim(load.id, driverId, pickupAtIso);
  } catch {
    return "error";
  }
  if (!fresh) return "skipped";
  const res = await deps.send(chatId, formatPickupReminderMessage(load, pickupAtIso, nowMs));
  if (res.ok) return "sent";
  // Transient failure: release so the next poll retries. Permanent: keep claim.
  if (!res.permanent) deps.release?.(load.id, driverId, pickupAtIso);
  return "error";
}
