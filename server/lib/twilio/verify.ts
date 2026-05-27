// ===========================================================================
// server/lib/twilio/verify.ts — Twilio Verify (SMS) for trial anti-fraud
// ===========================================================================
//
// Phone verification on signup/onboarding: a real, SMS-reachable mobile number
// must be confirmed before a trial activates. Combined with the invite gate +
// per-MC uniqueness + disposable-email block, this closes the last cheap
// trial-farming vector (one person, many throwaway accounts).
//
// Auth uses a Standard API key (TWILIO_API_KEY_SID/SECRET), not the root Auth
// Token — keys can be rotated in the Twilio console + redeployed without
// touching the account credentials. All four env vars live in Fly secrets in
// prod; locally they're absent, so every function degrades gracefully (the
// flow is simply skipped, never crashes).

import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const apiKeySid = process.env.TWILIO_API_KEY_SID;
const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

/** True iff all four Twilio secrets are present (prod). */
export const TWILIO_VERIFY_CONFIGURED = Boolean(
  accountSid && apiKeySid && apiKeySecret && serviceSid,
);

let client: ReturnType<typeof twilio> | null = null;
function getClient(): ReturnType<typeof twilio> | null {
  if (!TWILIO_VERIFY_CONFIGURED) return null;
  if (!client) {
    // API-key auth: twilio(apiKeySid, apiKeySecret, { accountSid }).
    client = twilio(apiKeySid as string, apiKeySecret as string, {
      accountSid: accountSid as string,
    });
  }
  return client;
}

export type LineType = "mobile" | "landline" | "voip" | "unknown";

/**
 * Send an SMS verification code to an E.164 number.
 * Returns true if Twilio accepted the request. Returns false if Twilio isn't
 * configured (local dev) — the caller decides whether that's a hard error.
 */
export async function sendSmsVerification(phoneE164: string): Promise<boolean> {
  const c = getClient();
  if (!c || !serviceSid) return false;
  await c.verify.v2.services(serviceSid).verifications.create({
    to: phoneE164,
    channel: "sms",
  });
  return true;
}

/**
 * Check a user-provided code. Returns true iff Twilio reports "approved".
 * Any other status (pending, expired, canceled) or a not-configured client
 * returns false.
 */
export async function checkSmsVerification(
  phoneE164: string,
  code: string,
): Promise<boolean> {
  const c = getClient();
  if (!c || !serviceSid) return false;
  const result = await c.verify.v2
    .services(serviceSid)
    .verificationChecks.create({ to: phoneE164, code });
  return result.status === "approved";
}

/**
 * Look up the line type to harden against trial abuse (VoIP / landline numbers
 * are trivially disposable). Returns "unknown" when Twilio isn't configured or
 * the lookup fails, so callers can decide their own policy on "unknown".
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
