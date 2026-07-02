// Self-serve password reset test (temp DB).
// Run: npx tsx server/lib/password-reset.test.ts
//
// Covers the security invariants of server/routes/password-reset.ts:
// no account-existence oracle, sha256-only token storage, 30-min TTL,
// single-use, supersede-on-new-request, signup password policy reuse,
// and session revocation (session_epoch bump) on completed reset.

import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), `dispatchos-password-reset-test-${Date.now()}.db`);
const { storage } = await import("../storage");
const { hashPassword, verifyPassword } = await import("../auth");
const { forgotPasswordHandler, resetPasswordHandler, issuePasswordResetToken, sha256Hex } =
  await import("../routes/password-reset");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}
const rnd = () => Math.random().toString(36).slice(2, 10);

// Second connection on the same file — for raw-row assertions the storage
// helpers intentionally don't expose.
const rawDb = new Database(process.env.DISPATCHOS_DB_PATH);
const tokenCount = () =>
  (rawDb.prepare("SELECT COUNT(*) AS c FROM password_reset_tokens").get() as { c: number }).c;

function call(
  handler: (req: any, res: any) => unknown,
  body: Record<string, unknown>,
): { status: number; body: any } {
  let captured: { status: number; body: any } = { status: 0, body: null };
  const req: any = { body, ip: "127.0.0.1", headers: {} };
  const res: any = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { captured = { status: this.statusCode, body: payload }; return this; },
  };
  handler(req, res);
  return captured;
}

const OLD_PASSWORD = "OldPassword123!";
const NEW_PASSWORD = "NewPassword456!";
const { salt, hash } = hashPassword(OLD_PASSWORD);
const user = storage.createUser({
  email: `reset-${rnd()}@test.local`,
  fullName: "Reset Test",
  role: "driver",
  passwordSalt: salt,
  passwordHash: hash,
} as any);

// 1. Unknown email → same status + body as known email, and creates NO token.
const before = tokenCount();
const rUnknown = call(forgotPasswordHandler, { email: `nobody-${rnd()}@test.local` });
assert("unknown email -> 200 { ok:true }", rUnknown.status === 200 && rUnknown.body?.ok === true,
  JSON.stringify(rUnknown));
assert("unknown email -> no token row created", tokenCount() === before);

const rKnown = call(forgotPasswordHandler, { email: user.email });
assert("known email -> identical response shape",
  rKnown.status === rUnknown.status && JSON.stringify(rKnown.body) === JSON.stringify(rUnknown.body),
  `${JSON.stringify(rKnown)} vs ${JSON.stringify(rUnknown)}`);
assert("known email -> token row created", tokenCount() === before + 1);

// 2. sha256-only storage: the raw token never lands in the DB row.
const t1 = issuePasswordResetToken(user.id);
const rowRaw = rawDb
  .prepare("SELECT * FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL")
  .get(user.id) as Record<string, unknown>;
assert("stored hash = sha256(raw)", rowRaw?.token_hash === sha256Hex(t1.raw));
assert("raw token absent from DB row", !JSON.stringify(rowRaw).includes(t1.raw));
assert("lookup by hash finds the row",
  storage.findPasswordResetTokenByHash(sha256Hex(t1.raw))?.userId === user.id);

// 3. Requesting a new token invalidates the previous one.
const t2 = issuePasswordResetToken(user.id);
const rOld = call(resetPasswordHandler, { token: t1.raw, newPassword: NEW_PASSWORD });
assert("superseded token rejected 400", rOld.status === 400, JSON.stringify(rOld));

// 4. Weak password rejected by the signup policy — and does NOT consume the token.
const rWeak = call(resetPasswordHandler, { token: t2.raw, newPassword: "short" });
assert("weak password (signup policy min 10) -> 400", rWeak.status === 400, JSON.stringify(rWeak));
assert("weak-password attempt does not burn the token",
  storage.findPasswordResetTokenByHash(sha256Hex(t2.raw))?.usedAt === null);

// 5. Happy path: valid token resets the password + revokes sessions.
const epochBefore = storage.getUserById(user.id)!.sessionEpoch;
const rOk = call(resetPasswordHandler, { token: t2.raw, newPassword: NEW_PASSWORD });
assert("valid token -> 200 { ok:true }", rOk.status === 200 && rOk.body?.ok === true,
  JSON.stringify(rOk));
const fresh = storage.getUserById(user.id)!;
assert("old password stops verifying",
  !verifyPassword(OLD_PASSWORD, fresh.passwordSalt, fresh.passwordHash).ok);
assert("new password verifies",
  verifyPassword(NEW_PASSWORD, fresh.passwordSalt, fresh.passwordHash).ok);
assert("session epoch bumped (all sessions revoked)", fresh.sessionEpoch === epochBefore + 1,
  `epoch ${epochBefore} -> ${fresh.sessionEpoch}`);

// 6. Single-use: the same token again → 400, password unchanged.
const rReplay = call(resetPasswordHandler, { token: t2.raw, newPassword: "AnotherPass789!" });
assert("second use of token -> 400", rReplay.status === 400, JSON.stringify(rReplay));
const afterReplay = storage.getUserById(user.id)!;
assert("replay did not change the password",
  verifyPassword(NEW_PASSWORD, afterReplay.passwordSalt, afterReplay.passwordHash).ok);

// 7. Expired token rejected.
const rawExpired = crypto.randomBytes(32).toString("hex");
storage.createPasswordResetToken({
  userId: user.id,
  tokenHash: sha256Hex(rawExpired),
  expiresAt: new Date(Date.now() - 60_000).toISOString(),
});
const rExpired = call(resetPasswordHandler, { token: rawExpired, newPassword: NEW_PASSWORD });
assert("expired token -> 400", rExpired.status === 400, JSON.stringify(rExpired));

// 8. Garbage / missing token → same generic 400.
const rGarbage = call(resetPasswordHandler, { token: "not-a-real-token", newPassword: NEW_PASSWORD });
assert("unknown token -> 400", rGarbage.status === 400);
const rMissing = call(resetPasswordHandler, { newPassword: NEW_PASSWORD });
assert("missing token -> 400", rMissing.status === 400);
assert("unknown/expired/missing share one generic body",
  JSON.stringify(rGarbage.body) === JSON.stringify(rExpired.body) &&
  JSON.stringify(rMissing.body) === JSON.stringify(rExpired.body));

// 9. Blocked user: forgot still answers { ok:true } but mints no token.
storage.updateUser(user.id, { blocked: true }, user.id);
const beforeBlocked = tokenCount();
const rBlocked = call(forgotPasswordHandler, { email: user.email });
assert("blocked user -> same 200 { ok:true }", rBlocked.status === 200 && rBlocked.body?.ok === true);
assert("blocked user -> no token minted", tokenCount() === beforeBlocked);

rawDb.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
