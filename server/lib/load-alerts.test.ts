// Matched-load push test (temp DB). Run: npx tsx server/lib/load-alerts.test.ts
//
// P0.4/P0.5: the scorer found strong loads but nobody got pinged — the core
// "start receiving offers" promise was undelivered. This verifies:
//  (a) shouldAlertLoad gates on verdict + threshold,
//  (b) formatMatchedLoadMessage renders a clean, injection-safe offer,
//  (c) storage.listTelegramRecipientsForClient returns linked drivers with a
//      chat_id (excluding blocked/unlinked) and de-dups by chat_id,
//  (d) storage.claimLoadAlert de-dups (load, chat) atomically,
//  (e) notifyMatchedLoad routes per-recipient, skips already-alerted, never throws.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-load-alerts-${Date.now()}.db`);
const { storage } = await import("../storage");
const {
  shouldAlertLoad,
  formatMatchedLoadMessage,
  notifyMatchedLoad,
  notifyMatchedLoadsBatch,
  formatMatchedLoadsBatchMessage,
  matchAlertThreshold,
} = await import("./load-alerts");
import type { Client, ScoredLoad } from "@shared/schema";

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
const rnd = () => Math.random().toString(36).slice(2, 10);

function makeScored(over: Partial<ScoredLoad> = {}): ScoredLoad {
  return {
    id: `load-${rnd()}`,
    originCity: "Dallas",
    originState: "TX",
    destinationCity: "Atlanta",
    destinationState: "GA",
    rate: 2400,
    loadedMiles: 780,
    deadheadMiles: 40,
    netPpmTotal: 1.92,
    dispatchScore: 88,
    verdict: "book",
    counterOffer: null,
    warnings: [],
    ...over,
  } as unknown as ScoredLoad;
}

// --- (a) threshold/verdict gating -------------------------------------------
assert("book above threshold alerts", shouldAlertLoad(makeScored({ dispatchScore: 88 })));
assert("skip verdict never alerts", !shouldAlertLoad(makeScored({ verdict: "skip", dispatchScore: 130 })));
assert(
  "below threshold doesn't alert",
  !shouldAlertLoad(makeScored({ dispatchScore: matchAlertThreshold() - 1 })),
);
assert("negotiate above threshold alerts", shouldAlertLoad(makeScored({ verdict: "negotiate", dispatchScore: 80 })));

// --- (b) formatter ----------------------------------------------------------
const client = { id: "c1", name: "Acme Hauling" } as unknown as Client;
const msg = formatMatchedLoadMessage(client, makeScored({ counterOffer: 2600, verdict: "negotiate" }));
assert("message includes lane", msg.includes("Dallas, TX → Atlanta, GA"));
assert("message includes rate", msg.includes("$2,400"));
assert("message includes counter", msg.includes("$2,600"));
assert("message includes carrier", msg.includes("Acme Hauling"));
const injMsg = formatMatchedLoadMessage(client, makeScored({ originCity: "Bad\nCity\tInject" } as any));
assert("formatter strips newlines/tabs (injection-safe)", !/[\r\n\t]Inject/.test(injMsg) && injMsg.includes("Bad City Inject"));

// --- (c) recipients query ---------------------------------------------------
const owner = storage.createUser({
  email: `owner-${rnd()}@example.com`,
  fullName: "Owner Op",
  role: "driver",
  passwordSalt: "s",
  passwordHash: "h",
});
storage.claimMc(`MC-${Math.floor(100000 + Math.random() * 800000)}`, owner.id);
const carrier = storage.provisionCarrierFromOnboarding(owner.id, {
  persona: "owner_operator",
  companyName: "Push Test LLC",
  planTier: "fleet_pro",
}) as { id: string };
const clientId = carrier.id;

// owner has no chat yet → not a recipient
assert("no recipients before any chat linked", storage.listTelegramRecipientsForClient(clientId).length === 0);

storage.setUserTelegramChatId(owner.id, "1001");
const driver2 = storage.createUser({
  email: `drv-${rnd()}@example.com`,
  fullName: "Driver Two",
  role: "driver",
  passwordSalt: "s",
  passwordHash: "h",
  linkedClientId: clientId,
});
storage.setUserTelegramChatId(driver2.id, "1002");
const blocked = storage.createUser({
  email: `blk-${rnd()}@example.com`,
  fullName: "Blocked Driver",
  role: "driver",
  passwordSalt: "s",
  passwordHash: "h",
  linkedClientId: clientId,
});
storage.setUserTelegramChatId(blocked.id, "1003");
storage.updateUser(blocked.id, { blocked: true });

const recips = storage.listTelegramRecipientsForClient(clientId);
const chatIds = recips.map((r) => r.chatId).sort();
assert("returns linked drivers with chat", chatIds.includes("1001") && chatIds.includes("1002"));
assert("excludes blocked driver", !chatIds.includes("1003"), `got ${chatIds.join(",")}`);
assert("recipient count = 2", recips.length === 2, `got ${recips.length}`);

