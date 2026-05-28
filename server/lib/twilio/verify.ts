/**
 * server/lib/twilio/verify.ts — Twilio Verify for DispatchOS
 *
 * Supports two channels:
 *   - SMS   (phone verification in onboarding/signup)
 *   - Email (email verification immediately after signup)
 *
 * Uses API Key auth (TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET + TWILIO_ACCOUNT_SID),
 * not the root Auth Token — keys can be rotated without redeploying.
 *
 * Graceful degradation: every exported function returns a typed result
 * indicating unconfigured state rather than throwing. Callers return 503
 * and the UI shows a "verify later" banner instead of hard-blocking.
 *
 * Email channel note: requires a SendGrid integration configured on the
 * Twilio Verify Service. If the service has no email integration,
 * Twilio returns a 60220 error which we surface as error: 'email_channel_not_configured'.
 */

import twilio from "twilio";

const accountSid   = process.env.TWILIO_ACCOUNT_SID;
const apiKeySid    = process.env.TWILIO_API_KEY_SID;
const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
const serviceSid   = process.env.TWILIO_VERIFY_SERVICE_SID;

/** True iff all four Twilio secrets are present. */
export const TWILIO_VERIFY_CONFIGURED = Boolean(
  accountSid && apiKeySid && apiKeySecret && serviceSid,
);

let _client: ReturnType<typeof twilio> | null = null;
function getClient(): ReturnType<typeof twilio> | null {
  if (!TWILIO_VERIFY_CONFIGURED) return null;
  if (!_client) {
    _client = twilio(apiKeySid as string, apiKeySecret as string, {
      accountSid: accountSid as string,
    });
  }
  return _client;
}

export type LineType = "mobile" | "landline" | "voip" | "unknown";

type VerifyResult = { ok: boolean; sid?: string; error?: string };
type CheckResult  = { ok: boolean; status?: string; error?: string };

// ---------------------------------------------------------------------------
// SMS channel
// ---------------------------------------------------------------------------

/**
 * Send a 6-digit SMS verification code.
 * Returns ok:false + error:'twilio_not_configured' when env vars absent.
 */
export async function sendVerificationCode(phoneE164: string): Promise<VerifyResult> {
  const c = getClient();
  if (!c) return { ok: false, error: "twilio_not_configured" };
  try {
    const v = await c.verify.v2
      .services(serviceSid!)
      .verifications.create({ to: phoneE164, channel: "sms" });
    return { ok: true, sid: v.sid };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "twilio_error" };
  }
}

/** Check a user-provided SMS code. */
export async function checkVerificationCode(
  phoneE164: string,
  code: string,
): Promise<CheckResult> {
  const c = getClient();
  if (!c) return { ok: false, error: "twilio_not_configured" };
  try {
    const v = await c.verify.v2
      .services(serviceSid!)
      .verificationChecks.create({ to: phoneE164, code });
    return { ok: v.status === "approved", status: v.status };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "twilio_error" };
  }
}

// ---------------------------------------------------------------------------
// Email channel
// ---------------------------------------------------------------------------

// Twilio error code for "email channel not configured on this Verify Service"
const TWILIO_EMAIL_NOT_CONFIGURED_CODE = 60220;

/**
 * Send a 6-digit email verification code via Twilio Verify (email channel).
 *
 * Requires SendGrid integration to be enabled on the Verify Service in the
 * Twilio console. If absent, Twilio returns error 60220 and we surface
 * error:'email_channel_not_configured' so callers can return 503.
 */
export async function sendEmailVerificationCode(email: string): Promise<VerifyResult> {
  const c = getClient();
  if (!c) return { ok: false, error: "twilio_not_configured" };
  try {
    const v = await c.verify.v2
      .services(serviceSid!)
      .verifications.create({ to: email, channel: "email" });
    return { ok: true, sid: v.sid };
  } catch (e: any) {
    // 60220 = Email integration not configured on the Verify Service
    if (e?.code === TWILIO_EMAIL_NOT_CONFIGURED_CODE) {
      return { ok: false, error: "email_channel_not_configured" };
    }
    return { ok: false, error: e?.message ?? "twilio_error" };
  }
}

/** Check a user-provided email verification code. */
export async function checkEmailVerificationCode(
  email: string,
  code: string,
): Promise<CheckResult> {
  const c = getClient();
  if (!c) return { ok: false, error: "twilio_not_configured" };
  try {
    const v = await c.verify.v2
      .services(serviceSid!)
      .verificationChecks.create({ to: email, code });
    return { ok: v.status === "approved", status: v.status };
  } catch (e: any) {
    if (e?.code === TWILIO_EMAIL_NOT_CONFIGURED_CODE) {
      return { ok: false, error: "email_channel_not_configured" };
    }
    return { ok: false, error: e?.message ?? "twilio_error" };
  }
}

// ---------------------------------------------------------------------------
// Line-type lookup (anti-abuse: reject VoIP/landline for SMS)
// ---------------------------------------------------------------------------

/**
 * Look up phone line type. Returns "unknown" when Twilio is unconfigured
 * or the lookup fails — callers decide their own policy on unknown.
 */
export async function lookupLineType(phoneE164: string): Promise<LineType> {
  const c = getClient();
  if (!c) return "unknown";
  try {
    const r = await c.lookups.v2
      .phoneNumbers(phoneE164)
      .fetch({ fields: "line_type_intelligence" });
    const type = (r.lineTypeIntelligence as { type?: string } | undefined)?.type;
    if (type === "mobile") return "mobile";
    if (type === "landline" || type === "fixedLine") return "landline";
    if (type === "voip" || type === "nonFixedVoip" || type === "fixedVoip") return "voip";
    return "unknown";
  } catch {
    return "unknown";
  }
}
