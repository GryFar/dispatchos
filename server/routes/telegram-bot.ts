// Telegram driver bot — webhook receiver.
//
// Architecture
// ------------
// Telegram POSTs every chat update to
//     /api/telegram/webhook/<TELEGRAM_DRIVER_BOT_TOKEN>
// The token in the path is the only secret — TG docs explicitly recommend
// this pattern (https://core.telegram.org/bots/api#setwebhook §Notes).
// On every update we:
//   1. Match path token against process.env.TELEGRAM_DRIVER_BOT_TOKEN (constant-
//      time). If mismatch → 404 with no body (don't leak whether route exists).
//   2. Find the calling user via users.telegram_chat_id. If not linked,
//      branch into the linking flow (/start, then invite-code message).
//   3. Otherwise dispatch on the command verb (/loc /yes /no /nego /status
//      /help /unlink).
//
// All replies go back via tgSend() → POST sendMessage. We always 200 OK to
// TG even on bad input — TG would otherwise retry for 24h. User-visible
// errors go through the bot itself.
//
// Why a separate file from /api/telegram/command:
// - /api/telegram/command is the *internal* programmatic endpoint
//   (server-to-server, no auth gate). Useful for ops scripts.
// - This file is the external bot face. Different shape, different auth.

import { fetchWithTimeout } from "../lib/fetch-timeout";
import type { Express, Request, Response } from "express";
import crypto from "node:crypto";
import { storage } from "../storage";

interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TgChat {
  id: number;
  type: string;
}

interface TgLocation {
  latitude: number;
  longitude: number;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  location?: TgLocation;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}

function timingSafeEqual(a: string, b: string): boolean {
  // Hash both inputs to a fixed length first so the compared buffers are always
  // equal-length. A raw length check on the secret would short-circuit and leak
  // the token length via timing — this is the webhook's only auth gate.
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

async function tgSend(
  botToken: string,
  chatId: string | number,
  text: string,
  opts?: { parseMode?: "HTML" | "MarkdownV2" },
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: opts?.parseMode ?? "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[tg-bot] sendMessage failed: ${res.status} ${redactToken(body.slice(0, 200), botToken)}`,
      );
    }
  } catch (err) {
    // SECURITY (audit M): the request URL embeds the bot token — the webhook's
    // only auth secret. fetch/undici error objects can carry the URL on their
    // message/cause, so never log the raw error verbatim; serialize and scrub
    // the token out of every sink.
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error("[tg-bot] sendMessage threw:", redactToken(detail, botToken));
  }
}

// -----------------------------------------------------------------------------
// Command parsing
// -----------------------------------------------------------------------------

interface ParsedCommand {
  verb: string;       // /loc, /yes, etc. (lowercase, no @bot suffix)
  args: string;       // everything after the verb, trimmed
  raw: string;        // original message text
}

function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const space = trimmed.indexOf(" ");
  let verb = space === -1 ? trimmed : trimmed.slice(0, space);
  // TG appends @botname when used in groups: "/start@DispatchOS_Bot"
  const at = verb.indexOf("@");
  if (at !== -1) verb = verb.slice(0, at);
  return {
    verb: verb.toLowerCase(),
    args: space === -1 ? "" : trimmed.slice(space + 1).trim(),
    raw: trimmed,
  };
}

// -----------------------------------------------------------------------------
// Help text — shown on /start (unlinked), /help (always), and after linking.
// -----------------------------------------------------------------------------

const HELP_LINKED = `<b>DispatchOS driver commands</b>

<b>/loc</b> <i>City, ST</i> — update your last-known location (or send a TG location pin instead)
<b>/yes</b> [load id] — approve / accept a posted load
<b>/no</b> [load id] — reject a posted load
<b>/nego</b> [load id] [note] — ask dispatcher to negotiate
<b>/status</b> available | on_route | off_duty — set your driver status
<b>/help</b> — this message
<b>/unlink</b> — disconnect this chat from your account`;

