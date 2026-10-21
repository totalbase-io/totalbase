import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations, TOTALBASE_SCHEMA_MARKER } from "./runner.js";

/**
 * The startup ownership check (Foundations.md §14, step 3). Each case
 * runs in a scratch database of its own, created and dropped here - a
 * foreign `totalbase` schema can't be staged in the shared test database,
 * which TotalBase already owns.
 */
describe("totalbase schema ownership (integration)", () => {
  let admin: Database;
  let scratch: Database | undefined;
  let scratchName: string;
  let emptyDir: string;

  beforeAll(async () => {
    admin = new Database(loadDatabaseConfigFromEnv());
    emptyDir = await mkdtemp(join(tmpdir(), "totalbase-ownership-"));
  });

  afterAll(async () => {
    await rm(emptyDir, { recursive: true, force: true });
    await admin.close();
  });

  beforeEach(async () => {
    scratchName = `tb_ownership_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await admin.query(`CREATE DATABASE ${scratchName}`);
    scratch = new Database({ ...loadDatabaseConfigFromEnv(), database: scratchName, poolMax: 2 });
  });

  afterEach(async () => {
    await scratch?.close();
    scratch = undefined;
    await admin.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`);
  });

  const migrate = () => runMigrations(scratch!, { migrationsDir: emptyDir, totalbaseVersion: "0.0.0-test" });
  const marker = async () =>
    (await scratch!.query<{ marker: string | null }>(`SELECT obj_description(oid, 'pg_namespace') AS marker FROM pg_namespace WHERE nspname = 'totalbase'`)).rows[0]?.marker;

  it("creates and marks the schema in a fresh database, and starts again on it", async () => {
    await migrate();
    expect(await marker()).toBe(TOTALBASE_SCHEMA_MARKER);
    await expect(migrate()).resolves.toBeDefined();
  });

  it("refuses a foreign totalbase schema with TOTALBASE_SCHEMA_CONFLICT and leaves it untouched", async () => {
    await scratch!.query(`CREATE SCHEMA totalbase`);
    await scratch!.query(`CREATE TABLE totalbase.orders (id int PRIMARY KEY)`);

    const error = await migrate().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TotalBaseError);
    expect((error as TotalBaseError).code).toBe("TOTALBASE_SCHEMA_CONFLICT");

    const { rows } = await scratch!.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'totalbase' AND c.relkind = 'r'`,
    );
    expect(rows.map((r) => r.relname)).toEqual(["orders"]); // no ledger created in it
  });

  it("refuses a foreign schema holding only a function", async () => {
    await scratch!.query(`CREATE SCHEMA totalbase`);
    await scratch!.query(`CREATE FUNCTION totalbase.answer() RETURNS int LANGUAGE sql AS 'SELECT 42'`);
    await expect(migrate()).rejects.toMatchObject({ code: "TOTALBASE_SCHEMA_CONFLICT" });
  });

  it("adopts an empty totalbase schema pre-created for it", async () => {
    await scratch!.query(`CREATE SCHEMA totalbase`);
    await expect(migrate()).resolves.toBeDefined();
  });

  it("accepts an install that predates the marker: its ledger identifies it", async () => {
    await migrate();
    await scratch!.query(`COMMENT ON SCHEMA totalbase IS NULL`);
    await scratch!.query(`CREATE TABLE totalbase.things (id int)`);
    await expect(migrate()).resolves.toBeDefined();
  });

  it("accepts a marked schema", async () => {
    await scratch!.query(`CREATE SCHEMA totalbase`);
    await scratch!.query(`COMMENT ON SCHEMA totalbase IS '${TOTALBASE_SCHEMA_MARKER}'`);
    await scratch!.query(`CREATE TABLE totalbase.things (id int)`);
    await expect(migrate()).resolves.toBeDefined();
  });
});
