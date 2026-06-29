// integration-config resolver regression test (temp DB, no network).
// Run: npx tsx server/lib/integration-config.test.ts
//
// What this locks in (a teammate is refactoring nearby — these must not regress):
//
//   * requireIntegrationValue returns an INTENTIONALLY-PRESENT empty string ("")
//     WITHOUT throwing. Only `undefined` is "missing". Both getIntegrationValue
//     and requireIntegrationValue test `value === undefined` (integration-config.ts
//     lines 64 & 81), NOT a falsy check. A naive refactor to `if (!value)` would
//     treat a deliberately-blank value (e.g. a Fly secret deliberately set to the
//     empty string) as missing: getIntegrationValue would return undefined and
//     requireIntegrationValue would THROW. That is the regression this guards.
//
//     The reachable source of a "" value is the process.env fallback. (A DB row
//     cannot decrypt to "": encryptSecret("") yields a 16-byte tag-only blob and
//     decryptSecret rejects it via its `length < TAG_LEN + 1` guard — verified —
//     so "" can only arrive through env, which is exactly what we exercise.)
//
//   * getIntegrationValue falls back to process.env[envVar] when no DB row
//     exists, and returns undefined when neither DB nor env has a value.
//
// Determinism: no Date.now-dependent assertions, no real HTTP, unique temp DB
// per run. The 5s in-process cache is sidestepped by using a DISTINCT
// (integrationKey, envVar) pair per scenario and busting the cache explicitly.

import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

// --- MUST be set BEFORE importing storage (better-sqlite3 opens the file on
//     import) and BEFORE the keyring is used. Unique path per run. --------------
process.env.DISPATCHOS_DB_PATH = join(
  tmpdir(),
  `dispatchos-integration-config-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.db`,
);
// A valid 32-byte base64 keyring primary so encryptSecret/decryptSecret work.
// Deterministic 32 bytes (no randomness needed) — round-trips clean base64.
process.env.DISPATCHOS_KEYRING_PRIMARY = Buffer.alloc(32, 7).toString("base64");

const { storage } = await import("../storage");
const { encryptSecret } = await import("./crypto/keyring");
const {
  getIntegrationValue,
  requireIntegrationValue,
  getIntegrationValueSource,
  invalidateIntegrationConfigCache,
} = await import("./integration-config");

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

// Persist an (already-encrypted) value for (integrationKey, envVar).
function storeEncrypted(integrationKey: string, envVar: string, plaintext: string) {
  const enc = encryptSecret(plaintext);
  storage.setIntegrationConfig(integrationKey, envVar, enc, "test-actor");
  // Defensive: the resolver caches for 5s; ensure a fresh read sees the row.
  invalidateIntegrationConfigCache(integrationKey, envVar);
}

const uniq = () => crypto.randomBytes(4).toString("hex");

// ===========================================================================
// 1) REGRESSION GUARD: an intentionally-PRESENT empty string is a real value.
//    A Fly secret deliberately set to "" (no DB override) must come back as ""
//    — getIntegrationValue returns "" (NOT undefined), and
//    requireIntegrationValue must NOT throw.
//
//    PASSES on current code (resolver checks `value === undefined`).
//    WOULD FAIL pre-fix / on a `if (!value)` refactor: "" is falsy, so
//    getIntegrationValue would return undefined and requireIntegrationValue
//    would throw "Integration value missing".
// ===========================================================================
{
  const key = `fmcsa-${uniq()}`;
  const envVar = `EMPTY_TOKEN_${uniq()}`;
  // No DB row for this (key, envVar) — env is the source. Set it to "".
  process.env[envVar] = "";

  const got = getIntegrationValue(key, envVar);
  assert(
    "empty-string: getIntegrationValue returns '' (not undefined)",
    got === "",
    `got=${JSON.stringify(got)}`,
  );

  // The crux: must NOT throw on a present-but-empty value.
  let threw = false;
  let required: string | undefined;
  try {
    required = requireIntegrationValue(key, envVar);
  } catch {
    threw = true;
  }
  assert(
    "empty-string: requireIntegrationValue does NOT throw on present ''",
    threw === false,
  );
  assert(
    "empty-string: requireIntegrationValue returns the present ''",
    required === "",
    `got=${JSON.stringify(required)}`,
  );

  delete process.env[envVar];
}

// ===========================================================================
// 2) Control: a stored NON-empty value round-trips through decryptSecret.
//    (Confirms the empty-string case in (1) isn't passing for a trivial reason
//    like "encryption is broken so everything decrypts to ''".)
// ===========================================================================
{
  const key = `fmcsa-${uniq()}`;
  const envVar = `REAL_TOKEN_${uniq()}`;
  delete process.env[envVar];
  storeEncrypted(key, envVar, "sk_live_real_value");
  assert(
    "non-empty: getIntegrationValue decrypts the stored value",
    getIntegrationValue(key, envVar) === "sk_live_real_value",
  );
  assert(
    "non-empty: requireIntegrationValue returns it",
    requireIntegrationValue(key, envVar) === "sk_live_real_value",
  );
}

// ===========================================================================
// 3) env fallback: no DB row → getIntegrationValue returns process.env[envVar].
//    Guards the documented precedence (DB wins, else env, else undefined).
// ===========================================================================
{
  const key = `twilio-${uniq()}`;
  const envVar = `ONLY_IN_ENV_${uniq()}`;
  process.env[envVar] = "from-fly-secret";
  // No storage row for this (key, envVar) → must fall back to env.
  assert(
    "env-fallback: returns process.env value when no DB row",
    getIntegrationValue(key, envVar) === "from-fly-secret",
  );
  assert(
    "env-fallback: source is 'env' when only env is set",
    getIntegrationValueSource(key, envVar) === "env",
  );
  // requireIntegrationValue is happy with the env value.
  assert(
    "env-fallback: requireIntegrationValue returns env value",
    requireIntegrationValue(key, envVar) === "from-fly-secret",
  );
  delete process.env[envVar];
}

// ===========================================================================
// 4) DB row WINS over env for the same envVar (documented precedence #1).
// ===========================================================================
{
  const key = `fmcsa-${uniq()}`;
  const envVar = `BOTH_SET_${uniq()}`;
  process.env[envVar] = "stale-env-value";
  storeEncrypted(key, envVar, "fresh-db-value");
  assert(
    "precedence: DB row overrides process.env",
    getIntegrationValue(key, envVar) === "fresh-db-value",
  );
  assert(
    "precedence: source is 'db' when both set",
    getIntegrationValueSource(key, envVar) === "db",
  );
  delete process.env[envVar];
}

// ===========================================================================
// 5) Truly missing (no DB row, no env) → undefined, and requireIntegrationValue
//    THROWS. This is the *only* legitimate "missing" case — contrasts directly
//    with the empty-string case in (1) to prove they are treated differently.
// ===========================================================================
{
  const key = `nope-${uniq()}`;
  const envVar = `MISSING_${uniq()}`;
  delete process.env[envVar];
  assert(
    "missing: getIntegrationValue returns undefined",
    getIntegrationValue(key, envVar) === undefined,
  );
  assert(
    "missing: source is 'missing'",
    getIntegrationValueSource(key, envVar) === "missing",
  );
  let threw = false;
  let msg = "";
  try {
    requireIntegrationValue(key, envVar);
  } catch (e) {
    threw = true;
    msg = (e as Error).message;
  }
  assert("missing: requireIntegrationValue THROWS on undefined", threw === true);
  assert(
    "missing: throw message names the missing key/envVar",
    msg.includes(key) && msg.includes(envVar),
    msg,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
