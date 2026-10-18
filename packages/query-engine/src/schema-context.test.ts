import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SchemaContext } from "./schema-context.js";

describe("SchemaContext.resolveRelated() (integration)", () => {
  let database: Database;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await database.query(`DROP TABLE IF EXISTS public.sc_test_categories CASCADE`);
    await database.query(`
      CREATE TABLE public.sc_test_categories (
        id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.resources WHERE "schema" = 'public' AND name = 'sc_test_categories'`);
    await database.query(`DROP TABLE IF EXISTS public.sc_test_categories CASCADE`);
    await database.close();
  });

  it("resolves the ACTIVE row, not a stale MISSING one sharing the same (schema, name)", async () => {
    // A stale row left behind by an earlier drop+recreate cycle of a
    // table with this same name (a real oid that never existed, kept
    // as MISSING forever - reconcile-resources.ts never deletes those)
    // - inserted FIRST, and with an OLDER updated_at, so an unordered
    // `rows[0]` would have picked this one.
    await database.query(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods, updated_at)
       VALUES (900555, 'public', 'sc_test_categories', 'TABLE', 'MISSING', ARRAY['GET'], now() - interval '1 day')`,
    );

    const { rows } = await database.query<{ oid: number }>(
      `SELECT 'public.sc_test_categories'::regclass::oid::int AS oid`,
    );
    await database.query(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES ($1, 'public', 'sc_test_categories', 'TABLE', 'ACTIVE', ARRAY['GET'])`,
      [rows[0]!.oid],
    );

    const schemaContext = new SchemaContext(database);
    const resolved = await schemaContext.resolveRelated("public", "sc_test_categories");
    expect(resolved.oid).toBe(rows[0]!.oid);
  });

  it("rejects a relation target whose ONLY matching row is MISSING or unexposed", async () => {
    await database.query(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (900556, 'public', 'sc_test_gone', 'TABLE', 'MISSING', ARRAY['GET'])`,
    );
    const schemaContext = new SchemaContext(database);
    await expect(schemaContext.resolveRelated("public", "sc_test_gone")).rejects.toMatchObject({ code: "INVALID_RELATION" });
    await database.query(`DELETE FROM totalbase.resources WHERE "schema" = 'public' AND name = 'sc_test_gone'`);
  });
});
