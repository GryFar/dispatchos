# Runbook — split production off the demo app (one-time cutover)

**Problem this fixes:** today `dispatchos.co` and `demo.dispatchos.co` are the
SAME Fly app (`dispatchos-demo`) on the SAME SQLite volume, so demo/test traffic
and real customers share one database. Before taking paying customers, production
must be its own app + its own volume.

**What the code already does (this branch, `feat/prod-demo-split`):**
- `fly.prod.toml` — prod app config (`dispatchos-prod`, volume `dispatchos_prod_data`).
- `.github/workflows/deploy.yml` — `develop → dispatchos-demo` (fly.toml),
  `main → dispatchos-prod` (fly.prod.toml), health-checked per env.

**The steps below need the owner's Fly account + DNS and CANNOT be done by CI.**
Do them IN ORDER. Do NOT merge this branch to `main` until steps 1-4 are done,
or the first `main` deploy fails (the app won't exist yet).

---

## 0. Prereqs
- `flyctl auth login` as the account that owns `dispatchos-demo`.
- Have the LIVE Stripe keys ready (prod should charge real cards, not test mode).

## 1. Create the prod app + its own volume
```bash
flyctl apps create dispatchos-prod
flyctl volumes create dispatchos_prod_data --app dispatchos-prod --region iad --size 3
```

## 2. Copy secrets demo → prod (and swap Stripe to LIVE)
List the demo secret NAMES (values aren't shown) and set each on prod:
```bash
flyctl secrets list --app dispatchos-demo        # names only — copy the list
```
Set every one on prod (`flyctl secrets set KEY=... --app dispatchos-prod`). The
ones that MUST differ on prod:
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` → **LIVE** values (not `sk_test_…`).
- Anything env-specific (base URLs, webhook targets) → prod values.
Everything else (ANTHROPIC_API_KEY, DISPATCHOS_CRON_SECRET, Telegram token,
FMCSA key, IP salt, etc.) can be the same values as demo.

## 3. First deploy to prod
```bash
flyctl deploy --config fly.prod.toml --app dispatchos-prod
flyctl certs add dispatchos.co --app dispatchos-prod   # issue the TLS cert
```
Prod starts with an EMPTY database (fresh volume). If real carriers already
signed up on the shared instance, copy the DB across BEFORE going live:
`flyctl ssh sftp get /data/dispatchos.db` from demo, then `put` to prod — do this
while both are quiesced so you don't lose writes.

## 4. Point the domain at prod
- In Cloudflare DNS, repoint `dispatchos.co` (the apex/`@`, currently on demo) to
  `dispatchos-prod.fly.dev`. Leave `demo.dispatchos.co` on `dispatchos-demo`.
- Verify: `curl -sI https://dispatchos.co/api/health` should hit the new app
  (check `Fly-Request-Id` differs from demo, and `/api/health` is 200).

## 5. Flip the crons to prod
The billing/backup/daily/fuel/poll workflows default their BASE_URL to
`https://demo.dispatchos.co`. Set the repo variable so they target prod:
```bash
gh variable set DISPATCHOS_BASE_URL --body "https://dispatchos.co"
```
(Weekly billing then charges PROD customers; backups back up the PROD volume.)

## 6. Enable the pipeline
- Merge `feat/prod-demo-split` → `develop` (no behaviour change for demo).
- Sync `develop → main`. That push deploys to `dispatchos-prod` and health-checks
  `https://dispatchos.co/api/health`.

## Rollback
If prod misbehaves, repoint `dispatchos.co` DNS back to `dispatchos-demo` — the
demo app is untouched by all of the above and keeps serving. No data is lost
because prod is a separate volume.
