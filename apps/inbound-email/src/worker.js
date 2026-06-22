// CF Email Worker — receives email at loads@dispatchos.co and forwards
// the parsed payload to demo.dispatchos.co/api/inbound/email.
//
// CF passes us a ForwardableEmailMessage with:
//   - from, to        : addresses
//   - headers         : Headers object
//   - raw             : ReadableStream of the full MIME message
//   - rawSize         : bytes
//
// We pull subject from headers and extract the text body (or fall back to
// the full raw MIME). No external deps — Workers runtime has TextDecoder
// and standard streams.
//
// Audit V2-4 hardening:
//   - Reject messages > MAX_RAW_BYTES (memory bomb / OOM defense).
//   - Reject when SPF/DKIM authentication-results show "fail" (anti-spoof).
//   - Trim body to MAX_BODY_BYTES so a malicious huge payload doesn't
//     bloat `email_ingest` rows.
//   - Per-sender rate-limit using a CF Workers KV namespace (if bound).

const MAX_RAW_BYTES = 1 * 1024 * 1024; // 1 MB hard cap on inbound MIME
const MAX_BODY_BYTES = 32 * 1024; // 32 KB persisted body
const RATE_LIMIT_PER_HOUR = 30; // per sender address

/**
 * Inspect the Authentication-Results header CF/our forwarder adds.
 * We REJECT only on an explicit `spf=fail` or `dkim=fail`. Missing
 * results / softfail are allowed (forwarded mail often loses SPF).
 *
 * @param {Headers} headers
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkAuthResults(headers) {
  const ar = (headers.get("authentication-results") || "").toLowerCase();
  if (!ar) return { ok: true };
  if (/\bspf=fail\b/.test(ar)) return { ok: false, reason: "spf=fail" };
  if (/\bdkim=fail\b/.test(ar)) return { ok: false, reason: "dkim=fail" };
  if (/\bdmarc=fail\b/.test(ar)) return { ok: false, reason: "dmarc=fail" };
  return { ok: true };
}

/**
 * Sliding-window-ish rate-limit using KV with a 1-hour expiry on the key.
 * If KV isn't bound (local dev / not configured) we skip silently.
 *
 * @param {string|undefined} kvNamespace
 * @param {string} sender
 * @returns {Promise<boolean>} true if allowed
 */
async function checkRateLimit(kv, sender) {
  if (!kv || !sender) return true;
  const key = `rl:${sender.toLowerCase()}`;
  try {
    const raw = await kv.get(key);
    const count = raw ? parseInt(raw, 10) || 0 : 0;
    if (count >= RATE_LIMIT_PER_HOUR) return false;
    // Don't bother resetting expiry on every hit; simple counter is fine
    // for 30/hour granularity. expirationTtl is set on first put.
    await kv.put(key, String(count + 1), { expirationTtl: 3600 });
    return true;
  } catch (err) {
    console.error("[inbound-email] KV rate-limit check failed:", err);
    return true; // fail-open — better deliver than drop legit mail
  }
}

export default {
  /**
   * @param {import('@cloudflare/workers-types').ForwardableEmailMessage} message
   * @param {{ INGEST_URL: string, DISPATCHOS_INBOUND_SECRET: string, INBOUND_RL?: any }} env
   * @param {ExecutionContext} ctx
   */
  async email(message, env, ctx) {
    try {
      // Recipient allowlist — defense-in-depth on top of the CF routing rule.
      // Only forward mail addressed to our known ingest address(es), so a
      // misconfigured catch-all route can't pipe arbitrary mail into ingest.
      const to = String(message.to || "").toLowerCase();
      const allowed = String(env.INBOUND_ALLOWED_TO || "loads@dispatchos.co")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (!allowed.includes(to)) {
        console.warn(`[inbound-email] rejected: recipient ${message.to} not in allowlist`);
        return;
      }

      // V2-4(1): size cap BEFORE buffering the body.
      if (typeof message.rawSize === "number" && message.rawSize > MAX_RAW_BYTES) {
        console.warn(
          `[inbound-email] rejected: rawSize=${message.rawSize} exceeds ${MAX_RAW_BYTES}`,
        );
        return; // drop silently — Worker accepts but doesn't forward
      }

      // V2-4(2): authentication-results check.
      const auth = checkAuthResults(message.headers);
      if (!auth.ok) {
        console.warn(
          `[inbound-email] rejected: auth ${auth.reason} from=${message.from}`,
        );
        return;
      }

      // V2-4(3): per-sender rate-limit (best-effort; KV optional).
      // NB: must NOT shadow the `allowed` recipient-allowlist binding above —
      // a duplicate `const allowed` is a parse-time SyntaxError that bricks the
      // whole Worker (every inbound load email silently dropped).
      const rateOk = await checkRateLimit(env.INBOUND_RL, message.from);
      if (!rateOk) {
        console.warn(`[inbound-email] rejected: rate-limit hit from=${message.from}`);
        return;
      }

      // Read the entire raw MIME message (now bounded by size check above).
      const rawBuffer = await new Response(message.raw).arrayBuffer();
      const rawText = new TextDecoder("utf-8").decode(rawBuffer);

      const subject = message.headers.get("subject") || "";
      const messageId = message.headers.get("message-id") || "";
      const dateHeader = message.headers.get("date") || "";

      // Try to extract the plain-text body from the MIME message. CF doesn't
      // give us a parsed body — only the raw stream. We do a naive split on
      // the first blank line (end of headers), then strip any "Content-*"
      // lines that leak into the body. Good enough for Sylectus which sends
      // mostly text/plain or simple HTML.
      let body = rawText;
      const headersEnd = rawText.indexOf("\r\n\r\n");
      if (headersEnd !== -1) {
        body = rawText.slice(headersEnd + 4);
      }

      // If this is a multipart message, pull the text/plain part if present.
      const contentType = message.headers.get("content-type") || "";
      if (contentType.toLowerCase().includes("multipart/")) {
        const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
        if (boundaryMatch) {
          const boundary = "--" + boundaryMatch[1];
          const parts = rawText.split(boundary);
          for (const part of parts) {
            if (/Content-Type:\s*text\/plain/i.test(part)) {
              const innerEnd = part.indexOf("\r\n\r\n");
              if (innerEnd !== -1) {
                body = part.slice(innerEnd + 4).trim();
                break;
              }
            }
          }
        }
      }

      // V2-4(4): cap the persisted body size.
      if (body.length > MAX_BODY_BYTES) {
        body = body.slice(0, MAX_BODY_BYTES) + "\n\n[...truncated by ingest worker]";
      }

      const payload = {
        from: message.from,
        to: message.to,
        subject,
        body,
        messageId,
        receivedAt: dateHeader || new Date().toUTCString(),
      };

      const res = await fetch(env.INGEST_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-inbound-secret": env.DISPATCHOS_INBOUND_SECRET,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        // Surface the body so we see it in the Worker logs / CF dashboard
        const errBody = await res.text().catch(() => "");
        console.error(
          `[inbound-email] POST failed: ${res.status} ${errBody.slice(0, 300)}`,
        );
        // Don't reject the email — that would bounce it. Let it through silently
        // and rely on logs / Sentry for visibility.
      }
    } catch (err) {
      console.error("[inbound-email] worker threw:", err);
    }
  },
};
