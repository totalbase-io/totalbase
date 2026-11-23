import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { TotalBaseError } from "@totalbase/errors";
import { COMMON_PASSWORDS } from "./common-passwords.js";

/**
 * How many Argon2id computations run at once in this process, and how many more may wait (Security.md §2.4). Each one
 * takes a libuv thread (four by default, shared with file and DNS work) and 64 MiB for its duration, and a sign-in
 * costs one whether or not the email exists - so a flood of sign-ins, from any number of addresses, behind a proxy or
 * not, never takes more than this: past it, `429 RATE_LIMIT_EXCEEDED` at once. Always on: no rate limit setting turns
 * it off. A burst of real sign-ins waits its turn - 256 at 2 at a time is a few seconds.
 */
export const PASSWORD_CHECKS_AT_ONCE = 2;
export const PASSWORD_CHECKS_WAITING = 256;

/** Checks admitted - waiting for a turn, running, or admitted ahead by a sign-in: at most AT_ONCE + WAITING. */
let admitted = 0;
/** Checks computing right now: at most AT_ONCE. */
let running = 0;
const waiting: Array<() => void> = [];

/** A password check admitted - a place among the AT_ONCE + WAITING - held until `release()`, called once (more do nothing). */
export interface PasswordCheck {
  release(): void;
}

/**
 * Admits a password check, or refuses it with `429 RATE_LIMIT_EXCEEDED` at once when AT_ONCE + WAITING are admitted. A
 * sign-in is admitted first, before it looks the account up (AuthService.login): a full queue answers every email
 * alike and counts no attempt. Admission holds no turn: a sign-in waiting on the database - its account's row locked -
 * keeps no one else's check from running (SEC-117); it takes one of the AT_ONCE turns only to compute.
 */
export function admitPasswordCheck(): PasswordCheck {
  if (admitted >= PASSWORD_CHECKS_AT_ONCE + PASSWORD_CHECKS_WAITING) {
    throw new TotalBaseError("RATE_LIMIT_EXCEEDED", "Too many sign-ins at once. Please try again in a moment.");
  }
  admitted++;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      admitted--;
    },
  };
}

/** One of the AT_ONCE turns, for the computation alone; handed over by the one finishing, so `running` never drops between them. */
async function inTurn<T>(work: () => Promise<T>): Promise<T> {
  if (running >= PASSWORD_CHECKS_AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
  else running++;
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

/** A check admitted now - or by `check`, when the caller was admitted ahead (a sign-in) - then computed in a turn. */
async function checked<T>(work: () => Promise<T>, check?: PasswordCheck): Promise<T> {
  if (check) return inTurn(work);
  const own = admitPasswordCheck();
  try {
    return await inTurn(work);
  } finally {
    own.release();
  }
}

/** LOCAL passwords use Argon2id. See Security.md §2. */
export async function hashPassword(password: string): Promise<string> {
  return checked(() => argon2.hash(password, { type: argon2.argon2id }));
}

/** Checks a password - admitted now, or under `check` when the caller was admitted ahead (a sign-in is). */
export async function verifyPassword(hash: string, password: string, check?: PasswordCheck): Promise<boolean> {
  return checked(() => argon2.verify(hash, password), check);
}

let timingEqualizer: Promise<string> | undefined;

/**
 * A hash of no one's password, made once per process: what a sign-in refused before its password check verifies
 * against, so it answers in the time a wrong password takes. Made outside the turns - a sign-in holding one waits
 * for it, and one hash per process costs nothing - and a failed one isn't kept: the next caller makes it again.
 */
export function timingEqualizerHash(): Promise<string> {
  timingEqualizer ??= argon2.hash(randomBytes(24).toString("base64url"), { type: argon2.argon2id }).catch((error: unknown) => {
    timingEqualizer = undefined;
    throw error;
  });
  return timingEqualizer;
}

/** The longest password accepted - the ceiling of auth.password_min_length too (Security.md §2.3, ASVS 2.1.2). */
export const PASSWORD_MAX_LENGTH = 128;

const COMMON = new Set(COMMON_PASSWORDS);

/** auth.password_min_length, PASSWORD_MAX_LENGTH and the common-password list, see Security.md §2.3. */
export function assertPasswordStrength(password: string, minLength: number): void {
  // A body without it (or with another JSON type) is a password too short, not a TypeError.
  if (typeof password !== "string" || password.length < minLength) {
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
