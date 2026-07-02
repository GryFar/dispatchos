// Minimal express-session Store on better-sqlite3, replacing connect-sqlite3.
// connect-sqlite3 pulled in the legacy `sqlite3` native driver (node-gyp →
// tar/cacache), which was the source of the entire npm-audit CVE chain. We
// already ship better-sqlite3 for the main DB, so sessions ride the same
// driver on their OWN Database handle / file.
//
// SCHEMA-COMPAT: must read/write the exact table connect-sqlite3 created so
// live sessions survive the swap. Its shape (connect-sqlite3.js v0.9):
//   CREATE TABLE IF NOT EXISTS sessions (sid PRIMARY KEY, expired, sess)
//   expired = ms-epoch number; sess = JSON.stringify(session)
//   get:  WHERE sid = ? AND <now> <= expired
//   set:  expired = now + (cookie.maxAge ?? oneDay), INSERT OR REPLACE
//   touch: expired = cookie.expires, only while not already expired
// Any change to these semantics silently logs out (or worse, revives) users.
import Database from "better-sqlite3";
import session from "express-session";

const ONE_DAY_MS = 86_400_000;

export interface SqliteSessionStoreOptions {
  /** Full path to the sessions db file (e.g. <dataRoot>/sessions.db). */
  dbPath: string;
  /** Table name; must stay "sessions" in prod for schema compat. */
  table?: string;
  /** Expired-row sweep period; connect-sqlite3 swept once a day. */
  cleanupIntervalMs?: number;
}

export class SqliteSessionStore extends session.Store {
  private readonly db: Database.Database;
  private readonly table: string;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(options: SqliteSessionStoreOptions) {
    super();
    this.table = options.table || "sessions";
    if (!/^[A-Za-z0-9_]+$/.test(this.table)) {
      throw new Error(`invalid session table name: ${this.table}`);
    }
    this.db = new Database(options.dbPath);
    // Column types intentionally unspecified — byte-identical DDL to
    // connect-sqlite3 so CREATE IF NOT EXISTS matches the live table.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.table} (sid PRIMARY KEY, expired, sess)`,
    );
    this.cleanup();
    this.cleanupTimer = setInterval(
      () => this.cleanup(),
      options.cleanupIntervalMs ?? ONE_DAY_MS,
    );
    // Never hold the process open just to sweep expired sessions.
    this.cleanupTimer.unref();
  }

  private cleanup(): void {
    try {
      this.db
        .prepare(`DELETE FROM ${this.table} WHERE ? > expired`)
        .run(Date.now());
    } catch (err) {
      console.error("[session-store] cleanup failed:", err);
    }
  }

  get(
    sid: string,
    cb: (err: unknown, session?: session.SessionData | null) => void,
  ): void {
    try {
      const row = this.db
        .prepare(`SELECT sess FROM ${this.table} WHERE sid = ? AND ? <= expired`)
        .get(sid, Date.now()) as { sess: string } | undefined;
      if (!row) return cb(null);
      cb(null, JSON.parse(row.sess) as session.SessionData);
    } catch (err) {
      cb(err);
    }
  }

  set(
    sid: string,
    sess: session.SessionData,
    cb?: (err?: unknown) => void,
  ): void {
    try {
      const maxAge = sess.cookie?.maxAge;
      const expired = Date.now() + (typeof maxAge === "number" ? maxAge : ONE_DAY_MS);
      this.db
        .prepare(`INSERT OR REPLACE INTO ${this.table} VALUES (?, ?, ?)`)
        .run(sid, expired, JSON.stringify(sess));
      cb?.();
    } catch (err) {
      cb?.(err);
    }
  }

  destroy(sid: string, cb?: (err?: unknown) => void): void {
    try {
      this.db.prepare(`DELETE FROM ${this.table} WHERE sid = ?`).run(sid);
      cb?.();
    } catch (err) {
      cb?.(err);
    }
  }

  touch(
    sid: string,
    sess: session.SessionData,
    cb?: (err?: unknown) => void,
  ): void {
    try {
      const expires = sess?.cookie?.expires;
      if (expires) {
        // Only slide expiry on rows that haven't already lapsed — reviving an
        // expired sid would resurrect a logged-out session.
        this.db
          .prepare(
            `UPDATE ${this.table} SET expired = ? WHERE sid = ? AND ? <= expired`,
          )
          .run(new Date(expires).getTime(), sid, Date.now());
      }
      cb?.();
    } catch (err) {
      cb?.(err);
    }
  }

  length(cb: (err: unknown, length?: number) => void): void {
    try {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS count FROM ${this.table}`)
        .get() as { count: number };
      cb(null, row.count);
    } catch (err) {
      cb(err);
    }
  }

  clear(cb?: (err?: unknown) => void): void {
    try {
      this.db.prepare(`DELETE FROM ${this.table}`).run();
      cb?.();
    } catch (err) {
      cb?.(err);
    }
  }

  all(
    cb: (err: unknown, obj?: session.SessionData[] | null) => void,
  ): void {
    try {
      const rows = this.db
        .prepare(`SELECT sess FROM ${this.table}`)
        .all() as Array<{ sess: string }>;
      cb(null, rows.map((r) => JSON.parse(r.sess) as session.SessionData));
    } catch (err) {
      cb(err);
    }
  }

  /** Test hook: stop the sweep timer and release the db file handle. */
  close(): void {
    clearInterval(this.cleanupTimer);
    this.db.close();
  }
}
