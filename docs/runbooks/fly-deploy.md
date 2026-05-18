# Fly.io Demo Deployment Runbook

**Live URL:** https://demo.dispatchos.co
**Fly URL (always works):** https://dispatchos-demo.fly.dev
**Region:** iad (Ashburn, VA)
**Stack:** Node 20 + Express + better-sqlite3 + persistent Fly volume

The coming-soon landing on https://dispatchos.co (Cloudflare Worker, separate
deployment) is **NOT touched** by this. Only `demo.dispatchos.co` points here.

---

## One-time setup (founder)

### 1. Sign up at fly.io
- https://fly.io/app/sign-up
- GitHub OAuth recommended
- Card required for verification — actual usage stays on free allowance
  (1 shared-cpu, 256MB-1GB RAM, 3GB volume = $0/month at this scale)

### 2. Install flyctl locally (or on a server you control)
```bash
curl -L https://fly.io/install.sh | sh
flyctl auth login
```

### 3. Get an API token (so Computer can deploy on your behalf)
```bash
flyctl auth token
# Outputs a long token like FlyV1 fm2_lJPECAAAAA...
```

Send that token to Computer in a message — Computer uses it to:
- Run `flyctl deploy` after a code change
- Roll back if something breaks
- Read logs / status without you needing to SSH

**Rotate this token** (`flyctl auth logout && flyctl auth login`) every 90 days
or when leaking.

### 4. Run the setup script (creates app + volume + first deploy)
```bash
cd dispatchos-repo
git checkout phase4-fly-deploy   # or main once merged
bash scripts/fly-setup.sh
```

Output gives you the `{app}.fly.dev` URL. Verify it works before adding DNS.

### 5. Add DNS in Cloudflare
- Dashboard → dispatchos.co → DNS
- Add **CNAME**: `demo` → `dispatchos-demo.fly.dev`
- **Proxy status: DNS only (grey cloud)** — Fly handles its own TLS
- TTL: Auto

Wait ~30s, verify cert:
```bash
flyctl certs check demo.dispatchos.co --app dispatchos-demo
```

---

## Day-to-day operations

### Deploy a code change
```bash
git push origin develop          # or whatever branch
flyctl deploy --app dispatchos-demo --remote-only
```

`--remote-only` builds on Fly's builder so your laptop doesn't burn CPU.
Takes ~3 min for full rebuild, ~30s for code-only changes.

### Check status
```bash
flyctl status --app dispatchos-demo
flyctl logs --app dispatchos-demo --tail
```

### SSH into the running container
```bash
flyctl ssh console --app dispatchos-demo
# inside:  ls /data    (you'll see dispatchos-unified.db + uploads/ + drive/)
```

### Backup the SQLite DB
```bash
flyctl ssh sftp shell --app dispatchos-demo
> get /data/dispatchos-unified.db ./backup-$(date +%Y%m%d).db
```

Or via API endpoint (existing):
```bash
curl -H "Cookie: dispatchos.sid=..." https://demo.dispatchos.co/api/backup/export -o backup.json
```

### Roll back to previous release
```bash
flyctl releases --app dispatchos-demo
flyctl deploy --app dispatchos-demo --image <previous-image-ref>
```

### Stop / start (save credits during demo pauses)
```bash
flyctl scale count 0 --app dispatchos-demo   # stop all machines
flyctl scale count 1 --app dispatchos-demo   # start one machine
```

`auto_stop_machines = "stop"` in fly.toml means idle machines stop after 5min
of no traffic. They auto-wake on next request (~2s cold start).

---

## Cost guard

Fly free allowance covers:
- 3 shared-cpu-1x VMs OR 2 shared-cpu-2x VMs
- 3GB persistent volumes (we use 3GB)
- 160GB outbound transfer/month

This deployment uses 1 VM + 3GB volume = entirely within free tier.
Real bill should be **$0/month** until you scale up.

If you ever see a bill: check `flyctl scale show --app dispatchos-demo`.

---

## Security

- Session cookie `dispatchos.sid` is httpOnly + secure + sameSite=lax
- TLS handled by Fly edge — no cert management needed
- Trust proxy = 2 (Cloudflare → Fly proxy → app)
- DISPATCHOS_SESSION_SECRET is rotated by `fly-setup.sh` on first run
  (set to 32 random bytes via openssl)
- DB lives on encrypted volume, not on container disk
- All Fly VMs are isolated VMs (firecracker microVM), not containers

If you suspect compromise:
1. `flyctl secrets set DISPATCHOS_SESSION_SECRET="$(openssl rand -hex 32)" --app dispatchos-demo`
2. Wait ~10s for redeploy
3. All existing sessions invalidated, users re-login

---

## Bootstrap first admin

After the first deploy, the app needs a bootstrap admin. Hit:
```bash
curl -X POST https://demo.dispatchos.co/api/auth/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"YourStrongPass1!","fullName":"Your Name"}'
```

Response includes `totpSecret` + `otpauthUrl` — scan the otpauth URL into
Authy / Google Authenticator. Login at https://demo.dispatchos.co/#/login.

After bootstrap, `/api/auth/bootstrap` returns 409 — only one admin can be
created this way. All future users go through invite flow.
