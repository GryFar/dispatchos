# `server/lib/ai/` — DispatchOS AI Engine

Pure-function decision engine for ranking loads, evaluating brokers, and
pricing lanes. **No LLM calls** — everything here is deterministic math + rules
so it's fast (sub-15ms per load) and testable with fixtures.

## Modules

| File | Purpose | Tests |
|---|---|---|
| `scoring.ts` | Score and rank loads against drivers (PPM, deadhead, feasibility) | 25 |
| `fuel.ts` | Diesel pricing by state (PADD baseline + EIA refresh hook) | — |
| `fmcsa.ts` | FMCSA broker verification + risk verdict | 31 |
| `lanes.ts` | Region-pair PPM benchmarks + seasonal + equipment multipliers | 29 |
| `brokers.ts` | Internal broker performance tracking + combined trust score | 22 |

**Total: 107 unit tests** — run with `npx tsx server/lib/ai/<file>.test.ts`.

## How to use from route layer

```ts
import {
  rankLoadsForClient,
  evaluateBroker,
  quoteLane,
  combineVerdicts,
  buildHistory,
  fetchByMc,
} from "@/server/lib/ai";
```

### Example: dispatcher suggestions endpoint

```ts
// GET /api/dispatch/suggestions?clientId=...
const client = await storage.getClient(clientId);
const location = client.lastLocation;
const allLoads = await storage.listLoads({ status: "available" });
const suggestions = rankLoadsForClient(allLoads, client, location, { topN: 5 });
return suggestions;
```

### Example: book a load with broker check

```ts
// POST /api/dispatch/loads/:id/book
const load = await storage.getLoad(id);
const fmcsa = await fetchByMc(load.brokerMc, { webKey: process.env.FMCSA_WEB_KEY! });
const fmcsaVerdict = fmcsa ? evaluateBroker(fmcsa) : { verdict: "yellow", score: 50, reasons: ["FMCSA unreachable"], redFlags: [] };
const events = await storage.listBrokerEvents(load.brokerMc);
const history = buildHistory(events);
const combined = combineVerdicts(fmcsaVerdict, history);
if (combined.verdict === "red") {
  return res.status(409).json({ error: "broker_blocked", reasons: combined.reasons });
}
// proceed with booking...
```

### Example: classify a counter-offer

```ts
const quote = quoteLane({ originState, destState, equipment, asOfDate });
const classification = classifyOffer(rate, loadedMiles, quote);
if (classification.recommendedAction === "counter") {
  await sendCounterEmail(brokerEmail, classification.suggestedCounter);
}
```

## Design rules

1. **No I/O in pure modules.** `scoring.ts`, `lanes.ts`, `brokers.ts` never
   hit the network or database. Caller passes data in, gets result out.
   `fmcsa.ts` and `fuel.ts` have optional network functions explicitly named
   (`fetchByMc`, `refreshFromEia`).
2. **Deterministic.** Same inputs always produce same output. No randomness,
   no `new Date()` inside scoring logic (caller passes timestamps).
3. **Conservative defaults.** When uncertain, return the safer verdict
   (yellow over green, skip over book). Trucking margins are too thin for
   optimism.
4. **Explainable.** Every score comes with `reasons` and `warnings` arrays so
   the dispatcher can audit and override.

## Calibration sources

| Domain | Source |
|---|---|
| Fuel baselines | EIA Weekly Retail On-Highway Diesel (May 2026) |
| Lane PPM | DAT One Trendlines + Trucker Path Spot Market (May 2026) |
| Seasonal factors | DAT 5-year seasonality analysis |
| Equipment multipliers | Car-hauler dispatcher community survey (May 2026) |
| FMCSA logic | 49 CFR §371 (broker authority) + §387 (insurance) |
| Broker performance weights | Hand-tuned, will replace with learned model after ~500 booked loads |

Re-calibrate quarterly. When you do, bump the constants at the top of each
file and re-run tests — they're tuned to the current calibration.
