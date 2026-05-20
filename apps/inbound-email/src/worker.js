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

export default {
  /**
   * @param {import('@cloudflare/workers-types').ForwardableEmailMessage} message
   * @param {{ INGEST_URL: string, DISPATCHOS_INBOUND_SECRET: string }} env
   * @param {ExecutionContext} ctx
   */
  async email(message, env, ctx) {
    try {
      // Read the entire raw MIME message
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
