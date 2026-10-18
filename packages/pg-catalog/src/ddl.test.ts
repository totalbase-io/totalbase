import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getFunctionDdl, getViewDdl } from "./ddl.js";

describe("@totalbase/pg-catalog ddl (integration)", () => {
  let database: Database;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await database.query(`DROP VIEW IF EXISTS public.ddl_pkg_test_view`);
    await database.query(`DROP FUNCTION IF EXISTS public.ddl_pkg_test_fn(integer)`);
    await database.query(`CREATE VIEW public.ddl_pkg_test_view AS SELECT 1 AS n`);
    await database.query(`
      CREATE FUNCTION public.ddl_pkg_test_fn(n integer) RETURNS integer
      LANGUAGE sql IMMUTABLE AS $$ SELECT n * 2 $$
    `);
  });

  afterAll(async () => {
    await database.query(`DROP VIEW IF EXISTS public.ddl_pkg_test_view`);
    await database.query(`DROP FUNCTION IF EXISTS public.ddl_pkg_test_fn(integer)`);
    await database.close();
  });

  it("reconstructs a view's complete CREATE OR REPLACE VIEW statement, runnable as is", async () => {
    const { rows } = await database.query<{ oid: number }>(
      `SELECT 'public.ddl_pkg_test_view'::regclass::oid::int AS oid`,
    );
    const ddl = await getViewDdl(database, rows[0]!.oid);
    expect(ddl).toMatch(/^CREATE OR REPLACE VIEW public\.ddl_pkg_test_view AS\n/);
    expect(ddl).toContain("SELECT");
    await database.query(ddl);
  });

  it("reconstructs a function's CREATE FUNCTION source", async () => {
    const { rows } = await database.query<{ oid: number }>(
      `SELECT 'public.ddl_pkg_test_fn(integer)'::regprocedure::oid::int AS oid`,
    );
    const ddl = await getFunctionDdl(database, rows[0]!.oid);
    expect(ddl).toContain("ddl_pkg_test_fn");
    expect(ddl).toContain("LANGUAGE sql");
  });

  it("throws RESOURCE_NOT_FOUND for a nonexistent oid", async () => {
    await expect(getViewDdl(database, 999999999)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
});
