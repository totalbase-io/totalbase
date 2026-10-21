import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type pino from "pino";
import type { Database } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";

const SETTINGS_KEY = "system.master_key_verifier";

export function fingerprint(masterKey: string): string {
  // Non-reversible verifier only, per Foundations.md §15.
  // The plaintext master key is never persisted in PostgreSQL.
  return createHash("sha256").update(masterKey, "utf8").digest("hex");
}

/**
 * Validates TOTALBASE_MASTER_KEY against the stored fingerprint.
 * On first run (no fingerprint yet), stores the fingerprint of the
 * provided key. See Foundations.md §15.
 */
export async function assertValidMasterKey(database: Database, masterKey: string): Promise<void> {
  const expected = fingerprint(masterKey);

  const { rows } = await database.query<{ value: string }>(
    `SELECT value FROM totalbase.settings WHERE key = $1`,
    [SETTINGS_KEY],
  );

  const existing = rows[0];
  if (!existing) {
    await database.query(
      `INSERT INTO totalbase.settings (key, value) VALUES ($1, to_jsonb($2::text))`,
      [SETTINGS_KEY, expected],
    );
    return;
  }

  // node-postgres parses jsonb columns automatically; value is the plain string.
  const storedFingerprint = existing.value;
  if (storedFingerprint !== expected) {
    throw new TotalBaseError(
      "INVALID_MASTER_KEY",
      "TOTALBASE_MASTER_KEY does not match the fingerprint recorded for this installation.",
    );
  }
}

/** The shortest key accepted: 32 characters - a generated one is 43 (32 random bytes, base64url). */
export const MASTER_KEY_MIN_LENGTH = 32;

/** Where the key came from - shown, never the key itself. */
export type MasterKeySource = "ENV" | "FILE" | "GENERATED";

/** What the admin shows: the variable, or the file and its path. */
export interface MasterKeyOrigin { source: "ENV" | "FILE"; path: string | null }

/** A key that would be too weak to protect the secrets refuses to start - with the way to get a good one. */
export function assertStrongMasterKey(masterKey: string, origin: string): void {
  if (masterKey.length < MASTER_KEY_MIN_LENGTH) {
    throw new Error(
      `${origin} is ${masterKey.length} characters; it must be at least ${MASTER_KEY_MIN_LENGTH}. ` +
        `A key generated now, on this machine: TOTALBASE_MASTER_KEY=${randomBytes(32).toString("base64url")}`,
    );
  }
}

async function readKeyFile(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The master key (Foundations.md §15): TOTALBASE_MASTER_KEY when set; else the one kept in the data directory
 * (`<dataDir>/master.key`); else - only for an installation that has none yet - a new one, generated and kept
 * there. Never a new key for an installation that already has one: its secrets would become unreadable, so a
 * missing key file with a recorded fingerprint refuses to start. Every key is checked against the fingerprint.
 */
export async function resolveMasterKey(database: Database, envKey: string | undefined, dataDir: string, logger: pino.Logger): Promise<{ masterKey: string; source: MasterKeySource; path: string | null }> {
  if (envKey !== undefined && envKey !== "") {
    assertStrongMasterKey(envKey, "TOTALBASE_MASTER_KEY");
    await assertValidMasterKey(database, envKey);
    return { masterKey: envKey, source: "ENV", path: null };
  }
  const path = join(dataDir, "master.key");
  const stored = await readKeyFile(path);
  if (stored !== null) {
    assertStrongMasterKey(stored, path);
    await assertValidMasterKey(database, stored);
    return { masterKey: stored, source: "FILE", path };
  }
  const { rows } = await database.query(`SELECT 1 FROM totalbase.settings WHERE key = $1`, [SETTINGS_KEY]);
  if (rows.length > 0) {
    throw new TotalBaseError(
      "INVALID_MASTER_KEY",
      `This installation already has a master key, and neither TOTALBASE_MASTER_KEY nor ${path} holds it. ` +
        "Restore the file from your backup (or set the variable) - a new key would leave every stored secret unreadable.",
    );
  }
  const generated = randomBytes(32).toString("base64url");
  await mkdir(dataDir, { recursive: true });
  // Readable by this process only; `wx` never overwrites a file another process wrote meanwhile.
  await writeFile(path, generated + "\n", { mode: 0o600, flag: "wx" });
  await assertValidMasterKey(database, generated);
  logger.warn({ path }, "master key generated - back this file up apart from the database: without it, stored secrets can't be read");
  return { masterKey: generated, source: "GENERATED", path };
}
