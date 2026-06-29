// Twilio Verify opaque-error mapping test (no network).
// Run: npx tsx server/lib/twilio/verify.test.ts
//
// REGRESSION GUARD for the opaque-error fix in twilioErrorCode():
//
// Twilio SDK errors routinely embed the submitted phone/email, the Verify
// Service SID, an internal error code and a "More info" URL. The signup routes
// forward result.error VERBATIM into the HTTP body for UNAUTHENTICATED clients.
// The fix maps every caught Twilio error to a fixed, non-leaking code:
//   * the channel-config code 60220  -> "email_channel_not_configured" (preserved,
//     because callers branch on it to return 503);
//   * everything else                -> generic "twilio_error".
// The raw Twilio message (with phone/SID/info-URL) must NEVER appear in result.error.
//
// PRE-FIX behavior this would FAIL on: forwarding e.message (or e.code) straight
// through — e.g. returning the leaky string, or returning the raw numeric/string
// Twilio code instead of the opaque "twilio_error".
//
// Seam: verify.ts has no client injector, so we replace the `twilio` package in
// the CJS require cache BEFORE importing verify.ts. The fake factory's Verify
// client throws synthetic Twilio errors. No real SDK loads => no network, fully
// deterministic. The four TWILIO_* env vars are set so TWILIO_VERIFY_CONFIGURED
// is true and getClient() actually builds (the fake) client and reaches the
// try/catch that calls twilioErrorCode.

import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// 0) Install the fake `twilio` module + env BEFORE importing verify.ts.
// ---------------------------------------------------------------------------

// Make TWILIO_VERIFY_CONFIGURED true so getClient() builds a client.
process.env.TWILIO_ACCOUNT_SID = "AC_test_account_sid";
process.env.TWILIO_API_KEY_SID = "SK_test_key_sid";
process.env.TWILIO_API_KEY_SECRET = "test_key_secret";
process.env.TWILIO_VERIFY_SERVICE_SID = "VA_test_service_sid";

// A leaky message exactly like the real Twilio SDK produces: it embeds the
// submitted destination, the Verify Service SID and a "More info" URL — the
// stuff that must never reach the client.
const LEAKY_PHONE = "+15555550123";
const LEAKY_SID = "VA_test_service_sid";
const LEAKY_URL = "https://www.twilio.com/docs/errors/60200";
const LEAKY_MESSAGE =
  `Invalid parameter \`To\`: ${LEAKY_PHONE} on Service ${LEAKY_SID}. ` +
  `More info: ${LEAKY_URL}`;

// `error` describes what verifications.create / verificationChecks.create throw.
// Tests reassign this between cases.
let thrownError: any = null;

function makeThrower() {
  return async () => {
    if (thrownError) throw thrownError;
    // Default: an approved check so the non-throwing path is also exercisable.
    return { sid: "VExxxx", status: "approved" };
  };
}

const fakeVerifyClient = {
  verify: {
    v2: {
      services: (_serviceSid: string) => ({
        verifications: { create: makeThrower() },
        verificationChecks: { create: makeThrower() },
      }),
    },
  },
};

const fakeFactory: any = function () {
  return fakeVerifyClient;
};

const require = createRequire(import.meta.url);
const twilioPath = require.resolve("twilio");
require.cache[twilioPath] = {
  id: twilioPath,
  filename: twilioPath,
  loaded: true,
  exports: fakeFactory,
} as any;

// Now import the module under test — it will pick up the fake `twilio`.
const { sendVerificationCode, checkVerificationCode, sendEmailVerificationCode, checkEmailVerificationCode, TWILIO_VERIFY_CONFIGURED } =
  await import("./verify");

// ---------------------------------------------------------------------------
// Test harness (project style: assert + console + process.exit).
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

// Build a synthetic Twilio SDK error with a given numeric code.
function twilioErr(code: number) {
  const e: any = new Error(LEAKY_MESSAGE);
  e.code = code;
  e.status = 400;
  e.moreInfo = LEAKY_URL;
  return e;
}

// Sanity: the fake client really did configure (otherwise we'd be testing the
// "twilio_not_configured" early-return, not the error mapping).
assert("setup: TWILIO_VERIFY_CONFIGURED true with all four env vars", TWILIO_VERIFY_CONFIGURED === true);

