// Audit-log actorId SQL filter tests.
// Run: npx tsx server/lib/audit-actor.test.ts
//
// The actor is denormalized into the audit_events.actor_user_id column, so
// filtering by actorId happens in SQL — total, hasMore and nextCursor must be
// exact (the old JS post-filter made total a per-page approximation and could
// dead-end the cursor mid-stream).

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), "dispatchos-audit-actor-test.db");
const { storage } = await import("../storage");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// Unique actors per run so a persisted temp DB never leaks counts between runs.
const rnd = () => Math.random().toString(36).slice(2, 10);
const actorA = `userA-${rnd()}`;
const actorB = `userB-${rnd()}`;

// 5 events by actorA, 3 by actorB, 2 with no actor.
for (let i = 0; i < 5; i++) storage.audit("test.event", "test", `a-${i}-${rnd()}`, { createdByUserId: actorA });
for (let i = 0; i < 3; i++) storage.audit("test.event", "test", `b-${i}-${rnd()}`, { createdByUserId: actorB });
for (let i = 0; i < 2; i++) storage.audit("test.event", "test", `n-${i}-${rnd()}`, { note: "no actor" });

// ---------------------------------------------------------------------------
// Exact total + correct membership when filtering by actor
// ---------------------------------------------------------------------------
{
  const page = storage.listAuditEventsPaginated({ actorId: actorA, limit: 100 });
  assert("filter: total is exact (5 for actorA)", page.total === 5, `got ${page.total}`);
  assert("filter: returns exactly actorA's events", page.items.length === 5, `got ${page.items.length}`);
  assert("filter: every item is actorA", page.items.every((e) => e.actorUserId === actorA));
  assert("filter: excludes actorB", !page.items.some((e) => e.actorUserId === actorB));
}

// ---------------------------------------------------------------------------
// Accurate keyset pagination within an actor filter (total stays exact, no drops)
// ---------------------------------------------------------------------------
{
  const seen = [];
  let cursor = null;
  let guard = 0;
  do {
    const page = storage.listAuditEventsPaginated({ actorId: actorA, limit: 2, cursor: cursor ?? undefined });
    assert(`paginate: total stays 5 on every page (page ${guard})`, page.total === 5, `got ${page.total}`);
    seen.push(...page.items.map((e) => e.id));
    cursor = page.nextCursor;
    if (++guard > 10) break;
  } while (cursor);
  assert("paginate: walked all 5 of actorA's events", new Set(seen).size === 5, `saw ${new Set(seen).size}`);
  assert("paginate: no duplicates across pages", seen.length === new Set(seen).size);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
