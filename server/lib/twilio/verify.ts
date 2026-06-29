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

// Fail-fast request timeout (ms). Well below the SDK's ~30s default so a
// stalled Twilio endpoint quickly surfaces as an error and the graceful
// degradation path engages instead of piling up open verify requests.
const TWILIO_REQUEST_TIMEOUT_MS = 10_000;

let _client: ReturnType<typeof twilio> | null = null;
function getClient(): ReturnType<typeof twilio> | null {
  if (!TWILIO_VERIFY_CONFIGURED) return null;
  if (!_client) {
    _client = twilio(apiKeySid as string, apiKeySecret as string, {
      accountSid: accountSid as string,
      timeout: TWILIO_REQUEST_TIMEOUT_MS,
    });
  }
  return _client;
}

export type LineType = "mobile" | "landline" | "voip" | "unknown";

type VerifyResult = { ok: boolean; sid?: string; error?: string };
type CheckResult  = { ok: boolean; status?: string; error?: string };

// Twilio error code for "email channel not configured on this Verify Service"
const TWILIO_EMAIL_NOT_CONFIGURED_CODE = 60220;

/**
 * Map a caught Twilio SDK error to an OPAQUE, non-leaking error code.
 *
 * Twilio SDK error messages routinely embed the submitted phone/email, the
 * Verify Service SID, internal error codes and a "More info" URL. Those must
 * never reach the HTTP response body (routes forward result.error verbatim to
 * unauthenticated signup clients). We log the full detail server-side and
 * return a fixed code: the one channel-config code callers branch on, or a
 * generic 'twilio_error' for everything else.
 */
function twilioErrorCode(e: any, context: string): string {
  // Log full detail server-side only (code + message), never to the client.
  console.error(`[twilio.verify] ${context} failed`, e?.code, e?.message);
  if (e?.code === TWILIO_EMAIL_NOT_CONFIGURED_CODE) {
    return "email_channel_not_configured";
  }
  return "twilio_error";
}

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
    return { ok: false, error: twilioErrorCode(e, "sendVerificationCode") };
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
    const approved = v.status === "approved";
    // On the non-throwing failure path (wrong/expired/canceled code) Twilio
    // returns status without throwing, so error would otherwise stay undefined
    // and callers forwarding result.error would leak nothing useful. Surface
    // the (non-sensitive) Verify status enum so the client can distinguish
    // wrong-code vs expired vs canceled.
    return approved
      ? { ok: true, status: v.status }
      : { ok: false, status: v.status, error: v.status };
  } catch (e: any) {
    return { ok: false, error: twilioErrorCode(e, "checkVerificationCode") };
  }
}

// ---------------------------------------------------------------------------
// Email channel
// ---------------------------------------------------------------------------

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
    // 60220 maps to 'email_channel_not_configured'; all else to opaque code.
    return { ok: false, error: twilioErrorCode(e, "sendEmailVerificationCode") };
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
    const approved = v.status === "approved";
    // See checkVerificationCode: surface the non-sensitive Verify status enum
    // on the non-throwing failure path so error isn't undefined. These status
    // values (pending/expired/canceled) never collide with the thrown-error
    // code 'email_channel_not_configured' the route branches on.
    return approved
      ? { ok: true, status: v.status }
      : { ok: false, status: v.status, error: v.status };
  } catch (e: any) {
    return { ok: false, error: twilioErrorCode(e, "checkEmailVerificationCode") };
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

// ---------------------------------------------------------------------------
// Legacy aliases — keep backward-compat with existing routes.ts imports
// ---------------------------------------------------------------------------
export const sendSmsVerification = async (phoneE164: string): Promise<boolean> => {
  const r = await sendVerificationCode(phoneE164);
  return r.ok;
};

export const checkSmsVerification = async (
  phoneE164: string,
  code: string,
): Promise<boolean> => {
  const r = await checkVerificationCode(phoneE164, code);
  return r.ok;
};
