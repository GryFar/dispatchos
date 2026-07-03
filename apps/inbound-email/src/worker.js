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
 * Decode a MIME part body per its Content-Transfer-Encoding. Real broker emails
 * routinely arrive quoted-printable (`=3D`, soft `=\r\n` line breaks) or base64;
 * without decoding, the persisted body is garbled and the server-side parser
 * extracts no load fields — the offer is silently useless. 7bit/8bit/binary and
 * unknown encodings pass through unchanged.
 *
 * @param {string} text
 * @param {string|undefined} encoding
 * @returns {string}
 */
export function decodeTransferEncoding(text, encoding) {
  const enc = (encoding || "").trim().toLowerCase();
  if (enc.includes("quoted-printable")) {
    return text
      .replace(/=\r?\n/g, "") // soft line breaks
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  if (enc.includes("base64")) {
    try {
      const bin = atob(text.replace(/\s+/g, ""));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder("utf-8").decode(bytes);
    } catch {
      return text; // not valid base64 — keep the raw text
    }
  }
  return text;
}

/**
 * Classify an ingest POST outcome. A transient failure (origin unreachable,
 * 5xx, or 401/403 secret-drift) must be RETRIED by the sending MTA rather than
 * silently accepted — otherwise the load email is lost forever. A 4xx we caused
 * (e.g. 400 malformed payload) is not retry-fixable, so we accept-and-log
 * rather than loop a poison message through the queue.
 *
 * @param {number|null} status  HTTP status, or null if fetch threw (network)
 * @returns {"ok"|"retry"|"accept"}
 */
export function classifyIngestOutcome(status) {
  if (status === null) return "retry"; // network / origin unreachable
  if (status >= 200 && status < 300) return "ok";
  if (status >= 500 || status === 401 || status === 403) return "retry";
  return "accept"; // other 4xx: our bug, not retry-fixable
}

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
    // NOTE: expirationTtl is (re)applied on every put, so a continuous trickle
    // of mail perpetually refreshes the 1-hour window and the counter only
    // resets after a full hour of silence — this is a soft, approximate cap,
    // not a strict per-hour window. The read-modify-write is also non-atomic
    // (KV has no atomic increment), so concurrent mail from one sender may
    // undercount. Acceptable at 30/hour anti-abuse granularity.
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
      // Fail fast & loud on misconfiguration: without these bindings the POST
      // below would call fetch(undefined) (TypeError) or send a literal
      // "undefined" secret, and the catch would silently swallow the mail.
      if (!env.INGEST_URL || !env.DISPATCHOS_INBOUND_SECRET) {
        console.error(
          "[inbound-email] misconfigured: INGEST_URL and/or DISPATCHOS_INBOUND_SECRET binding is unset — dropping mail",
        );
        return;
      }

      // Recipient allowlist — defense-in-depth on top of the CF routing rule.
      // Only forward mail addressed to our known ingest address(es), so a
      // misconfigured catch-all route can't pipe arbitrary mail into ingest.
      const to = String(message.to || "").toLowerCase();
      // Strip any plus-tag sub-address (loads+<token>@x -> loads@x) so the
      // per-source addresses the app auto-generates are matched against the base
      // allowlist instead of being silently rejected (every inbound load email
      // was dropped otherwise). The app mints loads+<token>@<DISPATCHOS_INBOUND_DOMAIN>
      // (default inbound.dispatchos.co — see server/storage.ts createLoadSource),
      // so the default allowlist below includes that base address; keep these in
      // sync with INBOUND_ALLOWED_TO in wrangler.toml.
      const toBase = to.replace(/\+[^@]*(?=@)/, "");
      const allowed = String(
        env.INBOUND_ALLOWED_TO || "loads@dispatchos.co,loads@inbound.dispatchos.co",
      )
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (!allowed.includes(to) && !allowed.includes(toBase)) {
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
      const contentType = message.headers.get("content-type") || "";
      const isMultipart = contentType.toLowerCase().includes("multipart/");
      if (headersEnd !== -1) {
        body = rawText.slice(headersEnd + 4);
        // Non-multipart: decode the whole body per the top-level transfer encoding.
        if (!isMultipart) {
          body = decodeTransferEncoding(body, message.headers.get("content-transfer-encoding"));
        }
      }

      // If this is a multipart message, pull the text/plain part if present and
      // decode it per THAT part's own Content-Transfer-Encoding.
      if (isMultipart) {
        const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
        if (boundaryMatch) {
          const boundary = "--" + boundaryMatch[1];
          const parts = rawText.split(boundary);
          for (const part of parts) {
            if (/Content-Type:\s*text\/plain/i.test(part)) {
              const innerEnd = part.indexOf("\r\n\r\n");
              if (innerEnd !== -1) {
                const partHeaders = part.slice(0, innerEnd);
                const cte = (partHeaders.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i) || [])[1];
                body = decodeTransferEncoding(part.slice(innerEnd + 4).trim(), cte);
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

      let res;
      try {
        res = await fetch(env.INGEST_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-inbound-secret": env.DISPATCHOS_INBOUND_SECRET,
          },
          body: JSON.stringify(payload),
        });
      } catch (netErr) {
        // Origin unreachable — transient. Throw so CF returns a temporary
        // failure and the sending MTA retries, instead of completing email()
        // (which tells the MTA "delivered" and loses the load offer forever).
        const e = new Error(`[inbound-email] ingest unreachable: ${netErr && netErr.message}`);
        e.__inboundRetry = true;
        throw e;
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.error(`[inbound-email] POST failed: ${res.status} ${errBody.slice(0, 300)}`);
        if (classifyIngestOutcome(res.status) === "retry") {
          // Recoverable (app 5xx / DISPATCHOS_INBOUND_SECRET drift → 401/403).
          // Throw → CF temporary failure → MTA retries, so the mail is never
          // silently lost while we fix the app or the secret.
          const e = new Error(`[inbound-email] ingest ${res.status} — signalling retry`);
          e.__inboundRetry = true;
          throw e;
        }
        // Other 4xx (a payload WE malformed): not retry-fixable — accept and
        // rely on the loud log above so we don't loop a poison message.
      }
    } catch (err) {
      // A deliberate transient signal must PROPAGATE so CF returns a temporary
      // failure and the sender MTA retries — otherwise the mail is lost. Genuine
      // parse/logic bugs stay swallowed (retrying can't fix a malformed message).
      if (err && err.__inboundRetry) throw err;
      console.error("[inbound-email] worker threw:", err);
    }
  },
};
