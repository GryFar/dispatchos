// createLoadSource inbound-address auto-provisioning test (temp DB).
// Run: npx tsx server/lib/load-source-inbound.test.ts
//
// Makes the (now-working, zero-API) email source self-serve: creating an email
// load source auto-assigns a unique loads+<token>@<domain> address the carrier
// forwards their broker offers to. Non-email sources get no address; an
// explicitly supplied address is preserved.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-ls-inbound-${Date.now()}.db`);
process.env.DISPATCHOS_INBOUND_DOMAIN = "inbound.test.co";
const { storage } = await import("../storage");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const cfg = (s: any) => (s?.configJson ?? {}) as Record<string, unknown>;

// email adapter, no address provided → auto-generated, unique, uses env domain
const a = storage.createLoadSource({ clientId: "c1", adapterKey: "rxo_email", label: "RXO" });
const addrA = String(cfg(a).inboundAddress ?? "");
assert("email source gets an inbound address", /^loads\+.+@inbound\.test\.co$/.test(addrA), addrA);

const b = storage.createLoadSource({ clientId: "c1", adapterKey: "email_generic", label: "Generic" });
const addrB = String(cfg(b).inboundAddress ?? "");
assert("generic email source also gets one", /^loads\+.+@inbound\.test\.co$/.test(addrB), addrB);
assert("each source gets a DISTINCT address", addrA !== addrB);

// non-email adapter → no inbound address
const m = storage.createLoadSource({ clientId: "c1", adapterKey: "mock", label: "Mock" });
assert("non-email source gets no inbound address", !cfg(m).inboundAddress);

// explicit address is preserved (not clobbered)
const e = storage.createLoadSource({
  clientId: "c1", adapterKey: "tql_email", label: "TQL",
  configJson: { inboundAddress: "loads+custom@my.co", senderDomains: ["tql.com"] },
});
assert("explicit inbound address preserved", cfg(e).inboundAddress === "loads+custom@my.co");
assert("other config preserved", Array.isArray(cfg(e).senderDomains));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
