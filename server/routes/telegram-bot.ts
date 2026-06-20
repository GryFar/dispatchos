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
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
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
      console.error(`[tg-bot] sendMessage failed: ${res.status} ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.error("[tg-bot] sendMessage threw:", err);
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
// Main handler — runs after path-token auth passes.
// -----------------------------------------------------------------------------

async function handleUpdate(botToken: string, update: TgUpdate): Promise<void> {
  const msg = update.message ?? update.edited_message;
  if (!msg) return;

  const chatId = String(msg.chat.id);
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

    // Invite needs to be valid, not consumed, and targeted at a driver.
    if (invite.consumedAt) {
      // Already used — but we still want to link if the chat user matches the
      // consuming user. Look up the consumer via invite.consumedByUserId.
      const consumerId = invite.consumedByUserId;
      if (consumerId) {
        const consumer = storage.getUserById(consumerId);
        if (consumer?.role === "driver") {
          storage.setUserTelegramChatId(consumer.id, chatId);
          storage.audit("telegram.link", "user", consumer.id, { chatId, via: "consumed_invite_recheck" });
          await tgSend(
            botToken,
            chatId,
            `✅ Welcome back, <b>${escapeHtml(consumer.fullName)}</b>.\n\n${HELP_LINKED}`,
          );
          return;
        }
      }
      await tgSend(botToken, chatId, "⚠️ This invite was already used. Ask dispatch for a fresh one.");
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

  // "City, ST" — best-effort parse
  if (args) {
    const m = args.match(/^([^,]+?)\s*,\s*([A-Za-z]{2})\b/);
    if (m) {
      city = m[1].trim();
      state = m[2].toUpperCase();
    } else {
      // Free-form: treat whole string as city, keep state
      city = args.trim();
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
    const rec = storage.getLoad?.(loadId) as
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
      storage.appendBrokerTrustSignal({
        brokerMc, loadId, clientId: user.linkedClientId,
        signalType: "load_refused_by_carrier", positive: false,
        reportedByUserId: user.id, source: "driver",
        notes: `Driver /no via Telegram (chatId=${chatId})`,
      });
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
    const task = storage.createApprovalTask({
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
