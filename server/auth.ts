import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { UserRole } from "@shared/schema";
import { storage, type UserInternal } from "./storage";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ISSUER = "DispatchOS";

declare module "express-session" {
  interface SessionData {
    /** Set by /api/auth/login on success. The presence of userId means the
     *  session is authenticated under the role recorded in this same payload. */
    userId?: string;
    role?: UserRole;
    /** Kept for backward compat with v1.2.7 frontend that reads this flag
     *  from /api/auth/status. New code should consult userId / role. */
    authenticated?: boolean;
    /** Set by POST /api/me/totp/setup. Holds a freshly generated TOTP
     *  secret that has NOT yet been persisted to users.totp_secret.
     *  POST /api/me/totp/confirm verifies a code against this pending
     *  secret before committing it. We keep it in the session (not in DB)
     *  so abandoning the setup flow leaves no orphan secret. */
    pendingTotpSecret?: string;
  }
}

// ===========================================================================
// Password hashing (pbkdf2-sha256)
// ===========================================================================
//
// Audit High #10 (2026-05-26): bumped iterations from 210_000 → 600_000 to
// match OWASP 2024 guidance for SHA-256. Existing hashes were stored raw
// hex with NO algorithm/iteration prefix, so we need to keep verifying them
// at the old count to avoid invalidating every account on deploy.
//
// Strategy:
//   • New hashes are stored with a prefix «pbkdf2$<iters>$<hex>» so future
//     bumps are graceful again.
//   • Legacy hashes (no prefix) are recognised by their bare 64-char hex
//     shape and verified at the old 210k count. On successful verify we
//     return `needsRehash = true` so the caller can upgrade transparently
//     at the next successful login.
//   • Caller (routes.ts /api/auth/login) checks the flag and calls
//     `updateUserPassword` to migrate. Backwards compatible end-to-end.
// ---------------------------------------------------------------------------

export const CURRENT_PBKDF2_ITERATIONS = 600_000;
const LEGACY_PBKDF2_ITERATIONS = 210_000;

function pbkdf2(password: string, salt: string, iterations: number): string {
  return crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
}

export function hashPassword(
  password: string,
  salt = crypto.randomBytes(16).toString("hex"),
): { salt: string; hash: string } {
  const hash = `pbkdf2$${CURRENT_PBKDF2_ITERATIONS}$${pbkdf2(password, salt, CURRENT_PBKDF2_ITERATIONS)}`;
  return { salt, hash };
}

/**
 * Verify a password against a stored hash, supporting both the new prefixed
 * format and legacy bare-hex 210k hashes.
 *
 * Returns `{ ok, needsRehash }` so the caller can opportunistically migrate
 * legacy hashes on the next login. Boolean coercion (`!!result.ok`) keeps
 * old callers happy if they ever existed (none do in-tree today).
 */
export function verifyPassword(
  password: string,
  salt: string,
  storedHash: string,
): { ok: boolean; needsRehash: boolean } {
  // New format: pbkdf2$<iters>$<hex>
  if (storedHash.startsWith("pbkdf2$")) {
    const parts = storedHash.split("$");
    if (parts.length !== 3) return { ok: false, needsRehash: false };
    const iters = Number(parts[1]);
    if (!Number.isInteger(iters) || iters < LEGACY_PBKDF2_ITERATIONS) {
      return { ok: false, needsRehash: false };
    }
    const expected = parts[2];
    if (expected.length !== 64) return { ok: false, needsRehash: false };
    const candidate = pbkdf2(password, salt, iters);
    const ok = safeHexEq(candidate, expected);
    return { ok, needsRehash: ok && iters < CURRENT_PBKDF2_ITERATIONS };
  }
  // Legacy format: bare 64-char hex computed at 210_000 iterations.
  if (storedHash.length === 64 && /^[0-9a-f]+$/i.test(storedHash)) {
    const candidate = pbkdf2(password, salt, LEGACY_PBKDF2_ITERATIONS);
    const ok = safeHexEq(candidate, storedHash);
    return { ok, needsRehash: ok }; // always needs upgrade on success
  }
  return { ok: false, needsRehash: false };
}

function safeHexEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

// ===========================================================================
// TOTP (RFC 6238, SHA1, 30s, 6 digits, ±2 window drift = 150s tolerance)
// ===========================================================================

export function generateBase32Secret(length = 20) {
  const bytes = crypto.randomBytes(length);
  let output = "";
  for (let index = 0; index < bytes.length; index += 1) {
    output += BASE32[bytes[index] % BASE32.length];
  }
  return output;
}

function base32ToBuffer(secret: string) {
  let bits = "";
  const clean = secret.replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  for (const char of clean) {
    const value = BASE32.indexOf(char);
    if (value < 0) continue;
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = bits.match(/.{1,8}/g) ?? [];
  return Buffer.from(bytes.filter((byte) => byte.length === 8).map((byte) => Number.parseInt(byte, 2)));
}

function hotp(secret: string, counter: number) {
  const key = base32ToBuffer(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter & 0xffffffff, 4);
  const hmac = crypto.createHmac("sha1", key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

/**
 * Verify a TOTP token.
 *
 * Audit hardening (2026-05-26):
 *  - High #12: window narrowed from ±2 (150s tolerance) to ±1 (90s),
 *    matching RFC 6238 guidance. Reduces brute-force surface 60%.
 *  - High #11: optional `minCounter` enables replay protection — caller
 *    passes the last successfully-accepted counter, we refuse any drift
 *    ≤ minCounter. Caller must persist the returned counter on success.
 *
 * Returns the accepted counter on success (>= minCounter), or `null` on
 * failure. Call sites that don't yet track replay can ignore the value;
 * passing `null` for minCounter preserves the old (replay-tolerant) behaviour.
 */
export function verifyTotp(
  secret: string,
  token: string,
  minCounter: number | null = null,
): number | null {
  // Strip whitespace and any non-digit (e.g. soft hyphens from clipboard).
  const clean = token.replace(/\D+/g, "");
  if (clean.length !== 6) return null;
  const counter = Math.floor(Date.now() / 30_000);
  for (const drift of [-1, 0, 1]) {
    const candidate = counter + drift;
    if (minCounter !== null && candidate <= minCounter) continue;
    if (hotp(secret, candidate) === clean) return candidate;
  }
  return null;
}

export function buildOtpAuthUrl(username: string, secret: string) {
  const label = encodeURIComponent(`${ISSUER}:${username}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`;
}

// ===========================================================================
// Session helpers
// ===========================================================================

/** Loads the user from session. Returns undefined if no session, blocked, or
 *  user no longer exists in DB (e.g. deleted directly). For the third case,
 *  the session is destroyed so the client retries from a clean state. */
export function getCurrentUser(req: Request): UserInternal | undefined {
  const userId = req.session.userId;
  if (!userId) return undefined;
  const user = storage.getUserById(userId);
  if (!user) {
    // Session points at a non-existent user — clean it up.
    req.session.destroy(() => {});
    return undefined;
  }
  if (user.blocked) return undefined;
  return user;
}

// ===========================================================================
// requireRole middleware
// ===========================================================================
//
// Usage:
//   app.get('/api/admin/users', requireRole('admin'), handler)
//   app.get('/api/shared', requireRole('admin', 'dispatcher'), handler)
//   app.get('/api/any-authed', requireRole.any(), handler)
//
// requireRole.any() is the modern replacement for the v1.2.7 requireAuth.
// ---------------------------------------------------------------------------

type RoleMiddleware = (req: Request, res: Response, next: NextFunction) => void;

interface RequireRole {
  (...roles: UserRole[]): RoleMiddleware;
  any(): RoleMiddleware;
}

function makeRoleMiddleware(allowed: UserRole[] | "any"): RoleMiddleware {
  return (req, res, next) => {
    // Until the system has been bootstrapped (no admin exists), we let
    // /api/auth/* (handled outside this middleware) flow through. For all
    // other endpoints, we deny access. This closes the v1.2.7 hole where
    // an unconfigured public deployment exposed every endpoint.
    const state = storage.getAuthState();
    if (!state.isConfigured) {
      return res.status(401).json({
        message: "DispatchOS is not bootstrapped yet. Create the first admin via POST /api/auth/bootstrap.",
        bootstrap: true,
      });
    }
    const user = getCurrentUser(req);
    if (!user) {
      return res.status(401).json({ message: "Authentication required" });
    }
    if (allowed !== "any" && !allowed.includes(user.role)) {
      return res.status(403).json({
        message: `Role '${user.role}' is not allowed here. Required: ${allowed.join(" or ")}.`,
      });
    }
    next();
  };
}

export const requireRole: RequireRole = ((...roles: UserRole[]) =>
  makeRoleMiddleware(roles)) as RequireRole;
requireRole.any = () => makeRoleMiddleware("any");

// Backward-compat alias. Phase 3 will remove call sites.
export const requireAuth = requireRole.any();

// ===========================================================================
// requireActiveBilling — read-only mode enforcement
// ===========================================================================
//
// Returns 402 Payment Required on mutating /api endpoints when the caller's
// carrier (client) has billingStatus='expired' OR 'past_due' (after a 7-day
// grace). Read endpoints stay open so the user can see what they had and pay.
//
// Apply as: app.post("/api/loads", requireRole("admin","dispatcher"), requireActiveBilling, handler).
// We don't blanket-apply it across /api because some mutating routes are
// legitimately allowed in expired state (billing/checkout itself, logout,
// document export-then-leave, etc.).
const PAST_DUE_GRACE_DAYS = 7;

export function requireActiveBilling(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
) {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ message: "Authentication required" });

  // Resolve which carrier this user represents — mirror of resolveCallerClientId
  // from billing.ts but inline to avoid a circular import.
  let clientId: string | null = null;
  if (user.role === "driver") {
    clientId = user.linkedClientId ?? null;
  } else {
    // V4-009: resolve the carrier from an EXPLICIT signal only — query param or
    // request body clientId. NEVER fall back to listClients()[0]: that applied
    // one tenant's billing status to every caller (multi-tenant collapse). With
    // no explicit carrier context we let the request through (it's not a
    // carrier-scoped mutation, or the route validates clientId itself).
    const q = typeof req.query.clientId === "string" ? req.query.clientId : null;
    const bodyClientId =
      req.body && typeof req.body === "object" && typeof (req.body as { clientId?: unknown }).clientId === "string"
        ? (req.body as { clientId: string }).clientId
        : null;
    clientId = q ?? bodyClientId;
  }
  if (!clientId) return next(); // No carrier context — let through (bootstrap/onboarding)

  const client = storage.getClient(clientId) as
| (Record<string, unknown> & {
        billingStatus?: string;
        trialEndsAt?: string;
        pastDueSince?: string;
        stripeSubscriptionId?: string;
      })
    | undefined;
  if (!client) return next();

  const status = client.billingStatus;
  if (status === "expired") {
    return res.status(402).json({
      message:
        "Account is in read-only mode (trial expired or subscription canceled). Upgrade at /admin/billing.",
      billingStatus: "expired",
    });
  }
  if (status === "past_due") {
    // Grace period: allow PAST_DUE_GRACE_DAYS after the most recent failed
    // invoice, then treat as expired.
    // Prefer the actual failed-payment date (stamped by the Stripe webhook on
    // invoice.payment_failed). Fall back to trialEndsAt only for legacy records
    // that pre-date pastDueSince — we can't reconstruct the failure date for those.
    const ref = client.pastDueSince
      ? new Date(client.pastDueSince).getTime()
      : client.trialEndsAt
        ? new Date(client.trialEndsAt).getTime()
        : Date.now();
    const past = (Date.now() - ref) / (24 * 3600 * 1000);
    if (past > PAST_DUE_GRACE_DAYS) {
      return res.status(402).json({
        message:
          "Payment past due > 7 days. Account is read-only. Update card at /admin/billing.",
        billingStatus: "past_due",
      });
    }
  }
  next();
}
