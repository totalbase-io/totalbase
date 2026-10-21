import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TableSchemaService } from "./table-schema-service.js";

const T1 = "schema_pkg_test_t1";
const T2 = "schema_pkg_test_t2";

describe("TableSchemaService (integration)", () => {
  let database: Database;
  let schemaService: TableSchemaService;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    schemaService = new TableSchemaService(database);
    await database.query(`DROP TABLE IF EXISTS public.${T1} CASCADE`);
    await database.query(`DROP TABLE IF EXISTS public.${T2} CASCADE`);
  });

  afterAll(async () => {
    await database.query(`DROP TABLE IF EXISTS public.${T1} CASCADE`);
    await database.query(`DROP TABLE IF EXISTS public.${T2} CASCADE`);
    await database.close();
  });

  it("creates a table with an inline PRIMARY KEY", async () => {
    await schemaService.createTable({
      schema: "public",
      name: T1,
      columns: [
        { name: "id", dataType: "uuid", nullable: false, default: "gen_random_uuid()", primaryKey: true },
        { name: "name", dataType: "text", nullable: false },
        { name: "price", dataType: "numeric(12,2)" },
      ],
    });

    const { rows } = await database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [T1],
    );
    expect(rows.map((r) => r.column_name)).toEqual(["id", "name", "price"]);

    const { rows: pkRows } = await database.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'public.${T1}'::regclass AND contype = 'p'`,
    );
    expect(pkRows).toHaveLength(1);
  });

  it("adds, alters, renames and drops columns", async () => {
    await schemaService.addColumn("public", T1, { name: "notes", dataType: "text" });
    let columns = (await database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
      [T1],
    )).rows.map((r) => r.column_name);
    expect(columns).toContain("notes");

    await schemaService.alterColumn("public", T1, "notes", { nullable: false, default: "''" });
    const { rows: notesRow } = await database.query<{ is_nullable: string; column_default: string }>(
      `SELECT is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='notes'`,
      [T1],
    );
    expect(notesRow[0]?.is_nullable).toBe("NO");
    expect(notesRow[0]?.column_default).toContain("''");

    await schemaService.alterColumn("public", T1, "notes", { rename: "remarks" });
    columns = (await database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
      [T1],
    )).rows.map((r) => r.column_name);
    expect(columns).toContain("remarks");
    expect(columns).not.toContain("notes");

    await schemaService.dropColumn("public", T1, "remarks");
    columns = (await database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
      [T1],
    )).rows.map((r) => r.column_name);
    expect(columns).not.toContain("remarks");
  });

  it("inline unique/check/foreignKey on a column land in the same statement, named as if added separately", async () => {
    await schemaService.addColumn("public", T1, { name: "sku", dataType: "text", unique: true, check: "length(sku) > 0" });

    const { rows: uniqueRows } = await database.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'public.${T1}'::regclass AND contype = 'u'`,
    );
    expect(uniqueRows.map((r) => r.conname)).toContain(`${T1}_sku_key`);

    const { rows: checkRows } = await database.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'public.${T1}'::regclass AND contype = 'c'`,
    );
    expect(checkRows.length).toBeGreaterThan(0);

    // The later "manages UNIQUE, FOREIGN KEY and CHECK constraints" test
    // asserts T1 has zero CHECK constraints once it drops its own - leaving
    // this one around would fail that test, not because anything's wrong,
    // just leftover state from this one.
    await schemaService.dropColumn("public", T1, "sku");
  });

  // An order number, a computed amount and a CHECK's message each needed raw SQL or a second call.
  it("creates identity and generated columns, and each inline constraint with its message, in one transaction", async () => {
    const T = "schema_pkg_test_lines";
    await database.query(`DROP TABLE IF EXISTS public.${T}`);
    try {
      await schemaService.createTable({
        schema: "public",
        name: T,
        columns: [
          { name: "numero", dataType: "bigint", identity: "ALWAYS", primaryKey: true },
          { name: "cantidad", dataType: "integer", nullable: false, check: "cantidad > 0", checkMessage: "La cantidad es mayor que cero" },
          { name: "precio", dataType: "numeric(12,2)", nullable: false },
          { name: "importe", dataType: "numeric(14,2)", generated: "cantidad * precio" },
          { name: "codigo", dataType: "text", unique: true, uniqueMessage: "Ese código ya existe" },
        ],
      });
      const { rows } = await database.query<{ numero: string; importe: string }>(
        `INSERT INTO public.${T} (cantidad, precio, codigo) VALUES (3, 2.5, 'A'), (1, 10, 'B') RETURNING numero, importe`,
      );
      expect(rows).toEqual([{ numero: "1", importe: "7.50" }, { numero: "2", importe: "10.00" }]);
      await expect(database.query(`INSERT INTO public.${T} (cantidad, precio, codigo) VALUES (0, 1, 'C')`)).rejects.toMatchObject({ message: "La cantidad es mayor que cero" });
      await expect(database.query(`INSERT INTO public.${T} (cantidad, precio, codigo) VALUES (1, 1, 'A')`)).rejects.toMatchObject({ message: "Ese código ya existe" });
      await expect(database.query(`INSERT INTO public.${T} (numero, cantidad, precio) VALUES (9, 1, 1)`)).rejects.toMatchObject({ code: "GENERATED_ALWAYS" });
    } finally {
      await database.query(`DROP TABLE IF EXISTS public.${T}`);
    }
    await expect(schemaService.createTable({ schema: "public", name: T, columns: [{ name: "n", dataType: "integer", identity: "ALWAYS", default: "0" }] }))
      .rejects.toMatchObject({ code: "INVALID_SCHEMA_OPERATION" });
    await expect(schemaService.createTable({ schema: "public", name: T, columns: [{ name: "n", dataType: "integer", checkMessage: "x" }] }))
      .rejects.toThrow(/has a check message but no check/);
    await expect(schemaService.createTable({ schema: "public", name: T, columns: [{ name: "n", dataType: "integer", generated: "1) STORED, m int GENERATED ALWAYS AS (2" }] }))
      .rejects.toThrow(/unbalanced parentheses/);
  });

  it("rejects an inline foreignKey against a non-unique target column without adding the column at all", async () => {
    // T1.name has no PK/UNIQUE - PostgreSQL requires the referenced
    // column to have one, so this REFERENCES clause must fail. The whole
    // ADD COLUMN is one statement, so the column must not exist afterward
    // either - no half-created state to clean up or discover later.
    await expect(
      schemaService.addColumn("public", T1, {
        name: "bad_fk",
        dataType: "text",
        foreignKey: { targetSchema: "public", targetTable: T1, targetColumn: "name" },
      }),
    ).rejects.toBeTruthy();

    const { rows } = await database.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'bad_fk'`,
      [T1],
    );
    expect(rows).toHaveLength(0);
  });

  it("manages UNIQUE, FOREIGN KEY and CHECK constraints", async () => {
    await schemaService.createTable({
      schema: "public",
      name: T2,
      columns: [{ name: "id", dataType: "uuid", nullable: false, default: "gen_random_uuid()", primaryKey: true }, { name: "t1_id", dataType: "uuid" }],
    });

    const uniqueName = await schemaService.addUniqueConstraint("public", T2, ["t1_id"]);
    const { rows: uniqueRows } = await database.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'public.${T2}'::regclass AND contype = 'u' AND conname = $1`,
      [uniqueName],
    );
    expect(uniqueRows).toHaveLength(1);

    const fkName = await schemaService.addForeignKey("public", T2, {
      column: "t1_id",
      targetSchema: "public",
      targetTable: T1,
      targetColumn: "id",
      onDelete: "CASCADE",
    });
    const { rows: fkRows } = await database.query<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint WHERE conrelid = 'public.${T2}'::regclass AND contype = 'f' AND conname = $1`,
      [fkName],
    );
    expect(fkRows[0]?.confdeltype).toBe("c"); // 'c' = CASCADE

    await schemaService.addCheckConstraint("public", T1, "schema_pkg_test_price_check", "price >= 0");
    const { rows: checkRows } = await database.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'public.${T1}'::regclass AND contype = 'c' AND conname = 'schema_pkg_test_price_check'`,
    );
    expect(checkRows).toHaveLength(1);

    await schemaService.dropConstraint("public", T1, "schema_pkg_test_price_check");
    const { rows: afterDrop } = await database.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'public.${T1}'::regclass AND contype = 'c'`,
    );
    expect(afterDrop).toHaveLength(0);
  });

  it("replaces the PRIMARY KEY and can drop it", async () => {
    await schemaService.setPrimaryKey("public", T2, ["id"]);
    const { rows: pkRows } = await database.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'public.${T2}'::regclass AND contype = 'p'`,
    );
    expect(pkRows).toHaveLength(1);

    await schemaService.dropPrimaryKey("public", T2);
    const { rows: afterDrop } = await database.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'public.${T2}'::regclass AND contype = 'p'`,
    );
    expect(afterDrop).toHaveLength(0);

    await expect(schemaService.dropPrimaryKey("public", T2)).rejects.toMatchObject({ code: "UNDEFINED_OBJECT" });
  });

  it("applies a multi-statement change whole or not at all", async () => {
    const T3 = "schema_pkg_test_t3";
    await database.query(`DROP TABLE IF EXISTS public.${T3} CASCADE`);
    await database.query(`CREATE TABLE public.${T3} (id integer PRIMARY KEY, code text)`);
    try {
      await database.query(`INSERT INTO public.${T3} VALUES (1, 'abc'), (2, NULL)`);
      const constraints = async (contype: string) =>
        (await database.query<{ conname: string }>(`SELECT conname FROM pg_constraint WHERE conrelid = 'public.${T3}'::regclass AND contype = $1`, [contype])).rows;

      // The new key is rejected (a NULL): the old one stays.
      await expect(schemaService.setPrimaryKey("public", T3, ["code"])).rejects.toBeDefined();
      expect(await constraints("p")).toHaveLength(1);

      // The rename runs after a type change PostgreSQL rejects: nothing applied.
      await expect(schemaService.alterColumn("public", T3, "code", { dataType: "integer", rename: "code_renamed" })).rejects.toBeDefined();
      const { rows } = await database.query(`SELECT 1 FROM pg_attribute WHERE attrelid = 'public.${T3}'::regclass AND attname = 'code'`);
      expect(rows).toHaveLength(1);

      // Existing rows violate it: neither the CHECK nor its message is left behind.
      await expect(schemaService.addCheckConstraint("public", T3, "t3_code_check", "code <> 'abc'", "Not abc")).rejects.toBeDefined();
      expect(await constraints("c")).toHaveLength(0);
    } finally {
      await database.query(`DROP TABLE IF EXISTS public.${T3} CASCADE`);
    }
  });

  it("renames a table", async () => {
    await schemaService.renameTable("public", T2, `${T2}_renamed`);
    const { rows } = await database.query(`SELECT to_regclass('public.${T2}_renamed') AS oid`);
    expect(rows[0]?.["oid"]).not.toBeNull();
    await schemaService.renameTable("public", `${T2}_renamed`, T2); // rename back for afterAll cleanup
  });

  it("rejects unsafe identifiers and expressions before touching PostgreSQL", async () => {
    await expect(
      schemaService.createTable({ schema: "public", name: "bad; DROP TABLE users --", columns: [{ name: "id", dataType: "uuid" }] }),
    ).rejects.toMatchObject({ code: "INVALID_SCHEMA_OPERATION" });

    await expect(
      schemaService.createTable({ schema: "public", name: "schema_pkg_test_reject", columns: [{ name: "id", dataType: "uuid; DROP TABLE users" }] }),
    ).rejects.toMatchObject({ code: "INVALID_SCHEMA_OPERATION" });

    await expect(
      schemaService.addCheckConstraint("public", T1, "c1", "price >= 0); DROP TABLE users; --"),
    ).rejects.toMatchObject({ code: "INVALID_SCHEMA_OPERATION" });

    await expect(
      schemaService.addCheckConstraint("public", T1, "c1", "price >= 0 -- sneaky comment"),
    ).rejects.toMatchObject({ code: "INVALID_SCHEMA_OPERATION" });

    await expect(
      schemaService.addColumn("public", T1, { name: "x", dataType: "text", default: "(SELECT 1); DROP TABLE users" }),
    ).rejects.toMatchObject({ code: "INVALID_SCHEMA_OPERATION" });
  });

  it("drop table cleans up", async () => {
    await schemaService.dropTable("public", T2, true);
    const { rows } = await database.query(`SELECT to_regclass('public.${T2}') AS oid`);
    expect(rows[0]?.["oid"]).toBeNull();
  });
});
