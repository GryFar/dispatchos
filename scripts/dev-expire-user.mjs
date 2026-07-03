// Dev-only throwaway helper to test the subscription countdown + expiry gate.
// NOT for commit — local manual testing only.
//
// List users:           node scripts/dev-expire-user.mjs
// Expire a user (past): node scripts/dev-expire-user.mjs driver@example.com
// Set N days left:      node scripts/dev-expire-user.mjs driver@example.com 2
//
// After running, refresh the app as that user:
//   - badge shows "Подписка истекла" (or "N дн." in red if 1-3 left)
//   - any non-GET request (create load, status, upload...) -> 402 subscription_expired
// (getCurrentUser reads fresh from DB each request, so no restart needed; if you
//  hit "database is locked", stop `npm run dev` first, run this, then start again.)

import Database from "better-sqlite3";

const db = new Database(process.env.DISPATCHOS_DB_PATH || "dispatchos-unified.db");
const [email, daysArg] = process.argv.slice(2);

if (!email) {
  console.log("Users (role / email / subscription ends):");
  for (const u of db.prepare("SELECT email, role, subscription_ends_at FROM users ORDER BY role").all()) {
    console.log(`  ${String(u.role).padEnd(10)} ${u.email}  ends=${u.subscription_ends_at ?? "(null = not gated)"}`);
  }
  console.log("\nUsage: node scripts/dev-expire-user.mjs <email> [daysFromNow]   (no days = expired)");
  process.exit(0);
}

const days = daysArg === undefined ? -1 : Number(daysArg);
const endsAt = new Date(Date.now() + days * 86400000).toISOString();
const r = db.prepare("UPDATE users SET subscription_ends_at = ? WHERE email = ?").run(endsAt, email);
console.log(r.changes ? `OK: ${email} -> ends=${endsAt} (${days} day(s) from now)` : `No user with email: ${email}`);
