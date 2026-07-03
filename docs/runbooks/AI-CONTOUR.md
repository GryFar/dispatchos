# AI Contour — Operations Runbook

How DispatchOS's AI features are wired, the cost-control levers, and what to do
in a cost incident. Companion to the audit's `ai-credit-ddos` finding: if Claude
spend runs away, this is where the kill-switch lives.

## Call sites

| Feature | Code | Trigger |
| --- | --- | --- |
| Broker-email parse fallback | `server/lib/parsers/broker-email-ai.ts` (via adapter `server/lib/adapters/broker-email.ts` `fetchLoads`) | Cron poller, per polled email whose regex parse misses load-defining fields |
| Dispatch advisor | `server/lib/ai/dispatch-advisor.ts` | `POST /api/dispatch/ai-recommend` (cockpit "AI analysis") |
| Broker-reply draft | `server/lib/ai/broker-reply.ts` + `server/routes/ai-drafts.ts` | `POST /api/ai/draft-broker-reply` (load-detail "Reply to broker") |
| Receipt OCR | `server/lib/ai/receipt-ocr.ts` | Driver receipt upload |

All use `claude-haiku` via the raw Messages API with a fetch timeout.

## Cost-control levers (environment)

Read live — flip the env var and restart the process/worker; no redeploy.

- **`DISPATCHOS_AI_KILL=1`** — **emergency stop.** Refuses ALL AI spend at once:
  the per-user routes (enforced in `storage.ts` `consumeAiQuota`) AND the
  system-side parse fallback (`broker-email-ai.ts`). Use this first.
- **`DISPATCHOS_AI_GLOBAL_DAILY_CAP`** (default `10000`) — max approved AI calls
  per day across ALL users. Backed by the `ai_usage_global` table; enforced in
  `consumeAiQuota` before any per-user spend.
- **`DISPATCHOS_AI_PARSE_DAILY_CAP`** (default `200`) — separate per-day cap for
  the poller's parse fallback (in-memory in `broker-email-ai.ts`). It is NOT
  counted in `ai_usage_global` (system path, no user), but it DOES respect
  `DISPATCHOS_AI_KILL`.
- Per-user daily free quota (50/day) + purchasable per-carrier credits — in
  `consumeAiQuota` / `ai_credit_grants` (`storage.ts`).

> Note: the parse fallback is bounded independently (its own 200/day cap +
> kill-switch) but is not part of the global 10000 ceiling. To fold it in, a
> system-level consume would have to live in `storage.ts`.

## Cost incident — steps

1. Set `DISPATCHOS_AI_KILL=1` and restart **both** the app and the cron/poll
   worker. Every call site stops.
2. Verify: user AI actions return `429`/`503` gracefully (never `500`); the
   poller makes no model calls.
3. Locate the spend: app logs per call site + the `ai_usage_global` day counter.
4. Resume: lower `DISPATCHOS_AI_GLOBAL_DAILY_CAP` / `DISPATCHOS_AI_PARSE_DAILY_CAP`
   as needed, unset `DISPATCHOS_AI_KILL`, restart.

## Eval — advisor quality gauge

Harness: `scripts/eval-advisor.mjs` (10 golden scenarios).

- Keyless: `npx tsx scripts/eval-advisor.mjs` — validates the scenario goldens
  (structural) and prints `Scaffold OK`, exit 0. Nothing is scored (the advisor
  returns null without a key).
- With key: `ANTHROPIC_API_KEY=sk-... npx tsx scripts/eval-advisor.mjs` — prints a
  per-scenario `pick`/`mentions` table + a summary line. Run it **before and
  after** a prompt edit in `dispatch-advisor.ts` to see the metric move.

## Graceful degradation (by design)

No AI call site returns `500`:

- Parse fallback — no key / budget spent / kill-switch → returns the regex parse
  unchanged (the load still ingests, just without AI-recovered fields).
- Advisor — no key / model failure → the cockpit shows an "AI unavailable" note.
- Broker-reply — no key / model failure → `503` `ai_unavailable`; daily quota +
  credits spent → `429` `ai_quota_exceeded` (UI offers a per-carrier top-up).
