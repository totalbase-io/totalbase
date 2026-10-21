import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "@totalbase/database";
import { loadMigrationFiles } from "@totalbase/migrations";
import { DATABASE_FILE, FILES_FILE, MANIFEST_FILE, parseManifest, type BackupManifest } from "./manifest.js";
import { pgTool, runCommand } from "./process.js";

export interface RestoreOptions {
  /** The backup's archive - a `.tar` downloaded from Settings › PostgreSQL › Backups, or taken from its destination. */
  archive: string;
  /** The database to restore into - it must be empty. */
  database: Database;
  /** The libpq environment pg_restore connects with (@totalbase/database's postgresClientEnv). */
  clientEnv: Record<string, string>;
  pgBinDir?: string | undefined;
  /** The fingerprint of the master key the restored instance will start with - it must be the backup's. */
  masterKeyVerifier: string;
  /** The image's migrations - a backup that applied one it doesn't have can't be restored by it. */
  migrationsDir: string;
  /** Where the archive is unpacked while restoring. */
  workDir: string;
  /** Each step, as it happens. */
  log: (line: string) => void;
}

/**
 * `totalbase restore <archive>` (Administration.md §12.5): a backup into an
 * empty database, never from a running server. Checked before anything is
 * written: the archive is a TotalBase backup, the master key is the one it
 * was taken with, this image has every migration it applied, PostgreSQL is
 * the same major version or newer, the database is empty and so is the files
 * directory. Then pg_restore in one transaction (all or nothing) and the
 * files; the instance starts on it as usual, migrating what is newer.
 */
export async function restoreBackup(options: RestoreOptions): Promise<BackupManifest> {
  const { database, log } = options;
  await mkdir(options.workDir, { recursive: true });
  const work = await mkdtemp(join(options.workDir, "restore-"));
  try {
    log(`Reading ${options.archive}`);
    await runCommand("tar", ["-xf", options.archive, "-C", work], {});
    const manifest = parseManifest(await readFile(join(work, MANIFEST_FILE), "utf8").catch(() => {
      throw new Error("The archive has no manifest.json - not a TotalBase backup.");
    }));
    log(`Backup of ${manifest.database}, ${manifest.createdAt} - TotalBase ${manifest.totalbaseVersion}, PostgreSQL ${manifest.postgresVersion}`);

    if (manifest.masterKeyVerifier && manifest.masterKeyVerifier !== options.masterKeyVerifier) {
      throw new Error("The master key given (TOTALBASE_MASTER_KEY, or TOTALBASE_DATA_DIR/master.key) is not the one this backup was taken with - the restored secrets couldn't be read. Set the backup's key and run it again.");
    }
    const latest = (await loadMigrationFiles(options.migrationsDir)).at(-1)?.version ?? 0n;
    if (BigInt(manifest.migration) > latest) {
      throw new Error(`The backup applied migration ${manifest.migration}; this image has up to ${latest}. Restore it with TotalBase ${manifest.totalbaseVersion} or newer.`);
    }
    const { rows } = await database.query<{ version: string; objects: string }>(
      `SELECT current_setting('server_version_num') AS version,
              (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%') AS objects`,
    );
    const target = Number(rows[0]!.version);
    if (Math.floor(target / 10_000) < Math.floor(manifest.postgresVersionNum / 10_000)) {
      throw new Error(`The backup was taken from PostgreSQL ${manifest.postgresVersion}; restore it into that major version or a newer one, not ${Math.floor(target / 10_000)}.`);
    }
    if (Number(rows[0]!.objects) > 0) {
      throw new Error("The database isn't empty - restore into a new, empty database (CREATE DATABASE), never over one in use.");
    }
    if (manifest.files) {
      const present = await readdir(manifest.filesPath).catch(() => []);
      if (present.length > 0) throw new Error(`The files directory ${manifest.filesPath} isn't empty - restore into an empty one.`);
    }

    log("Restoring the database (pg_restore, one transaction)");
    // Owned by the role restoring it: never an ALTER OWNER to a role that may not exist here, nor SUPERUSER.
    await runCommand(pgTool("pg_restore", options.pgBinDir), ["--no-owner", "--exit-on-error", "--single-transaction", "--no-password", `--dbname=${options.clientEnv["PGDATABASE"] ?? ""}`, join(work, DATABASE_FILE)], options.clientEnv);

    // The dump was taken while this backup ran: it is the one restored, the rest that were under way never finished.
    await database.query(
      `UPDATE totalbase.backups SET status = CASE WHEN id = $1 THEN 'COMPLETED' ELSE 'FAILED' END,
              error = CASE WHEN id = $1 THEN NULL ELSE 'Interrupted by a restore.' END,
              manifest = CASE WHEN id = $1 THEN $2::jsonb ELSE manifest END,
              completed_at = coalesce(completed_at, now()), locked_at = NULL, locked_by = NULL
       WHERE status IN ('PENDING', 'RUNNING')`,
      [manifest.backup, JSON.stringify(manifest)],
    );

    if (manifest.files) {
      log(`Restoring the files into ${manifest.filesPath}`);
      await mkdir(manifest.filesPath, { recursive: true });
      await runCommand("tar", ["-xf", join(work, FILES_FILE), "-C", manifest.filesPath], {});
    }
    log("Restored. Start TotalBase with the same master key: it applies any newer migration on its way up.");
    return manifest;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
