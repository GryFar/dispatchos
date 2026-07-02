// ===========================================================================
// server/routes/password-reset.ts — self-serve password reset (email token)
// ===========================================================================
//
//   POST /api/auth/forgot-password { email }
//       ALWAYS 200 { ok:true } — same status, same body whether or not an
//       account exists (no account-existence oracle). When a non-blocked user
//       matches, we store sha256(token) (30 min TTL, single-use), invalidate
//       any prior outstanding tokens, and email the raw token as
//       ${PUBLIC_URL}/#/reset-password?token=<raw>. The token rides the URL
//       hash FRAGMENT so it never reaches server access logs.
//
//   POST /api/auth/reset-password { token, newPassword }
//       Looks up sha256(token); 400 generic "Invalid or expired link" for
//       missing/expired/used (never says which). Password policy = the same
//       zod rule signup uses (signupSchema.shape.password). On success:
//       rehash + update, mark the token used, and bump session_epoch — the
//       codebase's session-revocation mechanism (getCurrentUser destroys any
//       session whose epoch is stale), so every pre-reset session dies.
//
// Both routes are public: the /api auth gate in routes.ts exempts /auth/*.
// ---------------------------------------------------------------------------

import type { Express, Request, Response } from "express";
import crypto from "node:crypto";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { signupSchema } from "@shared/schema";
import { hashPassword } from "../auth";
import { storage } from "../storage";
import { sendPasswordResetEmail } from "../lib/email";

const RESET_TOKEN_TTL_MS = 30 * 60_000;

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Generate + persist a reset token for a user: invalidates every prior
 * outstanding token first (a fresh request supersedes older links), stores
 * ONLY the sha256 of the raw token. Returns the raw token for the email link.
 * Exported for the unit test — the HTTP layer never returns the raw token.
 */
export function issuePasswordResetToken(userId: string): { raw: string; expiresAt: string } {
  const raw = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  storage.invalidateUserPasswordResetTokens(userId);
  storage.createPasswordResetToken({ userId, tokenHash: sha256Hex(raw), expiresAt });
  return { raw, expiresAt };
}

export function forgotPasswordHandler(req: Request, res: Response) {
  const email = String((req.body as { email?: unknown })?.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    // Shape validation only — a malformed email leaks nothing about accounts.
    return res.status(400).json({ ok: false, error: "invalid_email" });
  }

  const user = storage.getUserByEmail(email);
  const eligible = Boolean(user && !user.blocked && !user.deletedAt);
  if (user && eligible) {
    const { raw } = issuePasswordResetToken(user.id);
    const base = process.env.DISPATCHOS_PUBLIC_URL || "https://dispatchos.co";
    // Fire-and-forget: awaiting Resend here would make response latency a
    // user-exists oracle (and a Resend outage shouldn't 500 this route).
    void sendPasswordResetEmail({
      to: user.email,
      resetUrl: `${base}/#/reset-password?token=${raw}`,
    }).catch((err) => console.error("[password-reset] email send failed:", err));
  }
  // The audit trail may differ per outcome; the HTTP response must not.
  storage.audit("auth.password_reset_requested", "user", user?.id ?? email, {
    email,
    userExists: Boolean(user),
  });
  return res.json({ ok: true });
}

export function resetPasswordHandler(req: Request, res: Response) {
  const body = (req.body ?? {}) as { token?: unknown; newPassword?: unknown };
  const token = String(body.token ?? "").trim();
  const newPassword = String(body.newPassword ?? "");

  // Same policy as signup — reuse the zod rule, don't invent a second one.
  const pw = signupSchema.shape.password.safeParse(newPassword);
  if (!pw.success) {
    return res.status(400).json({
      message: "password must be at least 10 characters",
      code: "weak_password",
    });
  }

  // One generic rejection for missing/unknown/expired/used — never reveal
  // which, so a captured old link can't be probed for state.
  const invalid = () =>
    res.status(400).json({ message: "Invalid or expired link", code: "invalid_token" });

  if (!token) return invalid();
  const row = storage.findPasswordResetTokenByHash(sha256Hex(token));
  if (!row || row.usedAt || new Date(row.expiresAt).getTime() <= Date.now()) {
    return invalid();
  }
  const user = storage.getUserById(row.userId);
  if (!user || user.blocked || user.deletedAt) return invalid();

  // Consume BEFORE the password write: markPasswordResetTokenUsed is keyed on
  // used_at IS NULL, so a concurrent double-submit resets at most once.
  if (!storage.markPasswordResetTokenUsed(row.id)) return invalid();

  const { salt, hash } = hashPassword(newPassword);
  storage.updateUser(user.id, { passwordSalt: salt, passwordHash: hash }, user.id);
  // Destroy all existing sessions: bumping session_epoch makes getCurrentUser
  // reject (and destroy) every session minted before this point — same
  // mechanism as the admin reset-password flow.
  storage.bumpUserSessionEpoch(user.id);
  storage.audit("auth.password_reset_completed", "user", user.id, { email: user.email });
  return res.json({ ok: true });
}

export function registerPasswordResetRoutes(app: Express): void {
  // Unauthenticated + triggers outbound email → throttle hard. Per-IP via
  // ipKeyGenerator (IPv6-safe) AND per-target-email, so a botnet spread across
  // IPs still can't flood one inbox (mirrors the send-code limiter pattern).
  const forgotIpLimiter = rateLimit({
    windowMs: 60 * 60_000,
    limit: Number(process.env.DISPATCHOS_FORGOT_PW_IP_PER_HOUR || 5),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
    message: { ok: false, error: "rate_limited" },
  });
  const forgotEmailLimiter = rateLimit({
    windowMs: 60 * 60_000,
    limit: Number(process.env.DISPATCHOS_FORGOT_PW_EMAIL_PER_HOUR || 3),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const email = String((req.body as { email?: unknown })?.email ?? "").trim().toLowerCase();
      return email ? `email:${email}` : ipKeyGenerator(req.ip || "unknown");
    },
    message: { ok: false, error: "rate_limited" },
  });
  // reset-password verifies tokens, not passwords, but still cap probing.
  const resetIpLimiter = rateLimit({
    windowMs: 60 * 60_000,
    limit: Number(process.env.DISPATCHOS_RESET_PW_IP_PER_HOUR || 10),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
    message: { ok: false, error: "rate_limited" },
  });

  app.post("/api/auth/forgot-password", forgotIpLimiter, forgotEmailLimiter, forgotPasswordHandler);
  app.post("/api/auth/reset-password", resetIpLimiter, resetPasswordHandler);
}
