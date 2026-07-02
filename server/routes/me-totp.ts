// ===========================================================================
// server/routes/me-totp.ts — self-service 2FA setup
// ===========================================================================
//
// Three endpoints (any authenticated user, regardless of role):
//
//   GET  /api/me/totp/status          → { enabled: boolean }
//   POST /api/me/totp/setup           → { secret, otpauthUrl }
//                                       Generates a NEW secret + writes it to
//                                       session.pendingTotpSecret. Does NOT
//                                       touch users.totp_secret. Aborting the
//                                       flow at this point leaves no orphan.
//   POST /api/me/totp/confirm  { token }
//                                     → { enabled: true }
//                                       Validates token against the pending
//                                       secret. On success, persists it to
//                                       users.totp_secret and clears the
//                                       session field. Audits user.totp_enabled.
//
// Why session-staged instead of immediate write: if we wrote the new secret
// straight to the DB, a user who closes the page mid-setup would lock
// themselves out (DB secret != anything in their authenticator app). The
// session pattern matches what 1Password, Google, and Stripe do.
//
// This module is intentionally separate from server/routes/me.ts because
// the latter is gated by requireRole('driver'); 2FA setup must be available
// to every authenticated user (admin, dispatcher, driver).
// ---------------------------------------------------------------------------

import type { Express, Request, Response, NextFunction } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { ZodError } from "zod";
import { z } from "zod";
import { getCurrentUser, generateBase32Secret, buildOtpAuthUrl, verifyTotp, verifyPassword } from "../auth";
import { storage } from "../storage";

// POST /api/me/totp/setup runs verifyPassword for already-enrolled users, so it
// is a password-guessing oracle for anyone holding a valid session cookie.
// Rate-limit it. Keyed on the session user (NOT IP), so it binds to the targeted
// account and never locks out a shared-NAT office — safe to keep always on.
const totpSetupLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: Number(process.env.DISPATCHOS_TOTP_SETUP_LIMIT || 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.session?.userId ?? ipKeyGenerator(req.ip || "unknown"),
  message: { message: "Too many 2FA setup attempts. Try again in 15 minutes." },
});

// POST /api/me/totp/confirm verifies a code against the pending secret, and a
// FAILED verify never advances the replay counter (setLastUsedTotpCounter is
// only reached after acceptedCounter !== null), so wrong guesses are otherwise
// free. Throttle per session user — same key as the setup limiter — so it binds
// to the targeted account and never locks out a shared-NAT office.
const totpConfirmLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: Number(process.env.DISPATCHOS_TOTP_CONFIRM_LIMIT || 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.session?.userId ?? ipKeyGenerator(req.ip || "unknown"),
  message: { message: "Too many 2FA confirmation attempts. Try again in 15 minutes." },
});

function ah(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => handler(req, res, next))
      .catch((error: unknown) => {
        if (error instanceof ZodError) {
          return res.status(400).json({
            message: "Validation failed",
            issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
          });
        }
        return next(error);
      });
  };
}

const confirmSchema = z.object({
  token: z.string().min(1, "token is required"),
});

