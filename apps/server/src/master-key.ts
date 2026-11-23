import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type pino from "pino";
import type { Database, Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { decryptLegacySecret, encryptSecret, isLegacyCiphertext, legacyMasterKeyVerifier, masterKeyVerifier, unboundMasterKeyVerifier, type CipherPurpose } from "@totalbase/secrets";

const SETTINGS_KEY = "system.master_key_verifier";

/**
 * In the data directory, never the database: this installation holds only the current ciphertext format. Once it is
 * there, a database whose verifier says otherwise is refused rather than moved - SQL could set an old verifier back and
 * plant an old ciphertext for the move to bind to a purpose of its choosing (Foundations.md §15). `totalbase restore`
 * removes it: a restored backup is the one legitimate way back to an older format.
 */
export const FORMAT_MARKER = "ciphertext-format";
const CURRENT_FORMAT = "v3";

async function readMarker(dataDir: string): Promise<string | null> {
  try {
    return (await readFile(join(dataDir, FORMAT_MARKER), "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeMarker(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, FORMAT_MARKER), `${CURRENT_FORMAT}\n`, { mode: 0o600 });
}

/** The verifier a key is recorded and checked by (`@totalbase/secrets`' masterKeyVerifier, Foundations.md §15) - never the key, never what it encrypts with. */
export function fingerprint(masterKey: string): string {
  return masterKeyVerifier(masterKey);
}

/** Every verifier the key may be recorded by: the current one, and the ones an installation (or its backup) kept before it. */
export function acceptedFingerprints(masterKey: string): string[] {
  return [masterKeyVerifier(masterKey), unboundMasterKeyVerifier(masterKey), legacyMasterKeyVerifier(masterKey)];
}

/**
 * Validates the master key against the recorded verifier; on first run (none yet) records it (Foundations.md §15).
 * An installation that recorded the verifier of a format before - `v2:`'s (ciphertexts bound to no purpose), or the
 * encryption key itself, readable in its settings and its backups - is moved to the current format here, once, in
 * one transaction: every stored ciphertext re-encrypted bound to its purpose (a secret's feature, a TOTP factor, an
 * embed link), then the new verifier recorded. After it, nothing but the current format is ever read.
 */
export async function assertValidMasterKey(database: Database, masterKey: string, logger?: pino.Logger, dataDir?: string): Promise<void> {
  const current = masterKeyVerifier(masterKey);
  const { rows } = await database.query<{ value: string }>(`SELECT value #>> '{}' AS value FROM totalbase.settings WHERE key = $1`, [SETTINGS_KEY]);
  const stored = rows[0]?.value;
  if (stored === undefined) {
    await database.query(`INSERT INTO totalbase.settings (key, value) VALUES ($1, to_jsonb($2::text)) ON CONFLICT (key) DO NOTHING`, [SETTINGS_KEY, current]);
    if (dataDir) await writeMarker(dataDir);
    return;
  }
  if (stored === current) {
    // A data directory that can't be written (read-only) still starts: the database is current, nothing to move.
    if (dataDir) {
      try {
        if ((await readMarker(dataDir)) === null) await writeMarker(dataDir);
      } catch (error) {
        logger?.warn({ error }, "could not record the ciphertext format in the data directory - an old verifier set back in the database would be moved again");
      }
    }
    return;
  }
  if (stored === unboundMasterKeyVerifier(masterKey) || stored === legacyMasterKeyVerifier(masterKey)) {
    if (dataDir && (await readMarker(dataDir)) === CURRENT_FORMAT) {
      throw new TotalBaseError(
        "INVALID_MASTER_KEY",
        `The database records an older ciphertext format than this installation, which moved already (${join(dataDir, FORMAT_MARKER)}). Restore a backup with \`totalbase restore\`; to move this database anyway, remove that file and start again.`,
      );
    }
    const moved = await reencryptStoredSecrets(database, masterKey, current);
    if (dataDir) await writeMarker(dataDir);
    logger?.warn(moved, "stored secrets re-encrypted under the current format and the master key verifier replaced - backups made before today hold the old verifier, from which those secrets could be decrypted: treat them as sensitive as the key, or rotate the secrets");
    return;
  }
  throw new TotalBaseError("INVALID_MASTER_KEY", "TOTALBASE_MASTER_KEY does not match the fingerprint recorded for this installation.");
}

async function reencryptStoredSecrets(database: Database, masterKey: string, verifier: string): Promise<{ secrets: number; factors: number; embeds: number; unreadable: number }> {
  return database.transaction(async (client: Queryable) => {
    // One process moves it; another starting at once waits, then finds it done.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('totalbase.master_key_format'))`);
    const { rows: [recorded] } = await client.query<{ value: string }>(`SELECT value #>> '{}' AS value FROM totalbase.settings WHERE key = $1 FOR UPDATE`, [SETTINGS_KEY]);
    if (recorded?.value === verifier) return { secrets: 0, factors: 0, embeds: 0, unreadable: 0 };
    const reencrypt = async (table: "secrets" | "factors" | "dashboards_embeds", column: "ciphertext" | "secret" | "link_ciphertext", purposeOf: (row: { scope: string | null }) => CipherPurpose) => {
      const scope = table === "secrets" ? "scope" : "NULL::text";
      const { rows } = await client.query<{ id: string; value: string; scope: string | null }>(`SELECT id, ${column} AS value, ${scope} AS scope FROM totalbase.${table} WHERE ${column} IS NOT NULL FOR UPDATE`);
      let count = 0;
      for (const row of rows) {
        if (!isLegacyCiphertext(row.value)) continue;
        let plaintext: string;
        try {
          plaintext = decryptLegacySecret(masterKey, row.value);
        } catch {
          // Already unreadable with this key (written under another one): left as it is, counted, never a reason not to start.
          unreadable += 1;
          continue;
        }
        await client.query(`UPDATE totalbase.${table} SET ${column} = $2 WHERE id = $1`, [row.id, encryptSecret(masterKey, plaintext, purposeOf(row))]);
        count += 1;
      }
      return count;
    };
    let unreadable = 0;
    const secrets = await reencrypt("secrets", "ciphertext", (row) => `secret:${row.scope}`);
    const factors = await reencrypt("factors", "secret", () => "factor");
    const embeds = await reencrypt("dashboards_embeds", "link_ciphertext", () => "embed-link");
    await client.query(`UPDATE totalbase.settings SET value = to_jsonb($2::text) WHERE key = $1`, [SETTINGS_KEY, verifier]);
    return { secrets, factors, embeds, unreadable };
  });
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
    await assertValidMasterKey(database, envKey, logger, dataDir);
    return { masterKey: envKey, source: "ENV", path: null };
  }
  const path = join(dataDir, "master.key");
  const stored = await readKeyFile(path);
  if (stored !== null) {
    assertStrongMasterKey(stored, path);
    await assertValidMasterKey(database, stored, logger, dataDir);
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
  await assertValidMasterKey(database, generated, logger, dataDir);
  logger.warn({ path }, "master key generated - back this file up apart from the database: without it, stored secrets can't be read");
  return { masterKey: generated, source: "GENERATED", path };
}
