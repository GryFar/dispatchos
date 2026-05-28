// ===========================================================================
// server/lib/disposable-domains.ts — disposable / throwaway email blocklist
// ===========================================================================
//
// Anti-fraud: block trial signups from well-known temporary-email providers
// (mailinator, guerrillamail, 10minutemail, ...). This is a pragmatic static
// list — it won't catch every throwaway domain (new ones appear constantly),
// but it stops the overwhelming majority of low-effort abuse without a paid
// validation API. Combined with the invite gate + per-MC uniqueness, it raises
// the cost of farming free trials.
//
// Matching is on the registrable domain, case-insensitive, and also catches
// subdomains (e.g. "foo.mailinator.com" -> blocked because it ends with
// ".mailinator.com").

import { domainToASCII } from "node:url";

const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.info",
  "guerrillamail.biz",
  "guerrillamail.net",
  "guerrillamail.org",
  "grr.la",
  "sharklasers.com",
  "10minutemail.com",
  "10minutemail.net",
  "tempmail.com",
  "temp-mail.org",
  "tempmail.net",
  "throwawaymail.com",
  "yopmail.com",
  "yopmail.net",
  "getnada.com",
  "dispostable.com",
  "trashmail.com",
  "trashmail.net",
  "maildrop.cc",
  "mailnesia.com",
  "mintemail.com",
  "fakeinbox.com",
  "spamgourmet.com",
  "mohmal.com",
  "emailondeck.com",
  "tempinbox.com",
  "moakt.com",
  "mailcatch.com",
  "inboxbear.com",
  "tempr.email",
  "discard.email",
  "burnermail.io",
  "33mail.com",
  "anonbox.net",
  "spam4.me",
  "mailsac.com",
  "harakirimail.com",
  "tempmailo.com",
  "luxusmail.org",
  "emailfake.com",
  "minuteinbox.com",
]);

/**
 * Returns true if the email's domain is a known disposable/throwaway provider.
 * Matches the exact registrable domain or any subdomain of it. Malformed input
 * returns false (let the schema's .email() validator reject format issues).
 */
export function isDisposableEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  // V4-008: normalize IDN / punycode / unicode lookalikes to canonical ASCII
  // before matching. Without this, "máilinator.com", the punycode form
  // "xn--milinator-..." , or a Turkish-İ variant ("MAİLINATOR.COM") would all
  // slip past a plain lowercase compare against the ASCII blocklist.
  // domainToASCII handles the IDNA mapping (and returns "" on garbage, which
  // we treat as "not disposable" — the schema's .email() rejects bad formats).
  const rawDomain = email.slice(at + 1).trim();
  const asciiDomain = domainToASCII(rawDomain);
  const domain = (asciiDomain || rawDomain).toLowerCase();
  if (!domain) return false;
  // Check the full domain, then progressively strip leftmost labels so a
  // subdomain like "x.mailinator.com" still matches "mailinator.com" — all via
  // O(labels) Set lookups, no Set iteration (keeps the TS target happy).
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i += 1) {
    const candidate = parts.slice(i).join(".");
    if (DISPOSABLE_DOMAINS.has(candidate)) return true;
  }
  return false;
}
/** Exposed for tests / admin tooling. */
export function disposableDomainCount(): number {
  return DISPOSABLE_DOMAINS.size;
}
