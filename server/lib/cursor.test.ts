// Cursor pagination tests.
// Run: npx tsx server/lib/cursor.test.ts
//
// Covers:
//  1. The opaque cursor codec (encodeCursor/decodeCursor) — round-trip + the
//     tolerant legacy bare-timestamp fallback.
//  2. A deterministic keyset-pagination proof on an in-memory SQLite DB with
//     TIED created_at values: keyset returns every row across page boundaries,
//     while the old single-column `created_at < ?` cursor silently drops the
//     tail of a tied group (the exact bug this change fixes).

import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

// Point storage at a throwaway DB before importing it (module init opens the DB).
process.env.DISPATCHOS_DB_PATH = join(tmpdir(), "dispatchos-cursor-test.db");
const { __cursorInternals } = await import("../storage");
const { encodeCursor, decodeCursor } = __cursorInternals;

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ---------------------------------------------------------------------------
// Codec round-trip + legacy fallback
// ---------------------------------------------------------------------------
{
  const ts = "2026-06-17T12:34:56.789Z";
  const id = "load-abc-123";
  const enc = encodeCursor(ts, id);
  const dec = decodeCursor(enc);
  assert("codec: round-trips orderValue", dec.orderValue === ts, `got ${dec.orderValue}`);
  assert("codec: round-trips tiebreaker", dec.tiebreaker === id, `got ${dec.tiebreaker}`);
  assert("codec: cursor is url-safe", /^[A-Za-z0-9_-]+$/.test(enc), enc);

  // Legacy bare-timestamp cursor (minted before this change) → no tiebreaker.
  const legacy = decodeCursor(ts);
  assert("codec: legacy bare timestamp orderValue", legacy.orderValue === ts);
  assert("codec: legacy bare timestamp tiebreaker null", legacy.tiebreaker === null);

  // A tiebreaker containing the separator-free DOS code shape also round-trips.
  const code = "DOS-AB12-CD34-EF56-GH78-IJ90";
  assert("codec: code tiebreaker round-trips",
    decodeCursor(encodeCursor(ts, code)).tiebreaker === code);
}

// ---------------------------------------------------------------------------
// Keyset vs single-column on TIED timestamps
// ---------------------------------------------------------------------------
{
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (created_at TEXT NOT NULL, id TEXT NOT NULL)");
  // 7 rows: three share t1, three share t2, one alone at t3. Ties straddle the
  // limit=2 page boundaries, so a naive cursor must drop rows.
  const t1 = "2026-01-01T00:00:00.001Z";
  const t2 = "2026-01-01T00:00:00.002Z";
  const t3 = "2026-01-01T00:00:00.003Z";
  const seed: Array<[string, string]> = [
    [t1, "id-a"], [t1, "id-b"], [t1, "id-c"],
    [t2, "id-d"], [t2, "id-e"], [t2, "id-f"],
    [t3, "id-g"],
  ];
  const ins = db.prepare("INSERT INTO t (created_at, id) VALUES (?, ?)");
  for (const [c, i] of seed) ins.run(c, i);
  const allIds = new Set(seed.map(([, i]) => i));

  // --- Keyset pagination (the new behaviour) ---
  function keysetPage(cursor: string | null, limit: number) {
    const where: string[] = [];
    const params: string[] = [];
    if (cursor) {
      const { orderValue, tiebreaker } = decodeCursor(cursor);
      if (tiebreaker !== null) {
        where.push("(created_at < ? OR (created_at = ? AND id < ?))");
        params.push(orderValue, orderValue, tiebreaker);
      } else {
        where.push("created_at < ?");
        params.push(orderValue);
      }
    }
    const sql = `SELECT created_at, id FROM t ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...params, limit + 1) as Array<{ created_at: string; id: string }>;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const next = hasMore && last ? encodeCursor(last.created_at, last.id) : null;
    return { page, next };
  }

  const keysetCollected: string[] = [];
  let cursor: string | null = null;
  let guard = 0;
  do {
    const { page, next } = keysetPage(cursor, 2);
    keysetCollected.push(...page.map((r) => r.id));
    cursor = next;
  } while (cursor && ++guard < 50);

  assert("keyset: returns every row across tied boundaries",
    keysetCollected.length === seed.length && new Set(keysetCollected).size === seed.length,
    `collected ${keysetCollected.length}: ${keysetCollected.join(",")}`);
  assert("keyset: no duplicates",
    keysetCollected.length === new Set(keysetCollected).size);
  assert("keyset: strict created_at DESC, id DESC order",
    keysetCollected.join(",") === "id-g,id-f,id-e,id-d,id-c,id-b,id-a",
    keysetCollected.join(","));
  assert("keyset: covers the full id set", [...allIds].every((i) => keysetCollected.includes(i)));

  // --- Old single-column cursor (the bug): cursor = bare created_at, `< ?` ---
  function oldPage(cursor: string | null, limit: number) {
    const where = cursor ? "WHERE created_at < ?" : "";
    const params = cursor ? [cursor] : [];
    const rows = db.prepare(
      `SELECT created_at, id FROM t ${where} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params, limit + 1) as Array<{ created_at: string; id: string }>;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return { page, next: hasMore && last ? last.created_at : null };
  }

  const oldCollected: string[] = [];
  cursor = null;
  guard = 0;
  do {
    const { page, next } = oldPage(cursor, 2);
    oldCollected.push(...page.map((r) => r.id));
    cursor = next;
  } while (cursor && ++guard < 50);

  // The old cursor drops the tail of each tied group it pages out of.
  assert("regression: old single-column cursor DROPS tied rows",
    new Set(oldCollected).size < seed.length,
    `old returned ${new Set(oldCollected).size}/${seed.length}: ${oldCollected.join(",")}`);

  db.close();
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
