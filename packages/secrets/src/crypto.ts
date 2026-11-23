import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { TotalBaseError } from "@totalbase/errors";

/**
 * AES-256-GCM envelope for what TotalBase keeps encrypted - `totalbase.secrets.ciphertext`, a TOTP factor's secret
 * (Foundations.md §15, Security.md §12) - under a key derived from the master key.
 *
 * Stored format: `v3:` + base64(iv[12] || authTag[16] || ciphertext). The key is HKDF-SHA256 of the master key with
 * its own label, so no other value derived from the master key - the verifier the database keeps (masterKeyVerifier),
 * the HMAC keys of signed links - is it, or leads to it. Every ciphertext is bound to its purpose (`CipherPurpose`,
 * GCM's associated data): a secret's to its feature, a factor's, an embed link's, an OAuth state's - so a ciphertext
 * copied by SQL into another column, or another feature's secret, never decrypts there (Security.md §12.3).
 *
 * Two formats before it are read only for the one re-encryption an installation makes the first time it starts with
 * this one (`apps/server/src/master-key.ts`), never written: `v2:` (the same key, no purpose), and no prefix (keyed by
 * a bare SHA-256 of the master key - the value an installation used to keep as its verifier).
 */

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const CURRENT_PREFIX = "v3:";
const UNBOUND_PREFIX = "v2:";
const ENCRYPTION_KEY_LABEL = "totalbase:secrets:aes-256-gcm";
const VERIFIER_LABEL = "totalbase:master-key-verifier:v3";
const UNBOUND_VERIFIER_LABEL = "totalbase:master-key-verifier";

/** What a ciphertext is for - GCM's associated data: one never decrypts as another. */
export type CipherPurpose = `secret:${string}` | "factor" | "embed-link" | "oauth-state";

function encryptionKey(masterKey: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(masterKey, "utf8"), Buffer.alloc(0), ENCRYPTION_KEY_LABEL, 32));
}

function legacyEncryptionKey(masterKey: string): Buffer {
  return createHash("sha256").update(masterKey, "utf8").digest();
}

/**
 * What the database keeps to tell the right master key from a wrong one: an HMAC of a fixed label under the key -
 * it reveals neither the key nor the encryption key, and checking a guess against it means knowing the key.
 */
export function masterKeyVerifier(masterKey: string): string {
  return createHmac("sha256", masterKey).update(VERIFIER_LABEL).digest("hex");
}

/** The verifier an installation kept while its ciphertexts were `v2:` (no purpose) - to recognize it, and move it. */
export function unboundMasterKeyVerifier(masterKey: string): string {
  return createHmac("sha256", masterKey).update(UNBOUND_VERIFIER_LABEL).digest("hex");
}

/**
 * The verifier an installation kept before the current format - the legacy encryption key itself, hex. Only to
 * recognize such an installation (and a backup made by one), which then re-encrypts and replaces it.
 */
export function legacyMasterKeyVerifier(masterKey: string): string {
  return legacyEncryptionKey(masterKey).toString("hex");
}

/** A ciphertext in a format before the current one, to re-encrypt. */
export function isLegacyCiphertext(ciphertext: string): boolean {
  return !ciphertext.startsWith(CURRENT_PREFIX);
}

export function encryptSecret(masterKey: string, plaintext: string, purpose: CipherPurpose): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(masterKey), iv);
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return CURRENT_PREFIX + Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

/**
 * A ciphertext in the current format only. One in the format before is refused, never read: its key is what an
 * installation's settings and backups held as the verifier, so whoever has one of those could forge it (an OAuth
 * `state`, an embed link). The boot's one-time move reads those through decryptLegacySecret.
 */
export function decryptSecret(masterKey: string, ciphertext: string, purpose: CipherPurpose): string {
  if (isLegacyCiphertext(ciphertext)) throw new TotalBaseError("SECRET_DECRYPTION_FAILED", "Stored secret is in a format no longer read.");
  return decryptWith(encryptionKey(masterKey), ciphertext.slice(CURRENT_PREFIX.length), purpose);
}

/** A ciphertext in a format before the current one - only to re-encrypt it, once, at boot (Foundations.md §15). */
export function decryptLegacySecret(masterKey: string, ciphertext: string): string {
  if (!isLegacyCiphertext(ciphertext)) throw new TotalBaseError("SECRET_DECRYPTION_FAILED", "Stored secret is already in the current format.");
  if (ciphertext.startsWith(UNBOUND_PREFIX)) return decryptWith(encryptionKey(masterKey), ciphertext.slice(UNBOUND_PREFIX.length), null);
  return decryptWith(legacyEncryptionKey(masterKey), ciphertext, null);
}

/** Canonical base64 only: whitespace or padding Node's decoder would skip would let one value pass for another. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decryptWith(key: Buffer, body: string, purpose: CipherPurpose | null): string {
  if (!BASE64.test(body)) throw new TotalBaseError("SECRET_DECRYPTION_FAILED", "Stored secret is not valid base64.");
  const raw = Buffer.from(body, "base64");
  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new TotalBaseError("SECRET_DECRYPTION_FAILED", "Stored secret ciphertext is malformed.");
  }
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    if (purpose !== null) decipher.setAAD(Buffer.from(purpose, "utf8"));
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
