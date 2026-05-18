# `server/lib/ai/` — AI Enrichment Modules

Pure-function decision support for the **existing** `scoreLoadForClient` in
`server/routes.ts`. The core scorer is owned by Phase 1 — these modules
**enrich its inputs** so it makes better decisions.

## What's inside

| File | Replaces / enriches | Tests |
|---|---|---|
| `fuel.ts` | Static `client.fuelPrice` → live diesel price by state with PADD fallback + EIA refresh hook | — |
| `fmcsa.ts` | Manual broker entry → automated FMCSA Mobile API verdict (OOS / new MC / no BMC-84 / unsatisfactory) | 31 |
| `lanes.ts` | Manual `load.marketQuality` → dynamic lane benchmark with regional + seasonal + equipment factors | 29 |
| `brokers.ts` | Single-shot FMCSA → combined verdict using FMCSA + our internal performance history | 22 |

**Total: 82 unit tests** — `npx tsx server/lib/ai/<file>.test.ts`.

## Why these and not a new scorer

The existing `scoreLoadForClient(client, load)` in `server/routes.ts:332`
already handles ranking math (PPM weights, deadhead penalty, feasibility).
We don't replace it. We feed it better data.

Today the scorer trusts these load fields blindly:
- `load.brokerScore` — set manually at ingest, often default 70
- `load.fraudRisk` — set manually, often 0
- `load.marketQuality` — set manually, often 70
- `client.fuelPrice` — single static value per client, ignores state

These modules compute those fields dynamically from real signals.

## Wiring guide

### Pattern A — enrich at ingest time (recommended)

When a new load is added (`POST /api/loads`, CSV import, email ingest), call
the AI modules **once** and store the enriched values on the row:

```ts
import { evaluateBroker, fetchByMc, marketQualityFor } from "@/server/lib/ai";

async function enrichLoad(raw: InsertLoad): Promise<Load> {
  const fmcsa = process.env.FMCSA_WEB_KEY
    ? await fetchByMc(raw.brokerMc, { webKey: process.env.FMCSA_WEB_KEY })
    : null;
  const brokerVerdict = fmcsa ? evaluateBroker(fmcsa) : null;

  return {
    ...raw,
    brokerScore: brokerVerdict?.score ?? raw.brokerScore ?? 70,
    fraudRisk: brokerVerdict ? Math.max(0, 100 - brokerVerdict.score) : raw.fraudRisk ?? 0,
    marketQuality: marketQualityFor({
      originState: raw.originState,
      destinationState: raw.destinationState,
      equipment: raw.equipment,
      pickupAt: raw.pickupAt,
    }),
  };
}
```

### Pattern B — enrich at score time (safer, no DB churn)

If you don't want to mutate `load` rows, override fields just before scoring:

```ts
import { marketQualityFor, getDieselPrice } from "@/server/lib/ai";

const enrichedLoad = { ...load, marketQuality: marketQualityFor(load) };
const enrichedClient = {
  ...client,
  fuelPrice: getDieselPrice(client.currentLocation.state).price,
};
const scored = scoreLoadForClient(enrichedClient, enrichedLoad);
```

### Pattern C — book-time gate

Block bookings against bad brokers. New endpoint `POST /api/dispatch/loads/:id/book`:

```ts
import { fetchByMc, evaluateBroker, buildHistory, combineVerdicts } from "@/server/lib/ai";

const fmcsa = await fetchByMc(load.brokerMc, { webKey: process.env.FMCSA_WEB_KEY! });
const fmcsaVerdict = fmcsa ? evaluateBroker(fmcsa) : { verdict: "yellow" as const, score: 50, reasons: ["FMCSA unreachable"], redFlags: [] };
const events = await storage.listBrokerEvents(load.brokerMc);  // future storage method
const history = buildHistory(events);
const combined = combineVerdicts(fmcsaVerdict, history);

if (combined.verdict === "red") {
  return res.status(409).json({ error: "broker_blocked", reasons: combined.reasons, redFlags: combined.redFlags });
}
```

## Calibration sources

| Domain | Source |
|---|---|
| Fuel baselines | EIA Weekly Retail On-Highway Diesel (May 2026) |
| Lane PPM | DAT One Trendlines + Trucker Path Spot Market (May 2026) |
| Seasonal factors | DAT 5-year seasonality |
| Equipment multipliers | Car-hauler community survey (May 2026) |
| FMCSA logic | 49 CFR §371 + §387 |
| Broker history weights | Hand-tuned, replace with learned model after ~500 loads |

Re-calibrate quarterly. Bump constants at top of each file → re-run tests.
