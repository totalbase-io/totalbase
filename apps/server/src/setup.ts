import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type pino from "pino";
import type { Database } from "@totalbase/database";
import { hasAdministrator } from "./admin-bootstrap.js";

/**
 * The first-start setup (Foundations.md §14.1): an instance with no administrator, started without
 * TOTALBASE_ADMIN_*, is set up from the browser - or by a program, through POST /api/setup - with a single-use
 * code only someone with access to the server has. The code: TOTALBASE_SETUP_CODE when set, else the one kept
 * in the data directory (stable across restarts), else a new one written there. Gone once an administrator
 * exists.
 */
export const SETUP_CODE_MIN_LENGTH = 16;

export interface SetupState {
  /** The code while the instance has no administrator; null once it has one. */
  code: string | null;
  source: "ENV" | "FILE" | "GENERATED" | null;
  file: string;
}

/** `K7QP-M2XD-9WFA-H4TN`: 16 characters from an alphabet without look-alikes (no 0/O, 1/I/L) - 80 bits. */
function generateCode(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]!);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

/** What a person types and what is stored compare the same: case, dashes and spaces aside. */
function normalize(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

/**
 * `link` is where the instance answers; `linkIsGuess` when it isn't TOTALBASE_PUBLIC_URL but this process's own
 * port - behind Docker or a proxy the address a person opens differs, and the log line says so.
 */
export async function resolveSetup(database: Database, envCode: string | undefined, dataDir: string, logger: pino.Logger, link: string, linkIsGuess = false): Promise<SetupState> {
  const file = join(dataDir, "setup-code");
  if (await hasAdministrator(database)) {
    await rm(file, { force: true });
    return { code: null, source: null, file };
  }
  let code: string;
  let source: SetupState["source"];
  if (envCode) {
    if (envCode.length < SETUP_CODE_MIN_LENGTH) throw new Error(`TOTALBASE_SETUP_CODE is ${envCode.length} characters; it must be at least ${SETUP_CODE_MIN_LENGTH}.`);
    code = envCode;
    source = "ENV";
  } else {
    const stored = await readFile(file, "utf8").then((text) => text.trim(), () => "");
    if (stored) {
      code = stored;
      source = "FILE";
    } else {
      code = generateCode();
      source = "GENERATED";
      await mkdir(dataDir, { recursive: true });
      await writeFile(file, code + "\n", { mode: 0o600 });
    }
  }
  // The one place a code is shown - a person reads the server's log; a program (TOTALBASE_SETUP_CODE) already knows it.
  if (source !== "ENV") {
    // One line: the log is JSON, where a framed banner would read as escaped newlines.
    const url = `${link}/admin/setup?code=${encodeURIComponent(code)}`;
    const hint = linkIsGuess ? " (this process's own port: behind Docker or a proxy, open the same path on the address you published, or set TOTALBASE_PUBLIC_URL)" : "";
    logger.warn({ setupUrl: url }, `TotalBase needs its first administrator - open ${url}${hint}`);
  } else {
    logger.warn("TotalBase needs its first administrator: POST /api/setup with TOTALBASE_SETUP_CODE, or open /admin/setup");
  }
  return { code, source, file };
}

/** The code checked in constant time - never a hint of how much of it matched. */
export function setupCodeMatches(state: SetupState, given: unknown): boolean {
  if (!state.code || typeof given !== "string") return false;
  const a = createHash("sha256").update(normalize(state.code)).digest();
  const b = createHash("sha256").update(normalize(given)).digest();
  return timingSafeEqual(a, b);
}

/** Once set up: the code is gone, from memory and disk. */
export async function finishSetup(state: SetupState): Promise<void> {
  state.code = null;
  await rm(state.file, { force: true });
}
