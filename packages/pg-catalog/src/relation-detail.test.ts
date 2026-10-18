import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getChildForeignKeys, getRelationDetail } from "./relation-detail.js";

describe("getRelationDetail (integration)", () => {
  let database: Database;
  let parentOid: number;
  let childOid: number;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await database.query(`DROP TABLE IF EXISTS public.relation_detail_pkg_test_child`);
    await database.query(`DROP TABLE IF EXISTS public.relation_detail_pkg_test_parent`);
    await database.query(`
      CREATE TABLE public.relation_detail_pkg_test_parent (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code text NOT NULL,
        CONSTRAINT relation_detail_pkg_test_parent_code_key UNIQUE (code)
      )
    `);
    await database.query(`
      CREATE TABLE public.relation_detail_pkg_test_child (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        parent uuid NOT NULL,
        price numeric NOT NULL,
        CONSTRAINT relation_detail_pkg_test_child_parent_fkey
          FOREIGN KEY (parent) REFERENCES public.relation_detail_pkg_test_parent (id),
        CONSTRAINT relation_detail_pkg_test_child_price_check CHECK (price > 0)
      )
    `);
    const { rows } = await database.query<{ parent_oid: number; child_oid: number }>(
      `SELECT 'public.relation_detail_pkg_test_parent'::regclass::oid::int AS parent_oid,
              'public.relation_detail_pkg_test_child'::regclass::oid::int AS child_oid`,
    );
    parentOid = rows[0]!.parent_oid;
    childOid = rows[0]!.child_oid;
  });

  afterAll(async () => {
    await database.query(`DROP TABLE IF EXISTS public.relation_detail_pkg_test_child`);
    await database.query(`DROP TABLE IF EXISTS public.relation_detail_pkg_test_parent`);
    await database.close();
  });

  // A domain column read as a type with no input of its own (MCP_Demo_Findings.md F7).
  it("reports a domain column by its base type - a domain over a domain too - with the domain apart", async () => {
    await database.query(`DROP TABLE IF EXISTS public.relation_detail_pkg_test_domains`);
    await database.query(`DROP DOMAIN IF EXISTS public.relation_detail_pkg_test_amount`);
    await database.query(`DROP DOMAIN IF EXISTS public.relation_detail_pkg_test_money`);
    await database.query(`CREATE DOMAIN public.relation_detail_pkg_test_money AS numeric(12,2) CHECK (VALUE >= 0)`);
    await database.query(`CREATE DOMAIN public.relation_detail_pkg_test_amount AS public.relation_detail_pkg_test_money`);
    await database.query(`CREATE TABLE public.relation_detail_pkg_test_domains (id serial PRIMARY KEY, amount public.relation_detail_pkg_test_amount, note text)`);
    try {
      const { rows } = await database.query<{ oid: number }>(`SELECT 'public.relation_detail_pkg_test_domains'::regclass::oid::int AS oid`);
      const detail = await getRelationDetail(database, rows[0]!.oid);
      expect(detail.columns.find((c) => c.name === "amount")).toMatchObject({
        dataType: "numeric(12,2)", typeName: "numeric", typePrecision: 12, typeScale: 2, domain: "relation_detail_pkg_test_amount",
      });
      expect(detail.columns.find((c) => c.name === "note")).toMatchObject({ dataType: "text", domain: null });
    } finally {
      await database.query(`DROP TABLE IF EXISTS public.relation_detail_pkg_test_domains`);
      await database.query(`DROP DOMAIN IF EXISTS public.relation_detail_pkg_test_amount`);
      await database.query(`DROP DOMAIN IF EXISTS public.relation_detail_pkg_test_money`);
    }
  });

  it("returns the foreign key's constraint name alongside its columns", async () => {
    const detail = await getRelationDetail(database, childOid);
    expect(detail.relations).toEqual([
      {
        name: "relation_detail_pkg_test_child_parent_fkey",
        sourceColumn: "parent",
        targetSchema: "public",
        targetTable: "relation_detail_pkg_test_parent",
        targetColumn: "id",
        message: null,
      },
    ]);
  });

  it("returns CHECK constraints with name and full definition", async () => {
    const detail = await getRelationDetail(database, childOid);
    expect(detail.checkConstraints).toEqual([
      { name: "relation_detail_pkg_test_child_price_check", expression: "CHECK ((price > (0)::numeric))", message: null, columns: ["price"] },
    ]);
  });

  it("returns uniqueConstraintNames parallel to uniqueConstraints by index", async () => {
    const detail = await getRelationDetail(database, parentOid);
    expect(detail.uniqueConstraints).toEqual([["code"]]);
    expect(detail.uniqueConstraintNames).toEqual(["relation_detail_pkg_test_parent_code_key"]);
  });
});

describe("getChildForeignKeys (integration)", () => {
  let database: Database;
  let parentOid: number;
  let childOid: number;
  let grandchildOid: number;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await database.query(`DROP TABLE IF EXISTS public.child_fk_pkg_test_grandchild`);
    await database.query(`DROP TABLE IF EXISTS public.child_fk_pkg_test_child`);
    await database.query(`DROP TABLE IF EXISTS public.child_fk_pkg_test_parent`);
    await database.query(`
      CREATE TABLE public.child_fk_pkg_test_parent (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid()
      )
    `);
    await database.query(`
      CREATE TABLE public.child_fk_pkg_test_child (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        parent uuid NOT NULL,
        CONSTRAINT child_fk_pkg_test_child_parent_fkey
          FOREIGN KEY (parent) REFERENCES public.child_fk_pkg_test_parent (id)
      )
    `);
    await database.query(`
      CREATE TABLE public.child_fk_pkg_test_grandchild (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        child uuid NOT NULL,
        CONSTRAINT child_fk_pkg_test_grandchild_child_fkey
          FOREIGN KEY (child) REFERENCES public.child_fk_pkg_test_child (id)
      )
    `);
    const { rows } = await database.query<{ parent_oid: number; child_oid: number; grandchild_oid: number }>(
      `SELECT 'public.child_fk_pkg_test_parent'::regclass::oid::int AS parent_oid,
              'public.child_fk_pkg_test_child'::regclass::oid::int AS child_oid,
              'public.child_fk_pkg_test_grandchild'::regclass::oid::int AS grandchild_oid`,
    );
    parentOid = rows[0]!.parent_oid;
    childOid = rows[0]!.child_oid;
    grandchildOid = rows[0]!.grandchild_oid;
  });

  afterAll(async () => {
    await database.query(`DROP TABLE IF EXISTS public.child_fk_pkg_test_grandchild`);
    await database.query(`DROP TABLE IF EXISTS public.child_fk_pkg_test_child`);
    await database.query(`DROP TABLE IF EXISTS public.child_fk_pkg_test_parent`);
    await database.close();
  });

  it("finds tables with a FK pointing back at the given OID", async () => {
    const children = await getChildForeignKeys(database, parentOid);
    expect(children).toEqual([
      {
        name: "child_fk_pkg_test_child_parent_fkey",
        childOid,
        childSchema: "public",
        childTable: "child_fk_pkg_test_child",
        childColumn: "parent",
        parentColumn: "id",
      },
    ]);
  });

  it("returns no rows for a table nothing points at", async () => {
    const children = await getChildForeignKeys(database, grandchildOid);
    expect(children).toEqual([]);
  });
});
