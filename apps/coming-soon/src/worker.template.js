// dispatchos-coming-soon — single-file Cloudflare Worker
// Auto-built from static/* via build.mjs
const HTML = __HTML__;
const CSS = __CSS__;
const JS = __JS__;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60', ...SECURITY_HEADERS }});
    }
    if (req.method === 'GET' && url.pathname === '/styles.css') {
      return new Response(CSS, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=300', ...SECURITY_HEADERS }});
    }
    if (req.method === 'GET' && url.pathname === '/app.js') {
      return new Response(JS, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=300', ...SECURITY_HEADERS }});
    }

    if (url.pathname === '/api/subscribe' && req.method === 'POST') {
      try {
        const body = await req.json();
        const email = (body.email || '').toString().trim().toLowerCase();
        if (!email || !EMAIL_RE.test(email) || email.length > 254) return jsonResp({ error: 'invalid_email' }, 400);

        const ip = req.headers.get('cf-connecting-ip') || 'unknown';
        const rateKey = 'rate:' + ip;
        const attempts = parseInt((await env.SUBSCRIBERS.get(rateKey)) || '0', 10);
        if (attempts >= 5) return jsonResp({ error: 'rate_limited' }, 429);
        await env.SUBSCRIBERS.put(rateKey, String(attempts + 1), { expirationTtl: 3600 });

        const key = 'sub:' + email;
        const existing = await env.SUBSCRIBERS.get(key);
        if (existing) return jsonResp({ status: 'already_subscribed' }, 200);

        const record = {
          email, ts: Date.now(), source: body.source || 'coming-soon',
          referrer: body.referrer || null, ip,
          country: req.headers.get('cf-ipcountry') || null,
          ua: (req.headers.get('user-agent') || '').slice(0, 200),
        };
        await env.SUBSCRIBERS.put(key, JSON.stringify(record));

        const indexRaw = (await env.SUBSCRIBERS.get('_index')) || '[]';
        let index = JSON.parse(indexRaw);
        if (!Array.isArray(index)) index = [];
        index.push({ email, ts: record.ts, country: record.country });
        if (index.length > 10000) index = index.slice(-10000);
        await env.SUBSCRIBERS.put('_index', JSON.stringify(index));

        return jsonResp({ status: 'subscribed' }, 200);
      } catch (e) {
        return jsonResp({ error: 'bad_request' }, 400);
      }
    }

    if (url.pathname === '/api/admin/subscribers' && req.method === 'GET') {
      const auth = req.headers.get('authorization');
      if (!env.ADMIN_TOKEN || auth !== 'Bearer ' + env.ADMIN_TOKEN) return jsonResp({ error: 'unauthorized' }, 401);
      const indexRaw = (await env.SUBSCRIBERS.get('_index')) || '[]';
      return new Response(indexRaw, { headers: { 'content-type': 'application/json' }});
    }

    if (url.pathname === '/api/health') return jsonResp({ ok: true, time: new Date().toISOString() });

    return new Response('Not found', { status: 404 });
  },
};
function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY_HEADERS }});
}
