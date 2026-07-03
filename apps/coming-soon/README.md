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

**Automatic** via GitHub Actions — `.github/workflows/deploy-worker.yml`:
- Runs on **push to `develop`/`main`** with a `apps/coming-soon/**` path filter.
- Does **not** run on pull requests (deploys belong on push, not on PRs).
- Requires the `CLOUDFLARE_API_TOKEN` GitHub secret.

**Manual** (fallback):
```bash
cd apps/coming-soon
npm install
wrangler login
wrangler deploy
```

### ⚠️ Cloudflare Workers Builds also deploys this Worker — and it reds-out PRs

A second, **redundant** deployer exists: the Cloudflare **Workers Builds**
GitHub integration (configured in the CF dashboard, not in this repo). It builds
on *every* push including PR branches, its deploy fails on PRs, and it posts a
red commit status **"Workers Builds: dispatchos-coming-soon"** that makes
otherwise-green PRs look failed. It does not block merge (this private repo is
on the free plan → no branch protection), just adds noise. See `.cf-builds` for
the exact **owner** fix (dashboard-only): disconnect the CF Builds integration
(preferred) or turn off its non-production-branch builds. The GitHub Actions
workflow above is the real, PR-safe deployer.

## Environment

| Binding         | Type      | Notes                                          |
|-----------------|-----------|------------------------------------------------|
| `SUBSCRIBERS`   | KV        | namespace id `35604aaaed394333b7ba4c65a9ce3c48` |
| `ADMIN_TOKEN`   | Secret    | Set via `wrangler secret put ADMIN_TOKEN` or Dashboard |

## Custom Domains

**Retired from the apex.** `dispatchos.co` / `www.dispatchos.co` are now served
by the real app on Fly.io (landing for anonymous, SPA for authed) — see the
header in `wrangler.toml`. This Worker is intentionally kept **route-less** and
`workers_dev = false`, so its deploys are inert. Do **not** re-add `[[routes]]`
for the apex here or the next `wrangler deploy` would take the live product
offline.

## API

- `GET /` — landing
- `GET /styles.css` `/app.js` — assets
- `POST /api/subscribe` — `{email, source, referrer}` → `{status: subscribed|already_subscribed}`
- `GET /api/admin/subscribers` — requires `Authorization: Bearer <ADMIN_TOKEN>`
- `GET /api/health` — health check

## Editing content

1. Edit `static/index.html`, `static/styles.css`, or `static/app.js`
2. Commit + push to `develop`/`main` → `deploy-worker.yml` rebuilds and deploys
3. Done. No manual deploy needed. (Note: the Worker is retired from the apex, so
   this only updates the inert Worker — the live landing is on Fly.io.)
