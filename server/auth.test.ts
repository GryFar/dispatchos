// ===========================================================================
// server/auth.test.ts — password hashing migration (Audit High #10)
// ===========================================================================

import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";

import {
  hashPassword,
  verifyPassword,
  CURRENT_PBKDF2_ITERATIONS,
} from "./auth";

test("hashPassword writes the new prefixed format", () => {
  const { salt, hash } = hashPassword("hunter2");
  assert.match(hash, /^pbkdf2\$\d+\$[0-9a-f]{64}$/);
  const parts = hash.split("$");
  assert.equal(Number(parts[1]), CURRENT_PBKDF2_ITERATIONS);
  assert.equal(typeof salt, "string");
  assert.ok(salt.length >= 16);
});

test("verifyPassword accepts the new format and doesn't ask for rehash", () => {
  const { salt, hash } = hashPassword("hunter2");
  const r = verifyPassword("hunter2", salt, hash);
  assert.equal(r.ok, true);
  assert.equal(r.needsRehash, false);

  const wrong = verifyPassword("Hunter2", salt, hash);
  assert.equal(wrong.ok, false);
});

test("verifyPassword accepts legacy 210k bare-hex and asks for rehash", () => {
  const salt = crypto.randomBytes(16).toString("hex");
  const legacyHash = crypto
    .pbkdf2Sync("legacy-pw", salt, 210_000, 32, "sha256")
    .toString("hex");
  assert.equal(legacyHash.length, 64);

  const r = verifyPassword("legacy-pw", salt, legacyHash);
  assert.equal(r.ok, true);
  assert.equal(r.needsRehash, true);

  const wrong = verifyPassword("wrong-pw", salt, legacyHash);
  assert.equal(wrong.ok, false);
});

test("verifyPassword rejects malformed hashes safely", () => {
  const salt = crypto.randomBytes(16).toString("hex");
  // Wrong prefix
  assert.equal(verifyPassword("x", salt, "argon2id$3$xxx").ok, false);
  // Missing parts
  assert.equal(verifyPassword("x", salt, "pbkdf2$600000").ok, false);
  // Bad iteration count
  assert.equal(verifyPassword("x", salt, "pbkdf2$abc$" + "f".repeat(64)).ok, false);
  // Too-low iterations
  assert.equal(verifyPassword("x", salt, "pbkdf2$1000$" + "f".repeat(64)).ok, false);
  // Garbage
  assert.equal(verifyPassword("x", salt, "garbage").ok, false);
});
