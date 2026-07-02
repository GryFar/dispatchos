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
import { sendInviteEmail, sendEmail, escapeHtml } from "../lib/email";
import { resolveOwnerEmail } from "../lib/owner-email";
import { fetchWithTimeout } from "../lib/fetch-timeout";
import { getIntegrationValue } from "../lib/integration-config";
import type { SignupLead } from "@shared/schema";
import {
  subscribePublicSchema,
  approveLeadSchema,
  rejectLeadSchema,
  listLeadsQuerySchema,
} from "@shared/schema";
import { generateInviteCode } from "../lib/invite-code";
import { canAddDriver, planForClient } from "../lib/plans";

// Simple in-memory rate-limit: max 5 subscriptions per IP per hour.
// Replaced by proper rate-limiter once the load is non-trivial.
const subscribeAttempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
// Hard cap on distinct keys held in memory. Without this the Map grows
// unbounded as an attacker varies the source IP (memory-exhaustion DoS).
const RATE_LIMIT_MAX_KEYS = 10_000;

// Evict every entry whose window has fully elapsed. Cheap O(n) sweep; n is
// bounded by RATE_LIMIT_MAX_KEYS so this stays trivial.
function sweepExpired(now: number): void {
  const toDelete: string[] = [];
  subscribeAttempts.forEach((entry, key) => {
    if (now > entry.resetAt) toDelete.push(key);
  });
  toDelete.forEach((k) => subscribeAttempts.delete(k));
}

function rateLimitOk(ip: string): boolean {
  const now = Date.now();
  const entry = subscribeAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    // Sweep stale entries before inserting a new key. If the Map is still at
    // the hard cap after sweeping (all entries live), reject rather than grow
    // memory without bound — a live attacker varying IPs cannot exhaust RAM.
    if (subscribeAttempts.size >= RATE_LIMIT_MAX_KEYS) {
      sweepExpired(now);
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
  // Use Express's req.ip, which honors the configured `trust proxy` hop count
  // (index.ts: app.set("trust proxy", DISPATCHOS_TRUST_PROXY)) and therefore
  // resolves to the real client address rather than an attacker-controlled
  // first X-Forwarded-For token. Falls back to the socket address.
  return req.ip || req.socket.remoteAddress || "unknown";
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
  // Pin the scheme to https: the allowlist is https-only, so any other scheme
  // could never match anyway. Reading the proto from a client header
  // (x-forwarded-proto) would be a fragile no-op here.
  const candidate = `https://${rawHost}`;
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

// New-lead owner alert. Without it fresh signups land silently in the review
// queue and nobody follows up. Fire-and-forget from the subscribe route: every
// failure is logged and swallowed — a notify problem must never delay or fail
// the public 201. Telegram token/chat resolution mirrors trial-expiry/
// insurance-monitor (integration-config first, env fallback).
async function notifyNewLead(lead: SignupLead): Promise<void> {
  const summary =
    `${lead.email}` +
    `${lead.name ? ` (${lead.name})` : ""}` +
    `${lead.country ? ` [${lead.country}]` : ""}` +
    `${lead.lang ? ` lang=${lead.lang}` : ""}`;

  try {
    const token =
      getIntegrationValue("telegram_driver_bot", "TELEGRAM_DRIVER_BOT_TOKEN") ??
      process.env.TELEGRAM_DRIVER_BOT_TOKEN ??
      null;
    const chatId =
      getIntegrationValue("telegram_driver_bot", "TELEGRAM_ALERT_CHAT_ID") ??
      process.env.TELEGRAM_ALERT_CHAT_ID ??
      null;
    if (token && chatId) {
      const r = await fetchWithTimeout(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `🆕 New signup lead: ${summary}\nReview it in Admin → Leads.`,
          disable_web_page_preview: true,
        }),
      });
      if (!r.ok) console.error(`[leads/notify] telegram HTTP ${r.status} for lead ${lead.id}`);
    }
  } catch (err) {
    console.error(`[leads/notify] telegram failed for lead ${lead.id}:`, (err as Error).message);
  }

  try {
    const ownerEmail = resolveOwnerEmail();
    if (ownerEmail) {
      const result = await sendEmail({
        to: ownerEmail,
        subject: `New DispatchOS lead: ${lead.email}`,
        html:
          `<p>New signup lead: <strong>${escapeHtml(summary)}</strong></p>` +
          `<p>Review it in Admin → Leads.</p>`,
        text: `New signup lead: ${summary}\nReview it in Admin → Leads.`,
        tags: [{ name: "kind", value: "lead-alert" }],
      });
      if (!result.ok) {
        console.error(`[leads/notify] email failed for lead ${lead.id}: ${result.error}`);
      }
    }
  } catch (err) {
    console.error(`[leads/notify] email failed for lead ${lead.id}:`, (err as Error).message);
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

    // cf-ipcountry is client-settable when a request does not actually transit
    // Cloudflare. Constrain it to a 2-letter code (Cloudflare's documented
    // shape, including XX/T1 sentinels); anything else is treated as untrusted
    // and stored as null.
    const rawCountry = req.headers["cf-ipcountry"];
    const country =
      typeof rawCountry === "string" && /^[A-Za-z0-9]{2}$/.test(rawCountry)
        ? rawCountry.toUpperCase()
        : null;
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

    // Fire-and-forget owner alert for brand-new leads only (dupes re-post the
    // same email and would spam the channel).
    if (isNew) void notifyNewLead(lead);

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
      let seatCap: { clientId: string; maxSeats: number } | undefined;
      let seatClient: ReturnType<typeof storage.getClient>;
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
          // Re-check atomically inside the invite insert (check-then-create
          // guard). Hard cap exists only when the plan sells no overage seats
          // (mirrors canAddDriver); Infinity = uncapped.
          const plan = planForClient(linkedClient);
          seatCap = {
            clientId: parsed.data.linkedClientId,
            maxSeats: plan.additionalDriverCents === 0 ? plan.includedDriverSeats : Infinity,
          };
          seatClient = linkedClient;
        }
      }

      // Transition the lead FIRST (atomic status='pending' guard inside
      // approveSignupLead). generateInviteCode() is a pure CSPRNG with no DB
      // side effect, so we can mint the code up front to stamp on the lead and
      // only persist the invite row once the lead is actually approved. This
      // avoids orphaning a usable invite when the lead 404s or was already
      // reviewed by a concurrent reviewer (audit: invite-before-approve).
      const code = generateInviteCode();
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

      // Lead is now approved — create the invite via the existing Phase 3 path.
      const inviteInput = {
        code,
        role: parsed.data.role,
        email: lead.email,
        linkedClientId: parsed.data.linkedClientId,
        ttlHours: 168, // 7 days
        createdByUserId: reviewer.id,
      };
      let invite;
      try {
        invite = seatCap
          ? storage.createInviteIfSeatAvailable(inviteInput, seatCap)
          : storage.createInviteWithCode(inviteInput);
      } catch (err) {
        if ((err as { code?: string }).code === "SEAT_CAP_EXCEEDED" && seatClient) {
          // Concurrent seat grab between the gate above and the insert. The
          // lead stays approved (no invite minted) — the dispatcher can retry
          // after freeing a seat. Same 402 body as the gate (reason depends
          // only on the plan).
          const seat = canAddDriver({
            planTier: seatClient.planTier,
            persona: seatClient.persona,
            driverSeatCount: Number.MAX_SAFE_INTEGER,
          });
          return res.status(402).json({ message: seat.reason, needsUpgrade: seat.needsUpgrade });
        }
        throw err;
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
