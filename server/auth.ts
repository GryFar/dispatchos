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
// Password hashing (pbkdf2-sha256, 210k iterations) — unchanged from v1.2.7
// ===========================================================================

export function hashPassword(password: string, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 210_000, 32, "sha256").toString("hex");
  return { salt, hash };
}

export function verifyPassword(password: string, salt: string, expectedHash: string) {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(expectedHash, "hex"));
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

export function verifyTotp(secret: string, token: string) {
  // Strip whitespace and any non-digit (e.g. soft hyphens from clipboard).
  const clean = token.replace(/\D+/g, "");
  if (clean.length !== 6) return false;
  const counter = Math.floor(Date.now() / 30_000);
  // ±2 window = 150 seconds of tolerance. RFC 6238 allows up to ±1 by
  // default but users frequently type slower than 30s and authenticator
  // apps can drift up to a minute, so we widen to ±2.
  for (const drift of [-2, -1, 0, 1, 2]) {
    if (hotp(secret, counter + drift) === clean) return true;
  }
  return false;
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
