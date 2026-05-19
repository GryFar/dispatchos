#!/bin/bash
# One-time Fly.io setup for DispatchOS demo deployment.
#
# Run this AFTER:
#   1. flyctl auth login (or auth signup)
#   2. flyctl auth token > ~/.flyctl-token   (so other tools can read it)
#
# This script:
#   - Creates the Fly app
#   - Creates the persistent volume
#   - Sets required secrets (DISPATCHOS_SESSION_SECRET)
#   - Does first deploy
#   - Adds custom domain (demo.dispatchos.co)
#
# Re-run is mostly idempotent — existing app/volume will skip create steps.

set -euo pipefail

APP="dispatchos-demo"
REGION="iad"
DOMAIN="demo.dispatchos.co"

echo "=== Step 1: Verify flyctl is authenticated ==="
flyctl auth whoami

echo ""
echo "=== Step 2: Create app (if missing) ==="
if ! flyctl apps list 2>/dev/null | grep -q "^${APP}\b"; then
  flyctl apps create "${APP}" --org personal
else
  echo "App ${APP} already exists, skipping"
fi

echo ""
echo "=== Step 3: Create persistent volume (if missing) ==="
if ! flyctl volumes list -a "${APP}" 2>/dev/null | grep -q "dispatchos_data"; then
  flyctl volumes create dispatchos_data \
    --app "${APP}" \
    --region "${REGION}" \
    --size 3 \
    --yes
else
  echo "Volume dispatchos_data already exists, skipping"
fi

echo ""
echo "=== Step 4: Set session secret ==="
SECRET=$(openssl rand -hex 32)
flyctl secrets set DISPATCHOS_SESSION_SECRET="${SECRET}" --app "${APP}" --stage
echo "Session secret set (will be applied on next deploy)"

echo ""
echo "=== Step 5: First deploy ==="
flyctl deploy --app "${APP}" --remote-only

echo ""
echo "=== Step 6: Add custom domain ==="
flyctl certs add "${DOMAIN}" --app "${APP}" || true

echo ""
echo "=== Done ==="
echo ""
echo "Next steps:"
echo "  1. Add DNS records in Cloudflare:"
echo "     CNAME  demo  →  ${APP}.fly.dev   (proxied OFF — orange cloud GREY)"
echo "  2. Verify cert:"
echo "     flyctl certs check ${DOMAIN} --app ${APP}"
echo "  3. Open: https://${DOMAIN}"
echo ""
echo "  App URL (always works): https://${APP}.fly.dev"