export function registerMeTotpRoutes(app: Express): void {
  // GET /api/me/totp/status — cheap "do I have 2FA?" probe for the dashboard
  // banner. Returns { enabled: false } if the secret column is null.
  app.get(
    "/api/me/totp/status",
    ah((req, res) => {
      const user = getCurrentUser(req);
      if (!user) return res.status(401).json({ message: "Authentication required" });
      return res.json({ enabled: Boolean(user.totpSecret) });
    }),
  );

  // POST /api/me/totp/setup — stage a new secret in session.
  // Returns { secret, otpauthUrl }. The secret is shown to the user once for
  // the manual-entry fallback; the otpauthUrl is for QR rendering.
  app.post(
    "/api/me/totp/setup",
    totpSetupLimiter,
    ah((req, res) => {
      const user = getCurrentUser(req);
      if (!user) return res.status(401).json({ message: "Authentication required" });

      // H3 step-up: rotating an ALREADY-enabled 2FA requires re-entering the
      // current password, so a hijacked session can't silently move 2FA to an
      // attacker's authenticator. First-time enrollment needs no password.
      if (user.totpSecret) {
        const currentPassword =
          typeof (req.body as { currentPassword?: unknown })?.currentPassword === "string"
            ? (req.body as { currentPassword: string }).currentPassword
            : "";
        const { ok } = verifyPassword(currentPassword, user.passwordSalt, user.passwordHash);
        if (!ok) {
          // Audit parity with auth.login_failed / auth.confirm_signup_failed —
          // a wrong-password attempt during 2FA re-issue is a notable auth event.
          storage.audit("user.totp_reissue_password_failed", "user", user.id, {
            userId: user.id,
            actorUserId: user.id,
          });
          return res.status(401).json({
            message: "Текущий пароль обязателен для перевыпуска 2FA.",
            code: "password_required",
          });
        }
      }

      // The new secret only becomes active after /confirm succeeds.
      const secret = generateBase32Secret();
      req.session.pendingTotpSecret = secret;

      return res.json({
        secret,
        otpauthUrl: buildOtpAuthUrl(user.email, secret),
      });
    }),
  );

  // POST /api/me/totp/confirm { token } — verify code against pending secret,
  // then persist. We deliberately do NOT fall back to the user's existing
  // totp_secret here: confirm is meant for the setup flow only. If you just
  // want to test that a code is valid (e.g. mid-session re-auth), that's a
  // separate concern handled by /api/auth/login.
  app.post(
    "/api/me/totp/confirm",
    totpConfirmLimiter,
    ah((req, res) => {
      const user = getCurrentUser(req);
      if (!user) return res.status(401).json({ message: "Authentication required" });

      const body = confirmSchema.parse(req.body);
      const pending = req.session.pendingTotpSecret;
      if (!pending) {
        return res.status(400).json({
          message: "No 2FA setup in progress. Call POST /api/me/totp/setup first.",
        });
      }

      // Audit High #11/#12 — verifyTotp returns the accepted counter or null.
      // For setup/rotation minCounter=null: `pending` is a BRAND-NEW secret with
      // its own (empty) replay history, independent of the old secret's counter.
      const acceptedCounter = verifyTotp(pending, body.token);
      if (acceptedCounter === null) {
        return res.status(401).json({ message: "Invalid 2FA token" });
      }

      // Persist the new secret AND reset last_used_totp_counter to NULL in one
      // atomic write. On a ROTATION the user just authenticated with the OLD
      // secret, so last_used_totp_counter is already at/above the current
      // time-window; without this reset the new secret's first code (same
      // window) would fail the setLastUsedTotpCounter replay gate below and 401,
      // making rotation impossible. Clearing it re-bases replay protection on
      // the new secret's own history.
      const installed = storage.installTotpSecret(user.id, pending, user.id);
      if (!installed) return res.status(404).json({ message: "User not found" });

      // Replay guard, now against the freshly-reset (NULL) baseline: seed the
      // counter we just accepted so future logins reject replays. If a
      // concurrent confirm already seeded this same counter for the new secret,
      // setLastUsedTotpCounter returns false — reject as a replay (mirrors the
      // login and confirm-signup paths).
      if (!storage.setLastUsedTotpCounter(user.id, acceptedCounter)) {
        return res.status(401).json({ message: "Invalid 2FA token" });
      }
      // CRITICAL: stamp totp_confirmed_at. The login gate rejects any user with
      // a secret but no confirmation (code: "totp_setup_required"). updateUser
      // does NOT touch totp_confirmed_at, so without this the user who just
      // enabled 2FA is locked out on their very next login.
      //
      // confirmTotpSetup's IS-NULL-guarded UPDATE returns firstConfirm=false if a
      // concurrent confirm already stamped it; don't emit a fresh "enabled" audit
      // for the loser of that race (mirrors the confirm-signup path in routes.ts).
      const { firstConfirm } = storage.confirmTotpSetup(user.id);
      if (!firstConfirm) {
        req.session.pendingTotpSecret = undefined;
        return res.status(409).json({
          message: "2FA already confirmed for this account.",
          code: "already_confirmed",
        });
      }

      // Clear the staging field — secret is now in the DB.
      req.session.pendingTotpSecret = undefined;

      storage.audit("user.totp_enabled", "user", user.id, {
        userId: user.id,
        actorUserId: user.id,
      });

      return res.json({ enabled: true });
    }),
  );
}
