// End-to-end pipeline test (temp DB).
// Run: npx tsx server/lib/adapters/email-pipeline-e2e.test.ts
//
// Drives the WHOLE working-source chain that no test previously exercised end to
// end (which let the "email adapters ingest nothing" P0 hide): a forwarded
// broker email -> email_ingest -> adapter fetch/normalize -> upsert load ->
// offline geocode -> scoreLoadForClient -> matched-load alert. Asserts the
// load actually ingests, geocodes (not 0,0), scores with a SANE deadhead (the
// bug made it ~7,000 mi), and would alert the carrier's driver.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-email-e2e-${Date.now()}.db`);
const { storage } = await import("../../storage");
const { getAdapter } = await import("./index");
const { scoreLoadForClient } = await import("../../routes");
const { notifyMatchedLoadsBatch } = await import("../load-alerts");
import type { Client, Load } from "@shared/schema";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const rnd = () => Math.random().toString(36).slice(2, 10);

// --- carrier + linked driver with a Telegram chat ---------------------------
const owner = storage.createUser({
  email: `owner-${rnd()}@example.com`, fullName: "Owner", role: "driver",
  passwordSalt: "s", passwordHash: "h",
});
storage.claimMc(`MC-${Math.floor(100000 + Math.random() * 800000)}`, owner.id);
const carrier = storage.provisionCarrierFromOnboarding(owner.id, {
  persona: "owner_operator", companyName: "E2E Hauling", planTier: "oo_basic",
}) as { id: string };
const clientId = carrier.id;

// Make the carrier match the RXO load (enclosed) and sit near Kansas City so the
// deadhead to Dallas is a real, finite number.
const base = storage.getClient(clientId) as Client;
storage.upsertClient({
  ...(base as any),
  equipment: "enclosed_car_hauler",
  currentLocation: {
    city: "Kansas City", state: "MO", lat: 39.10, lng: -94.58,
    source: "manual_checkin", updatedAt: new Date().toISOString(),
    status: "empty", availableAt: new Date().toISOString(),
  },
} as any);
storage.setUserTelegramChatId(owner.id, "777001");

// --- forwarded broker email lands in email_ingest ---------------------------
const inbound = "loads+e2e@dispatchos.co";
storage.saveEmailIngest({
  from: "loadoffers@rxo.com",
  to: inbound,
  subject: "Load Available - Dallas, TX to Atlanta, GA - $2,450",
  body: [
    "Origin: Dallas, TX 75201",
    "Destination: Atlanta, GA 30303",
    "Pickup: 06/20/2026 08:00",
    "Delivery: 06/21/2026 17:00",
    "Miles: 781",
    "Equipment: Enclosed car hauler",
    "Rate: $2,450",
    "Reference: RXO-558213",
    "Broker: RXO Logistics (MC# 1234567)",
  ].join("\n"),
});

// --- adapter: fetch + normalize ---------------------------------------------
const sourceRow: any = {
  id: "src-rxo", clientId, adapterKey: "rxo_email",
  configJson: { inboundAddress: inbound },
};
const adapter = getAdapter("rxo_email")!;
await adapter.authenticate(sourceRow);
const raws = await adapter.fetchLoads(sourceRow);
assert("adapter ingests the forwarded email (the P0 fix)", raws.length === 1, `got ${raws.length}`);

const norm = adapter.normalizeToLoad(raws[0]!, sourceRow);
assert("origin geocoded to Dallas (not 0,0)", Math.abs(norm.originLat - 32.78) < 0.5 && norm.originLng < 0, `${norm.originLat},${norm.originLng}`);
assert("destination geocoded to Atlanta", Math.abs(norm.destinationLat - 33.75) < 0.5);
assert("rate + miles parsed", norm.rate === 2450 && norm.loadedMiles === 781);

// --- upsert the load ---------------------------------------------------------
const { id: loadId, inserted } = storage.upsertLoadFromSource({
  sourceId: "src-rxo", sourceExternalId: norm.sourceExternalId, clientId,
  payload: norm as unknown as Record<string, unknown>,
});
assert("load upserted as new", inserted);

// --- score it ----------------------------------------------------------------
const load = storage.getLoad(loadId) as Load;
const client = storage.getClient(clientId) as Client;
const scored = scoreLoadForClient(client, load, false);
assert("load scores (not filtered out)", scored !== null);
if (scored) {
  assert("dispatchScore is a finite number", Number.isFinite(scored.dispatchScore));
  // The bug it guards: deadhead to (0,0) was ~7,000 mi. KC -> Dallas is ~550.
  assert("deadhead is sane (geocoding worked)", scored.deadheadMiles > 0 && scored.deadheadMiles < 2000, `${scored.deadheadMiles} mi`);
  assert("netPpmTotal is finite", Number.isFinite(scored.netPpmTotal));
}

// --- alert would reach the carrier's driver ---------------------------------
if (scored) {
  const sent: string[] = [];
  const res = await notifyMatchedLoadsBatch(client, [scored], {
    listRecipients: (cid: string) => storage.listTelegramRecipientsForClient(cid),
    claim: (lid: string, chat: string, cid: string, score: number) =>
      storage.claimLoadAlert({ loadId: lid, chatId: chat, clientId: cid, dispatchScore: score }),
    send: async (chat: string, _t: string) => { sent.push(chat); return { ok: true }; },
  });
  assert("matched-load alert delivered to the driver", res.sent === 1 && sent[0] === "777001", `sent=${res.sent}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
