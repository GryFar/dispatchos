// Outbound-URL safety guard (anti-SSRF). Some outbound fetches use a host an
// admin can set (e.g. FMCSA_API_URL via /admin/integrations). Without a check a
// malicious/confused admin could point it at an internal or cloud-metadata
// address (http://169.254.169.254/...) and have the server fetch + reflect it.
// Allow only http/https to a non-internal host.
//
// Scope: blocks LITERAL localhost / private / link-local hosts. It does NOT
// resolve DNS, so a public domain resolving to an internal IP (DNS rebinding) is
// out of scope -- acceptable for an admin-gated path.

const PRIVATE_V4 = [
  /^0\./,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
];

export function assertSafeOutboundUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Outbound URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Outbound URL scheme not allowed: ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();
  const isV6Literal = host.startsWith("[");
  const v6 = isV6Literal ? host.slice(1, -1) : "";
  if (host === "localhost" || host === "0.0.0.0" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`Outbound URL host is not allowed: ${host}`);
  }
  if (
    isV6Literal &&
    (v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") ||
      v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb"))
  ) {
    throw new Error(`Outbound URL host is a private IPv6: ${host}`);
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && PRIVATE_V4.some((re) => re.test(host))) {
    throw new Error(`Outbound URL host is a private/internal IP: ${host}`);
  }
  return url;
}