// ---------------------------------------------------------------------------
// 1) sendVerificationCode: a generic Twilio error maps to opaque "twilio_error"
//    and NEVER leaks the phone/SID/info-URL from the raw message.
//    FAILS pre-fix if e.message or raw e.code were forwarded.
// ---------------------------------------------------------------------------
{
  thrownError = twilioErr(60200); // some non-60220 Twilio error
  const r = await sendVerificationCode(LEAKY_PHONE);
  assert("send sms: ok=false on thrown error", r.ok === false);
  assert("send sms: error is opaque 'twilio_error'", r.error === "twilio_error", String(r.error));
  // Defense-in-depth: the opaque code must not be the raw numeric code, nor leak.
  assert("send sms: error is not the raw numeric code", r.error !== "60200" && (r.error as any) !== 60200);
  assert("send sms: error does not contain phone number", !(r.error || "").includes(LEAKY_PHONE));
  assert("send sms: error does not contain service SID", !(r.error || "").includes(LEAKY_SID));
  assert("send sms: error does not contain info URL", !(r.error || "").includes("twilio.com"));
}

// ---------------------------------------------------------------------------
// 2) checkVerificationCode: a generic Twilio error maps to opaque "twilio_error"
//    and does not leak. FAILS pre-fix if the raw message/code were forwarded.
// ---------------------------------------------------------------------------
{
  thrownError = twilioErr(20404); // "resource not found" style Twilio error
  const r = await checkVerificationCode(LEAKY_PHONE, "123456");
  assert("check sms: ok=false on thrown error", r.ok === false);
  assert("check sms: error is opaque 'twilio_error'", r.error === "twilio_error", String(r.error));
  assert("check sms: error does not contain phone number", !(r.error || "").includes(LEAKY_PHONE));
  assert("check sms: error does not contain info URL", !(r.error || "").includes("twilio.com"));
}

// ---------------------------------------------------------------------------
// 3) Special-case PRESERVED: the email-channel code 60220 maps to the stable
//    "email_channel_not_configured" (NOT the generic opaque code), so callers
//    can still branch on it to return 503. FAILS if the fix collapsed ALL codes
//    to "twilio_error" (over-opaquing) OR forwarded the raw code.
// ---------------------------------------------------------------------------
{
  thrownError = twilioErr(60220);
  const rSend = await sendEmailVerificationCode("user@example.com");
  assert("send email 60220: ok=false", rSend.ok === false);
  assert("send email 60220: error preserved as 'email_channel_not_configured'",
    rSend.error === "email_channel_not_configured", String(rSend.error));
  assert("send email 60220: NOT collapsed to generic twilio_error",
    rSend.error !== "twilio_error");

  // And the same special-case applies on the check path.
  thrownError = twilioErr(60220);
  const rCheck = await checkEmailVerificationCode("user@example.com", "123456");
  assert("check email 60220: error preserved as 'email_channel_not_configured'",
    rCheck.error === "email_channel_not_configured", String(rCheck.error));
}

// ---------------------------------------------------------------------------
// 4) An error WITHOUT a code (e.g. a network/timeout Error) still maps to the
//    opaque "twilio_error" — never undefined, never the raw message.
//    FAILS pre-fix if error were left undefined or set to e.message.
// ---------------------------------------------------------------------------
{
  const bare: any = new Error(LEAKY_MESSAGE); // no .code
  thrownError = bare;
  const r = await sendVerificationCode(LEAKY_PHONE);
  assert("send sms (no code): error is opaque 'twilio_error'", r.error === "twilio_error", String(r.error));
  assert("send sms (no code): error not the raw message",
    r.error !== LEAKY_MESSAGE && !(r.error || "").includes("More info"));
}

// ---------------------------------------------------------------------------
// 5) Non-60220 email errors are still opaque (only 60220 is special-cased).
//    Guards against a regression that special-cases too broadly.
// ---------------------------------------------------------------------------
{
  thrownError = twilioErr(60200);
  const r = await sendEmailVerificationCode("user@example.com");
  assert("send email (non-60220): error opaque 'twilio_error'", r.error === "twilio_error", String(r.error));
  assert("send email (non-60220): not preserved as email_channel_not_configured",
    r.error !== "email_channel_not_configured");
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
