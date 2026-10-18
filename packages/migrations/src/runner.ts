import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Database, Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";

/**
 * The COMMENT that marks the `totalbase` schema as TotalBase's own
 * (Specification.md §14, step 3) - stamped when the runner creates the
 * schema.
 */
export const TOTALBASE_SCHEMA_MARKER = "TotalBase internal schema - managed by TotalBase migrations.";

/**
 * Refuses to migrate a `totalbase` schema that isn't TotalBase's
 * (Specification.md §14, step 3). It is TotalBase's when it carries the
 * marker, or TotalBase's migration ledger (an install from before the
 * marker, or one whose schema another role owns and so couldn't be
 * stamped). An empty schema - pre-created for TotalBase by a DBA - is
 * adopted. Anything else holds someone else's objects:
 * TOTALBASE_SCHEMA_CONFLICT, before a single statement runs in it.
 */
export async function assertTotalBaseSchemaOwnership(database: Queryable): Promise<void> {
  const { rows } = await database.query<{ marker: string | null; has_ledger: boolean; has_objects: boolean }>(
    `SELECT obj_description(n.oid, 'pg_namespace') AS marker,
            EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p')
                      AND c.relname = 'migrations') AS has_ledger,
            EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid)
              OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = n.oid)
              OR EXISTS (SELECT 1 FROM pg_type t WHERE t.typnamespace = n.oid) AS has_objects
     FROM pg_namespace n
     WHERE n.nspname = 'totalbase'`,
  );
  const schema = rows[0];
  if (!schema || schema.marker === TOTALBASE_SCHEMA_MARKER || schema.has_ledger || !schema.has_objects) return;
  throw new TotalBaseError(
    "TOTALBASE_SCHEMA_CONFLICT",
    "The database already has a schema named \"totalbase\" that TotalBase did not create: it holds objects but neither " +
      "TotalBase's ownership marker (its COMMENT) nor TotalBase's migration ledger (totalbase.migrations). " +
      "TotalBase reserves this schema and will not migrate someone else's - rename or drop that schema, or point " +
      "POSTGRES_DB at another database.",
  );
}

/**
 * Bootstrap DDL for the migration ledger itself.
 * This runs unconditionally before any tracked migration, because
 * totalbase.migrations must exist before it can track anything.
 * See Specification.md §16 and section 52.
 */
const BOOTSTRAP_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'totalbase') THEN
    CREATE SCHEMA totalbase;
    COMMENT ON SCHEMA totalbase IS '${TOTALBASE_SCHEMA_MARKER}';
  END IF;

  CREATE TABLE IF NOT EXISTS totalbase.migrations (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    version           bigint NOT NULL UNIQUE,
    name              text NOT NULL,
    checksum          text NOT NULL,
    totalbase_version text NOT NULL,
    applied_at        timestamptz NOT NULL DEFAULT now()
  );

  COMMENT ON TABLE totalbase.migrations IS 'The migrations applied to this schema, in order, with each file''s checksum. Rows are never changed: a published migration is never rewritten.';
END
$$;
`;

export interface MigrationFile {
  version: bigint;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

const MIGRATION_FILENAME_PATTERN = /^(\d{6})_([a-z0-9_]+)\.sql$/;

/** Reads and parses migration files from a directory, sorted by version ascending. */
export async function loadMigrationFiles(migrationsDir: string): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir);
  const files: MigrationFile[] = [];

  for (const filename of entries.sort()) {
    const match = MIGRATION_FILENAME_PATTERN.exec(filename);
    if (!match) continue;
    const [, versionStr, name] = match;
    const sql = await readFile(join(migrationsDir, filename), "utf8");
    files.push({
      version: BigInt(versionStr!),
      name: name!,
      filename,
      sql,
      checksum: checksumOf(sql),
    });
  }

  files.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  return files;
}

/** A standard SQL string literal (single quotes doubled) - for the ledger row's trusted values only. */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export interface RunMigrationsOptions {
  migrationsDir: string;
  totalbaseVersion: string;
}

export interface RunMigrationsResult {
  applied: string[];
  alreadyApplied: string[];
  /** What a migration applied now said (`RAISE NOTICE`) - a migration's report of what it changed or left out. */
  notices: { migration: string; message: string }[];
}

/**
 * Applies pending migrations in order, inside one transaction per migration.
 * Published migrations are immutable: checksum mismatches abort with
 * MIGRATION_CHECKSUM_MISMATCH (Specification.md §16).
 */
export async function runMigrations(
  database: Database,
  options: RunMigrationsOptions,
): Promise<RunMigrationsResult> {
  await assertTotalBaseSchemaOwnership(database);
  await database.query(BOOTSTRAP_SQL);

  const files = await loadMigrationFiles(options.migrationsDir);
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  const notices: RunMigrationsResult["notices"] = [];

  const { rows: existing } = await database.query<{
    version: string;
    checksum: string;
  }>("SELECT version, checksum FROM totalbase.migrations ORDER BY version ASC");
  const existingByVersion = new Map(existing.map((row) => [row.version, row.checksum]));

  for (const file of files) {
    const existingChecksum = existingByVersion.get(file.version.toString());

    if (existingChecksum !== undefined) {
      if (existingChecksum !== file.checksum) {
        throw new TotalBaseError(
          "MIGRATION_CHECKSUM_MISMATCH",
          `Checksum mismatch for already-applied migration ${file.filename}. ` +
            `Published migrations are immutable; do not edit applied migration files.`,
        );
      }
      alreadyApplied.push(file.filename);
      continue;
    }

    // A migration file is a script - several statements - so it runs over
    // the simple query protocol (transactionRaw), the one other caller
    // besides the SQL Console (Specification.md §18): every other query is
    // the extended protocol, which accepts one statement. The ledger row's
    // values are the file's own version/name/checksum (pattern-checked
    // above) and the server's version string, quoted as literals.
    await database.transactionRaw(async (client) => {
      const result = await client.queryRaw(file.sql);
      for (const notice of result.notices) notices.push({ migration: file.filename, message: notice.message });
      await client.queryRaw(
        `INSERT INTO totalbase.migrations (version, name, checksum, totalbase_version)
         VALUES (${file.version.toString()}, ${sqlLiteral(file.name)}, ${sqlLiteral(file.checksum)}, ${sqlLiteral(options.totalbaseVersion)})`,
      );
    });

    applied.push(file.filename);
  }

  return { applied, alreadyApplied, notices };
}
