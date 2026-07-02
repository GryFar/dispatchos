// Telegram web link-code test (pure in-memory ledger, no DB, no network).
// Run: npx tsx server/lib/telegram-link-codes.test.ts
//
// The authenticated web→bot link flow for self-serve carrier owners (who have
// no driver invite to redeem): POST /api/me/telegram/link-code mints a code,
// the bot's webhook consumes it and binds the chat. Security properties under
// test: single-use, short TTL, single active code per user, shape-distinct
// from invite codes, and normalization parity with the bot's candidate
// handling (trim / uppercase / whitespace strip).

import {
  consumeTelegramLinkCode,
  isTelegramLinkCode,
  mintTelegramLinkCode,
} from "./telegram-link-codes";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- format ------------------------------------------------------------------
{
  const { code, expiresAt } = mintTelegramLinkCode("user-a");
  assert("minted code matches TGL-XXXXXXXX shape", isTelegramLinkCode(code), code);
  assert(
    "code charset survives the bot's toUpperCase normalization",
    code === code.toUpperCase(),
  );
  assert("expiresAt is a valid ISO timestamp in the future", Date.parse(expiresAt) > Date.now());
  // Telegram start payloads allow only [A-Za-z0-9_-]; the deep link embeds the
  // code verbatim, so it must stay inside that charset.
  assert("code fits t.me start-payload charset", /^[A-Za-z0-9-]+$/.test(code));
}

// --- invite codes are never mistaken for link codes ---------------------------
assert("invite-shaped code is not a link code", isTelegramLinkCode("DOS-ABCD-EFGH") === false);
assert("random text is not a link code", isTelegramLinkCode("HELLO") === false);

// --- happy path + one-shot -----------------------------------------------------
{
  const { code } = mintTelegramLinkCode("user-b");
  const first = consumeTelegramLinkCode(code);
  assert("first consume returns the minting user", first?.userId === "user-b");
  assert("second consume of the same code is rejected", consumeTelegramLinkCode(code) === null);
}

// --- normalization parity with the bot -----------------------------------------
{
  const { code } = mintTelegramLinkCode("user-c");
  const messy = `  ${code.toLowerCase().slice(0, 6)} ${code.slice(6)}  `;
  assert(
    "lowercased / whitespace-split paste still consumes",
    consumeTelegramLinkCode(messy)?.userId === "user-c",
  );
}

// --- expiry ---------------------------------------------------------------------
{
  const minted = mintTelegramLinkCode("user-d", 1_000_000);
  const afterTtl = 1_000_000 + 10 * 60 * 1000 + 1;
  assert(
    "expired code is rejected",
    consumeTelegramLinkCode(minted.code, afterTtl) === null,
  );
}

// --- unknown code ----------------------------------------------------------------
assert("unknown (well-formed) code is rejected", consumeTelegramLinkCode("TGL-ZZZZZZZZ") === null);

// --- re-mint replaces the previous code (single active code per user) -------------
{
  const first = mintTelegramLinkCode("user-e");
  const second = mintTelegramLinkCode("user-e");
  assert("re-mint invalidates the earlier code", consumeTelegramLinkCode(first.code) === null);
  assert(
    "latest code still works after re-mint",
    consumeTelegramLinkCode(second.code)?.userId === "user-e",
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
