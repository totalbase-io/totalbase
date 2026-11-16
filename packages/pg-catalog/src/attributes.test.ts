import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findConstraintName, listAttributes, singleColumnPrimaryKey } from "./attributes.js";

describe("listAttributes / singleColumnPrimaryKey (integration)", () => {
  let database: Database;
  let oid: number;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await database.query(`DROP TABLE IF EXISTS public.pg_catalog_attributes_test, public.pg_catalog_attributes_pair`);
    await database.query(`CREATE TABLE public.pg_catalog_attributes_test (id integer PRIMARY KEY, gone text, "Name" varchar(20))`);
    await database.query(`ALTER TABLE public.pg_catalog_attributes_test DROP COLUMN gone`);
    await database.query(`CREATE TABLE public.pg_catalog_attributes_pair (a integer, b integer, PRIMARY KEY (a, b))`);
    oid = (await database.query<{ oid: number }>(`SELECT 'public.pg_catalog_attributes_test'::regclass::oid::int AS oid`)).rows[0]!.oid;
  });

  afterAll(async () => {
    await database.query(`DROP TABLE IF EXISTS public.pg_catalog_attributes_test, public.pg_catalog_attributes_pair`);
    await database.close();
  });

  it("lists live columns in order, with their full type, by OID or by name alike", async () => {
    const byOid = await listAttributes(database, [oid]);
    expect(byOid.map((a) => [a.name, a.attnum, a.type])).toEqual([["id", 1, "integer"], ["Name", 3, "character varying(20)"]]);
    expect(await listAttributes(database, ["public.pg_catalog_attributes_test"])).toEqual(byOid);
    expect(await listAttributes(database, [])).toEqual([]);
    expect(await listAttributes(database, ["public.pg_catalog_attributes_missing"])).toEqual([]);
  });

  it("answers a one-column primary key, and null for a composite one", async () => {
    expect(await singleColumnPrimaryKey(database, oid)).toEqual({ name: "id", typeId: 23 });
    expect(await singleColumnPrimaryKey(database, "public.pg_catalog_attributes_pair")).toBeNull();
    expect(await singleColumnPrimaryKey(database, "public.pg_catalog_attributes_missing")).toBeNull();
  });

  it("names a table's constraint of a kind, and null when it has none", async () => {
    expect(await findConstraintName(database, "public", "pg_catalog_attributes_test", "p")).toBe("pg_catalog_attributes_test_pkey");
    expect(await findConstraintName(database, "public", "pg_catalog_attributes_test", "u")).toBeNull();
  });
});
