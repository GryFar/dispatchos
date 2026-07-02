// Pickup-reminder test (temp DB). Run: npx tsx server/lib/pickup-reminders.test.ts
//
// A cron pings the assigned driver's Telegram before a load's pickup window.
// Verifies: (a) storage.listLoadsDueForPickupReminder windows on pickupAt and
// requires an assigned driver, (b) storage.claimPickupReminder de-dups per
// (load, driver), (c) formatPickupReminderMessage renders a clean reminder,
// (d) notifyPickupReminder sends once, skips on repeat, errors on send failure.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-pickup-rem-${Date.now()}.db`);
const { storage } = await import("../storage");
const { formatPickupReminderMessage, notifyPickupReminder, pickupReminderLeadHours } =
  await import("./load-alerts");
import type { Load } from "@shared/schema";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const rnd = () => Math.random().toString(36).slice(2, 10);

function makeLoad(over: Partial<Load> & { id: string; pickupAt: string }): Load {
  return {
    source: "test",
    originCity: "Dallas",
    originState: "TX",
    originLat: 32.7,
    originLng: -96.8,
    destinationCity: "Atlanta",
    destinationState: "GA",
    destinationLat: 33.7,
    destinationLng: -84.4,
    rate: 2400,
    loadedMiles: 780,
    deliveryAt: "2026-06-21T00:00:00.000Z",
    equipment: "open_car_hauler",
    brokerName: "Acme Broker",
    brokerMc: "MC-100200",
    brokerScore: 80,
    fraudRisk: 5,
    marketQuality: 70,
    ...over,
  } as unknown as Load;
}

const NOW = Date.parse("2026-06-20T12:00:00.000Z");
const inWindow = new Date(NOW + 2 * 3600_000).toISOString();  // +2h (within default 3h)
const outWindow = new Date(NOW + 10 * 3600_000).toISOString(); // +10h (outside)

// --- (c) formatter ----------------------------------------------------------
const fmsg = formatPickupReminderMessage(makeLoad({ id: "f1", pickupAt: inWindow }), inWindow, NOW);
assert("format: shows lane", fmsg.includes("Dallas, TX → Atlanta, GA"));
assert("format: shows 'in 2h'", fmsg.includes("in 2h"), fmsg);
assert("format: shows broker", fmsg.includes("Acme Broker"));
const fnow = formatPickupReminderMessage(makeLoad({ id: "f2", pickupAt: inWindow }), new Date(NOW - 60000).toISOString(), NOW);
assert("format: past pickup → 'now'", fnow.includes("Pickup now"), fnow);
assert("format: lead hours default 3", pickupReminderLeadHours() === 3);

// --- set up carrier + assigned driver with chat -----------------------------
const owner = storage.createUser({
  email: `owner-${rnd()}@example.com`, fullName: "Owner", role: "driver",
  passwordSalt: "s", passwordHash: "h",
});
storage.claimMc(`MC-${Math.floor(100000 + Math.random() * 800000)}`, owner.id);
const carrier = storage.provisionCarrierFromOnboarding(owner.id, {
  persona: "owner_operator", companyName: "Pickup Test LLC", planTier: "fleet_pro",
}) as { id: string };
const driver = storage.createUser({
  email: `drv-${rnd()}@example.com`, fullName: "Driver One", role: "driver",
  passwordSalt: "s", passwordHash: "h", linkedClientId: carrier.id,
});
storage.setUserTelegramChatId(driver.id, "555001");

// loads: assigned+in-window, assigned+out-of-window, in-window+no-driver
storage.upsertLoad(makeLoad({ id: "L_in", pickupAt: inWindow, driverId: driver.id, clientId: carrier.id } as any));
storage.upsertLoad(makeLoad({ id: "L_out", pickupAt: outWindow, driverId: driver.id, clientId: carrier.id } as any));
storage.upsertLoad(makeLoad({ id: "L_nodrv", pickupAt: inWindow, clientId: carrier.id } as any));

// --- (a) window query -------------------------------------------------------
const fromIso = new Date(NOW).toISOString();
const toIso = new Date(NOW + pickupReminderLeadHours() * 3600_000).toISOString();
const due = storage.listLoadsDueForPickupReminder(fromIso, toIso);
const dueIds = due.map((d) => d.load.id).sort();
assert("query: returns the in-window assigned load", dueIds.includes("L_in"));
assert("query: excludes out-of-window load", !dueIds.includes("L_out"), dueIds.join(","));
assert("query: excludes load with no driver", !dueIds.includes("L_nodrv"), dueIds.join(","));
assert("query: exactly one due", due.length === 1, `got ${due.length}`);

// --- (b) claim dedup --------------------------------------------------------
assert("claim: first succeeds", storage.claimPickupReminder({ loadId: "L_in", driverId: driver.id, pickupAt: inWindow }));
assert("claim: repeat deduped", !storage.claimPickupReminder({ loadId: "L_in", driverId: driver.id, pickupAt: inWindow }));
assert("claim: different driver fresh", storage.claimPickupReminder({ loadId: "L_in", driverId: "other", pickupAt: inWindow }));

// --- (d) notify end-to-end (fresh DB row via a new load to avoid the claim above) ---
const sent: string[] = [];
const okDeps = {
  claim: (loadId: string, driverId: string, pickupAt: string) =>
    storage.claimPickupReminder({ loadId, driverId, pickupAt }),
  send: async (chatId: string, _text: string) => { sent.push(chatId); return { ok: true as const }; },
};
const load2 = makeLoad({ id: "L_notify", pickupAt: inWindow, driverId: driver.id } as any);
const o1 = await notifyPickupReminder(load2, driver.id, "555001", inWindow, NOW, okDeps);
assert("notify: first sends", o1 === "sent" && sent.length === 1 && sent[0] === "555001");
const o2 = await notifyPickupReminder(load2, driver.id, "555001", inWindow, NOW, okDeps);
assert("notify: repeat skipped (deduped)", o2 === "skipped");

const load3 = makeLoad({ id: "L_fail", pickupAt: inWindow, driverId: driver.id } as any);
const o3 = await notifyPickupReminder(load3, driver.id, "555001", inWindow, NOW, {
  ...okDeps,
  send: async () => ({ ok: false as const, error: "tg 429" }),
});
assert("notify: send failure → error", o3 === "error");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
