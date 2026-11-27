// ===========================================================================
// server/lib/integration-config.ts — runtime resolver for UI-editable secrets
// ===========================================================================
//
// At runtime, when a part of the system needs e.g. FMCSA_WEB_KEY, it calls
// getIntegrationValue('fmcsa', 'FMCSA_WEB_KEY') instead of reading
// process.env directly. Precedence:
//
//   1. If integration_configs has a row for (key, envVar) → decrypt and use.
//   2. Otherwise fall back to process.env[envVar].
//   3. If neither exists → undefined.
//
// The DB layer ALWAYS wins so the admin UI can override a stale Fly secret
// without redeploying. A small in-process cache (5s TTL) keeps hot reads
// cheap; admins editing the value will see it on the next call after TTL.
// ---------------------------------------------------------------------------

import { storage } from "../storage";
import { decryptSecret } from "./crypto/keyring";

interface CacheEntry {
  value: string | undefined;
  expiresAt: number;
}

const CACHE_TTL_MS = 5_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(integrationKey: string, envVar: string) {
  return `${integrationKey}::${envVar}`;
}

/**
 * Read an integration secret. Returns string when set, undefined when
 * neither DB nor env has a value. Never throws on decryption errors —
 * logs and falls back to env so a bad row can't take the system down.
 */
export function getIntegrationValue(
  integrationKey: string,
  envVar: string,
): string | undefined {
  const k = cacheKey(integrationKey, envVar);
  const now = Date.now();
  const cached = cache.get(k);
  if (cached && cached.expiresAt > now) return cached.value;

  const row = storage.getIntegrationConfigRaw(integrationKey, envVar);
  let value: string | undefined;
  if (row) {
    try {
      value = decryptSecret({
        ciphertext: row.value_enc,
        iv: row.value_iv,
        keyId: row.value_key_id as "primary" | "secondary",
      });
    } catch (err) {
      console.error(
        `[integration-config] decrypt failed for ${integrationKey}/${envVar}:`,
        (err as Error).message,
      );
      // Fall through to env fallback below.
    }
  }
  if (value === undefined) {
    value = process.env[envVar];
  }
  cache.set(k, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/**
 * Like getIntegrationValue but throws if the value is missing. Use in
 * code paths where the absence is a programmer/config error (callers
 * already filtered for needs_config).
 */
export function requireIntegrationValue(
  integrationKey: string,
  envVar: string,
): string {
  const value = getIntegrationValue(integrationKey, envVar);
  if (value === undefined) {
    throw new Error(`Integration value missing: ${integrationKey}/${envVar}`);
  }
  return value;
}

/**
 * Bust the cache (called from admin endpoints after set/clear so the next
 * read of the integration sees the new value immediately).
 */
export function invalidateIntegrationConfigCache(
  integrationKey?: string,
  envVar?: string,
): void {
  if (integrationKey && envVar) {
    cache.delete(cacheKey(integrationKey, envVar));
    return;
  }
  if (integrationKey) {
    const toDelete: string[] = [];
    cache.forEach((_value, key) => {
      if (key.startsWith(`${integrationKey}::`)) toDelete.push(key);
    });
    toDelete.forEach((k) => cache.delete(k));
    return;
  }
  cache.clear();
}

/**
 * Source discriminator for the admin UI — lets the page show
 * "from database (set by an admin 5 min ago)" vs "from Fly secret".
 */
export function getIntegrationValueSource(
  integrationKey: string,
  envVar: string,
): "db" | "env" | "missing" {
  const row = storage.getIntegrationConfigRaw(integrationKey, envVar);
  if (row) return "db";
  if (process.env[envVar]) return "env";
  return "missing";
}
