// connect-sqlite3 has no official @types package as of 2026-05.
// Minimal declaration that matches our usage:
//   import connectSqlite3 from "connect-sqlite3";
//   const SQLiteStore = connectSqlite3(session);
//   new SQLiteStore({ db, dir, table })

declare module "connect-sqlite3" {
  import type session from "express-session";

  interface SQLiteStoreOptions {
    db?: string;
    dir?: string;
    table?: string;
    concurrentDB?: boolean;
  }

  interface SQLiteStoreCtor {
    new (options?: SQLiteStoreOptions): session.Store;
  }

  function connectSqlite3(s: typeof session): SQLiteStoreCtor;

  export default connectSqlite3;
}
