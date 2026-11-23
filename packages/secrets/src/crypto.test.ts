import { describe, expect, it } from "vitest";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { decryptLegacySecret, decryptSecret, encryptSecret, isLegacyCiphertext, legacyMasterKeyVerifier, masterKeyVerifier, unboundMasterKeyVerifier } from "./crypto.js";

const P = "secret:WORKFLOWS" as const;

const MASTER_KEY = "wBY8Qg4p0oel0wNzEGJjT0lLzQHghHGntGcoO36cbEU=";

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a plaintext value", () => {
    const ciphertext = encryptSecret(MASTER_KEY, "hunter2", P);
    expect(decryptSecret(MASTER_KEY, ciphertext, P)).toBe("hunter2");
  });

  it("produces different ciphertext for the same plaintext each time (random IV)", () => {
    const a = encryptSecret(MASTER_KEY, "same-value", P);
    const b = encryptSecret(MASTER_KEY, "same-value", P);
    expect(a).not.toBe(b);
    expect(decryptSecret(MASTER_KEY, a, P)).toBe("same-value");
    expect(decryptSecret(MASTER_KEY, b, P)).toBe("same-value");
  });

  it("never stores the plaintext as a substring of the ciphertext", () => {
    const ciphertext = encryptSecret(MASTER_KEY, "super-secret-value", P);
    expect(ciphertext).not.toContain("super-secret-value");
  });

  it("fails closed when decrypting with the wrong master key", () => {
    const ciphertext = encryptSecret(MASTER_KEY, "hunter2", P);
    expect(() => decryptSecret("a-different-master-key", ciphertext, P)).toThrow(/decrypt/i);
  });

  it("fails closed on tampered ciphertext (GCM auth tag mismatch)", () => {
    const ciphertext = encryptSecret(MASTER_KEY, "hunter2", P);
    const tampered = Buffer.from(ciphertext.slice("v3:".length), "base64");
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0xff) & 0xff;
    expect(() => decryptSecret(MASTER_KEY, `v3:${tampered.toString("base64")}`, P)).toThrow(/decrypt/i);
  });

  it("rejects malformed base64/short ciphertext rather than throwing an unrelated error", () => {
    expect(() => decryptSecret(MASTER_KEY, "v3:not-long-enough", P)).toThrow(/malformed|decrypt|base64/i);
    expect(() => decryptSecret(MASTER_KEY, "v3:AAAA", P)).toThrow(/malformed/i);
  });

  it("handles empty-string plaintext", () => {
    const ciphertext = encryptSecret(MASTER_KEY, "", P);
    expect(decryptSecret(MASTER_KEY, ciphertext, P)).toBe("");
  });

  // Security regression (SEC-102): a ciphertext was bound to nothing, so SQL could copy one secret's into another
  // feature's row, or into an embed link the admin lists decrypted - reading any secret without the master key.
  it("decrypts a ciphertext only for the purpose it was made for", () => {
    const ciphertext = encryptSecret(MASTER_KEY, "client-secret", "secret:AUTH_PROVIDERS");
    expect(decryptSecret(MASTER_KEY, ciphertext, "secret:AUTH_PROVIDERS")).toBe("client-secret");
    for (const other of ["secret:SMTP", "secret:WORKFLOWS", "embed-link", "factor", "oauth-state"] as const) {
      expect(() => decryptSecret(MASTER_KEY, ciphertext, other), other).toThrow(expect.objectContaining({ code: "SECRET_DECRYPTION_FAILED" }));
    }
    // Nor a non-canonical spelling of it (whitespace Node's base64 decoder skips, so a trigger sees a "new" value).
    expect(() => decryptSecret(MASTER_KEY, `${ciphertext}\n`, "secret:AUTH_PROVIDERS")).toThrow(/base64/);
  });

  it("handles Unicode plaintext", () => {
    const ciphertext = encryptSecret(MASTER_KEY, "clave-con-ñ-y-emoji-🔐", P);
    expect(decryptSecret(MASTER_KEY, ciphertext, P)).toBe("clave-con-ñ-y-emoji-🔐");
  });
});

// Security regression (Foundations.md §15): the verifier the database keeps was SHA-256 of the master key - the AES
// key itself - so a settings row, a dump or a backup's manifest decrypted every secret.
describe("the master-key verifier", () => {
  const decryptWith = (key: Buffer, ciphertext: string) => {
    const raw = Buffer.from(ciphertext.replace(/^v3:/, ""), "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  };

  it("decrypts nothing: it is not the encryption key, nor what the bare hash of the master key was", () => {
    const ciphertext = encryptSecret(MASTER_KEY, "hunter2", P);
    expect(ciphertext.startsWith("v3:")).toBe(true);
    for (const candidate of [masterKeyVerifier(MASTER_KEY), unboundMasterKeyVerifier(MASTER_KEY), legacyMasterKeyVerifier(MASTER_KEY)]) {
      expect(() => decryptWith(Buffer.from(candidate, "hex"), ciphertext)).toThrow();
    }
    expect(masterKeyVerifier(MASTER_KEY)).not.toBe(legacyMasterKeyVerifier(MASTER_KEY));
    expect(masterKeyVerifier(MASTER_KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(masterKeyVerifier("another-key-of-at-least-thirty-two-chars")).not.toBe(masterKeyVerifier(MASTER_KEY));
  });

  // Security regression (Foundations.md §15): every decryption still read the format before, whose key is the verifier
  // an installation's settings and backups held - so whoever had one forged an OAuth state or read an embed link.
  it("reads a ciphertext of the format before only for the one re-encryption - never as a current one - and never writes one", () => {
    const legacyKey = createHash("sha256").update(MASTER_KEY, "utf8").digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", legacyKey, iv);
    const body = Buffer.concat([cipher.update("old-secret", "utf8"), cipher.final()]);
    const legacy = Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
    expect(isLegacyCiphertext(legacy)).toBe(true);
    expect(() => decryptSecret(MASTER_KEY, legacy, P)).toThrow(expect.objectContaining({ code: "SECRET_DECRYPTION_FAILED" }));
    expect(decryptLegacySecret(MASTER_KEY, legacy)).toBe("old-secret");
    expect(() => decryptLegacySecret(MASTER_KEY, encryptSecret(MASTER_KEY, "x", P))).toThrow();
    expect(isLegacyCiphertext(encryptSecret(MASTER_KEY, "x", P))).toBe(false);
  });
});
