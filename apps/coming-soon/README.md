# Coming Soon — dispatchos.co landing

Single-file Cloudflare Worker that serves the static landing page and handles `/api/subscribe`.

## Structure

```
apps/coming-soon/
├── static/              # Source HTML/CSS/JS (edit these)
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── src/
│   └── worker.template.js   # Worker code with __HTML__/__CSS__/__JS__ placeholders
├── build.mjs            # Inlines static/ into dist/worker.js
├── dist/worker.js       # Generated (gitignored locally, but built on CF)
├── wrangler.toml
└── package.json
```

## Local development

```bash
cd apps/coming-soon
npm install
npm run build         # Generates dist/worker.js
npx wrangler dev      # Runs locally on http://localhost:8787
```

## Deployment

**Automatic** via Cloudflare Workers Builds (configured in CF Dashboard):
- Push to `main` → CF runs `npm run build` → deploys `dist/worker.js`
- Watch path: `apps/coming-soon/**`

**Manual** (fallback):
```bash
cd apps/coming-soon
npm install
wrangler login
wrangler deploy
```

## Environment

| Binding         | Type      | Notes                                          |
|-----------------|-----------|------------------------------------------------|
| `SUBSCRIBERS`   | KV        | namespace id `35604aaaed394333b7ba4c65a9ce3c48` |
| `ADMIN_TOKEN`   | Secret    | Set via `wrangler secret put ADMIN_TOKEN` or Dashboard |

## Custom Domains

Managed outside this folder (via API or Dashboard):
- `dispatchos.co` → this Worker
- `www.dispatchos.co` → this Worker

## API

- `GET /` — landing
- `GET /styles.css` `/app.js` — assets
- `POST /api/subscribe` — `{email, source, referrer}` → `{status: subscribed|already_subscribed}`
- `GET /api/admin/subscribers` — requires `Authorization: Bearer <ADMIN_TOKEN>`
- `GET /api/health` — health check

## Editing content

1. Edit `static/index.html`, `static/styles.css`, or `static/app.js`
2. Commit + push → CF Workers Builds auto-rebuilds and deploys (60-90 sec)
3. Done. No manual deploy needed.
