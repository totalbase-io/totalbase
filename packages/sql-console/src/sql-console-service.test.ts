import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqlConsoleService } from "./sql-console-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));
const TABLE = "sql_console_pkg_test_t1";

describe("SqlConsoleService (integration)", () => {
  let database: Database;
  let consoleService: SqlConsoleService;
  let adminId: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    consoleService = new SqlConsoleService(database);

    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await database.query(`DELETE FROM totalbase.users WHERE email = 'sql-console-pkg-test@example.com'`);
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.users (email, password_hash)
       VALUES ('sql-console-pkg-test@example.com', 'x')
       RETURNING id`,
    );
    adminId = rows[0]!.id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.sql_queries WHERE admin = $1`, [adminId]);
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [adminId]);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await database.close();
  });

  it("executes a simple SELECT and returns typed columns + rows", async () => {
    const result = await consoleService.execute(adminId, { sql: "SELECT 1 AS n, 'hi'::text AS label" });
    expect(result.status).toBe("EXECUTED");
    expect(result.rows).toEqual([{ n: 1, label: "hi" }]);
    expect(result.columns).toEqual([
      { name: "n", dataType: "integer" },
      { name: "label", dataType: "text" },
    ]);
  });

  it("cuts the returned rows to maxRows, keeping the real row count", async () => {
    const result = await consoleService.execute(adminId, { sql: "SELECT generate_series(1, 5) AS n", maxRows: 3 });
    expect(result.rows).toHaveLength(3);
    expect(result.rowCount).toBe(5);
    expect(result.truncated).toBe(true);
    const whole = await consoleService.execute(adminId, { sql: "SELECT generate_series(1, 2) AS n", maxRows: 3 });
    expect([whole.rows.length, whole.truncated]).toEqual([2, false]);
  });

  it("executes a multi-statement script via the simple query protocol", async () => {
    const result = await consoleService.execute(adminId, {
      sql: `CREATE TABLE public.${TABLE} (id integer); INSERT INTO public.${TABLE} VALUES (1), (2); SELECT * FROM public.${TABLE} ORDER BY id`,
    });
    expect(result.status).toBe("EXECUTED");
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("answers every statement of a script, in order, each with its own rows and command", async () => {
    const result = await consoleService.execute(adminId, {
      sql: "SELECT 1 AS a; SELECT generate_series(1, 4) AS b; CREATE TEMP TABLE sql_console_tmp (x int)",
      maxRows: 3,
    });
    expect(result.statements.map((statement) => statement.command)).toEqual(["SELECT", "SELECT", "CREATE"]);
    expect(result.statements[0]).toMatchObject({ rows: [{ a: 1 }], rowCount: 1, truncated: false, columns: [{ name: "a", dataType: "integer" }] });
    expect(result.statements[1]).toMatchObject({ rowCount: 4, truncated: true });
    expect(result.statements[1]!.rows).toHaveLength(3);
    expect([result.rows, result.columns]).toEqual([[], []]);
  });

  it("rolls back the whole script in transactional mode when a later statement fails", async () => {
    await database.query(`DELETE FROM public.${TABLE}`);
    await expect(
      consoleService.execute(adminId, {
        sql: `INSERT INTO public.${TABLE} VALUES (99); SELECT 1/0`,
        transactional: true,
      }),
    ).rejects.toBeTruthy();

    const { rows } = await database.query(`SELECT * FROM public.${TABLE} WHERE id = 99`);
    expect(rows).toHaveLength(0);
  });

  it("records EXECUTED and FAILED attempts in history", async () => {
    await consoleService.execute(adminId, { sql: "SELECT 1" });
    await expect(consoleService.execute(adminId, { sql: "SELECT * FROM nonexistent_table_xyz" })).rejects.toBeTruthy();

    const { entries: history } = await consoleService.listHistory(adminId, 10);
    expect(history.some((h) => h.status === "EXECUTED")).toBe(true);
    expect(history.some((h) => h.status === "FAILED" && h.errorMessage)).toBe(true);

    const entry = await consoleService.getHistoryEntry(history[0]!.id);
    expect(entry.id).toBe(history[0]!.id);
    await expect(consoleService.getHistoryEntry("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
  });

  it("listHistory search filters by sql_text substring, case-insensitively", async () => {
    await database.query(`DELETE FROM totalbase.sql_queries WHERE admin = $1`, [adminId]);
    await consoleService.execute(adminId, { sql: "SELECT 'needle' AS haystack" });
    await consoleService.execute(adminId, { sql: "SELECT 1" });

    const matched = await consoleService.listHistory(adminId, 10, 0, "NEEDLE");
    expect(matched.entries).toHaveLength(1);
    expect(matched.total).toBe(1);
    expect(matched.entries[0]!.sqlText).toContain("needle");

    const unmatched = await consoleService.listHistory(adminId, 10, 0, "does-not-appear");
    expect(unmatched).toEqual({ entries: [], total: 0 });

    // total counts every match, not just the page.
    const firstPage = await consoleService.listHistory(adminId, 1, 0);
    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.total).toBe(2);
  });

  it("explain returns a query plan without executing the statement", async () => {
    await database.query(`DELETE FROM public.${TABLE}`);
    const plan = await consoleService.explain(`SELECT * FROM public.${TABLE}`);
    expect(plan).toBeDefined();
    const { rows } = await database.query(`SELECT * FROM public.${TABLE}`);
    expect(rows).toHaveLength(0); // EXPLAIN alone never runs the statement
  });

  it("explain refuses stacked statements instead of running the trailing one (security regression)", async () => {
    const table = "public.sql_console_pkg_test_explain";
    await database.query(`DROP TABLE IF EXISTS ${table}`);
    await database.query(`CREATE TABLE ${table} (id integer)`);
    try {
      await database.query(`INSERT INTO ${table} VALUES (1)`);
      await expect(consoleService.explain(`SELECT 1; DELETE FROM ${table}`)).rejects.toBeDefined();
      const { rows } = await database.query(`SELECT * FROM ${table}`);
      expect(rows).toHaveLength(1);
    } finally {
      await database.query(`DROP TABLE IF EXISTS ${table}`);
    }
  });

  it("surfaces PostgreSQL NOTICE messages", async () => {
    const result = await consoleService.execute(adminId, {
      sql: "DO $$ BEGIN RAISE NOTICE 'hello from sql console'; END $$",
    });
    expect(result.status).toBe("EXECUTED");
    expect(result.notices.some((n) => n.message.includes("hello from sql console"))).toBe(true);
  });

  it("purgeHistory deletes only entries older than the given date", async () => {
    // purgeHistory is deliberately global (a retention sweep, not scoped to
    // one admin) - this dev/test database can carry unrelated history from
    // other admins and manual testing, so assert on this admin's own
    // entry surviving/disappearing rather than exact deletedCount totals.
    await database.query(`DELETE FROM totalbase.sql_queries WHERE admin = $1`, [adminId]);
    await consoleService.execute(adminId, { sql: "SELECT 1" });

    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);

    await consoleService.purgeHistory(past);
    expect((await consoleService.listHistory(adminId, 10)).entries).toHaveLength(1);

    await consoleService.purgeHistory(future);
    expect((await consoleService.listHistory(adminId, 10)).entries).toHaveLength(0);
  });
});