const HELP_UNLINKED = `<b>Welcome to DispatchOS 🚛</b>

This bot lets approved drivers update location, accept loads, and chat with dispatch.

To link this chat to your driver account, send me your <b>invite code</b> (e.g. <code>DOS-XXXX-XXXX</code>).
If you don't have one yet, ask your dispatcher.`;

// -----------------------------------------------------------------------------
// Per-chat rate limiting
// -----------------------------------------------------------------------------
//
// The webhook acks 200 immediately and runs handleUpdate async, so there is no
// backpressure to Telegram. Each update can trigger DB writes (updateClientLocation
// on /loc, audit() on every command, appendBrokerTrustSignal on /no, createApprovalTask
// on /nego). Without a cap a single linked (or hijacked) chat can flood location
// updates, broker-trust signals, and approval tasks. In-memory per-chat token
// budget, mirroring aiRateCheck in cockpit.ts. Over-limit updates are dropped
// silently (no reply) so we don't amplify the flood with outbound sends.
const TG_MAX_PER_MIN = 30;
const TG_WINDOW_MS = 60 * 1000;
interface ChatBudget {
  count: number;
  windowStart: number;
}
const chatBudgets = new Map<string, ChatBudget>();
function chatRateCheck(chatId: string): boolean {
  const now = Date.now();
  const b = chatBudgets.get(chatId);
  if (!b || now - b.windowStart > TG_WINDOW_MS) {
    chatBudgets.set(chatId, { count: 1, windowStart: now });
    return true;
  }
  if (b.count >= TG_MAX_PER_MIN) return false;
  b.count++;
  return true;
}

// -----------------------------------------------------------------------------
// Main handler — runs after path-token auth passes.
// -----------------------------------------------------------------------------

