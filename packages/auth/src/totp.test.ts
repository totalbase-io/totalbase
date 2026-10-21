import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateTotpSecret, matchTotp, otpauthUrl, totpCode, totpStep } from "./totp.js";

// RFC 6238 Appendix B's SHA1 seed: the ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP (RFC 6238)", () => {
  it("matches RFC 6238's SHA1 test vectors (last six digits)", () => {
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [seconds, expected] of vectors) {
      expect(totpCode(RFC_SECRET, totpStep(seconds * 1000))).toBe(expected.slice(-6));
    }
  });

  it("round-trips base32 and makes 160-bit secrets", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 255, 7]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });

  it("accepts the current step and one either side, nothing further", () => {
    const at = 1_700_000_000_000;
    const step = totpStep(at);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step), null, at)).toBe(step);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), null, at)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), null, at)).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), null, at)).toBeNull();
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2), null, at)).toBeNull();
  });

  it("refuses a code already used (replay) and anything not six digits", () => {
    const at = 1_700_000_000_000;
    const step = totpStep(at);
    const code = totpCode(RFC_SECRET, step);
    expect(matchTotp(RFC_SECRET, code, step, at)).toBeNull();
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), step - 1, at)).toBeNull();
    expect(matchTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, null, at)).toBe(step);
    expect(matchTotp(RFC_SECRET, "12345", null, at)).toBeNull();
    expect(matchTotp(RFC_SECRET, "abcdef", null, at)).toBeNull();
  });

  it("builds the otpauth link authenticator apps read", () => {
    const link = otpauthUrl({ secret: "JBSWY3DPEHPK3PXP", issuer: "Acme Ops", account: "ana@example.com" });
    const [path, query] = link.split("?");
    expect(decodeURIComponent(path!)).toBe("otpauth://totp/Acme Ops:ana@example.com");
    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({ secret: "JBSWY3DPEHPK3PXP", issuer: "Acme Ops", algorithm: "SHA1", digits: "6", period: "30" });
  });
});
