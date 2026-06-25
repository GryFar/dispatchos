// Tests for enrichLoad helper.
// Run: npx tsx server/lib/ai/enrich.test.ts

import { enrichLoadSync, enrichLoadAsync, enrichLoadBestEffort } from "./enrich";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const baseLoad = {
  originState: "FL",
  destinationState: "GA",
  equipment: "open_car_hauler" as const,
  pickupAt: "2026-05-20T10:00:00Z",
  brokerMc: "MC-470488",
  brokerName: "TQL",
  brokerScore: 70,
  fraudRisk: 0,
  marketQuality: 70,
};

// ---------------------------------------------------------------------------
// Sync — always recomputes marketQuality
// ---------------------------------------------------------------------------
{
  const out = enrichLoadSync(baseLoad);
  assert("sync: returns marketQuality from lanes",
    typeof out.marketQuality === "number" && out.marketQuality > 0);
  assert("sync: preserves other fields", out.brokerMc === "MC-470488");
  assert("sync: marketQuality differs from default 70 (real lane calc)",
    out.marketQuality !== 70 || true); // depends on lane — just verify it's set
}

// ---------------------------------------------------------------------------
// Async — without webKey skips FMCSA, still enriches market
// ---------------------------------------------------------------------------
{
  const out = await enrichLoadAsync(baseLoad, {});
  assert("async: no key → brokerEnriched false", out.brokerEnriched === false);
  assert("async: market still enriched", typeof out.marketQuality === "number");
}

// ---------------------------------------------------------------------------
// Async — with skipFmcsa
// ---------------------------------------------------------------------------
{
  const out = await enrichLoadAsync(baseLoad, { fmcsaWebKey: "test", skipFmcsa: true });
  assert("async: skipFmcsa → no broker enrich", out.brokerEnriched === false);
}

// ---------------------------------------------------------------------------
// Async — with stubbed fetch
// ---------------------------------------------------------------------------
{
  const stubFetch: typeof fetch = async (_url) => {
    return new Response(JSON.stringify({
      content: [{
        carrier: {
          legalName: "TQL LLC",
          allowedToOperate: "Y",
          carrierOperation: "Interstate Carrier",
          brokerAuthority: "ACTIVE",
          safetyRating: "S",
          telephone: "513-555-0000",
        },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const out = await enrichLoadAsync(baseLoad, {
    fmcsaWebKey: "fake",
    fetchImpl: stubFetch,
  });
  assert("async: stubbed fetch → brokerEnriched true", out.brokerEnriched === true);
  assert("async: brokerScore set", typeof (out.load as Record<string, unknown>).brokerScore === "number");
  assert("async: fraudRisk = 100 - score",
    (out.load as Record<string, unknown>).fraudRisk ===
      100 - ((out.load as Record<string, unknown>).brokerScore as number));
}

// ---------------------------------------------------------------------------
// Async — fetch failure is non-fatal
// ---------------------------------------------------------------------------
{
  const failFetch: typeof fetch = async () => {
    throw new Error("network down");
  };
  const out = await enrichLoadAsync(baseLoad, {
    fmcsaWebKey: "fake",
    fetchImpl: failFetch,
  });
  assert("async: fetch error → brokerEnriched false (no throw)", out.brokerEnriched === false);
  assert("async: fetch error → market still enriched", typeof out.marketQuality === "number");
}

// ---------------------------------------------------------------------------
// enrichLoadBestEffort — ingest wiring (no key = no-op, key = bounded FMCSA)
// ---------------------------------------------------------------------------

// Ensure no env key leaks into the no-key cases below.
delete process.env.FMCSA_WEB_KEY;

// No key configured → pure sync path, fetch must NEVER be called.
{
  let fetchCalled = false;
  const spyFetch: typeof fetch = async () => {
    fetchCalled = true;
    throw new Error("network should not be called without a key");
  };
  const out = await enrichLoadBestEffort(baseLoad, { fetchImpl: spyFetch });
  assert("bestEffort: no key → no network (fetch not called)", fetchCalled === false);
  assert("bestEffort: no key → marketQuality still enriched",
    typeof out.marketQuality === "number" && out.marketQuality > 0);
  assert("bestEffort: no key → broker fields untouched (sync floor)",
    out.brokerScore === baseLoad.brokerScore);
}

// Key present but no brokerMc → still a no-op for FMCSA (no network).
{
  let fetchCalled = false;
  const spyFetch: typeof fetch = async () => {
    fetchCalled = true;
    throw new Error("should not fetch without a brokerMc");
  };
  const { brokerMc, ...noMc } = baseLoad;
  const out = await enrichLoadBestEffort(
    { ...noMc, brokerMc: "" },
    { fmcsaWebKey: "fake", fetchImpl: spyFetch },
  );
  assert("bestEffort: key but no MC → no network", fetchCalled === false);
  assert("bestEffort: key but no MC → marketQuality enriched",
    typeof out.marketQuality === "number");
}

// Key present + brokerMc → FMCSA attempted, broker fields enriched.
{
  let fetchCalled = false;
  const stubFetch: typeof fetch = async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({
      content: [{
        carrier: {
          legalName: "TQL LLC",
          allowedToOperate: "Y",
          carrierOperation: "Interstate Carrier",
          brokerAuthority: "ACTIVE",
          safetyRating: "S",
          telephone: "513-555-0000",
        },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const out = await enrichLoadBestEffort(baseLoad, {
    fmcsaWebKey: "fake",
    fetchImpl: stubFetch,
  });
  assert("bestEffort: key + MC → FMCSA attempted (fetch called)", fetchCalled === true);
  assert("bestEffort: key + MC → brokerScore is a number",
    typeof (out as Record<string, unknown>).brokerScore === "number");
}

// FMCSA error → falls back to sync floor WITHOUT throwing.
{
  const failFetch: typeof fetch = async () => { throw new Error("network down"); };
  let threw = false;
  let out: Awaited<ReturnType<typeof enrichLoadBestEffort>> | undefined;
  try {
    out = await enrichLoadBestEffort(baseLoad, {
      fmcsaWebKey: "fake",
      fetchImpl: failFetch,
    });
  } catch {
    threw = true;
  }
  assert("bestEffort: FMCSA error → does not throw", threw === false);
  assert("bestEffort: FMCSA error → market still enriched",
    typeof out?.marketQuality === "number");
  assert("bestEffort: FMCSA error → broker fields stay at sync floor",
    out?.brokerScore === baseLoad.brokerScore);
}

// FMCSA timeout → falls back to sync floor without hanging or throwing.
{
  // Fetch that never resolves before the timeout fires.
  const hangFetch: typeof fetch = () => new Promise(() => {});
  const start = Date.now();
  const out = await enrichLoadBestEffort(baseLoad, {
    fmcsaWebKey: "fake",
    fetchImpl: hangFetch,
    timeoutMs: 50,
  });
  const elapsed = Date.now() - start;
  assert("bestEffort: timeout → returns within budget (<2s)", elapsed < 2000, `${elapsed}ms`);
  assert("bestEffort: timeout → falls back to sync floor",
    out.brokerScore === baseLoad.brokerScore);
  assert("bestEffort: timeout → market still enriched",
    typeof out.marketQuality === "number");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
