// Phase 4 — signup leads routing.
//
// Three contexts:
//   1. Public: POST /api/public/subscribe — landing page email capture.
//      No auth. Lightweight rate-limit by IP.
//   2. Dispatcher: GET/POST /api/dispatch/leads/* — review queue, approve→invite.
//      requireRole('dispatcher','admin').
//   3. Admin: same dispatcher endpoints (admin can do everything).
//
// Approve flow generates an invite via existing storage.createInviteWithCode
// and links it back to the lead row. The actual email/SMS delivery is the
// dispatcher's job (manual paste of signupUrl) — see HANDOFF §2.4.

import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { requireRole, getCurrentUser } from "../auth";
import { sendInviteEmail } from "../lib/email";
import {
  subscribePublicSchema,
  approveLeadSchema,
  rejectLeadSchema,
  listLeadsQuerySchema,
} from "@shared/schema";
import crypto from "node:crypto";
import { generateInviteCode } from "../lib/invite-code";
import { canAddDriver } from "../lib/plans";

// Simple in-memory rate-limit: max 5 subscriptions per IP per hour.
// H24: bound the map. Keyed on a (previously spoofable) client IP, entries were
// inserted on first hit and NEVER swept, so an attacker varying the key grew the
// heap without bound → OOM. Sweep expired entries when the map gets large and
// hard-cap total keys (fail-closed under a flood rather than exhaust memory).
const subscribeAttempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX_KEYS = 50_000;

function sweepExpired(now: number): void {
  subscribeAttempts.forEach((v, k) => {
    if (now > v.resetAt) subscribeAttempts.delete(k);
  });
}

