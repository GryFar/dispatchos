// server/lib/ai-global-cap.test.ts — platform-wide AI kill-switch + daily cap.
// Run: npx tsx server/lib/ai-global-cap.test.ts
//
// Super-audit 2026-07-02 [ai-credit-ddos, HIGH]: every Claude cost control was
// PER-USER (consumeAiQuota 50/day free per user_id), so N self-minted accounts
// multiplied into an unbounded aggregate Claude bill, with no restart-free
// kill-switch. consumeAiQuota now enforces a global daily ceiling
// (DISPATCHOS_AI_GLOBAL_DAILY_CAP) and a kill-switch (DISPATCHOS_AI_KILL),
// BEFORE any per-user spend. These pin that behaviour.

import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const DB_PATH = join(tmpdir(), `dispatchos-ai-global-cap-${Date.now()}-${process.pid}.db`);
process.env.DISPATCHOS_DB_PATH = DB_PATH;
// Start from a known-clean env; each test sets what it needs.
delete process.env.DISPATCHOS_AI_KILL;
delete process.env.DISPATCHOS_AI_GLOBAL_DAILY_CAP;

const { storage } = await import("../storage");

// The platform-wide counter is CUMULATIVE per day and shared across every test
// in this file (one DB). A second connection (WAL-visible after commit, same
// pattern as backup.test.ts) lets cap-sensitive tests start from a known count.
const raw = new Database(DB_PATH);
raw.pragma("busy_timeout = 5000");
function resetGlobalCounter(): void {
  raw.prepare("DELETE FROM ai_usage_global").run();
}

const rnd = () => Math.random().toString(36).slice(2, 10);
function mkUser(): string {
  const u = storage.createUser({
    email: `aicap-${rnd()}@example.com`,
    fullName: "AI Cap",
    role: "driver",
    passwordSalt: "x",
    passwordHash: "y",
  } as Parameters<typeof storage.createUser>[0]);
  return u.id;
}

test("kill-switch: DISPATCHOS_AI_KILL blocks ALL AI spend regardless of per-user quota", () => {
  const u = mkUser();
  // Fresh user has 50 free — normally ok.
  assert.equal(storage.consumeAiQuota(u).ok, true, "baseline free call should pass");
  process.env.DISPATCHOS_AI_KILL = "1";
  try {
    assert.equal(storage.consumeAiQuota(u).ok, false, "kill-switch must refuse");
    assert.equal(storage.consumeAiQuota(mkUser()).ok, false, "kill-switch applies to every user");
  } finally {
    delete process.env.DISPATCHOS_AI_KILL;
  }
  // Lever released → spend resumes.
  assert.equal(storage.consumeAiQuota(u).ok, true, "post-kill call should pass again");
});

test("global cap: aggregate approved calls across DIFFERENT users are capped", () => {
  resetGlobalCounter();
  process.env.DISPATCHOS_AI_GLOBAL_DAILY_CAP = "3";
  try {
    // Three distinct users, each with personal free quota — but the platform
    // ceiling is 3, so exactly 3 approved then everyone is blocked.
    const users = [mkUser(), mkUser(), mkUser(), mkUser()];
    const results = users.map((u) => storage.consumeAiQuota(u).ok);
    const approved = results.filter(Boolean).length;
    assert.equal(approved, 3, `expected 3 approved under cap=3, got ${approved}: ${JSON.stringify(results)}`);
    // A brand-new user with full personal quota is still blocked by the ceiling.
    assert.equal(storage.consumeAiQuota(mkUser()).ok, false, "over-cap call must be refused");
  } finally {
    delete process.env.DISPATCHOS_AI_GLOBAL_DAILY_CAP;
  }
});

test("refund: a maxed-out user's rejected calls do NOT burn the shared ceiling", () => {
  // dailyFree=0 for this user forces the no-free-slot path; with no credits the
  // call is rejected and must REFUND the optimistic global increment, so other
  // users still get the full ceiling.
  resetGlobalCounter();
  process.env.DISPATCHOS_AI_GLOBAL_DAILY_CAP = "2";
  try {
    const attacker = mkUser();
    // 5 rejected attempts (no free slot via dailyFree=0, no credits).
    for (let i = 0; i < 5; i++) {
      assert.equal(storage.consumeAiQuota(attacker, 0).ok, false, "no-quota call rejected");
    }
    // The ceiling is untouched: two legitimate users still get approved.
    assert.equal(storage.consumeAiQuota(mkUser()).ok, true, "legit user 1 within ceiling");
    assert.equal(storage.consumeAiQuota(mkUser()).ok, true, "legit user 2 within ceiling");
    // Third legit call now exceeds cap=2.
    assert.equal(storage.consumeAiQuota(mkUser()).ok, false, "third legit call over cap");
  } finally {
    delete process.env.DISPATCHOS_AI_GLOBAL_DAILY_CAP;
  }
});

test("default cap is generous (does not bite normal usage)", () => {
  // No env set → default 10000. A handful of calls all pass.
  for (let i = 0; i < 5; i++) {
    assert.equal(storage.consumeAiQuota(mkUser()).ok, true, `default-cap call ${i}`);
  }
});

console.log("ai-global-cap: all tests passed");
