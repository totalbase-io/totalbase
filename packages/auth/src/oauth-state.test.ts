import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { TotalBaseError } from "@totalbase/errors";
import { describe, expect, it, vi } from "vitest";
import { signOAuthState, verifyOAuthState } from "./oauth-state.js";

const MASTER_KEY = "test-master-key-for-oauth-state";

function payload(overrides: Partial<Parameters<typeof signOAuthState>[1]> = {}) {
  return {
    provider: "google",
    codeVerifier: "verifier-123",
    nonce: "nonce-456",
    redirectTo: "https://app.example.com/callback",
    issuedAt: Date.now(),
    browser: "browser-hash",
    ...overrides,
  };
}

describe("OAuth state (sign/verify round trip)", () => {
  it("round-trips exactly what was signed", () => {
    const original = payload();
    const state = signOAuthState(MASTER_KEY, original);
    const verified = verifyOAuthState(MASTER_KEY, state);
    expect(verified).toEqual(original);
  });

  it("rejects a tampered state value", () => {
    const state = signOAuthState(MASTER_KEY, payload());
    const tampered = `${state.slice(0, -4)}abcd`;
    expect(() => verifyOAuthState(MASTER_KEY, tampered)).toThrow(TotalBaseError);
  });

  it("rejects a state signed with a different master key", () => {
    const state = signOAuthState(MASTER_KEY, payload());
    expect(() => verifyOAuthState("a-completely-different-key", state)).toThrow(TotalBaseError);
  });

  it("rejects an expired state", () => {
    vi.useFakeTimers();
    try {
      const state = signOAuthState(MASTER_KEY, payload({ issuedAt: Date.now() }));
      vi.advanceTimersByTime(11 * 60 * 1000); // past the 10-minute TTL
      expect(() => verifyOAuthState(MASTER_KEY, state)).toThrow(TotalBaseError);
    } finally {
      vi.useRealTimers();
    }
  });

  // Security regression (Security.md §2.11, Foundations.md §15): a state in the ciphertext format before the current
  // one still verified - its key is the verifier old settings and backups held, so whoever had one forged a state
  // with any redirectTo and no browser binding.
  it("rejects a state in the format before the current one, even one the old key would open", () => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(MASTER_KEY, "utf8").digest(), iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(payload({ redirectTo: "https://attacker.example" })), "utf8"), cipher.final()]);
    const forged = Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
    expect(() => verifyOAuthState(MASTER_KEY, forged)).toThrow(expect.objectContaining({ code: "INVALID_OAUTH_STATE" }));
  });
});
