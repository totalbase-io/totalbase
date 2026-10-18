import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { TotalBaseError } from "@totalbase/errors";

/**
 * AES-256-GCM envelope for totalbase.secrets.ciphertext
 * (TotalBase secrets architecture: "Los valores almacenados en
 * totalbase.secrets deben permanecer cifrados", master key from
 * TOTALBASE_MASTER_KEY, "nunca debe almacenarse en PostgreSQL").
 *
 * Stored format: base64(iv[12] || authTag[16] || ciphertext).
 * The master key string (any length, e.g. the base64 value from .env) is
 * SHA-256-hashed to derive a fixed 32-byte AES-256 key - this normalizes
 * key length without needing a separate KDF/salt for a single,
 * operator-provided root key.
 */

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function deriveKey(masterKey: string): Buffer {
  return createHash("sha256").update(masterKey, "utf8").digest();
}

export function encryptSecret(masterKey: string, plaintext: string): string {
  const key = deriveKey(masterKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptSecret(masterKey: string, ciphertext: string): string {
  const key = deriveKey(masterKey);
  let raw: Buffer;
  try {
    raw = Buffer.from(ciphertext, "base64");
  } catch {
    throw new TotalBaseError("SECRET_DECRYPTION_FAILED", "Stored secret is not valid base64.");
  }
  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new TotalBaseError("SECRET_DECRYPTION_FAILED", "Stored secret ciphertext is malformed.");
  }
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    // Wrong TOTALBASE_MASTER_KEY or tampered ciphertext - GCM's auth tag
    // check fails closed rather than returning garbage plaintext.
    throw new TotalBaseError(
      "SECRET_DECRYPTION_FAILED",
      "Could not decrypt stored secret - TOTALBASE_MASTER_KEY may have changed or the ciphertext is corrupted.",
    );
  }
}
