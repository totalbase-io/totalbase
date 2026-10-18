import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./crypto.js";

const MASTER_KEY = "wBY8Qg4p0oel0wNzEGJjT0lLzQHghHGntGcoO36cbEU=";

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a plaintext value", () => {
    const ciphertext = encryptSecret(MASTER_KEY, "hunter2");
    expect(decryptSecret(MASTER_KEY, ciphertext)).toBe("hunter2");
  });

  it("produces different ciphertext for the same plaintext each time (random IV)", () => {
    const a = encryptSecret(MASTER_KEY, "same-value");
    const b = encryptSecret(MASTER_KEY, "same-value");
    expect(a).not.toBe(b);
    expect(decryptSecret(MASTER_KEY, a)).toBe("same-value");
    expect(decryptSecret(MASTER_KEY, b)).toBe("same-value");
  });

  it("never stores the plaintext as a substring of the ciphertext", () => {
    const ciphertext = encryptSecret(MASTER_KEY, "super-secret-value");
    expect(ciphertext).not.toContain("super-secret-value");
  });

  it("fails closed when decrypting with the wrong master key", () => {
    const ciphertext = encryptSecret(MASTER_KEY, "hunter2");
    expect(() => decryptSecret("a-different-master-key", ciphertext)).toThrow(/decrypt/i);
  });

  it("fails closed on tampered ciphertext (GCM auth tag mismatch)", () => {
    const ciphertext = encryptSecret(MASTER_KEY, "hunter2");
    const tampered = Buffer.from(ciphertext, "base64");
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0xff) & 0xff;
    expect(() => decryptSecret(MASTER_KEY, tampered.toString("base64"))).toThrow(/decrypt/i);
  });

  it("rejects malformed base64/short ciphertext rather than throwing an unrelated error", () => {
    expect(() => decryptSecret(MASTER_KEY, "not-long-enough")).toThrow(/malformed|decrypt/i);
  });

  it("handles empty-string plaintext", () => {
    const ciphertext = encryptSecret(MASTER_KEY, "");
    expect(decryptSecret(MASTER_KEY, ciphertext)).toBe("");
  });

  it("handles Unicode plaintext", () => {
    const ciphertext = encryptSecret(MASTER_KEY, "clave-con-ñ-y-emoji-🔐");
    expect(decryptSecret(MASTER_KEY, ciphertext)).toBe("clave-con-ñ-y-emoji-🔐");
  });
});
