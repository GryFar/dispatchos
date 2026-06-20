# DispatchOS — context for AI agents

## What this is
AI-powered dispatch/logistics automation for US trucking. Single-LLC SaaS.
Repo: github.com/GryFar/dispatchos. Active branch: develop.
Local: C:\Users\pily\Desktop\dispatchos\dispatchos-repo
DB: dispatchos-unified.db (real data). smoke-*.db are throwaway test DBs.

## Stack
Node 20, Express 5, TypeScript, React 18 + Vite, shadcn/ui, wouter (hash routing),
better-sqlite3 with payload-JSON storage (loads/clients stored as JSON in a `payload`
column, not normalized columns), express-session. Zod validation in shared/schema.ts.
Inline DB migrations in storage.ts via ALTER ... IF NOT EXISTS (no separate migration files).

## Roles & domain
Roles: admin / dispatcher / driver. A "carrier"/tenant = a `client` record. Billing fields
(billingStatus, trialEndsAt, pastDueSince, stripeSubscriptionId) live INSIDE the client JSON
payload, not as columns. A self-serve carrier owner = a driver-role user with linkedClientId.

## Build / test loop
- npm run check  -> tsc
- node scripts/smoke.mjs  -> ~194 checks. ONE known pre-existing failure:
  "bootstrap without token returns 409 expected 401" — cosmetic, not a real bug.
- Per-lib tests: npx tsx server/lib/<name>.test.ts

## CRITICAL Windows/PowerShell gotcha
PowerShell console renders UTF-8 as CP1251 — Cyrillic strings LOOK like mojibake
(ЎСЃС‹»є°) in Get-Content / Select-String output but the FILES ARE CLEAN UTF-8.
NEVER "fix" mojibake based on console output. Always read bytes:
  $b=[System.IO.File]::ReadAllBytes("path"); $t=[System.Text.Encoding]::UTF8.GetString($b)
Verify any encoding concern by byte-reading before editing.

## Debugging discipline that works here
Narrow hunting, not broad audits. Symptom -> hypotheses -> verify in code/browser -> fix
with test or browser proof. For runtime/visual bugs, get DevTools facts (Network response
body, the actual failing request URL+status) BEFORE editing. Don't fix blind.

## Recently fixed (commit 470c0e9)
loadFullSchema rejected real persisted loads -> 400 on dashboard/load lists/detail.
Three coupled defects: driverId & bookedAt were .optional() not .nullable() (rejected
stored null); assign-driver + driver self-dispatch wrote bookedAt as full ISO timestamp
but dateOnlySchema + billing require date-only YYYY-MM-DD. Lesson: the schema/writer
contract had drifted from stored data. Watch for the same .optional()-vs-.nullable()
trap and the date-only bookedAt convention in any other writer.

## Open items
- #3 detention: bill-endpoint (event->invoice line) NOT written; /detention/upcoming and
  billableDetentionCents contradict on whether an open leg is billable. Product decision
  needed (Nikita/owner) before coding. Client money — do not write blind.
- ANTHROPIC_API_KEY not set -> dispatcher cockpit AI returns 503 (graceful by design).
  Owner task to set the key; not a code bug.
- i18n: server has hardcoded RU literals (routes.ts, email.ts, ifta.ts, etc.) not yet in
  the dictionary — Nikita's zone.

## Collaborators
Owner/PM: Nikita (@GryFar, commits as GryFar). Pushes large feature batches to develop
(matching engine, GMV/fleet-assignment, load-chaining). Pull before working; he moves fast.
