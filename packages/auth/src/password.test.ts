import { describe, expect, it } from "vitest";
import { PASSWORD_CHECKS_AT_ONCE, PASSWORD_CHECKS_WAITING, PASSWORD_MAX_LENGTH, assertPasswordStrength, hashPassword, verifyPassword } from "./password.js";

const code = (fn: () => void): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

describe("assertPasswordStrength (Security.md §2.3)", () => {
  it("refuses a password shorter than the minimum", () => {
    expect(code(() => assertPasswordStrength("a1b2c3d4e5", 12))).toBe("PASSWORD_TOO_SHORT");
  });

  it("accepts 128 characters and refuses 129", () => {
    expect(code(() => assertPasswordStrength("x7".repeat(64), 12))).toBeUndefined();
    expect(code(() => assertPasswordStrength("x7".repeat(64) + "y", 12))).toBe("PASSWORD_TOO_LONG");
    expect(PASSWORD_MAX_LENGTH).toBe(128);
  });

  it("refuses a common password, ignoring case", () => {
    expect(code(() => assertPasswordStrength("qwertyuiop", 8))).toBe("PASSWORD_TOO_COMMON");
    expect(code(() => assertPasswordStrength("PassWord1", 8))).toBe("PASSWORD_TOO_COMMON");
  });

  it("accepts an uncommon password of the minimum length", () => {
    expect(code(() => assertPasswordStrength("tb-correct-horse", 12))).toBeUndefined();
  });
});

describe("hashPassword / verifyPassword (Security.md §2.3)", () => {
  // Made by argon2 0.41 (Argon2id, its defaults): what a stored password looks like. Every later argon2 must still
  // verify it - an upgrade never locks anyone out.
  const STORED = "$argon2id$v=19$m=65536,t=3,p=4$VCCAR3VKo/sml3/y7CBhtQ$ZxBqqGK8OA5WmpUTpKOBL78l8AXI5Cwn6qvIFRgd7BI";

  it("verifies a hash stored by an earlier argon2, and only with its password", async () => {
    expect(await verifyPassword(STORED, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(STORED, "correct horse battery stapler")).toBe(false);
  });

  it("hashes with Argon2id and verifies what it hashed", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^\$argon2id\$v=19\$/);
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
  });
});

describe("the password checks a process runs at once (Security.md §2.4)", () => {
  it("queues a burst and refuses only past the queue, then serves again", async () => {
    const hash = await hashPassword("tb-correct-horse");
    const burst = PASSWORD_CHECKS_AT_ONCE + PASSWORD_CHECKS_WAITING + 5;
    const results = await Promise.allSettled(Array.from({ length: burst }, () => verifyPassword(hash, "wrong-password")));
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(5);
    for (const r of refused) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "RATE_LIMIT_EXCEEDED" });
    expect(results.filter((r) => r.status === "fulfilled").every((r) => (r as PromiseFulfilledResult<boolean>).value === false)).toBe(true);
    // Every turn was handed back: the next check runs at once.
    expect(await verifyPassword(hash, "tb-correct-horse")).toBe(true);
  }, 120_000);
});
