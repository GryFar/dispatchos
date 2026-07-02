// AI-assisted broker-email fallback tests.
// Run: npx tsx server/lib/parsers/broker-email-ai.test.ts   (picked up by smoke:ai)
//
// The AI call is mocked by overriding globalThis.fetch (fetchWithTimeout calls
// the ambient fetch at call time). We assert the CONTRACT, not model quality:
//   - clean regex parse            -> zero AI calls;
//   - no ANTHROPIC_API_KEY         -> byte-identical to the plain regex parse;
//   - incomplete parse             -> one AI call that fills ONLY empty fields;
//   - regex always wins a conflict; confidence < 0.7 is dropped;
//   - daily budget cap, non-2xx, and empty responses degrade to the regex parse.

import { parseBrokerEmail } from "./broker-email";
import { parseBrokerEmailWithAi, criticalComplete } from "./broker-email-ai";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- fetch mock -----------------------------------------------------------
const realFetch = globalThis.fetch;
let fetchCalls = 0;
function mockAi(fields: unknown, ok = true) {
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return {
      ok,
      json: async () => ({ content: [{ type: "text", text: JSON.stringify(fields) }] }),
      text: async () => "",
    } as unknown as Response;
  }) as typeof fetch;
}

// --- fixtures (mirror the passing broker-email.test.ts shapes) -------------
const CLEAN = {
  from: "loadoffers@rxo.com",
  subject: "Load Available - Dallas, TX to Atlanta, GA - $2,450",
  body: [
    "Origin: Dallas, TX",
    "Destination: Atlanta, GA",
    "Rate: $2,450",
    "Pickup: 2026-07-10",
    "Equipment: Reefer",
    "Miles: 780",
  ].join("\n"),
};
// Missing RATE only.
const NO_RATE = {
  from: "x@broker.com",
  subject: "Load: Chicago, IL to Dallas, TX",
  body: ["Origin: Chicago, IL", "Destination: Dallas, TX", "Pickup: 2026-07-11"].join("\n"),
};
// Has rate, missing PICKUP (for the conflict test).
const NO_PICKUP = {
  from: "x@broker.com",
  subject: "Load: Miami, FL to Charlotte, NC - $1,650",
  body: ["Origin: Miami, FL", "Destination: Charlotte, NC", "Rate: $1,650"].join("\n"),
};
// Junk non-load email.
const JUNK = {
  from: "marketing@echo.com",
  subject: "Your weekly Echo newsletter",
  body: "Check out our blog for market trends this week!",
};

async function main() {
  delete process.env.DISPATCHOS_AI_PARSE_DAILY_CAP;

  // 1. No key -> byte-identical to the plain regex parse; AI never called.
  {
    delete process.env.ANTHROPIC_API_KEY;
    mockAi({ rate: 9999, confidenceRate: 1 }); // would fill if (wrongly) called
    const ai = await parseBrokerEmailWithAi(NO_RATE);
    const rx = parseBrokerEmail(NO_RATE);
    assert("no key: result identical to regex parse", JSON.stringify(ai) === JSON.stringify(rx));
    assert("no key: AI not called", fetchCalls === 0, `calls=${fetchCalls}`);
  }

  process.env.ANTHROPIC_API_KEY = "test-key";

  // 2. Clean email -> regex complete -> zero AI cost.
  {
    assert("precondition: CLEAN parses complete", criticalComplete(parseBrokerEmail(CLEAN)));
    mockAi({ rate: 1, confidenceRate: 1 });
    const r = await parseBrokerEmailWithAi(CLEAN);
    assert("clean: AI not called", fetchCalls === 0, `calls=${fetchCalls}`);
    assert("clean: not flagged aiAssisted", !r.aiAssisted);
  }

  // 3. Incomplete (no rate) -> one AI call fills rate at high confidence.
  {
    assert("precondition: NO_RATE parses incomplete", !criticalComplete(parseBrokerEmail(NO_RATE)));
    mockAi({ rate: 2400, confidenceRate: 0.9 });
    const r = await parseBrokerEmailWithAi(NO_RATE);
    assert("incomplete: exactly one AI call", fetchCalls === 1, `calls=${fetchCalls}`);
    assert("incomplete: AI filled rate", r.rate === 2400, `rate=${r.rate}`);
    assert("incomplete: flagged aiAssisted", r.aiAssisted === true);
  }

  // 4. Regex wins a conflict: NO_PICKUP has a rate; AI returns a DIFFERENT rate
  //    while filling the missing pickup -> the regex rate is kept.
  {
    const rx = parseBrokerEmail(NO_PICKUP);
    assert("precondition: NO_PICKUP has rate, no pickup", (rx.rate ?? 0) > 0 && !rx.pickupAt);
    mockAi({ rate: 9999, confidenceRate: 1, pickupDate: "2026-07-12", confidencePickup: 0.9 });
    const r = await parseBrokerEmailWithAi(NO_PICKUP);
    assert("conflict: regex rate kept (not AI's)", r.rate === rx.rate, `rate=${r.rate} want=${rx.rate}`);
    assert("conflict: AI filled the empty pickup", r.pickupAt === "2026-07-12", `pickup=${r.pickupAt}`);
  }

  // 5. Low confidence (< 0.7) is dropped.
  {
    mockAi({ rate: 2400, confidenceRate: 0.5 });
    const r = await parseBrokerEmailWithAi(NO_RATE);
    assert("low-confidence rate dropped", !((r.rate ?? 0) > 0), `rate=${r.rate}`);
    assert("low-confidence: nothing used -> not aiAssisted", !r.aiAssisted);
  }

  // 6. Junk email + empty AI response -> no fields invented, nothing flagged.
  {
    mockAi({});
    const r = await parseBrokerEmailWithAi(JUNK);
    assert("junk+empty AI: no endpoints/rate invented", !r.origin && !r.destination && !((r.rate ?? 0) > 0));
    assert("junk+empty AI: not aiAssisted", !r.aiAssisted);
  }

  // 7. AI HTTP error (!ok) -> graceful regex fallback.
  {
    mockAi({ rate: 2400, confidenceRate: 1 }, false);
    const r = await parseBrokerEmailWithAi(NO_RATE);
    const rx = parseBrokerEmail(NO_RATE);
    assert("AI non-2xx: falls back to regex", JSON.stringify(r) === JSON.stringify(rx));
  }

  // 8. Budget cap 0 -> AI never called even when incomplete.
  {
    process.env.DISPATCHOS_AI_PARSE_DAILY_CAP = "0";
    mockAi({ rate: 2400, confidenceRate: 1 });
    const r = await parseBrokerEmailWithAi(NO_RATE);
    assert("budget=0: AI not called", fetchCalls === 0, `calls=${fetchCalls}`);
    assert("budget=0: regex result", JSON.stringify(r) === JSON.stringify(parseBrokerEmail(NO_RATE)));
    delete process.env.DISPATCHOS_AI_PARSE_DAILY_CAP;
  }

  globalThis.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
