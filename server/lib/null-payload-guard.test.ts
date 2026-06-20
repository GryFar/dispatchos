// Guardrail for the driverId/bookedAt "400-the-dashboard" bug class.
//
// reassignLoadDriver (server/storage.ts) clears a field on unassign by mutating
// the load's JSON payload with RAW SQL — json_set(payload, '$.field', json('null')).
// That write bypasses Zod, so it can persist an explicit null. The read path then
// runs loadFullSchema.parse(load) (server/routes/me.ts, server/routes/dispatch.ts).
// If such a field is declared .optional() (accepts undefined, REJECTS null) the
// parse throws "Expected string, received null" and 400s the entire dispatcher /
// driver dashboard. The fix is .nullish() (accepts undefined AND null).
//
// driverId + bookedAt were the first two offenders. This test fails if either
// regresses to .optional(), OR if a NEW json('null') field is introduced in
// storage.ts without a matching .nullish() in the schema.
//
// Run: npx tsx server/lib/null-payload-guard.test.ts
// Convention mirrors load-reassign.test.ts. NOTE: this is a standalone unit test;
// the HTTP smoke in scripts/smoke.mjs does not pick it up.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { loadFullSchema } from "../../shared/schema";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// 1) Static scan: which load-payload fields does storage.ts null-inject via
//    json_set(..., '$.field', json('null'))? Today this is driverId + bookedAt.
// ---------------------------------------------------------------------------
const thisDir = dirname(fileURLToPath(import.meta.url));
const storageSrc = readFileSync(join(thisDir, "..", "storage.ts"), "utf8");

const nullInjectedFields = new Set<string>();
for (const line of storageSrc.split("\n")) {
  if (!line.includes("json('null')")) continue;
  // Each json('null') line carries the '$.field' path it nulls, e.g.
  //   json_set(payload, '$.driverId', ${... ? "json('null')" : "?"})
  const frags = line.match(/'\$\.([A-Za-z0-9_]+)'/g);
  if (!frags) continue;
  for (const frag of frags) {
    const m = /'\$\.([A-Za-z0-9_]+)'/.exec(frag);
    if (m && m[1]) nullInjectedFields.add(m[1]);
  }
}

// Tripwire: if storage.ts still null-injects but the extractor matched nothing,
// the json_set pattern changed shape — fix the regex above, don't silently pass.
if (storageSrc.includes("json('null')")) {
  assert(
    "static scan extracts >=1 json('null') field (extractor sanity)",
    nullInjectedFields.size >= 1,
    "storage.ts contains json('null') but no '$.field' was parsed — update this test's regex",
  );
}
console.log(`  null-injected load fields: [${Array.from(nullInjectedFields).join(", ")}]`);

// ---------------------------------------------------------------------------
// 2) Schema invariant: loadFullSchema (the read-path validator) MUST accept an
//    explicit null for every null-injected field. .optional() fails this check;
//    .nullish() passes it.
// ---------------------------------------------------------------------------
const validLoad: Record<string, unknown> = {
  id: "L_guard",
  source: "guard",
  originCity: "Dallas", originState: "TX", originLat: 32.7, originLng: -96.8,
  destinationCity: "Phoenix", destinationState: "AZ", destinationLat: 33.4, destinationLng: -112.0,
  rate: 1800, loadedMiles: 1065,
  pickupAt: "2026-01-01T08:00:00.000Z", deliveryAt: "2026-01-02T18:00:00.000Z",
  equipment: "open_car_hauler",
  brokerName: "Guard Broker", brokerMc: "MC-0000",
  brokerScore: 70, fraudRisk: 5, marketQuality: 60,
};

assert("baseline load object is valid", loadFullSchema.safeParse(validLoad).success);

for (const field of Array.from(nullInjectedFields)) {
  const candidate = { ...validLoad, [field]: null };
  const result = loadFullSchema.safeParse(candidate);
  assert(
    `loadFullSchema accepts ${field} === null (must be .nullish, not .optional)`,
    result.success,
    result.success ? undefined : JSON.stringify(result.error.issues),
  );
}

// ---------------------------------------------------------------------------
// 3) End-to-end repro through the real storage layer (temp DB): book then
//    unassign a load — which forces json('null') into the persisted payload —
//    re-read it the way the route does, and parse with loadFullSchema. This is
//    the exact original crash path, not a stand-in.
// ---------------------------------------------------------------------------
process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-null-guard-${Date.now()}.db`);
const { storage } = await import("../storage");

const ld = storage.upsertLoad({ ...validLoad, id: undefined } as any);
storage.reassignLoadDriver(ld.id, null, "drv_guard"); // assign   -> driverId + bookedAt set
storage.reassignLoadDriver(ld.id, "drv_guard", null); // unassign -> json('null') for both

const raw = storage.getLoad(ld.id);
if (!raw) {
  assert("re-read persisted load", false, "storage.getLoad returned undefined");
} else {
  const anyRaw = raw as Record<string, unknown>;
  assert("persisted payload driverId is null after unassign", anyRaw.driverId === null);
  assert("persisted payload bookedAt is null after unassign", anyRaw.bookedAt === null);
  const parsed = loadFullSchema.safeParse(raw);
  assert(
    "loadFullSchema accepts the null-injected persisted payload (no 400)",
    parsed.success,
    parsed.success ? undefined : JSON.stringify(parsed.error.issues),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