async function handleUpdate(botToken: string, update: TgUpdate): Promise<void> {
  // SECURITY (tg-03): replay/dedup gate. Telegram retries an update until the
  // webhook 200s, and a replayed update body would otherwise re-run the command
  // (duplicate broker-trust signals on /no, duplicate /nego approval tasks).
  // Record each update_id exactly once and drop replays. A non-finite/missing
  // update_id is treated as un-dedupable and processed (TG always sends one;
  // this only guards against a malformed body, not against legit traffic).
  if (typeof update.update_id === "number" && Number.isFinite(update.update_id)) {
    if (!storage.markTelegramUpdateProcessed(update.update_id)) return;
  }

  const msg = update.message ?? update.edited_message;
  if (!msg) return;

  const chatId = String(msg.chat.id);

  // Per-chat flood control. Drop over-limit updates before any DB write or
  // outbound send. We don't reply (that would defeat the point of the cap and
  // could amplify a flood); legitimate driver usage is well under the cap.
  if (!chatRateCheck(chatId)) return;

  const text = msg.text ?? "";
  const cmd = parseCommand(text);
  const user = storage.getUserByTelegramChatId(chatId);

  // ---------------------------------------------------------------------------
  // Linking flow (no user yet)
  // ---------------------------------------------------------------------------
  if (!user) {
    if (cmd?.verb === "/start" || cmd?.verb === "/help") {
      await tgSend(botToken, chatId, HELP_UNLINKED);
      return;
    }

    // Try to interpret the message as an invite code. Codes are short
    // ASCII (e.g. DOS-XXXX-XXXX or similar). We strip whitespace and
    // uppercase before lookup — storage.getInvite is case-sensitive.
    const candidate = text.trim().toUpperCase().replace(/\s+/g, "");
    if (candidate.length < 6 || candidate.length > 64) {
      await tgSend(
        botToken,
        chatId,
        "I don't recognize you yet. Send your <b>invite code</b> to link this chat, or /help.",
      );
      return;
    }

    const invite = storage.getInvite(candidate);
    if (!invite) {
      await tgSend(botToken, chatId, "❌ Invite code not found. Double-check and try again, or contact dispatch.");
      return;
    }

    // SECURITY (audit M): enforce the invite TTL (and admin soft-revoke, which
    // stamps expiresAt = now()) at the bot before walking the user toward any
    // link. An unparseable/missing expiry is treated as expired (fail closed).
    const expiresMs = Date.parse(invite.expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
      await tgSend(botToken, chatId, "⌛ This invite has expired. Ask dispatch for a fresh one.");
      return;
    }

    // Invite needs to be valid, not consumed, and targeted at a driver.
    if (invite.consumedAt) {
      // Already used at signup — the consumed code is the ONLY proof we have, and
      // it is a shared secret (emailed, shown in the admin UI, embedded in audit
      // payloads). Look up the consumer via invite.consumedByUserId.
      const consumerId = invite.consumedByUserId;
      if (consumerId) {
        const consumer = storage.getUserById(consumerId);
        // SECURITY (audit C1 / tg-02): this path may bind a NEW chat to the
        // consuming driver AT MOST ONCE, and must never overwrite an existing
        // binding; otherwise anyone who learns the code could bind THEIR chat to
        // the (possibly unlinked) victim and take over /loc /yes /no /nego
        // /status. Require an active driver account and an unexpired invite.
        const expired = Date.parse(invite.expiresAt) < Date.now();
        const alreadyLinkedElsewhere =
          !!consumer?.telegramChatId && consumer.telegramChatId !== chatId;
        const eligible =
          consumer?.role === "driver" && !consumer.blocked && !expired;

        // Idempotent re-affirm: the consumer is already bound to THIS exact chat.
        // No new binding happens, so this is safe to allow even after the
        // one-shot link slot is spent (e.g. a blocked account re-sending the code
        // won't reach here via getUserByTelegramChatId, but defend anyway).
        if (eligible && consumer && consumer.telegramChatId === chatId) {
          await tgSend(
            botToken,
            chatId,
            `✅ Welcome back, <b>${escapeHtml(consumer.fullName)}</b>.\n\n${HELP_LINKED}`,
          );
          return;
        }

        // First-time link from this consumed invite: allowed ONLY if the
        // consumer isn't already linked to a different chat AND the invite's
        // single Telegram-link slot is still free. The redemption is atomic and
        // one-shot — it stamps telegram_linked_at and clears the chat from any
        // prior owner, so a later attacker who knows the same code can no longer
        // rebind the account. A lost race (slot already spent) falls through to
        // the "already used" rejection below.
        if (eligible && consumer && !alreadyLinkedElsewhere) {
          const linked = storage.redeemConsumedInviteForTelegramLink({
            code: invite.code,
            userId: consumer.id,
            chatId,
          });
          if (linked) {
            storage.audit("telegram.link", "user", consumer.id, {
              chatId,
              via: "consumed_invite_first_link",
            });
            await tgSend(
              botToken,
              chatId,
              `✅ Welcome, <b>${escapeHtml(consumer.fullName)}</b>. This chat is now linked.\n\n${HELP_LINKED}`,
            );
            return;
          }
        }
      }
      await tgSend(
        botToken,
        chatId,
        "⚠️ This invite was already used to link a chat. Ask dispatch for a fresh one.",
      );
      return;
    }

    if (invite.role !== "driver") {
      await tgSend(botToken, chatId, "This bot is for drivers only. Dispatcher invites use the web portal.");
      return;
    }

    // Invite is fresh and for a driver — but we don't have a User yet
    // (they haven't signed up). Drivers must complete signup on the
    // web portal first, then come back here to link.
    await tgSend(
      botToken,
      chatId,
      "✋ I see your invite but you haven't completed signup yet.\n\n" +
        "Finish signup at <a href=\"https://demo.dispatchos.co\">demo.dispatchos.co</a> first, " +
        "then come back and send your code again to link this chat.",
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // Linked user — dispatch on command
  // ---------------------------------------------------------------------------

  if (!cmd) {
    // Plain text or a TG location pin without a command
    if (msg.location) {
      await handleLoc(botToken, chatId, user, "", msg.location);
      return;
    }
    await tgSend(botToken, chatId, "Send a command. /help to see what I can do.");
    return;
  }

  switch (cmd.verb) {
    case "/start":
    case "/help":
      await tgSend(botToken, chatId, HELP_LINKED);
      return;
    case "/loc":
      await handleLoc(botToken, chatId, user, cmd.args, msg.location);
      return;
    case "/yes":
    case "/no":
    case "/nego":
      await handleApprovalLog(botToken, chatId, user, cmd.verb, cmd.args);
      return;
    case "/status":
      await handleStatus(botToken, chatId, user, cmd.args);
      return;
    case "/unlink":
      storage.setUserTelegramChatId(user.id, null);
      storage.audit("telegram.unlink", "user", user.id, { chatId });
      await tgSend(botToken, chatId, "🔌 Unlinked. Send your invite code again any time to relink.");
      return;
    default:
      await tgSend(botToken, chatId, `Unknown command <code>${escapeHtml(cmd.verb)}</code>. /help.`);
      return;
  }
}

// -----------------------------------------------------------------------------
// /loc
// -----------------------------------------------------------------------------

async function handleLoc(
  botToken: string,
  chatId: string,
  user: ReturnType<typeof storage.getUserByTelegramChatId>,
  args: string,
  pin?: TgLocation,
): Promise<void> {
  if (!user) return;
  if (user.role !== "driver" || !user.linkedClientId) {
    await tgSend(botToken, chatId, "Your account isn't tied to a driver record. Contact dispatch.");
    return;
  }
  const client = storage.getClient(user.linkedClientId);
  if (!client) {
    await tgSend(botToken, chatId, "Linked client not found. Contact dispatch.");
    return;
  }

  let city = client.currentLocation.city;
  let state = client.currentLocation.state;
  let lat = client.currentLocation.lat;
  let lng = client.currentLocation.lng;
  let source: "telegram_live" | "manual_checkin" = "manual_checkin";

  if (pin) {
    lat = pin.latitude;
    lng = pin.longitude;
    source = "telegram_live";
  }

  // "City, ST" — best-effort parse. City is driver-supplied free text that gets
  // persisted and later rendered/echoed, so strip control chars and cap length.
  const cleanCity = (s: string): string =>
    s.replace(/[ -]+/g, " ").trim().slice(0, 64);
  if (args) {
    const m = args.match(/^([^,]+?)\s*,\s*([A-Za-z]{2})\b/);
    if (m) {
      city = cleanCity(m[1]);
      state = m[2].toUpperCase();
    } else {
      // Free-form: treat whole string as city, keep state
      city = cleanCity(args);
    }
  }

  storage.updateClientLocation(user.linkedClientId, {
    city,
    state,
    lat,
    lng,
    source,
    status: client.currentLocation.status,
    notes: pin ? "TG live pin" : args || undefined,
  });
  storage.audit("telegram.command", "telegram", user.linkedClientId, {
    command: "/loc",
    via: "bot",
    userId: user.id,
    chatId,
    city,
    state,
    lat,
    lng,
  });

  await tgSend(
    botToken,
    chatId,
    `📍 Location updated: <b>${escapeHtml(city)}, ${escapeHtml(state)}</b>` +
      (pin ? ` (live pin)` : ""),
  );
}

// -----------------------------------------------------------------------------
// /yes /no /nego — log only; human dispatcher confirms final action
// -----------------------------------------------------------------------------

async function handleApprovalLog(
  botToken: string,
  chatId: string,
  user: ReturnType<typeof storage.getUserByTelegramChatId>,
  verb: string,
  args: string,
): Promise<void> {
  if (!user) return;
  if (user.role !== "driver" || !user.linkedClientId) {
    await tgSend(botToken, chatId, "Your account isn't tied to a driver record. Contact dispatch.");
    return;
  }

  storage.audit("telegram.command", "telegram", user.linkedClientId, {
    command: verb,
    via: "bot",
    userId: user.id,
    chatId,
    args,
  });

  // Resolve the referenced load ONCE, tenant-scoped. The first token of args is
  // the load id (/nego may add a free-text note after it). loadId is fully
  // driver-supplied and storage.getLoad is global (keyed by id only), so only
  // accept a load that belongs to the driver's OWN carrier — used both to record
  // signals and to echo which load the driver acted on. Cross-tenant / unknown
  // ids resolve to null (no probing, no false confirmation).
  const loadId = args.trim().split(/\s+/)[0] || null;
  let ownedLoad:
    | {
        brokerMc?: string; broker_mc?: string;
        originCity?: string; originState?: string;
        destinationCity?: string; destinationState?: string;
      }
    | null = null;
  if (loadId) {
    const rec = storage.getLoad(loadId) as
      | {
          clientId?: string; client_id?: string;
          brokerMc?: string; broker_mc?: string;
          originCity?: string; originState?: string;
          destinationCity?: string; destinationState?: string;
        }
      | undefined;
    const recClientId = (rec?.clientId ?? rec?.client_id) as string | undefined;
    if (rec && recClientId === user.linkedClientId) ownedLoad = rec;
  }

  // A load id was given but isn't on the driver's board (typo / wrong id /
  // another carrier's load): tell them plainly instead of a misleading ack —
  // and don't record any signal against a load they don't own.
  if (loadId && !ownedLoad) {
    await tgSend(
      botToken,
      chatId,
      `Couldn't find load <code>${escapeHtml(loadId)}</code> on your board. Double-check the id from the alert and resend.`,
    );
    return;
  }

  // Broker Trust Signal: /no = carrier refusing this broker's load — auto-collect.
  if (verb === "/no" && ownedLoad) {
    const brokerMc = (ownedLoad.brokerMc ?? ownedLoad.broker_mc ?? "") as string;
    if (brokerMc) {
      try {
        storage.appendBrokerTrustSignal({
          brokerMc, loadId, clientId: user.linkedClientId,
          signalType: "load_refused_by_carrier", positive: false,
          reportedByUserId: user.id, source: "driver",
          notes: `Driver /no via Telegram (chatId=${chatId})`,
        });
      } catch (err) {
        // The /no itself is already captured in the audit log above; only the
        // broker-trust aggregation failed. Don't throw past the success ack
        // (the only catch is in handleUpdate, which runs after TG was 200'd, so
        // the driver would otherwise get silence). Log and continue to ack.
        console.error("[tg-bot] appendBrokerTrustSignal failed:", err);
      }
    }
  }

  // /nego = driver asks the dispatcher to negotiate this load. Surface it as a
  // real task in the dispatcher's queue (admin fallback if no dispatcher is
  // assigned) — same routing as POST /api/me/issues — so the note isn't lost in
  // the audit log. Only for an owned load (cross-tenant ids already rejected).
  if (verb === "/nego" && ownedLoad) {
    const note = args
      .trim()
      .split(/\s+/)
      .slice(1)
      .join(" ")
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, 500);
    let assigneeRole: "dispatcher" | "admin" = "admin";
    let dispatcherUserId: string | null = null;
    let routedTo: "dispatcher" | "admin_fallback" = "admin_fallback";
    const active = storage.getActiveDispatcherForClient(user.linkedClientId);
    if (active) {
      assigneeRole = "dispatcher";
      dispatcherUserId = active.dispatcherUserId;
      routedTo = "dispatcher";
    }
    let task: ReturnType<typeof storage.createApprovalTask>;
    try {
      task = storage.createApprovalTask({
        taskType: "driver_booking_request",
        assigneeRole,
        payload: {
          loadId,
          lane: `${ownedLoad.originCity ?? "?"}, ${ownedLoad.originState ?? "?"} → ${ownedLoad.destinationCity ?? "?"}, ${ownedLoad.destinationState ?? "?"}`,
          note: note || null,
          brokerMc: ownedLoad.brokerMc ?? ownedLoad.broker_mc ?? null,
          reporterUserId: user.id,
          source: "telegram_nego",
          dispatcherUserId,
          routedTo,
        },
        createdByUserId: user.id,
      });
    } catch (err) {
      // The negotiation task is the driver's primary action here. If it fails,
      // tell them plainly instead of throwing past the success ack (which would
      // leave them with no reply but believing dispatch was notified).
      console.error("[tg-bot] createApprovalTask failed:", err);
      await tgSend(
        botToken,
        chatId,
        "⚠️ Couldn't log your negotiation request just now. Please try again, or contact dispatch directly.",
      );
      return;
    }
    storage.audit("driver.nego_requested", "approval_task", task.id, {
      userId: user.id,
      actorUserId: user.id,
      loadId,
      routedTo,
    });
  }

  // Echo the matched load's lane so the driver knows exactly which load registered.
  const laneSuffix = ownedLoad
    ? ` for <b>${escapeHtml(ownedLoad.originCity ?? "?")}, ${escapeHtml(ownedLoad.originState ?? "?")} → ` +
      `${escapeHtml(ownedLoad.destinationCity ?? "?")}, ${escapeHtml(ownedLoad.destinationState ?? "?")}</b>`
    : "";
  const reply =
    verb === "/yes"
      ? `👍 Approval logged${laneSuffix}. Dispatcher confirms with broker / rate con.`
      : verb === "/no"
        ? `👎 Rejection logged${laneSuffix}.`
        : `🤝 Negotiation request logged${laneSuffix}. Dispatcher will follow up.`;
  await tgSend(botToken, chatId, reply);
}

// -----------------------------------------------------------------------------
// /status
// -----------------------------------------------------------------------------

async function handleStatus(
  botToken: string,
  chatId: string,
  user: ReturnType<typeof storage.getUserByTelegramChatId>,
  args: string,
): Promise<void> {
  if (!user) return;
  if (user.role !== "driver") {
    await tgSend(botToken, chatId, "Status command is for drivers only.");
    return;
  }

  if (!args) {
    const current = user.driverStatus ?? "available";
    await tgSend(
      botToken,
      chatId,
      `Your status: <b>${escapeHtml(current)}</b>\n\nChange with /status available | on_route | off_duty`,
    );
    return;
  }

  const want = args.toLowerCase().trim();
  if (want !== "available" && want !== "on_route" && want !== "off_duty") {
    await tgSend(
      botToken,
      chatId,
      "Status must be one of: <b>available</b>, <b>on_route</b>, <b>off_duty</b>",
    );
    return;
  }

  storage.updateUser(user.id, { driverStatus: want });
  storage.audit("telegram.command", "user", user.id, {
    command: "/status",
    via: "bot",
    chatId,
    driverStatus: want,
  });

  await tgSend(botToken, chatId, `✅ Status set to <b>${want}</b>.`);
}

// -----------------------------------------------------------------------------
// Utility
// -----------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

// Scrub the bot token from any string before it reaches a log sink. The token
// is the webhook's only authenticator; an error message or response body that
// echoes the sendMessage URL would otherwise leak it verbatim.
function redactToken(s: string, token: string): string {
  if (!s || !token) return s;
  return s.split(token).join("***");
}

// -----------------------------------------------------------------------------
// Route registration
// -----------------------------------------------------------------------------

export function registerTelegramBotRoutes(app: Express): void {
  // POST /api/telegram/webhook/:token
  //
  // :token must equal process.env.TELEGRAM_DRIVER_BOT_TOKEN.
  // We always 200 OK to TG so it doesn't keep retrying — error reporting
  // (if any) happens via tgSend back to the chat itself.
  app.post("/api/telegram/webhook/:token", async (req: Request, res: Response) => {
    const { getIntegrationValue } = await import("../lib/integration-config");
    const expected = getIntegrationValue("telegram_driver_bot", "TELEGRAM_DRIVER_BOT_TOKEN");
    if (!expected) {
      // Misconfigured — silently 404 so we don't leak that the route exists.
      return res.status(404).end();
    }
    const provided = String(req.params.token || "");
    if (!timingSafeEqual(provided, expected)) {
      return res.status(404).end();
    }

    // Body sanity — TG always sends an object
    const update = req.body as TgUpdate;
    if (!update || typeof update !== "object") {
      return res.status(200).json({ ok: true });
    }

    // Don't block TG on slow downstream work; ack immediately, process async.
    res.status(200).json({ ok: true });
    handleUpdate(expected, update).catch((err) => {
      console.error("[tg-bot] handleUpdate failed:", err);
    });
  });
}
