// Invite-email HTML escaping tests.
// Run: npx tsx server/lib/email-escape.test.ts
//
// Locks in the stored-XSS / HTML-injection guard: every dynamic value
// interpolated into the outbound invite email HTML (inviterName, roleName,
// signupUrl) must be HTML-escaped. inviterName flows from user-controlled
// reviewer.fullName, so markup in a name must not reach the rendered email.

import { escapeHtml } from "./email";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

// Markup in a name must be neutralised (no live tags).
const evilName = `<img src=x onerror=alert(1)>`;
const escapedName = escapeHtml(evilName);
assert("script/markup tags are escaped", !escapedName.includes("<") && !escapedName.includes(">"));
assert("angle brackets become entities", escapedName.includes("&lt;img") && escapedName.includes("&gt;"));

// Attribute breakout in a URL must be neutralised (can't escape an href="...").
const evilUrl = `https://x/"><script>alert(1)</script>`;
const escapedUrl = escapeHtml(evilUrl);
assert("double quotes are escaped (attribute breakout)", !escapedUrl.includes('"') && escapedUrl.includes("&quot;"));
assert("escaped URL has no live markup", !escapedUrl.includes("<") && !escapedUrl.includes(">"));

// Single quote and ampersand are handled.
assert("single quotes are escaped", escapeHtml(`O'Brien`) === "O&#39;Brien");
assert("ampersand is escaped first (no double-encoding of entities)", escapeHtml("a&b") === "a&amp;b");
assert("ampersand before existing entity-like text", escapeHtml("&lt;") === "&amp;lt;");

// Benign values pass through unchanged.
assert("plain ASCII unchanged", escapeHtml("Alice Smith") === "Alice Smith");
assert("normal https URL unchanged", escapeHtml("https://app.example.com/#/signup?code=abc123") === "https://app.example.com/#/signup?code=abc123");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
