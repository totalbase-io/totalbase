import { describe, expect, it } from "vitest";
import { PASSWORD_MAX_LENGTH, assertPasswordStrength } from "./password.js";

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
