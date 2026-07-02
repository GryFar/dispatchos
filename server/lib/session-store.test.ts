// Tests for the better-sqlite3 express-session store (server/lib/session-store.ts).
// Run: npx tsx server/lib/session-store.test.ts
//
// The store replaced connect-sqlite3, so beyond basic Store semantics the
// critical assertion here is SCHEMA COMPATIBILITY: a table created with
// connect-sqlite3's exact DDL and a row shaped exactly like connect-sqlite3
// wrote it must be readable by the new store — that's the guarantee that live
// sessions survive the dependency swap in production.
//
// Deterministic: temp db files per case, fixed expiry offsets, no HTTP.

import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSessionStore } from "./session-store";
import type { SessionData } from "express-session";

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

function tempDb(tag: string): string {
  return join(
    tmpdir(),
    `dispatchos-sessions-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

// The store's callbacks fire synchronously (better-sqlite3 is sync), so a
// closure capture is populated by the time the call returns.
function getSync(
  store: SqliteSessionStore,
  sid: string,
): { err: unknown; sess: SessionData | null | undefined } {
  let err: unknown = "callback not invoked";
  let sess: SessionData | null | undefined;
  store.get(sid, (e, s) => {
    err = e;
    sess = s;
  });
  return { err, sess };
}

function makeSession(maxAge: number | null, data?: Record<string, unknown>): SessionData {
  return {
    cookie: { originalMaxAge: maxAge, maxAge: maxAge ?? undefined },
    ...data,
  } as unknown as SessionData;
}

// ---------------------------------------------------------------------------
// 1) set/get roundtrip.
// ---------------------------------------------------------------------------
{
  const store = new SqliteSessionStore({ dbPath: tempDb("roundtrip") });
  const sess = makeSession(60_000, { userId: 42, role: "dispatcher" });
  let setErr: unknown = null;
  store.set("sid-1", sess, (e) => (setErr = e));
  assert("set succeeds", setErr == null, String(setErr));

  const got = getSync(store, "sid-1");
  assert("get returns no error", got.err == null, String(got.err));
  assert(
    "get roundtrips session data",
    (got.sess as unknown as { userId?: number })?.userId === 42,
    JSON.stringify(got.sess),
  );
  assert("get of unknown sid returns undefined", getSync(store, "nope").sess === undefined);
  store.close();
}

// ---------------------------------------------------------------------------
// 2) Expired session is treated as missing (get returns undefined, not the
//    stale payload). connect-sqlite3 semantics: row survives until the daily
//    sweep, but get() filters on `now <= expired`.
// ---------------------------------------------------------------------------
{
  const dbPath = tempDb("expired");
  const store = new SqliteSessionStore({ dbPath });
  // maxAge in the past → expired < now the moment it's written.
  store.set("sid-old", makeSession(-1000, { userId: 7 }));
  const got = getSync(store, "sid-old");
  assert("expired session get -> no error", got.err == null, String(got.err));
  assert("expired session get -> undefined", got.sess === undefined, JSON.stringify(got.sess));
  store.close();
}

// ---------------------------------------------------------------------------
// 3) destroy removes the row.
// ---------------------------------------------------------------------------
{
  const store = new SqliteSessionStore({ dbPath: tempDb("destroy") });
  store.set("sid-gone", makeSession(60_000, { userId: 1 }));
  assert("row exists before destroy", getSync(store, "sid-gone").sess !== undefined);
  let destroyErr: unknown = null;
  store.destroy("sid-gone", (e) => (destroyErr = e));
  assert("destroy succeeds", destroyErr == null, String(destroyErr));
  assert("row gone after destroy", getSync(store, "sid-gone").sess === undefined);
  store.close();
}

// ---------------------------------------------------------------------------
// 4) touch extends expiry: write with a short maxAge, touch with a far-future
//    cookie.expires, then verify the raw expired column moved forward.
// ---------------------------------------------------------------------------
{
  const dbPath = tempDb("touch");
  const store = new SqliteSessionStore({ dbPath });
  store.set("sid-touch", makeSession(5_000, { userId: 9 }));

  const before = new Database(dbPath)
    .prepare("SELECT expired FROM sessions WHERE sid = ?")
    .get("sid-touch") as { expired: number };

  const newExpires = new Date(Date.now() + 3_600_000);
  const touched = {
    cookie: { originalMaxAge: 3_600_000, maxAge: 3_600_000, expires: newExpires },
    userId: 9,
  } as unknown as SessionData;
  let touchErr: unknown = null;
  store.touch("sid-touch", touched, (e) => (touchErr = e));
  assert("touch succeeds", touchErr == null, String(touchErr));

  const after = new Database(dbPath)
    .prepare("SELECT expired FROM sessions WHERE sid = ?")
    .get("sid-touch") as { expired: number };
  assert(
    "touch extends the expired column",
    after.expired === newExpires.getTime() && after.expired > before.expired,
    `before=${before.expired} after=${after.expired} want=${newExpires.getTime()}`,
  );
  store.close();
}

// ---------------------------------------------------------------------------
// 5) SCHEMA-COMPAT — the live-session-survival guarantee. Pre-create the table
//    with connect-sqlite3's EXACT DDL and insert a row exactly like
//    connect-sqlite3's set() wrote it (ms-epoch expired, JSON sess). The new
//    store must (a) not fail CREATE IF NOT EXISTS on the existing table and
//    (b) return the legacy session from get().
// ---------------------------------------------------------------------------
{
  const dbPath = tempDb("compat");
  const legacy = new Database(dbPath);
  // Byte-identical to connect-sqlite3.js line 78 (untyped columns, no WAL).
  legacy.exec("CREATE TABLE IF NOT EXISTS sessions (sid PRIMARY KEY, expired, sess)");
  const legacySess = {
    cookie: {
      originalMaxAge: 43_200_000,
      expires: new Date(Date.now() + 43_200_000).toISOString(),
      httpOnly: true,
      sameSite: "strict",
      secure: true,
      path: "/",
    },
    userId: 1337,
    carrierId: 5,
  };
  legacy
    .prepare("INSERT OR REPLACE INTO sessions VALUES (?, ?, ?)")
    .run("legacy-sid", Date.now() + 43_200_000, JSON.stringify(legacySess));
  legacy.close();

  const store = new SqliteSessionStore({ dbPath });
  const got = getSync(store, "legacy-sid");
  assert("compat: get returns no error", got.err == null, String(got.err));
  const s = got.sess as unknown as { userId?: number; carrierId?: number };
  assert(
    "compat: legacy connect-sqlite3 row is readable (live sessions survive)",
    s?.userId === 1337 && s?.carrierId === 5,
    JSON.stringify(got.sess),
  );

  // And the reverse: a row the NEW store writes lands in the same shape
  // (ms-epoch number + JSON string), so a rollback to connect-sqlite3 would
  // also keep sessions alive.
  store.set("new-sid", makeSession(60_000, { userId: 2 }));
  const raw = new Database(dbPath)
    .prepare("SELECT expired, sess FROM sessions WHERE sid = ?")
    .get("new-sid") as { expired: unknown; sess: unknown };
  assert(
    "compat: new store writes ms-epoch expired + JSON sess",
    typeof raw.expired === "number" &&
      raw.expired > Date.now() &&
      typeof raw.sess === "string" &&
      (JSON.parse(raw.sess as string) as { userId?: number }).userId === 2,
    JSON.stringify(raw),
  );
  store.close();
}

// ---------------------------------------------------------------------------
// 6) Cleanup sweep deletes expired rows but keeps live ones (constructor runs
//    one sweep immediately, mirroring connect-sqlite3's dbCleanup-on-connect).
// ---------------------------------------------------------------------------
{
  const dbPath = tempDb("cleanup");
  const seed = new Database(dbPath);
  seed.exec("CREATE TABLE IF NOT EXISTS sessions (sid PRIMARY KEY, expired, sess)");
  seed
    .prepare("INSERT INTO sessions VALUES (?, ?, ?)")
    .run("dead", Date.now() - 1000, JSON.stringify({ cookie: {} }));
  seed
    .prepare("INSERT INTO sessions VALUES (?, ?, ?)")
    .run("alive", Date.now() + 60_000, JSON.stringify({ cookie: {} }));
  seed.close();

  const store = new SqliteSessionStore({ dbPath });
  const rows = new Database(dbPath)
    .prepare("SELECT sid FROM sessions ORDER BY sid")
    .all() as Array<{ sid: string }>;
  assert(
    "startup sweep removed expired row, kept live row",
    rows.length === 1 && rows[0].sid === "alive",
    JSON.stringify(rows),
  );
  let count: number | undefined;
  store.length((_e, n) => (count = n));
  assert("length reports remaining sessions", count === 1, String(count));
  store.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