// --- (d) claimLoadAlert dedup ----------------------------------------------
const lid = `load-${rnd()}`;
assert("first claim succeeds", storage.claimLoadAlert({ loadId: lid, chatId: "1001", clientId, dispatchScore: 88 }));
assert("repeat claim deduped", !storage.claimLoadAlert({ loadId: lid, chatId: "1001", clientId, dispatchScore: 88 }));
assert("different chat claims fresh", storage.claimLoadAlert({ loadId: lid, chatId: "1002", clientId, dispatchScore: 88 }));

// --- (e) notifyMatchedLoad end-to-end with mock send ------------------------
const sentTo: string[] = [];
const realClient = { id: clientId, name: "Push Test LLC" } as unknown as Client;
const scored = makeScored({ id: `load-${rnd()}` });
const deps = {
  listRecipients: (cid: string) => storage.listTelegramRecipientsForClient(cid),
  claim: (loadId: string, chatId: string, cid: string, score: number) =>
    storage.claimLoadAlert({ loadId, chatId, clientId: cid, dispatchScore: score }),
  send: async (chatId: string, _text: string) => {
    sentTo.push(chatId);
    return { ok: true };
  },
};
const r1 = await notifyMatchedLoad(realClient, scored, deps);
assert("notify sent to both recipients", r1.sent === 2, `sent=${r1.sent}`);
assert("notify recorded recipients", r1.recipients === 2);
assert("notify no errors", r1.errors.length === 0, r1.errors.join(";"));

// re-running the SAME load → all deduped, zero re-sends
sentTo.length = 0;
const r2 = await notifyMatchedLoad(realClient, scored, deps);
assert("re-notify same load sends nothing", r2.sent === 0 && sentTo.length === 0);
assert("re-notify marks all skipped", r2.skipped === 2, `skipped=${r2.skipped}`);

// send failure is captured, not thrown
const r3 = await notifyMatchedLoad(realClient, makeScored({ id: `load-${rnd()}` }), {
  ...deps,
  send: async () => ({ ok: false, error: "tg 429" }),
});
assert("send failure captured in errors", r3.errors.length === 2 && r3.sent === 0);

// --- (f) batch digest -------------------------------------------------------
// 3 fresh loads → ONE digest message per recipient (not 3 each).
const batchMsg = formatMatchedLoadsBatchMessage(realClient, [
  makeScored({ id: "b1", dispatchScore: 90, originCity: "Dallas", destinationCity: "Atlanta" }),
  makeScored({ id: "b2", dispatchScore: 75 }),
  makeScored({ id: "b3", dispatchScore: 60 }),
]);
assert("batch: header shows count", batchMsg.includes("3 new matched loads"));
assert("batch: lists a lane", batchMsg.includes("Dallas, TX → Atlanta, GA"));

const sentMsgs: Array<{ chat: string; text: string }> = [];
const batchDeps = {
  listRecipients: (cid: string) => storage.listTelegramRecipientsForClient(cid),
  claim: (loadId: string, chatId: string, cid: string, score: number) =>
    storage.claimLoadAlert({ loadId, chatId, clientId: cid, dispatchScore: score }),
  send: async (chatId: string, text: string) => {
    sentMsgs.push({ chat: chatId, text });
    return { ok: true };
  },
};
const threeFresh = [
  makeScored({ id: `b-${rnd()}`, dispatchScore: 92 }),
  makeScored({ id: `b-${rnd()}`, dispatchScore: 80 }),
  makeScored({ id: `b-${rnd()}`, dispatchScore: 71 }),
];
const rb = await notifyMatchedLoadsBatch(realClient, threeFresh, batchDeps);
assert("batch: one message per recipient", rb.sent === 2 && sentMsgs.length === 2, `sent=${rb.sent} msgs=${sentMsgs.length}`);
assert("batch: message is a digest", sentMsgs.every((m) => m.text.includes("new matched loads")));

// re-run → all (load,chat) deduped → zero messages
sentMsgs.length = 0;
const rb2 = await notifyMatchedLoadsBatch(realClient, threeFresh, batchDeps);
assert("batch: re-run sends nothing (deduped)", rb2.sent === 0 && sentMsgs.length === 0);
assert("batch: re-run skipped = 3 loads × 2 chats", rb2.skipped === 6, `skipped=${rb2.skipped}`);

// a SINGLE fresh load via batch → rich single-load format, not the digest
sentMsgs.length = 0;
const oneFresh = [makeScored({ id: `b-${rnd()}`, dispatchScore: 88 })];
const rb3 = await notifyMatchedLoadsBatch(realClient, oneFresh, batchDeps);
assert("batch: single load → rich format", rb3.sent === 2 && sentMsgs.every((m) => m.text.includes("New load match")));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
