// saveEmailIngest messageId-dedup tests (temp DB).
// Run: npx tsx server/lib/email-ingest-dedup.test.ts
//
// Locks in the inbound-email idempotency guard: replaying a POST
// /api/inbound/email (or a cron re-parse) must NOT mint a duplicate
// email_ingest row when the email carries a stable Message-ID. Rows without a
// messageId keep the old always-insert behavior.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-email-dedup-${Date.now()}.db`);
const { storage } = await import("../storage");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const base = { from: "loads@sylectus.com", subject: "New posting", body: "hello world load" };

// Same messageId twice → ONE row, same ingest id returned both times.
const first = storage.saveEmailIngest({ ...base, messageId: "<msg-1@sylectus.com>" });
const replay = storage.saveEmailIngest({ ...base, body: "different body on replay", messageId: "<msg-1@sylectus.com>" });
assert("replaying same messageId returns the SAME ingest id", first.id === replay.id, `${first.id} vs ${replay.id}`);
assert(
  "replay does NOT overwrite the original payload",
  replay.body === "hello world load",
  String(replay.body),
);

// Different messageIds → distinct rows.
const second = storage.saveEmailIngest({ ...base, messageId: "<msg-2@sylectus.com>" });
assert("a different messageId yields a DISTINCT ingest id", second.id !== first.id, `${second.id} vs ${first.id}`);

// Missing messageId → always inserts a new row (legacy behavior).
const noId1 = storage.saveEmailIngest({ ...base });
const noId2 = storage.saveEmailIngest({ ...base });
assert("missing messageId still inserts (1st)", typeof noId1.id === "string" && noId1.id.length > 0);
assert("two messageId-less saves yield DISTINCT rows", noId1.id !== noId2.id, `${noId1.id} vs ${noId2.id}`);

// getEmailIngestByMessageId resolves the stored row.
const found = storage.getEmailIngestByMessageId("<msg-1@sylectus.com>");
assert("getEmailIngestByMessageId finds the row", found?.id === first.id, String(found?.id));
assert("getEmailIngestByMessageId misses unknown id", storage.getEmailIngestByMessageId("<nope@x>") === undefined);

// Exactly the right number of rows landed: 2 (with ids) + 2 (without) = 4.
assert("exactly 4 rows persisted (2 unique ids + 2 id-less)", storage.countEmailIngest() === 4, String(storage.countEmailIngest()));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
