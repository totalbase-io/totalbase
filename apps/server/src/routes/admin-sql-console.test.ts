import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

describe("admin SQL Console routes and their settings", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  const saved: Partial<Record<"sql_console.enabled" | "sql_console.max_rows", { overridden: boolean; value: unknown }>> = {};

  const post = (url: string, payload?: Record<string, unknown>) =>
    app.inject({ method: "POST", url, ...(payload === undefined ? {} : { payload }), headers: { authorization: `Bearer ${adminToken}` } });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    for (const key of ["sql_console.enabled", "sql_console.max_rows"] as const) {
      saved[key] = { overridden: await context.settings.isOverridden(key), value: await context.settings.get(key) };
    }
  });

  afterAll(async () => {
    // Shared with local development: leave these as they were.
    for (const key of ["sql_console.enabled", "sql_console.max_rows"] as const) {
      const entry = saved[key]!;
      if (entry.overridden) await context.settings.set(key, entry.value as never);
      else await context.settings.reset(key);
    }
    await app.close();
    await database.close();
  });

  it("caps the rows a query returns at sql_console.max_rows", async () => {
    await context.settings.set("sql_console.enabled", true);
    await context.settings.set("sql_console.max_rows", 2);
    const res = await post("/admin/api/sql/execute", { data: { sql: "SELECT generate_series(1, 4) AS n" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ rowCount: 4, truncated: true });
    expect(res.json().data.rows).toHaveLength(2);
  });

  it("refuses to execute or explain while sql_console.enabled is off", async () => {
    await context.settings.set("sql_console.enabled", false);
    for (const url of ["/admin/api/sql/execute", "/admin/api/sql/explain"]) {
      const res = await post(url, { data: { sql: "SELECT 1" } });
      expect([res.statusCode, res.json().errors[0].code], url).toEqual([403, "SQL_CONSOLE_DISABLED"]);
    }
    await context.settings.set("sql_console.enabled", true);
    expect((await post("/admin/api/sql/execute", { data: { sql: "SELECT 1" } })).statusCode).toBe(200);
  });

  it("takes the SQL inside data: a bare or missing body is a 400, and runs nothing", async () => {
    await context.settings.set("sql_console.enabled", true);
    for (const url of ["/admin/api/sql/execute", "/admin/api/sql/explain"]) {
      for (const payload of [undefined, { sql: "SELECT 1" }]) {
        const res = await post(url, payload);
        expect([res.statusCode, res.json().errors[0].code], url).toEqual([400, "INVALID_QUERY"]);
      }
    }
  });

  it("answers a failed statement with PostgreSQL's DETAIL, HINT, SQLSTATE and position", async () => {
    await context.settings.set("sql_console.enabled", true);
    const raised = await post("/admin/api/sql/execute", {
      data: { sql: "DO $$ BEGIN RAISE EXCEPTION 'boom' USING DETAIL = 'the detail', HINT = 'the hint'; END $$" },
    });
    expect(raised.statusCode).toBe(422);
    expect(raised.json().errors[0]).toMatchObject({ source: "POSTGRESQL", message: "boom", detail: "the detail", hint: "the hint", sqlstate: "P0001" });

    // The position counts characters of the script as sent, 1-based.
    const sql = "SELECT 1;\nSELEC 2";
    const syntax = await post("/admin/api/sql/execute", { data: { sql } });
    expect(syntax.json().errors[0]).toMatchObject({ sqlstate: "42601", position: sql.indexOf("SELEC 2") + 1 });

    // EXPLAIN's own prefix is not counted: the position points into what was typed.
    const explained = await post("/admin/api/sql/explain", { data: { sql: "SELECT relnam FROM pg_class" } });
    expect(explained.json().errors[0]).toMatchObject({ sqlstate: "42703", position: "SELECT relnam".indexOf("relnam") + 1 });
    expect(explained.json().errors[0].hint).toMatch(/relname/);
  });

  it("keeps PostgreSQL's diagnostics out of the Data API's errors (AGENTS.md section 20)", async () => {
    const { rows } = await database.query<{ name: string }>("SELECT name FROM totalbase.roles LIMIT 1");
    const res = await post("/api/totalbase/table/roles", { data: { name: rows[0]!.name } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const error = res.json().errors[0];
    expect(error.source).toBe("POSTGRESQL");
    for (const key of ["detail", "hint", "sqlstate", "position"]) expect(error, key).not.toHaveProperty(key);
  });

  it("returns a page of history with its total in meta", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/sql/history?limit=1", headers: { authorization: `Bearer ${adminToken}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().meta.total).toBeGreaterThanOrEqual(1);
  });
});
