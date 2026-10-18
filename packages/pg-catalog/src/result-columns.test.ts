import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewRelationRows, resolveResultColumns } from "./result-columns.js";

// A name that breaks any hand-quoted `"schema"."table"` - PostgreSQL's own regclass output quotes it right.
const TABLE = `preview "pkg" test`;
const TIMEOUT = { statementTimeoutMs: 5_000 };

describe("previewRelationRows (integration)", () => {
  let database: Database;
  let oid: number;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await database.query(`DROP TABLE IF EXISTS public."preview ""pkg"" test"`);
    await database.query(`CREATE TABLE public."preview ""pkg"" test" (id int PRIMARY KEY, created timestamptz NOT NULL DEFAULT now())`);
    await database.query(`INSERT INTO public."preview ""pkg"" test" (id) SELECT generate_series(1, 5)`);
    oid = (await database.query<{ oid: number }>(`SELECT c.oid::int AS oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1`, [TABLE])).rows[0]!.oid;
  });

  afterAll(async () => {
    await database.query(`DROP TABLE IF EXISTS public."preview ""pkg"" test"`);
    await database.close();
  });

  it("reads a page by OID, with typed columns and whether more follow - whatever the table is called", async () => {
    const first = await previewRelationRows(database, oid, { limit: 2, offset: 0 }, TIMEOUT);
    expect(first.rows.map((r) => r.id)).toEqual([1, 2]);
    expect(first.hasMore).toBe(true);
    expect(first.columns).toEqual([
      { name: "id", dataType: "integer" },
      { name: "created", dataType: "timestamp with time zone" },
    ]);
    const last = await previewRelationRows(database, oid, { limit: 2, offset: 4 }, TIMEOUT);
    expect(last.rows.map((r) => r.id)).toEqual([5]);
    expect(last.hasMore).toBe(false);
  });

  it("answers an OID that isn't a table as not found", async () => {
    await expect(previewRelationRows(database, 1, { limit: 5, offset: 0 }, TIMEOUT)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("bounds the page", async () => {
    await expect(previewRelationRows(database, oid, { limit: 0, offset: 0 }, TIMEOUT)).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(previewRelationRows(database, oid, { limit: 1000, offset: 0 }, TIMEOUT)).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(previewRelationRows(database, oid, { limit: 5, offset: -1 }, TIMEOUT)).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });
});

describe("resolveResultColumns (integration)", () => {
  it("names types from pg_type, and falls back to the OID when it can't", async () => {
    const database = new Database(loadDatabaseConfigFromEnv());
    try {
      expect(await resolveResultColumns(database, [{ name: "a", dataTypeId: 25 }, { name: "b", dataTypeId: 999999 }])).toEqual([
        { name: "a", dataType: "text" },
        { name: "b", dataType: "oid:999999" },
      ]);
      expect(await resolveResultColumns(database, [])).toEqual([]);
    } finally {
      await database.close();
    }
  });
});