function rateLimitOk(ip: string): boolean {
  const now = Date.now();
  const entry = subscribeAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    if (subscribeAttempts.size >= RATE_LIMIT_MAX_KEYS) {
      sweepExpired(now);
      // Still full after sweeping live windows → refuse new keys (the public
      // subscribe endpoint is non-critical; failing closed beats OOM).
      if (subscribeAttempts.size >= RATE_LIMIT_MAX_KEYS) return false;
    }
    subscribeAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

function clientIp(req: Request): string {
  // H24: use req.ip (honours Express `trust proxy`) instead of the raw leftmost
  // X-Forwarded-For entry, which is fully attacker-controlled and let a flood
  // mint a fresh rate-limit bucket per request.
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

// Audit V3-3 — hardened against Host-header injection. We never trust
// X-Forwarded-Host or Host headers for outbound URLs embedded in email or
// Telegram messages. Production *always* sets DISPATCHOS_PUBLIC_URL; we
// fall back to a hard-coded allowlist only when it's missing (dev).
const PUBLIC_URL_ALLOWLIST = new Set([
  "https://dispatchos.co",
  "https://www.dispatchos.co",
  "https://demo.dispatchos.co",
  "https://app.dispatchos.co",
]);
function hostFromReq(req: Request): string {
  // Source of truth: explicit env var. This is the safe path.
  const envUrl = process.env.DISPATCHOS_PUBLIC_URL;
  if (envUrl) {
    // Strip trailing slash for clean concat at call sites.
    return envUrl.replace(/\/$/, "");
  }
  // Fall back only if env not set (local dev). Even then we check Host
  // against an allowlist; an unknown host means we return the safe default.
  const xfHost = req.headers["x-forwarded-host"];
  const rawHost = typeof xfHost === "string" ? xfHost : req.headers.host;
  if (!rawHost) return "https://dispatchos.co";
  const xfProto = req.headers["x-forwarded-proto"];
  const proto = (typeof xfProto === "string" ? xfProto : req.protocol) ?? "https";
  const candidate = `${proto}://${rawHost}`;
  if (PUBLIC_URL_ALLOWLIST.has(candidate)) return candidate;
  // Unknown host — audit and fall back to the canonical landing URL so
  // emails never carry an attacker-controlled link.
  console.warn(`[hostFromReq] rejected unknown host "${rawHost}" — falling back to dispatchos.co`);
  return "https://dispatchos.co";
}

// V5-006: was 48-bit (3×randomBytes(2)) — replaced by the shared ~98-bit
// generator in server/lib/invite-code.ts (imported below).

// Whitelist of origins allowed to POST to /api/public/* from the browser.
// Landing on dispatchos.co posts cross-origin to demo.dispatchos.co.
const PUBLIC_CORS_ALLOWED = new Set([
  "https://dispatchos.co",
  "https://www.dispatchos.co",
  "https://demo.dispatchos.co",
]);

function applyPublicCors(req: Request, res: Response): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && PUBLIC_CORS_ALLOWED.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

export function registerLeadRoutes(app: Express): void {
  // -------------------------------------------------------------------------
  // PUBLIC — POST /api/public/subscribe (CORS preflight + POST)
  // -------------------------------------------------------------------------
  app.options("/api/public/subscribe", (req: Request, res: Response) => {
    applyPublicCors(req, res);
    return res.status(204).end();
  });

  app.post("/api/public/subscribe", (req: Request, res: Response) => {
    applyPublicCors(req, res);
    const ip = clientIp(req);
    if (!rateLimitOk(ip)) {
      return res.status(429).json({ message: "Too many requests" });
    }

    const parsed = subscribePublicSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid input",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    const country = (req.headers["cf-ipcountry"] as string | undefined) ?? null;
    const userAgent = (req.headers["user-agent"] as string | undefined)?.slice(0, 500) ?? null;

    const { lead, isNew } = storage.insertSignupLead({
      email: parsed.data.email,
      lang: parsed.data.lang ?? null,
      country,
      userAgent,
      referer: parsed.data.referer ?? null,
      name: parsed.data.name ?? null,
      note: parsed.data.note ?? null,
    });

    return res.status(isNew ? 201 : 200).json({
      ok: true,
      leadId: lead.id,
      status: lead.status,
      duplicate: !isNew,
    });
  });

  // -------------------------------------------------------------------------
  // DISPATCHER — GET /api/dispatch/leads
  // -------------------------------------------------------------------------
  app.get(
    "/api/dispatch/leads",
    requireRole("dispatcher", "admin"),
    (req: Request, res: Response) => {
      const parsed = listLeadsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          message: "Invalid query",
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      const result = storage.listSignupLeadsPaginated(parsed.data);
      return res.json(result);
    },
  );

  // -------------------------------------------------------------------------
  // DISPATCHER — POST /api/dispatch/leads/:id/approve
  // -------------------------------------------------------------------------
  app.post(
    "/api/dispatch/leads/:id/approve",
    requireRole("dispatcher", "admin"),
    async (req: Request, res: Response) => {
      const reviewer = getCurrentUser(req);
      if (!reviewer) return res.status(401).json({ message: "Unauthorized" });

      const leadId = String(req.params.id);
      const lead = storage.getSignupLead(leadId);
      if (!lead) return res.status(404).json({ message: "Lead not found" });
      if (lead.status !== "pending") {
        return res.status(409).json({
          message: "Lead already reviewed",
          currentStatus: lead.status,
        });
      }

      const parsed = approveLeadSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          message: "Invalid input",
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }

      // Security (audit #2): a DISPATCHER must not escalate role or link a driver
      // into a carrier they are not assigned to via lead approval. Admins keep
      // full power (this block is skipped for them). Mirrors POST /api/admin/invites.
      if (reviewer.role === "dispatcher") {
        // 1. Dispatchers onboard DRIVERS only -- never mint dispatcher accounts.
        if (parsed.data.role !== "driver") {
          return res.status(403).json({
            message: "Dispatchers can approve leads as drivers only.",
          });
        }
        // 2. And only into a carrier they are actually assigned to (no cross-tenant).
        if (parsed.data.linkedClientId !== undefined) {
          const assignedIds = new Set(
            storage.listAssignedClientsForDispatcher(reviewer.id).map((c) => c.id),
          );
          if (!assignedIds.has(parsed.data.linkedClientId)) {
            return res.status(403).json({
              message: "linkedClientId must be one of your assigned carriers.",
            });
          }
          // 3. Seat-limit, same as the admin invite path.
          const linkedClient = storage.getClient(parsed.data.linkedClientId);
          if (!linkedClient) {
            return res.status(400).json({ message: "linkedClientId references unknown client" });
          }
          const seat = canAddDriver({
            planTier: linkedClient.planTier,
            persona: linkedClient.persona,
            driverSeatCount: storage.countDriverSeats(parsed.data.linkedClientId),
          });
          if (!seat.allowed) {
            return res.status(402).json({ message: seat.reason, needsUpgrade: seat.needsUpgrade });
          }
        }
      }

      // Generate invite via existing Phase 3 mechanism
      const code = generateInviteCode();
      const invite = storage.createInviteWithCode({
        code,
        role: parsed.data.role,
        email: lead.email,
        linkedClientId: parsed.data.linkedClientId,
        ttlHours: 168, // 7 days
        createdByUserId: reviewer.id,
      });

      const result = storage.approveSignupLead(leadId, code, reviewer.id);
      if ("notFound" in result) {
        return res.status(404).json({ message: "Lead vanished mid-approval" });
      }
      if ("alreadyReviewed" in result) {
        return res.status(409).json({
          message: "Lead already reviewed",
          currentStatus: result.alreadyReviewed,
        });
      }

      const signupUrl = `${hostFromReq(req)}/#/signup?code=${code}`;

      // Auto-send invite email via Resend. Failure is non-fatal: dispatcher
      // still gets the URL in the response and can resend manually if needed.
      const lang = (lead.lang === "ru" || lead.lang === "uk" ? lead.lang : "en") as "en" | "ru" | "uk";
      const emailResult = await sendInviteEmail({
        to: lead.email,
        signupUrl,
        role: parsed.data.role,
        inviterName: reviewer.fullName ?? reviewer.email,
        lang,
        expiresAt: invite.expiresAt,
      });

      return res.json({
        leadId: result.id,
        invite: { code: invite.code, signupUrl, expiresAt: invite.expiresAt },
        email: emailResult.ok
          ? { sent: true, id: emailResult.id }
          : { sent: false, error: emailResult.error },
      });
    },
  );

  // -------------------------------------------------------------------------
  // DISPATCHER — POST /api/dispatch/leads/:id/reject  (also /spam)
  // -------------------------------------------------------------------------
  for (const action of ["reject", "spam"] as const) {
    app.post(
      `/api/dispatch/leads/:id/${action}`,
      requireRole("dispatcher", "admin"),
      (req: Request, res: Response) => {
        const reviewer = getCurrentUser(req);
        if (!reviewer) return res.status(401).json({ message: "Unauthorized" });

        const parsed = rejectLeadSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return res.status(400).json({
            message: "Invalid input",
            issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          });
        }
        const result = storage.rejectSignupLead(
          String(req.params.id),
          reviewer.id,
          parsed.data.reason ?? null,
          action === "spam",
        );
        if ("notFound" in result) return res.status(404).json({ message: "Lead not found" });
        if ("alreadyReviewed" in result) {
          return res.status(409).json({
            message: "Lead already reviewed",
            currentStatus: result.alreadyReviewed,
          });
        }
        return res.json(result);
      },
    );
  }
}
