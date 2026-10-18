import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyTableEditPlan, buildTableEditPlan, type TableEditOperation } from "./table-edit-orchestrator.js";
import { TableSchemaService } from "./table-schema-service.js";

const T1 = "schema_pkg_edit_test_t1";

describe("table edit orchestrator (integration)", () => {
  let database: Database;
  let tableService: TableSchemaService;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    tableService = new TableSchemaService(database);
    await database.query(`DROP TABLE IF EXISTS public.${T1} CASCADE`);
    await tableService.createTable({
      schema: "public",
      name: T1,
      columns: [
        { name: "id", dataType: "uuid", nullable: false, default: "gen_random_uuid()", primaryKey: true },
        { name: "email", dataType: "text" },
      ],
    });
  });

  afterAll(async () => {
    await database.query(`DROP TABLE IF EXISTS public.${T1} CASCADE`);
    await database.close();
  });

  it("runs a batch (add column + check + rename) as one transaction", async () => {
    const ops: TableEditOperation[] = [
      { kind: "add_column", column: { name: "age", dataType: "integer" } },
      { kind: "add_check", name: `${T1}_age_check`, expression: "age >= 0" },
    ];
    const plan = await buildTableEditPlan(database, "public", T1, ops);
    expect(plan.transactional).toHaveLength(2);
    expect(plan.concurrent).toHaveLength(0);

    await applyTableEditPlan(database, plan);

    const { rows } = await database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'age'`,
      [T1],
    );
    expect(rows).toHaveLength(1);
  });

  it("gives a CHECK its message - on add, and later on an existing one, removed with null (T50)", async () => {
    const message = async () => (await database.query<{ m: string | null }>(
      `SELECT obj_description(oid, 'pg_constraint') AS m FROM pg_constraint WHERE conname = $1`, [`${T1}_email_check`],
    )).rows[0]?.m ?? null;
    await applyTableEditPlan(database, await buildTableEditPlan(database, "public", T1, [
      { kind: "add_check", name: `${T1}_email_check`, expression: "email ~ '@'", message: "An email has an @." },
    ]));
    expect(await message()).toBe("An email has an @.");
    await applyTableEditPlan(database, await buildTableEditPlan(database, "public", T1, [{ kind: "set_constraint_message", name: `${T1}_email_check`, message: "It's 'name@host'." }]));
    expect(await message()).toBe("It's 'name@host'.");
    await applyTableEditPlan(database, await buildTableEditPlan(database, "public", T1, [{ kind: "set_constraint_message", name: `${T1}_email_check`, message: null }]));
    expect(await message()).toBeNull();
    await applyTableEditPlan(database, await buildTableEditPlan(database, "public", T1, [{ kind: "drop_constraint", name: `${T1}_email_check` }]));
  });

  it("addresses the table by its new name after a rename, in any order - CONCURRENTLY included", async () => {
    const original = `${T1}_ren`;
    const renamed = `${T1}_ren2`;
    await database.query(`DROP TABLE IF EXISTS public.${original}, public.${renamed} CASCADE`);
    await database.query(`CREATE TABLE public.${original} (id integer PRIMARY KEY)`);
    try {
      const ops: TableEditOperation[] = [
        { kind: "rename_table", newName: renamed },
        { kind: "add_column", column: { name: "code", dataType: "text" } },
        { kind: "add_unique", columns: ["code"] },
        { kind: "create_index", input: { name: `${renamed}_code_idx`, columns: [{ name: "code" }], concurrently: true } },
      ];
      await applyTableEditPlan(database, await buildTableEditPlan(database, "public", original, ops));
      const { rows } = await database.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY 1`, [renamed]);
      expect(rows.map((r) => r["indexname"])).toEqual(expect.arrayContaining([`${renamed}_code_idx`]));
      expect(rows.length).toBeGreaterThanOrEqual(3); // pkey, unique, the index
    } finally {
      await database.query(`DROP TABLE IF EXISTS public.${original}, public.${renamed} CASCADE`);
    }
  });

  it("never runs a stacked statement, even one that got past validation (security regression)", async () => {
    const victim = `${T1}_victim`;
    await database.query(`DROP TABLE IF EXISTS public.${victim}`);
    await database.query(`CREATE TABLE public.${victim} (id integer)`);
    try {
      const plan = { transactional: [`SELECT 1; DROP TABLE public.${victim}`], concurrent: [`SELECT 1; DROP TABLE public.${victim}`] };
      await expect(applyTableEditPlan(database, plan)).rejects.toBeDefined();
      await expect(applyTableEditPlan(database, { transactional: [], concurrent: plan.concurrent })).rejects.toBeDefined();
      const { rows } = await database.query(`SELECT to_regclass('public.${victim}') AS oid`);
      expect(rows[0]?.["oid"]).not.toBeNull();
    } finally {
      await database.query(`DROP TABLE IF EXISTS public.${victim}`);
    }
  });

  it("rolls back the whole transactional batch when one statement fails", async () => {
    const ops: TableEditOperation[] = [
      { kind: "add_column", column: { name: "should_not_exist", dataType: "text" } },
      // Invalid: references a column that doesn't exist - fails, and
      // should take the add_column above down with it.
      { kind: "add_check", name: `${T1}_bad_check`, expression: "nonexistent_column > 0" },
    ];
    const plan = await buildTableEditPlan(database, "public", T1, ops);
    await expect(applyTableEditPlan(database, plan)).rejects.toBeTruthy();

    const { rows } = await database.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'should_not_exist'`,
      [T1],
    );
    expect(rows).toHaveLength(0);
  });

  it("set_primary_key drops the existing PK first, in the same plan", async () => {
    const ops: TableEditOperation[] = [{ kind: "set_primary_key", columns: ["email"] }];
    const plan = await buildTableEditPlan(database, "public", T1, ops);
    // DROP CONSTRAINT (existing id PK) + ADD CONSTRAINT (new email PK)
    expect(plan.transactional).toHaveLength(2);
    expect(plan.transactional[0]).toMatch(/DROP CONSTRAINT/);
    // Knex-compiled (buildSetPrimaryKeySql), lowercase keywords - unlike
    // the hand-built DROP CONSTRAINT statement above.
    expect(plan.transactional[1]).toMatch(/primary key/i);
  });

  it("separates CONCURRENTLY index operations from the transactional batch", async () => {
    const ops: TableEditOperation[] = [
      { kind: "add_column", column: { name: "nickname", dataType: "text" } },
      { kind: "create_index", input: { columns: ["nickname"], concurrently: true } },
    ];
    const plan = await buildTableEditPlan(database, "public", T1, ops);
    expect(plan.transactional).toHaveLength(1);
    expect(plan.concurrent).toHaveLength(1);
    expect(plan.concurrent[0]).toMatch(/CONCURRENTLY/);
  });
});
