// Sylectus adapter window-completeness regression test (temp DB).
// Run: npx tsx server/lib/adapters/sylectus-email.test.ts
//
// Locks the fix in sylectusEmailAdapter.fetchLoads: the pre-fix code fed a
// GLOBAL newest-200 listEmailIngest() page into the per-source filters, so 200+
// newer unrelated emails in a poll window evicted an in-window Sylectus offer
// permanently (rows only get older; purged at 180d). The broker-email adapter
// was fixed to scan the whole window; this pins the same behaviour for Sylectus.
// The buried-offer assertion FAILS on the old newest-200-global code.

import { tmpdir } from "node:os";
import { join } from "node:path";

// Unique temp DB BEFORE importing storage (better-sqlite3 binds the file at
// import time) — mirrors the other adapter tests. No shared/native rebuild.
process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-sylectus-email-${Date.now()}-${process.pid}.db`);

const { storage } = await import("../../storage");
const { sylectusEmailAdapter } = await import("./sylectus-email");
import type { LoadSourceRow } from "./types";

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
const rnd = () => Math.random().toString(36).slice(2, 10);

const INBOX = "loads+syl@dispatchos.co";
function srcRow(): LoadSourceRow {
  return {
    id: `src_${rnd()}`,
    clientId: `cli_${rnd()}`,
    adapterKey: "sylectus_email",
    label: "test",
    status: "active",
    configJson: { inboundAddress: INBOX },
    pollIntervalMin: 60,
  };
}

// A parseable, matched Sylectus posting (mirrors the parser test's canonical
// shape) forwarded to our inbox from a sylectus.com sender. A unique messageId
// avoids the saveEmailIngest idempotency short-circuit; createdAt is stamped
// "now" so it sits inside the 24h lookback window.
function seedSylectus(from: string): string {
  storage.saveEmailIngest({
    from,
    to: INBOX,
    subject: "New Load Posted - Atlanta, GA to Miami, FL - $1850",
    body: [
      "Pickup: 05/20/2026 09:00",
      "Origin: Atlanta, GA 30303",
      "Destination: Miami, FL 33101",
      "Miles: 661",
      "Rate: $1,850",
      "Broker: ACME Logistics (MC# 123456)",
    ].join("\n"),
    messageId: `<${rnd()}@test.local>`,
  });
  return from;
}

// Non-Sylectus noise to the same mailbox: no sylectus sender AND no "sylectus"
// body marker → dropped by sender scoping before it can crowd out a real offer.
function seedNoise(): void {
  storage.saveEmailIngest({
    from: "noise@unrelated.example",
    to: INBOX,
    subject: "Weekly digest",
    body: "Thanks for reading our updates — nothing to see here.",
    messageId: `<${rnd()}@test.local>`,
  });
}

// ---------------------------------------------------------------------------
// Window-completeness: an in-window Sylectus offer buried under >200 NEWER
// unrelated emails must still be found. The pre-fix newest-200-global page
// (cron passes no limit → cap 200) would evict it; the window-complete scan
// finds it. Mirrors the broker-email adapter's window guard.
// ---------------------------------------------------------------------------
{
  const buried = seedSylectus(`alerts+${rnd()}@sylectus.com`);
  // Guarantee the noise is strictly NEWER (created_at has ms precision; a 15ms
  // gap removes any same-millisecond ordering ambiguity).
  await new Promise((r) => setTimeout(r, 15));
  for (let i = 0; i < 220; i++) seedNoise();

  const out = await sylectusEmailAdapter.fetchLoads(srcRow()); // no limit, like the cron poller
  assert(
    "window: in-window Sylectus offer buried under 220 newer noise emails is still found",
    out.some((r) => String(r.from) === buried),
  );
  assert(
    "window: unrelated noise still filtered out",
    !out.some((r) => String(r.from) === "noise@unrelated.example"),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
