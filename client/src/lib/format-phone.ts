/**
 * US phone number formatting utilities.
 *
 * Henry QA Bug #3: "gotta set up a correct phone number type:
 * 3 digits area code, + 7 numbers = (example (123) 456-7890)"
 *
 * Two formats are used throughout the codebase:
 *
 *   Display format  — "(123) 456-7890"  — what the user sees in inputs/tables.
 *   E.164 format    — "+11234567890"    — what we store in the DB (users.phone)
 *                                          and send to Twilio/SMS providers.
 *
 * Always store E.164, always display the formatted version. Convert at the
 * boundary (input onChange → toE164Us, data load → fromE164Us).
 */

/**
 * Format a raw digit string (or partially-typed phone) into US display format.
 * Strips all non-digit characters, caps at 10 digits.
 *
 * Examples:
 *   "1234567890"   → "(123) 456-7890"
 *   "11234567890"  → "(123) 456-7890"  (leading US country code stripped)
 *   "123"          → "(123"      (mid-type — keeps parens open)
 *   "1234"         → "(123) 4"
 *   "123456"       → "(123) 456"
 */
export function formatUsPhone(value: string): string {
  let raw = value.replace(/\D/g, "");
  // Drop a leading US country-code "1" on 11-digit pastes (e.g. "1 (123) 456-7890")
  // so the real 10-digit number is kept instead of being truncated to the wrong one.
  if (raw.length === 11 && raw.startsWith("1")) {
    raw = raw.slice(1);
  }
  // Keep only the first 10 digits.
  const digits = raw.slice(0, 10);

  if (digits.length < 4) {
    // 0–3 digits: just show them (prefix with "(" once we have at least 1).
    return digits.length === 0 ? "" : `(${digits}`;
  }
  if (digits.length < 7) {
    // 4–6 digits: "(XXX) YYY"
    return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  }
  // 7–10 digits: full "(XXX) YYY-ZZZZ"
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/**
 * Convert a display-format phone string to E.164 (+1XXXXXXXXXX).
 *
 * Returns null when the input doesn't contain exactly 10 digits — signals
 * to callers (form validation) that the value is incomplete/invalid.
 *
 * Examples:
 *   "(123) 456-7890"  → "+11234567890"
 *   "123-456-7890"    → "+11234567890"
 *   "1234"            → null  (too short)
 *   ""                → null
 */
export function toE164Us(displayed: string): string | null {
  const digits = displayed.replace(/\D/g, "");
  if (digits.length !== 10) return null;
  return `+1${digits}`;
}

/**
 * Convert an E.164 phone string back to the US display format.
 * Inverse of toE164Us.
 *
 * Returns "" for null/undefined/non-US numbers so UI inputs stay empty
 * rather than crashing.
 *
 * Examples:
 *   "+11234567890"  → "(123) 456-7890"
 *   null            → ""
 *   "+441234567890" → ""  (non-US +1 prefix — fall through)
 */
export function fromE164Us(e164: string | null | undefined): string {
  if (!e164 || !e164.startsWith("+1")) return "";
  // Remove the +1 country code; only format when exactly 10 digits remain so a
  // malformed stored value yields "" (empty input) instead of a silently-wrong
  // number. This keeps it a true inverse of toE164Us (which requires 10 digits).
  const rest = e164.slice(2);
  if (!/^\d{10}$/.test(rest)) return "";
  return formatUsPhone(rest);
}
