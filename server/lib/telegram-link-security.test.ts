// Regression test: Telegram driver-link account-takeover gate (temp DB, no net).
// Run: npx tsx server/lib/telegram-link-security.test.ts
//
// THREAT under guard (tg-02 / tg-03 / tg-04)
// ------------------------------------------
// The driver bot's only Telegram-link path is the consumed-invite flow: a driver
// signs up on the web (which CONSUMES their invite), then sends the same code to
// the bot to bind their chat. The invite code is a SHARED SECRET (emailed, shown
// in the admin UI, embedded in audit payloads), so it cannot by itself prove WHO
// is sending it. The pre-fix bot bound an arbitrary chat to the consumer whenever
// the consumer wasn't currently linked — so anyone who learned the code could bind
// THEIR chat to an unlinked victim and take over /loc /yes /no /nego /status.
//
// The fix makes the consumed-invite link a ONE-SHOT consumable
// (storage.redeemConsumedInviteForTelegramLink): the first redemption wins and
// stamps invites.telegram_linked_at; every later attempt with the same code is
// rejected. It also clears the chat from any prior owner (telegram_chat_id is not
// DB-unique) so a chat maps to exactly one account. Plus an update_id replay/dedup
// ledger (storage.markTelegramUpdateProcessed) so a replayed webhook is a no-op.
//
// This locks those invariants in at the storage layer (the atomic security
// primitives); the bot route composes them. Deterministic, no network/HTTP.

import { tmpdir } from "node:os";
import { join } from "node:path";

// MUST set a unique DB path BEFORE importing storage (better-sqlite3 binds the
// file at import time). Mirror invite-expiry.test.ts.
process.env.DISPATCHOS_DB_PATH = join(
  tmpdir(),
  `dispatchos-tg-link-sec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.db`,
);
process.env.DISPATCHOS_KEYRING_PRIMARY =
  process.env.DISPATCHOS_KEYRING_PRIMARY || Buffer.alloc(32, 7).toString("base64");

const { storage } = await import("../storage");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}
const rnd = () => Math.random().toString(36).slice(2, 10);

function makeConsumedDriverInvite(): { code: string; userId: string } {
  const code = `DOS-${rnd().toUpperCase()}-${rnd().toUpperCase()}`;
  storage.createInviteWithCode({ code, role: "driver", createdByUserId: "admin-x" });
  const driver = storage.createUser({
    email: `drv-${rnd()}@example.com`,
    fullName: "Real Driver",
    role: "driver",
    passwordSalt: "s",
    passwordHash: "h",
  });
  // Simulate web signup consuming the invite (sets consumed_by_user_id).
  const ok = storage.consumeInvite(code, driver.id);
  if (!ok) throw new Error("setup: consumeInvite failed");
  return { code, userId: driver.id };
}

// ---------------------------------------------------------------------------
// 1) FIRST-TIME link succeeds for the real driver (legitimate flow preserved).
// ---------------------------------------------------------------------------
{
  const { code, userId } = makeConsumedDriverInvite();
  const driverChat = "100000001";
  const linked = storage.redeemConsumedInviteForTelegramLink({ code, userId, chatId: driverChat });
  assert("first-time link succeeds for real driver", linked === true);
  assert(
    "driver chat is bound after first link",
    storage.getUserById(userId)?.telegramChatId === driverChat,
  );
  assert(
    "invite link slot is now stamped (telegramLinkedAt set)",
    !!storage.getInvite(code)?.telegramLinkedAt,
  );

  // 2) TAKEOVER attempt: attacker who knows the SAME consumed code tries to
  //    rebind the account to their chat. Must be rejected (one-shot spent), and
  //    the driver's binding must be untouched.
  const attackerChat = "999999999";
  const stolen = storage.redeemConsumedInviteForTelegramLink({
    code,
    userId,
    chatId: attackerChat,
  });
  assert("takeover via spent consumed code is rejected", stolen === false);
  assert(
    "driver chat is UNCHANGED after takeover attempt",
    storage.getUserById(userId)?.telegramChatId === driverChat,
  );
  assert(
    "attacker chat resolves to NOBODY",
    storage.getUserByTelegramChatId(attackerChat) === undefined,
  );
}

// ---------------------------------------------------------------------------
// 3) TAKEOVER of an UNLINKED victim (the exact pre-fix gap): victim consumed an
//    invite but never linked Telegram. Attacker sends the code first → before
//    fix this bound the attacker's chat to the victim. Now it's one-shot: the
//    first redeemer claims the slot, and a SECOND distinct chat cannot rebind.
// ---------------------------------------------------------------------------
{
  const { code, userId } = makeConsumedDriverInvite();
  // Victim is currently UNLINKED (telegramChatId is undefined).
  assert("victim starts unlinked", storage.getUserById(userId)?.telegramChatId == null);

  const attackerChat = "777000111";
  const firstClaim = storage.redeemConsumedInviteForTelegramLink({
    code,
    userId,
    chatId: attackerChat,
  });
  // The storage method cannot distinguish attacker from driver by code alone;
  // the one-shot property is what bounds the damage to a single binding that the
  // admin can see (telegram.link audit) and revoke. The SECOND attempt fails.
  assert("first redeemer claims the single slot", firstClaim === true);
  const secondChat = "777000222";
  const secondClaim = storage.redeemConsumedInviteForTelegramLink({
    code,
    userId,
    chatId: secondChat,
  });
  assert("second chat cannot rebind via same consumed code", secondClaim === false);
  assert(
    "second chat resolves to NOBODY",
    storage.getUserByTelegramChatId(secondChat) === undefined,
  );
}

// ---------------------------------------------------------------------------
// 4) PRIOR-OWNER clearing: telegram_chat_id is not DB-unique. Binding a chat to
//    a new user must detach it from any prior owner so the chat maps to exactly
//    one account (no two users resolving from one chat; no stale alerts).
// ---------------------------------------------------------------------------
{
  const sharedChat = "555123456";
  // userA links the chat first (via a clean one-shot invite).
  const a = makeConsumedDriverInvite();
  storage.redeemConsumedInviteForTelegramLink({ code: a.code, userId: a.userId, chatId: sharedChat });
  assert("userA bound to shared chat", storage.getUserById(a.userId)?.telegramChatId === sharedChat);

  // userB now legitimately links the SAME chat (e.g. driver changed accounts).
  const b = makeConsumedDriverInvite();
  const bLinked = storage.redeemConsumedInviteForTelegramLink({
    code: b.code,
    userId: b.userId,
    chatId: sharedChat,
  });
  assert("userB links the shared chat", bLinked === true);
  assert(
    "prior owner (userA) chat was CLEARED",
    storage.getUserById(a.userId)?.telegramChatId == null,
  );
  assert(
    "shared chat now resolves to userB only",
    storage.getUserByTelegramChatId(sharedChat)?.id === b.userId,
  );
}

// ---------------------------------------------------------------------------
// 5) UPDATE_ID replay/dedup: first time true, every replay false (no-op).
// ---------------------------------------------------------------------------
{
  const id = 4242000 + Math.floor(Math.random() * 1000);
  assert("first delivery of update_id is processed", storage.markTelegramUpdateProcessed(id) === true);
  assert("replay of same update_id is dropped", storage.markTelegramUpdateProcessed(id) === false);
  assert("second replay still dropped", storage.markTelegramUpdateProcessed(id) === false);
  // A different update_id is independent.
  assert("a fresh update_id is processed", storage.markTelegramUpdateProcessed(id + 1) === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
