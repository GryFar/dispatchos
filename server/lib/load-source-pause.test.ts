// recordLoadSourcePoll auto-pause transition test (temp DB).
// Run: npx tsx server/lib/load-source-pause.test.ts
//
// A load source must auto-pause after 3 consecutive failures, and the method
// must report the active->paused transition (justPaused) EXACTLY ONCE — on the
// flip — never on subsequent already-paused polls. The cron handler relies on
// this to surface pausedCount / fire a one-shot owner alert.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-ls-pause-${Date.now()}.db`);
const { storage } = await import("../storage");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const src = storage.createLoadSource({ clientId: "c1", adapterKey: "mock", label: "Flaky feed" });

// Two failures: streak grows, still active, no transition yet.
const r1 = storage.recordLoadSourcePoll(src.id, { loadsFound: 0, errorMessage: "boom 1" });
assert("1st failure does not pause", !r1.justPaused);
assert("1st failure: still active", storage.getLoadSource(src.id)?.status === "active");

const r2 = storage.recordLoadSourcePoll(src.id, { loadsFound: 0, errorMessage: "boom 2" });
assert("2nd failure does not pause", !r2.justPaused);
assert("2nd failure: still active", storage.getLoadSource(src.id)?.status === "active");

// Third failure hits the 3-strike threshold → active->paused transition.
const r3 = storage.recordLoadSourcePoll(src.id, { loadsFound: 0, errorMessage: "boom 3" });
assert("3rd failure flips to paused", storage.getLoadSource(src.id)?.status === "paused");
assert("3rd failure reports justPaused=true (the transition)", r3.justPaused === true);
assert("transition carries source id", r3.sourceId === src.id);
assert("transition carries client id", r3.clientId === "c1");
assert("transition carries label", r3.label === "Flaky feed");

// Fourth failure: already paused → MUST NOT re-report the transition.
const r4 = storage.recordLoadSourcePoll(src.id, { loadsFound: 0, errorMessage: "boom 4" });
assert("4th failure (already paused) does NOT re-report justPaused", r4.justPaused === false);
assert("4th failure: still paused", storage.getLoadSource(src.id)?.status === "paused");

// countPausedLoadSources reflects exactly the one paused source.
assert("countPausedLoadSources counts the paused source", storage.countPausedLoadSources() === 1);

// A healthy source that never fails: success poll never pauses / transitions.
const ok = storage.createLoadSource({ clientId: "c1", adapterKey: "mock", label: "Healthy" });
const rOk = storage.recordLoadSourcePoll(ok.id, { loadsFound: 5 });
assert("successful poll does not pause", !rOk.justPaused);
assert("successful poll: stays active", storage.getLoadSource(ok.id)?.status === "active");
assert("still only one paused source total", storage.countPausedLoadSources() === 1);

// latestLoadSourcePollAt returns a heartbeat now that polls have run.
assert("latestLoadSourcePollAt has a heartbeat", typeof storage.latestLoadSourcePollAt() === "string");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
