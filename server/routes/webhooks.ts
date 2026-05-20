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

// Resend uses the Standard Webhooks / svix signature scheme.
//   Headers: svix-id, svix-timestamp, svix-signature
//   Signed payload: `${svix_id}.${svix_timestamp}.${raw_body}`
//   Signature: base64( HMAC-SHA256(secret_bytes, signed_payload) )
//   Header format: "v1,<base64sig> v1,<base64sig> ..." (may be multiple)
//   Secret must be base64-decoded after stripping the "whsec_" prefix.
// See https://www.standardwebhooks.com/ + https://docs.svix.com/receiving/verifying-payloads/how-manual
function verifyResendSignature(
  rawBody: string,
  svixId: string | undefined,
  svixTimestamp: string | undefined,
  svixSignatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!svixId || !svixTimestamp || !svixSignatureHeader || !secret) return false;

  // Strip prefix and decode base64 → raw secret bytes
  const cleaned = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(cleaned, "base64");
  } catch {
    return false;
  }
  if (secretBytes.length === 0) return false;

  const signedPayload = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secretBytes).update(signedPayload).digest("base64");

  // Header is space-separated list of "v1,<sig>" entries. Accept v1 only.
  const candidates = svixSignatureHeader.split(" ").map((s) => s.trim()).filter(Boolean);
  for (const candidate of candidates) {
    const [version, sig] = candidate.split(",");
    if (version !== "v1" || !sig) continue;
    // Constant-time compare to avoid timing attacks
    if (sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return true;
    }
  }
  return false;
}

export function registerWebhookRoutes(app: Express): void {
  // -------------------------------------------------------------------------
  // POST /api/webhooks/resend
  // -------------------------------------------------------------------------
  // Express applies express.json() globally; req.body is already the parsed
  // object. For svix HMAC we need the EXACT raw bytes (whitespace matters).
  // Two solutions:
  //   a) re-serialize req.body — fragile, whitespace differs
  //   b) capture rawBody via verify hook in express.json
  // We use (b) by checking (req as any).rawBody first, then falling back to
  // re-serialize. The rawBody hook is added in routes.ts express.json config
  // when this PR lands.
  app.post("/api/webhooks/resend", (req: Request, res: Response) => {
    const secret = process.env.RESEND_WEBHOOK_SECRET;

    if (secret) {
      const svixId = req.headers["svix-id"] as string | undefined;
      const svixTimestamp = req.headers["svix-timestamp"] as string | undefined;
      const svixSignature = req.headers["svix-signature"] as string | undefined;
      // express.json verify hook stores rawBody as a Buffer (see server/index.ts).
      // svix signature needs the EXACT bytes Resend signed.
      const rawBuf = (req as unknown as { rawBody?: Buffer }).rawBody;
      const rawBody = rawBuf ? rawBuf.toString("utf8") : JSON.stringify(req.body);
      if (!verifyResendSignature(rawBody, svixId, svixTimestamp, svixSignature, secret)) {
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
