import argon2 from "argon2";
import { TotalBaseError } from "@totalbase/errors";
import { COMMON_PASSWORDS } from "./common-passwords.js";

/** LOCAL passwords use Argon2id. See Security.md §2. */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

/** The longest password accepted - the ceiling of auth.password_min_length too (Security.md §2.3, ASVS 2.1.2). */
export const PASSWORD_MAX_LENGTH = 128;

const COMMON = new Set(COMMON_PASSWORDS);

/** auth.password_min_length, PASSWORD_MAX_LENGTH and the common-password list, see Security.md §2.3. */
export function assertPasswordStrength(password: string, minLength: number): void {
  if (password.length < minLength) {
    throw new TotalBaseError(
      "PASSWORD_TOO_SHORT",
      `Password must be at least ${minLength} characters long.`,
    );
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new TotalBaseError(
      "PASSWORD_TOO_LONG",
      `Password must be at most ${PASSWORD_MAX_LENGTH} characters long.`,
    );
  }
  if (COMMON.has(password.toLowerCase())) {
    throw new TotalBaseError(
      "PASSWORD_TOO_COMMON",
      "This password is one of the most commonly used. Choose another.",
    );
  }
}
