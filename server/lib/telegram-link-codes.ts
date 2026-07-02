// ===========================================================================
// server/lib/telegram-link-codes.ts — authenticated web→bot chat linking
// ===========================================================================
//
// The driver bot's historical chat-binding path (consumed driver invite) does
// not exist for self-serve carrier owners — they sign up with no invite, so
// they could NEVER link Telegram and never receive a matched-load alert.
//
// Flow: a logged-in user POSTs /api/me/telegram/link-code → we mint a
// short-lived one-time code and hand back a t.me deep link
// (https://t.me/<bot>?start=<code>). Telegram delivers the tap as
// "/start <code>" to the webhook, which validates the code here and calls
// storage.setUserTelegramChatId. Pasting the bare code into the chat works
// too (the webhook probes unlinked messages against this ledger first).
//
// Codes are single-use, expire after 10 minutes, and live in memory only —
// the API server and the bot webhook share one process, and a lost code just
// means the user clicks "Connect" again. One active code per user (re-minting
// replaces the previous one, so a stale copy can't linger as a second secret).
//
// Format: TGL-XXXXXXXX (A-Z/2-9, no confusable 0/O/1/I). Uppercase-only so it
// survives the bot's candidate normalization (trim + toUpperCase), and within
// Telegram's start-payload charset [A-Za-z0-9_-].
// ---------------------------------------------------------------------------

import crypto from "node:crypto";

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = /^TGL-[A-Z2-9]{8}$/;

interface PendingLink {
  userId: string;
  expiresAt: number;
}

const pendingByCode = new Map<string, PendingLink>();

/** Drop expired entries so an abandoned flow can't grow the map unbounded. */
function prune(nowMs: number): void {
  pendingByCode.forEach((entry, code) => {
    if (entry.expiresAt <= nowMs) pendingByCode.delete(code);
  });
}

/** Cheap shape probe — lets the bot distinguish link codes from invite codes. */
export function isTelegramLinkCode(candidate: string): boolean {
  return CODE_RE.test(candidate);
}

/**
 * Mint a fresh one-time link code for the user. Any previous unexpired code
 * for the same user is invalidated (single active code per user).
 */
export function mintTelegramLinkCode(
  userId: string,
  nowMs = Date.now(),
): { code: string; expiresAt: string } {
  prune(nowMs);
  pendingByCode.forEach((entry, code) => {
    if (entry.userId === userId) pendingByCode.delete(code);
  });
  const bytes = crypto.randomBytes(8);
  let suffix = "";
  for (let i = 0; i < bytes.length; i++) {
    suffix += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  const code = `TGL-${suffix}`;
  const expiresAt = nowMs + CODE_TTL_MS;
  pendingByCode.set(code, { userId, expiresAt });
  return { code, expiresAt: new Date(expiresAt).toISOString() };
}

/**
 * Redeem a code exactly once. Returns the minting userId, or null for an
 * unknown / expired / already-consumed code. Input is normalized the same way
 * the bot normalizes candidates (trim/uppercase, whitespace stripped).
 */
export function consumeTelegramLinkCode(
  candidate: string,
  nowMs = Date.now(),
): { userId: string } | null {
  const code = candidate.trim().toUpperCase().replace(/\s+/g, "");
  if (!isTelegramLinkCode(code)) return null;
  const entry = pendingByCode.get(code);
  if (!entry) return null;
  pendingByCode.delete(code); // one-shot: spent whether valid or expired
  if (entry.expiresAt <= nowMs) return null;
  return { userId: entry.userId };
}
