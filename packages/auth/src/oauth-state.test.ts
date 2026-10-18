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
});
