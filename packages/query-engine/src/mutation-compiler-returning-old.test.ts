import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FilterNode } from "./ast.js";
import { compileUpdate, type MutationCompileContext } from "./mutation-compiler.js";
import { SchemaContext, type ResolvedResource } from "./schema-context.js";

/**
 * UPDATE audit old values on a table WITHOUT a primary key
 * (Specification_Security.md §11.4): PostgreSQL 18+ reads them with
 * RETURNING OLD in the UPDATE itself; before 18 none are read. The
 * PostgreSQL 18 cases run only against a PostgreSQL 18 server.
 */
const SERVER_MAJOR = await (async () => {
  const probe = new Database(loadDatabaseConfigFromEnv());
  try {
    return await probe.serverMajorVersion();
  } finally {
    await probe.close();
  }
})();

describe("compileUpdate on a table without a primary key (integration)", () => {
  let database: Database;
  let root: ResolvedResource;
  let major: number;
  const where: FilterNode = { type: "comparison", path: ["code"], operator: "_eq", value: "A" };

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    major = await database.serverMajorVersion();
    await database.query(`DROP TABLE IF EXISTS public.mc_test_nopk CASCADE`);
    // A column named "old" too: RETURNING WITH (OLD AS ...) names the old row, so it can't be shadowed.
    await database.query(`CREATE TABLE public.mc_test_nopk (code text NOT NULL, label text, qty integer, old text)`);
    const { rows } = await database.query<{ oid: number }>(`SELECT 'public.mc_test_nopk'::regclass::oid::int AS oid`);
    root = await new SchemaContext(database).loadRoot("public", "mc_test_nopk", rows[0]!.oid);
  });

  afterAll(async () => {
    await database.query(`DROP TABLE IF EXISTS public.mc_test_nopk CASCADE`);
    await database.close();
  });

  const context = (overrides?: Partial<MutationCompileContext>): MutationCompileContext => ({
    root,
    fieldDecision: () => "ALLOW",
    rowFilter: undefined,
    payloadChecks: undefined,
    resolveUserVariable: () => undefined,
    ...overrides,
  });
  const seed = async () => {
    await database.query(`TRUNCATE public.mc_test_nopk`);
    await database.query(`INSERT INTO public.mc_test_nopk VALUES ('A', 'before', 1, 'kept'), ('B', 'other', 2, 'kept')`);
  };

  it("reads no old values without RETURNING OLD (PostgreSQL 15-17): the plain UPDATE", async () => {
    await seed();
    const compiled = await compileUpdate(context(), { label: "after" }, where, ["label", "qty"]);
    expect(compiled.oldValueColumns).toEqual([]);
    expect(compiled.sql).not.toContain("OLD AS");
    const { rows } = await database.query<Record<string, unknown>>(compiled.sql, compiled.params);
    expect(rows).toEqual([expect.objectContaining({ code: "A", label: "after" })]);
  });

  it("reads the server's major version once and keeps it", async () => {
    expect(major).toBe(SERVER_MAJOR);
    expect(await database.serverMajorVersion()).toBe(major);
  });

  describe.runIf(SERVER_MAJOR >= 18)("PostgreSQL 18+", () => {
    it("returns each asked field's old value as __old_N, in the UPDATE itself", async () => {
      await seed();
      const compiled = await compileUpdate(context({ returningOld: true }), { label: "after", qty: 5 }, where, ["label", "qty", "dropped"]);
      expect(compiled.oldValueColumns).toEqual([{ column: "__old_0", field: "label" }, { column: "__old_1", field: "qty" }]);
      expect(compiled.sql).toContain("RETURNING WITH (OLD AS");
      expect(compiled.sql).not.toContain("FOR UPDATE");
      const { rows } = await database.query<Record<string, unknown>>(compiled.sql, compiled.params);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ code: "A", label: "after", qty: 5, old: "kept", __old_0: "before", __old_1: 1, __authorized: true });
    });

    it("still applies the OLD row filter and re-checks NEW", async () => {
      await seed();
      const rowFilter: FilterNode = { type: "comparison", path: ["qty"], operator: "_lt", value: "2" };
      const compiled = await compileUpdate(context({ returningOld: true, rowFilter }), { qty: 9 }, undefined, ["qty"]);
      const { rows } = await database.query<Record<string, unknown>>(compiled.sql, compiled.params);
      expect(rows.map((r) => r["code"])).toEqual(["A"]);
      expect(rows[0]).toMatchObject({ qty: 9, __old_0: 1, __authorized: false });
    });
  });
});
