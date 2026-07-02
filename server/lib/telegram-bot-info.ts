// ===========================================================================
// server/lib/telegram-bot-info.ts — resolve the driver bot's public username
// ===========================================================================
//
// The onboarding Done step and the driver profile page need a t.me link to the
// REAL driver bot (the one whose TELEGRAM_DRIVER_BOT_TOKEN webhook runs the
// linking flow) — a hardcoded username drifts the moment the token is rotated
// to a different bot, and previously pointed customers at the dev team's
// internal bot. We resolve the username from Telegram's getMe once and cache
// it per token (usernames effectively never change; a rename is picked up when
// the cache entry expires).
//
// Fail-soft: no token or a getMe failure yields { configured, username: null }
// so the UI can hide the button with a "not configured" note instead of 500ing
// the page. Failures are NOT cached — the next call re-probes.
// ---------------------------------------------------------------------------

import { fetchWithTimeout } from "./fetch-timeout";
import { getIntegrationValue } from "./integration-config";

export interface DriverBotInfo {
  configured: boolean;
  username: string | null;
}

const CACHE_TTL_MS = 10 * 60 * 1000;

let cache: { token: string; username: string; expiresAt: number } | null = null;

/** The driver bot token (DB override first, env fallback) — or null. */
export function driverBotToken(): string | null {
  return getIntegrationValue("telegram_driver_bot", "TELEGRAM_DRIVER_BOT_TOKEN") ?? null;
}

/**
 * getMe → username for a bot token. Injectable fetch so tests run without
 * network. Returns null on any HTTP / shape / network failure (never throws).
 */
export async function fetchBotUsername(
  token: string,
  fetchImpl: typeof fetchWithTimeout = fetchWithTimeout,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`);
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { username?: string };
    };
    const username = body.ok ? body.result?.username : undefined;
    return typeof username === "string" && username.length > 0 ? username : null;
  } catch {
    // Token is embedded in the URL — never log the raw error (see tg-bot's
    // redactToken rationale). The caller degrades to "not configured".
    return null;
  }
}

/** Test-only seam: clear the memoized username. */
export function __resetBotInfoCacheForTest(): void {
  cache = null;
}

/**
 * Public bot info for the frontend. Cached per token for CACHE_TTL_MS.
 */
export async function getDriverBotInfo(
  fetchImpl: typeof fetchWithTimeout = fetchWithTimeout,
): Promise<DriverBotInfo> {
  const token = driverBotToken();
  if (!token) return { configured: false, username: null };
  const now = Date.now();
  if (cache && cache.token === token && cache.expiresAt > now) {
    return { configured: true, username: cache.username };
  }
  const username = await fetchBotUsername(token, fetchImpl);
  if (username) {
    cache = { token, username, expiresAt: now + CACHE_TTL_MS };
  }
  return { configured: true, username };
}
