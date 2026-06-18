// AES-256-GCM keyring tests.
// Run: npx tsx server/lib/crypto/keyring.test.ts
//
// This keyring encrypts integration credentials at rest (load_sources
// credentials_enc, etc.), so the round-trip + tamper-detection + key-mismatch
// guarantees are security-load-bearing. Keys are read from env at call time.

import {
  encryptSecret,
  decryptSecret,
  encryptCredentials,
  decryptCredentials,
  isPrimaryConfigured,
} from "./keyring";

// Two distinct, valid 32-byte keys (base64). Deterministic so the test is
// reproducible; the IV is still randomised per-encrypt inside the module.
process.env.DISPATCHOS_KEYRING_PRIMARY = Buffer.alloc(32, 1).toString("base64");
process.env.DISPATCHOS_KEYRING_SECONDARY = Buffer.alloc(32, 2).toString("base64");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function throws(name: string, fn: () => unknown) {
  try {
    fn();
    assert(name, false, "expected throw");
  } catch {
    assert(name, true);
  }
}

// --- round trip ------------------------------------------------------------
{
  const secret = "hunter2-🚚-pa$$word";
  const enc = encryptSecret(secret);
  assert("keyId is primary", enc.keyId === "primary");
  assert("ciphertext is not the plaintext", !enc.ciphertext.includes(secret));
  assert("round-trips back to plaintext", decryptSecret(enc) === secret);
}

// --- IV randomisation: same plaintext -> different ciphertext --------------
{
  const a = encryptSecret("same");
  const b = encryptSecret("same");
  assert("IV differs per encrypt", a.iv !== b.iv);
  assert("ciphertext differs per encrypt", a.ciphertext !== b.ciphertext);
  assert("both still decrypt", decryptSecret(a) === "same" && decryptSecret(b) === "same");
}

// --- tamper detection (GCM auth tag) --------------------------------------
{
  const enc = encryptSecret("integrity-matters");
  const buf = Buffer.from(enc.ciphertext, "base64");
  buf[0] ^= 0xff; // flip a ciphertext byte
  const tampered = { ...enc, ciphertext: buf.toString("base64") };
  throws("flipped ciphertext byte fails auth", () => decryptSecret(tampered));

  const buf2 = Buffer.from(enc.ciphertext, "base64");
  buf2[buf2.length - 1] ^= 0xff; // flip an auth-tag byte
  throws("flipped auth-tag byte fails auth", () =>
    decryptSecret({ ...enc, ciphertext: buf2.toString("base64") }),
  );
}

// --- key mismatch: decrypting a primary blob as secondary fails -----------
{
  const enc = encryptSecret("primary-only");
  throws("wrong keyId fails to decrypt", () => decryptSecret({ ...enc, keyId: "secondary" }));
}

// --- malformed inputs ------------------------------------------------------
{
  const enc = encryptSecret("x");
  throws("bad IV length", () => decryptSecret({ ...enc, iv: Buffer.alloc(5).toString("base64") }));
  throws("ciphertext too short", () =>
    decryptSecret({ ...enc, ciphertext: Buffer.alloc(3).toString("base64") }),
  );
}

// --- structured credentials helper ----------------------------------------
{
  const creds = { username: "ops@carrier.com", password: "s3cr3t", mc: "MC-123" };
  const enc = encryptCredentials(creds);
  const back = decryptCredentials<typeof creds>(enc);
  assert("credentials round-trip username", back.username === creds.username);
  assert("credentials round-trip password", back.password === creds.password);
  assert("credentials round-trip mc", back.mc === creds.mc);
}

// --- isPrimaryConfigured ---------------------------------------------------
{
  assert("primary configured -> true", isPrimaryConfigured() === true);
  const saved = process.env.DISPATCHOS_KEYRING_PRIMARY;
  delete process.env.DISPATCHOS_KEYRING_PRIMARY;
  assert("primary missing -> false", isPrimaryConfigured() === false);
  throws("encrypt without primary throws", () => encryptSecret("x"));
  process.env.DISPATCHOS_KEYRING_PRIMARY = saved;
}

// --- invalid key length is rejected ---------------------------------------
{
  const saved = process.env.DISPATCHOS_KEYRING_PRIMARY;
  process.env.DISPATCHOS_KEYRING_PRIMARY = Buffer.alloc(16).toString("base64"); // 16 != 32
  throws("16-byte primary key rejected", () => encryptSecret("x"));
  process.env.DISPATCHOS_KEYRING_PRIMARY = saved;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
