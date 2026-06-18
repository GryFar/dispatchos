// Invoice de-duplication test.
// Run: npx tsx server/lib/invoice-dedup.test.ts
//
// "One invoice per client per week" is now enforced by a UNIQUE(client_id,
// week_start) index (the app-level pre-check is TOCTOU-racy). This locks that
// guarantee in so a concurrent generate can never double-bill a carrier.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), "dispatchos-invoice-dedup-test.db");
const { storage } = await import("../storage");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const rnd = () => Math.random().toString(36).slice(2, 10);
const clientId = `inv-client-${rnd()}`;
const base = {
  clientId,
  weekStart: "2026-01-05",
  weekEnd: "2026-01-11",
  flatFee: 150,
  percentFee: 30,
  grossBooked: 1000,
};

const inv1 = storage.createInvoice({ ...base });
assert("first invoice for (client, week) is created", !!inv1?.id, JSON.stringify(inv1));

let threw = false;
try {
  storage.createInvoice({ ...base }); // same client + week -> must be rejected
} catch {
  threw = true;
}
assert("duplicate (client, week) invoice is rejected (no double-billing)", threw);

const inv2 = storage.createInvoice({ ...base, weekStart: "2026-01-12", weekEnd: "2026-01-18" });
assert("a different week for the same client is allowed", !!inv2?.id && inv2.id !== inv1.id);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
