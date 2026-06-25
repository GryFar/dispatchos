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
import { getIntegrationValue } from "../lib/integration-config";
import { parseSylectusEmail, type SylectusParsed } from "../lib/parsers/sylectus";

// Fire-and-forget TG alert when a parsed Sylectus posting lands. No-op
// unless TELEGRAM_DRIVER_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID are both set.
// We deliberately don't await this from the request handler — it must not
// delay our 201 back to the CF Worker.
async function notifyInboundLoad(id: string, parsed: SylectusParsed): Promise<void> {
  // Resolve via the integration store (admin-UI value) with env fallback — the
  // webhook path (telegram-bot.ts) does the same, so a token set only in the UI
  // works here too instead of this alert silently no-op'ing.
  const token =
    getIntegrationValue("telegram_driver_bot", "TELEGRAM_DRIVER_BOT_TOKEN") ??
    process.env.TELEGRAM_DRIVER_BOT_TOKEN;
  const chat =
    getIntegrationValue("telegram_driver_bot", "TELEGRAM_ALERT_CHAT_ID") ??
    process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chat) return;
  if (!parsed.matched || !parsed.origin || !parsed.destination) return;

  const lane = `${parsed.origin.city}, ${parsed.origin.state} → ${parsed.destination.city}, ${parsed.destination.state}`;
  const rate = parsed.rate ? `$${parsed.rate.toLocaleString("en-US")}` : "?";
  const miles = parsed.miles ? `${parsed.miles} mi` : "? mi";
  const rpm = parsed.rate && parsed.miles ? `$${(parsed.rate / parsed.miles).toFixed(2)}/mi` : null;
  const brokerLine = parsed.broker?.name
    ? `\n<b>Broker:</b> ${escapeHtml(parsed.broker.name)}${parsed.broker.mcNumber ? ` (MC# ${parsed.broker.mcNumber})` : ""}`
    : "";
  const refLine = parsed.reference ? `\n<b>Ref:</b> <code>${escapeHtml(parsed.reference)}</code>` : "";

  const text = [
    `📨 <b>New load posting</b> (Sylectus)`,
    ``,
    `<b>${escapeHtml(lane)}</b>`,
    `<b>Rate:</b> ${rate}  ·  <b>${miles}</b>${rpm ? `  ·  <b>${rpm}</b>` : ""}`,
    parsed.equipment ? `<b>Equipment:</b> ${escapeHtml(parsed.equipment)}` : "",
    parsed.weightLbs ? `<b>Weight:</b> ${parsed.weightLbs.toLocaleString("en-US")} lbs` : "",
    parsed.pickupAt ? `<b>Pickup:</b> ${escapeHtml(parsed.pickupAt)}` : "",
    brokerLine,
    refLine,
    ``,
    `<i>email_ingest id:</i> <code>${id}</code>`,
  ]
    .filter((line) => line !== "")
    .join("\n");

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error("[inbound/email] TG notify failed:", err);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

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
    // Log failed secret attempts so brute-force grinding against the static
    // inbound secret is visible to alerting. Never log the provided value —
    // only the source IP and whether a header was present at all.
    console.warn(
      `[inbound] rejected request: bad x-inbound-secret (present=${typeof provided === "string"}) from ${req.ip ?? "unknown"}`,
    );
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
    // Bound sizes so a leaked inbound secret can't write multi-MB blobs (DoS).
    const subjectStr = typeof body.subject === "string" ? body.subject : "";
    if (body.from.length > 998 || subjectStr.length > 998 || body.body.length > 1_000_000) {
      return res.status(413).json({ message: "email fields exceed size limits" });
    }

    const input = {
      from: body.from,
      subject: subjectStr,
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
      // Fire-and-forget alert — don't block the 201 response.
      void notifyInboundLoad(record.id, parsed);
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
