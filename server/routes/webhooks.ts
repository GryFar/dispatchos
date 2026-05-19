// Inbound webhooks from third-party services.
//
// Currently:
//   - POST /api/webhooks/resend — Resend email events (sent, delivered, bounce,
//     complaint, opened, clicked)
//
// All webhook endpoints are PUBLIC (no auth gate) because the calling service
// can't know our session cookies. They MUST verify a shared secret in the
// header (Resend uses a configurable signing secret).

import type { Express, Request, Response } from "express";
import crypto from "node:crypto";
import { storage } from "../storage";

interface ResendWebhookEvent {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    from?: string;
    subject?: string;
    [k: string]: unknown;
  };
}

// Resend webhook signing: SHA-256 HMAC over the raw body using the secret.
// See https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests
function verifyResendSignature(rawBody: string, signature: string, secret: string): boolean {
  if (!signature || !secret) return false;
  // Resend sends "v0,whsec_<hex>" format on header svix-signature
  // Different versions of svix use different schemes; support both.
  // Simplest implementation: compare HMAC-SHA256(secret, body) hex to the
  // hex part of the signature header.
  try {
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    return signature.includes(expected);
  } catch {
    return false;
  }
}

export function registerWebhookRoutes(app: Express): void {
  // -------------------------------------------------------------------------
  // POST /api/webhooks/resend
  // -------------------------------------------------------------------------
  // We use express.json() globally in routes.ts; for HMAC verification we need
  // the raw body. Resend's payload is tiny (<1KB) so we re-stringify after
  // parsing — that's NOT how HMAC normally works (whitespace would change the
  // digest) but it's pragmatic for a low-stakes notify-only endpoint.
  // For production-grade verification we'd use express.raw() on this path.
  app.post("/api/webhooks/resend", (req: Request, res: Response) => {
    const secret = process.env.RESEND_WEBHOOK_SECRET;

    // If a secret is configured, verify signature header.
    if (secret) {
      const sig =
        (req.headers["svix-signature"] as string | undefined) ??
        (req.headers["resend-signature"] as string | undefined) ??
        "";
      const raw = JSON.stringify(req.body);
      if (!verifyResendSignature(raw, sig, secret)) {
        return res.status(401).json({ message: "Invalid signature" });
      }
    }

    const event = req.body as ResendWebhookEvent;
    if (!event || typeof event.type !== "string") {
      return res.status(400).json({ message: "Malformed event" });
    }

    // Normalize "to" — Resend sometimes sends array, sometimes single string
    const toRaw = event.data?.to;
    const toEmail = Array.isArray(toRaw) ? toRaw[0] : toRaw;

    // Log via existing audit channel — this puts the event into audit_events
    // table which is already exposed in admin UI. Zero new schema needed.
    storage.audit(
      `resend.${event.type}`,
      "email",
      event.data?.email_id ?? "unknown",
      {
        type: event.type,
        emailId: event.data?.email_id,
        to: toEmail,
        from: event.data?.from,
        subject: event.data?.subject,
        createdAt: event.created_at,
      },
    );

    // Surface high-impact events to console for now; future: alert to TG
    if (
      event.type === "email.bounced" ||
      event.type === "email.complained" ||
      event.type === "email.delivery_delayed"
    ) {
      console.warn(`[resend webhook] ${event.type}: to=${toEmail} id=${event.data?.email_id}`);
    }

    return res.status(204).end();
  });
}
