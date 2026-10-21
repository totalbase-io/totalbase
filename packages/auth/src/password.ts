import argon2 from "argon2";
import { TotalBaseError } from "@totalbase/errors";

/** LOCAL passwords use Argon2id. See Security.md §2. */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

/** auth.password_min_length, see Administration.md §7.4. */
export function assertPasswordStrength(password: string, minLength: number): void {
  if (password.length < minLength) {
    throw new TotalBaseError(
      "PASSWORD_TOO_SHORT",
      `Password must be at least ${minLength} characters long.`,
    );
  }
}
