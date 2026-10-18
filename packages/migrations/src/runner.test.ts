import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./runner.js";

// High version numbers to avoid colliding with the real
// migrations/totalbase/000001_initial_schema.sql ledger entry.
const VERSION_A = "900001_runner_test_a";
const VERSION_B = "900002_runner_test_b";

describe("runMigrations (integration)", () => {
  let database: Database;
  let dir: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await database.ping();
  });

  afterAll(async () => {
    await database.query(
      `DELETE FROM totalbase.migrations WHERE version IN (900001, 900002)`,
    );
    await database.close();
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    await database.query(`DROP TABLE IF EXISTS public.migrations_runner_test_a`);
    await database.query(`DROP TABLE IF EXISTS public.migrations_runner_test_b_marker`);
    await database.query(
      `DELETE FROM totalbase.migrations WHERE version IN (900001, 900002)`,
    );
  });

  it("applies pending migrations once and is idempotent on rerun", async () => {
    dir = await mkdtemp(join(tmpdir(), "totalbase-migrations-"));
    await writeFile(
      join(dir, `${VERSION_A}.sql`),
      `CREATE TABLE public.migrations_runner_test_a (id uuid PRIMARY KEY DEFAULT gen_random_uuid());`,
    );

    const first = await runMigrations(database, {
      migrationsDir: dir,
      totalbaseVersion: "0.0.0-test",
    });
    expect(first.applied).toEqual([`${VERSION_A}.sql`]);
    expect(first.alreadyApplied).toEqual([]);

    const second = await runMigrations(database, {
      migrationsDir: dir,
      totalbaseVersion: "0.0.0-test",
    });
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual([`${VERSION_A}.sql`]);
  });

  it("returns what a migration applied now said (RAISE NOTICE) - its report", async () => {
    dir = await mkdtemp(join(tmpdir(), "totalbase-migrations-"));
    await writeFile(join(dir, `${VERSION_A}.sql`), `DO $$ BEGIN RAISE NOTICE 'moved 2, left out 1'; END $$;`);
    const first = await runMigrations(database, { migrationsDir: dir, totalbaseVersion: "0.0.0-test" });
    expect(first.notices).toEqual([{ migration: `${VERSION_A}.sql`, message: "moved 2, left out 1" }]);
    // Already applied: it doesn't run, nothing to say.
    expect((await runMigrations(database, { migrationsDir: dir, totalbaseVersion: "0.0.0-test" })).notices).toEqual([]);
  });

  it("applies migrations in version order", async () => {
    dir = await mkdtemp(join(tmpdir(), "totalbase-migrations-"));
    await writeFile(
      join(dir, `${VERSION_B}.sql`),
      `CREATE TABLE public.migrations_runner_test_b_marker (id int);`,
    );
    await writeFile(
      join(dir, `${VERSION_A}.sql`),
      `CREATE TABLE public.migrations_runner_test_a (id uuid PRIMARY KEY DEFAULT gen_random_uuid());`,
    );

    const result = await runMigrations(database, {
      migrationsDir: dir,
      totalbaseVersion: "0.0.0-test",
    });

    expect(result.applied).toEqual([`${VERSION_A}.sql`, `${VERSION_B}.sql`]);
  });

  it("runs a migration file of several statements (a script, not one statement)", async () => {
    dir = await mkdtemp(join(tmpdir(), "totalbase-migrations-"));
    await writeFile(
      join(dir, `${VERSION_A}.sql`),
      `CREATE TABLE public.migrations_runner_test_a (id int);\nINSERT INTO public.migrations_runner_test_a VALUES (1), (2);`,
    );
    const result = await runMigrations(database, { migrationsDir: dir, totalbaseVersion: "0.0.0-test" });
    expect(result.applied).toEqual([`${VERSION_A}.sql`]);
    const { rows } = await database.query(`SELECT count(*)::int AS n FROM public.migrations_runner_test_a`);
    expect(rows[0]?.["n"]).toBe(2);
  });

  it("rejects with MIGRATION_CHECKSUM_MISMATCH when an applied migration file is edited", async () => {
    dir = await mkdtemp(join(tmpdir(), "totalbase-migrations-"));
    const file = join(dir, `${VERSION_A}.sql`);
    await writeFile(
      file,
      `CREATE TABLE public.migrations_runner_test_a (id uuid PRIMARY KEY DEFAULT gen_random_uuid());`,
    );

    await runMigrations(database, { migrationsDir: dir, totalbaseVersion: "0.0.0-test" });

    // Simulate editing a published migration file after it was applied.
    await writeFile(file, `CREATE TABLE public.migrations_runner_test_a (id uuid PRIMARY KEY);`);

    const error = await runMigrations(database, {
      migrationsDir: dir,
      totalbaseVersion: "0.0.0-test",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TotalBaseError);
    expect((error as TotalBaseError).code).toBe("MIGRATION_CHECKSUM_MISMATCH");
  });

  describe("failure recovery", () => {
    it("rolls back a failing migration's own DDL and never records it in the ledger", async () => {
      dir = await mkdtemp(join(tmpdir(), "totalbase-migrations-"));
      await writeFile(
        join(dir, `${VERSION_A}.sql`),
        `CREATE TABLE public.migrations_runner_test_a (id uuid PRIMARY KEY DEFAULT gen_random_uuid()); THIS IS NOT VALID SQL;`,
      );

      await expect(
        runMigrations(database, { migrationsDir: dir, totalbaseVersion: "0.0.0-test" }),
      ).rejects.toBeTruthy();

      const { rows: ledger } = await database.query(
        `SELECT version FROM totalbase.migrations WHERE version = 900001`,
      );
      expect(ledger).toHaveLength(0);

      // Both statements were one transaction - the otherwise-valid
      // CREATE TABLE must not have survived the later syntax error.
      const { rows: table } = await database.query(
        `SELECT to_regclass('public.migrations_runner_test_a') AS oid`,
      );
      expect(table[0]?.["oid"]).toBeNull();
    });

    it("keeps an earlier migration applied when a later one in the same run fails, and allows a retry after fixing it", async () => {
      dir = await mkdtemp(join(tmpdir(), "totalbase-migrations-"));
      await writeFile(
        join(dir, `${VERSION_A}.sql`),
        `CREATE TABLE public.migrations_runner_test_a (id uuid PRIMARY KEY DEFAULT gen_random_uuid());`,
      );
      const brokenFile = join(dir, `${VERSION_B}.sql`);
      await writeFile(brokenFile, `THIS IS NOT VALID SQL;`);

      await expect(
        runMigrations(database, { migrationsDir: dir, totalbaseVersion: "0.0.0-test" }),
      ).rejects.toBeTruthy();

      const { rows: afterFailure } = await database.query<{ version: string }>(
        `SELECT version FROM totalbase.migrations WHERE version IN (900001, 900002) ORDER BY version`,
      );
      expect(afterFailure.map((r) => r.version)).toEqual(["900001"]); // A applied, B did not

      // Fix the broken migration and rerun - A is a no-op (already
      // applied), B now applies cleanly (section 60: "upgrades work").
      await writeFile(brokenFile, `CREATE TABLE public.migrations_runner_test_b_marker (id int);`);
      const retry = await runMigrations(database, { migrationsDir: dir, totalbaseVersion: "0.0.0-test" });
      expect(retry.alreadyApplied).toEqual([`${VERSION_A}.sql`]);
      expect(retry.applied).toEqual([`${VERSION_B}.sql`]);
    });
  });
});
