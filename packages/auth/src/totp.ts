import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238 over RFC 4226's HOTP): HMAC-SHA1, 6 digits, 30-second steps - what Google Authenticator,
 * Microsoft Authenticator, 1Password, Authy and Bitwarden all read from an `otpauth://` link (Security.md §2.17).
 * `node:crypto` only.
 */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted either side of now - a phone's clock a little off. */
const SKEW_STEPS = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, no padding - the form authenticator apps take a secret in. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("Not base32.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 20 random bytes (RFC 4226's recommended 160 bits), base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The time step `at` falls in. */
export function totpStep(at: number = Date.now()): number {
  return Math.floor(at / 1000 / TOTP_PERIOD_SECONDS);
}

/** HOTP(secret, step) as `TOTP_DIGITS` digits. */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const binary = ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * The step `code` is valid for - now or one step either side - or null. A step at or before `lastUsedStep` is
 * refused (a code is good once: replay). Every candidate is compared in constant time.
 */
export function matchTotp(secret: string, code: string, lastUsedStep: number | null, at: number = Date.now()): number | null {
  const given = code.replace(/\s/g, "");
  if (!/^\d+$/.test(given) || given.length !== TOTP_DIGITS) return null;
  const now = totpStep(at);
  let matched: number | null = null;
  for (let step = now - SKEW_STEPS; step <= now + SKEW_STEPS; step++) {
    const equal = timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(given));
    if (equal && matched === null && (lastUsedStep === null || step > lastUsedStep)) matched = step;
  }
  return matched;
}

/** The `otpauth://` link an authenticator app reads (the QR code's content): `issuer:account`, SHA1, 6 digits, 30 s. */
export function otpauthUrl(input: { secret: string; issuer: string; account: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
