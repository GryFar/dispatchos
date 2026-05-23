// AES-256-GCM keyring for at-rest encryption of integration credentials
// (load_sources.credentials_enc, future broker API tokens, etc.).
//
// Why not libsodium / sealedbox: extra native dep for the same security guarantee.
// Why not Vault / KMS: nothing on Fly bare metal that justifies the setup tax yet.
//
// Two slots so we can rotate without downtime:
//   DISPATCHOS_KEYRING_PRIMARY    — base64 of 32 random bytes (required)
//   DISPATCHOS_KEYRING_SECONDARY  — same shape; only used to decrypt older rows
//
// Rotation:
//   1. Generate new key, set old primary as DISPATCHOS_KEYRING_SECONDARY
//   2. Set new key as DISPATCHOS_KEYRING_PRIMARY
//   3. Call rotate() — re-encrypts every secondary-tagged row with primary
//   4. Unset DISPATCHOS_KEYRING_SECONDARY

import crypto from "node:crypto";

const ALGO = "aes-256-gcm" as const;
const IV_LEN = 12;
const TAG_LEN = 16;

export type KeyId = "primary" | "secondary";

export interface EncryptedSecret {
  ciphertext: string; // base64; includes 16-byte auth tag appended
  iv: string;         // base64
  keyId: KeyId;
}

function loadKey(envName: string): Buffer | null {
  const raw = process.env[envName];
  if (!raw) return null;
  try {
    const buf = Buffer.from(raw, "base64");
    if (buf.length !== 32) {
      throw new Error(`${envName} must decode to 32 bytes, got ${buf.length}`);
    }
    return buf;
  } catch (err) {
    throw new Error(`${envName} invalid: ${(err as Error).message}`);
  }
}

function getKey(id: KeyId): Buffer {
  const envName =
    id === "primary"
      ? "DISPATCHOS_KEYRING_PRIMARY"
      : "DISPATCHOS_KEYRING_SECONDARY";
  const key = loadKey(envName);
  if (!key) {
    throw new Error(`Keyring slot '${id}' not configured (${envName} missing)`);
  }
  return key;
}

export function isPrimaryConfigured(): boolean {
  try {
    loadKey("DISPATCHOS_KEYRING_PRIMARY");
    return Boolean(process.env.DISPATCHOS_KEYRING_PRIMARY);
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  const key = getKey("primary");
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([ct, tag]).toString("base64"),
    iv: iv.toString("base64"),
    keyId: "primary",
  };
}

export function decryptSecret(enc: EncryptedSecret): string {
  const key = getKey(enc.keyId);
  const iv = Buffer.from(enc.iv, "base64");
  if (iv.length !== IV_LEN) {
    throw new Error(`IV length invalid: ${iv.length}`);
  }
  const full = Buffer.from(enc.ciphertext, "base64");
  if (full.length < TAG_LEN + 1) {
    throw new Error("ciphertext too short");
  }
  const tag = full.subarray(full.length - TAG_LEN);
  const ct = full.subarray(0, full.length - TAG_LEN);

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Helper for storing structured credentials (e.g. { username, password }).
 * Returns the same shape EncryptedSecret — caller persists three columns.
 */
export function encryptCredentials(obj: Record<string, unknown>): EncryptedSecret {
  return encryptSecret(JSON.stringify(obj));
}

export function decryptCredentials<T = Record<string, unknown>>(enc: EncryptedSecret): T {
  return JSON.parse(decryptSecret(enc)) as T;
}
