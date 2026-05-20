// Inbound integration endpoints.
//
// These are called by external systems (Cloudflare Email Worker, future
// webhook providers) to push data INTO DispatchOS without holding a user
// session. Each endpoint requires a shared secret in a header.
//
// Currently:
//   POST /api/inbound/email  — Cloudflare Email Worker forwards raw email,
//                              we parse + persist as email_ingest row.

import type { Express, Request, Response } from "express";
import crypto from "node:crypto";
import { storage } from "../storage";
import { parseSylectusEmail } from "../lib/parsers/sylectus";

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireInboundSecret(req: Request, res: Response): boolean {
  const expected = process.env.DISPATCHOS_INBOUND_SECRET;
  if (!expected) {
    res.status(503).json({ message: "Inbound disabled: DISPATCHOS_INBOUND_SECRET not set" });
    return false;
  }
  const header = req.headers["x-inbound-secret"];
  const provided = Array.isArray(header) ? header[0] : header;
  if (typeof provided !== "string" || !timingSafeEqual(provided, expected)) {
    res.status(401).json({ message: "Unauthorized" });
    return false;
  }
  return true;
}

export function registerInboundRoutes(app: Express): void {
  // -------------------------------------------------------------------------
  // POST /api/inbound/email
  //
  // Auth: X-Inbound-Secret header.
  // Body: { from: string, subject: string, body: string, to?: string,
  //         messageId?: string, receivedAt?: string }
  //
  // Pipeline:
  //   1. Run parseSylectusEmail() — best-effort structured extraction
  //   2. Persist via storage.saveEmailIngest() with the parsed result
  //   3. Return { id, parsed }  (no Load created yet — dispatcher reviews
  //      in UI before promote-to-load)
  // -------------------------------------------------------------------------
  app.post("/api/inbound/email", (req: Request, res: Response) => {
    if (!requireInboundSecret(req, res)) return;

    const body = req.body as {
      from?: unknown;
      subject?: unknown;
      body?: unknown;
      to?: unknown;
      messageId?: unknown;
      receivedAt?: unknown;
    };

    if (typeof body?.from !== "string" || typeof body?.body !== "string") {
      return res.status(400).json({ message: "from and body are required strings" });
    }

    const input = {
      from: body.from,
      subject: typeof body.subject === "string" ? body.subject : "",
      body: body.body,
    };

    try {
      const parsed = parseSylectusEmail(input);
      const record = storage.saveEmailIngest({
        ...input,
        to: typeof body.to === "string" ? body.to : undefined,
        messageId: typeof body.messageId === "string" ? body.messageId : undefined,
        receivedAt: typeof body.receivedAt === "string" ? body.receivedAt : new Date().toISOString(),
        parsed,
      });
      return res.status(201).json({ id: record.id, parsed });
    } catch (err) {
      console.error("[inbound/email] persist failed:", err);
      return res.status(500).json({
        message: "Persist failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
