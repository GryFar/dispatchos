# DispatchOS Backend

**Owner:** Vlad

## ⚠️ This folder is empty.

Vlad — please upload your `dispatchos-v1.2.7-vds-production` baseline here so the rest of the team can:

1. Pull `shared/schema.ts` into other frontends without guessing
2. Build dispatcher and driver portals against a real API
3. Run smoke tests against a working baseline before Phase 1 changes

## How to upload (one-time)

```bash
git clone https://github.com/GryFar/dispatchos.git
cd dispatchos
git checkout -b phase0-v1.2.7-baseline

# Unpack your zip into THIS folder
cd backend
unzip ~/Downloads/dispatchos-v1.2.7.zip .
# or rsync/cp — but keep the files at backend/* not backend/dispatchos-v1.2.7/*

# Create .env.example — list of 24 env vars from your audit, no real values
cat > .env.example <<EOF
# Auth
SESSION_SECRET=
TOTP_ISSUER=DispatchOS
# (rest of your 24 vars here, with empty values or placeholders)
EOF

# Commit
cd ..
git add backend/
git commit -m "phase 0: baseline dispatchos v1.2.7-vds-production"
git tag pre-migration-v1.2.7
git push -u origin phase0-v1.2.7-baseline --tags

# Open PR
gh pr create --base main --head phase0-v1.2.7-baseline \
  --title "Phase 0: Baseline v1.2.7 import" \
  --body "Initial backend import. No code changes. Establishes baseline for Phase 1."
```

After Founder merges → start Phase 1 in a new branch `phase1-backend-roles`.

## Expected Structure (after upload)

```
backend/
├── package.json
├── tsconfig.json
├── drizzle.config.ts (or remove if not using Drizzle yet)
├── shared/
│   └── schema.ts                # SOURCE OF TRUTH — all frontends pull from this
├── server/
│   ├── index.ts                 # entry, sessions, middleware
│   ├── auth.ts                  # requireRole, getCurrentUser
│   ├── routes.ts (Phase 1)
│   ├── routes/                  # (after Phase 3 split)
│   │   ├── auth.ts
│   │   ├── admin.ts
│   │   ├── dispatcher.ts
│   │   ├── driver.ts
│   │   ├── shared.ts
│   │   ├── webhooks.ts
│   │   ├── health.ts
│   │   └── index.ts
│   ├── storage.ts
│   └── lib/                     # (after Phase 3) scoring, brokers, csv, email, billing, drive, seed
├── scripts/
│   ├── smoke.mjs                # smoke tests
│   ├── seed.mjs                 # dev seed data
│   └── migrate-owner.mjs        # one-time auth_config → users
├── data/                        # .gitignored — runtime SQLite DB lives here
└── .env.example                 # all 24 env vars, no values
```

## Smoke Tests

After upload, anyone should be able to:

```bash
cd backend
npm install
cp .env.example .env
# fill in dev values
npm run dev    # in one terminal
npm run smoke  # in another — should be green
```

## Notes for Founder & Frontend Teams

- **Do not touch `backend/shared/schema.ts`** without coordinating with Vlad
- `GET /api/me` (after Phase 1) is the canonical way to know who's logged in
- Sessions are cookie-based; frontends must use `credentials: "include"`
- API base path: `/api/*`
