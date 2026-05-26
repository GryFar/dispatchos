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
import { ZodError } from "zod";
import { z } from "zod";
import { getCurrentUser, generateBase32Secret, buildOtpAuthUrl, verifyTotp } from "../auth";
import { storage } from "../storage";

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
    ah((req, res) => {
      const user = getCurrentUser(req);
      if (!user) return res.status(401).json({ message: "Authentication required" });

      // Even if user already has 2FA, allow re-setup (rotate). The new secret
      // only becomes active after /confirm succeeds.
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
      // For initial setup minCounter=null (no replay history yet); we seed it
      // with the counter we just accepted so future logins reject replays.
      const acceptedCounter = verifyTotp(pending, body.token);
      if (acceptedCounter === null) {
        return res.status(401).json({ message: "Invalid 2FA token" });
      }

      const updated = storage.updateUser(user.id, { totpSecret: pending }, user.id);
      if (!updated) return res.status(404).json({ message: "User not found" });
      storage.setLastUsedTotpCounter(user.id, acceptedCounter);

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
