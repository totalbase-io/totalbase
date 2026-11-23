import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DashboardsAdminService } from "./dashboards-admin-service.js";
import { queryTables } from "./dashboards-runner.js";
import type { DashboardsContext } from "./dashboards-types.js";

/**
 * Widget SQL as the widget query role (Dashboards.md §2.10) - on a real PostgreSQL: it reads what the role may and
 * nothing else, and the query can't leave the role, by `set_config('role', ...)` or by SQL a variable's value turns
 * into (security regressions, AGENTS.md §23).
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));
const READER = "dashboards_pkg_test_reader";
const OPEN = "dashboards_pkg_test_role_open";
const SECRET = "dashboards_pkg_test_role_secret";
const DOMAIN = "dashboards_pkg_test_role_email";
const LIMITS = { timeoutMs: 5_000, maxRows: 100 };
const NO_VARS = { userId: null, variables: [], values: {} };
const FUNCTION = "totalbase.dashboards_query(text, text[], name)";

async function expectCode(promise: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  await expect(promise).rejects.toSatisfy((error: unknown) => error instanceof TotalBaseError && error.code === code && (!message || message.test(error.message)));
}

describe("the widget query role (integration, Dashboards.md §2.10)", () => {
  let database: Database;
  let role = READER;
  let dashboards: DashboardsAdminService;
  let dashboardId: string;
  let userId: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    dashboards = new DashboardsAdminService(database, { queryRole: async () => role });

    await database.query(`DELETE FROM totalbase.dashboards WHERE slug = 'dashboards-pkg-test-role'`);
    await database.query(`DELETE FROM totalbase.users WHERE email = 'dashboards-pkg-test-role@example.com'`);
    await database.query(`DROP TABLE IF EXISTS public.${OPEN}, public.${SECRET}`);
    await database.query(`DROP DOMAIN IF EXISTS public.${DOMAIN}`);
    await database.query(`ALTER FUNCTION ${FUNCTION} OWNER TO CURRENT_USER`);
    await database.query(`DROP ROLE IF EXISTS ${READER}`);

    await database.query(`CREATE ROLE ${READER} NOLOGIN`);
    await database.query(`GRANT ${READER} TO CURRENT_USER`);
    await database.query(`CREATE DOMAIN public.${DOMAIN} AS text CHECK (VALUE LIKE '%@%')`);
    await database.query(`CREATE TABLE public.${OPEN} (id serial PRIMARY KEY, status text NOT NULL, total numeric(12,2) NOT NULL, contact public.${DOMAIN})`);
    await database.query(`INSERT INTO public.${OPEN} (status, total, contact) VALUES ('PAID', 10.5, 'a@example.com'), ('PAID', 4.5, NULL), ('PENDING', 3, NULL)`);
    await database.query(`CREATE TABLE public.${SECRET} (id serial PRIMARY KEY, token text NOT NULL)`);
    await database.query(`INSERT INTO public.${SECRET} (token) VALUES ('top-secret')`);
    await database.query(`GRANT USAGE ON SCHEMA public TO ${READER}`);
    await database.query(`GRANT SELECT ON public.${OPEN} TO ${READER}`);

    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.users (email, name, password_hash) VALUES ('dashboards-pkg-test-role@example.com', 'Role Tester', 'secret-hash') RETURNING id`,
    );
    userId = rows[0]!.id;
    dashboardId = (await dashboards.create({ name: "dashboards pkg test role", slug: "dashboards-pkg-test-role" })).id;
    await dashboards.update(dashboardId, {
      variables: [
        { name: "note", label: "Note", type: "TEXT" },
        { name: "min_total", label: "Min total", type: "NUMBER" },
        { name: "statuses", label: "Statuses", type: "SELECT", multiple: true, options: { source: "QUERY", query: `SELECT DISTINCT status FROM public.${OPEN} ORDER BY 1` } },
      ],
    });
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [dashboardId]);
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]);
    await database.query(`DROP TABLE IF EXISTS public.${OPEN}, public.${SECRET}`);
    await database.query(`DROP DOMAIN IF EXISTS public.${DOMAIN}`);
    await database.query(`ALTER FUNCTION ${FUNCTION} OWNER TO CURRENT_USER`);
    await database.query(`REVOKE ALL ON SCHEMA public FROM ${READER}`);
    await database.query(`DROP ROLE IF EXISTS ${READER}`);
    await database.close();
  });

  const draft = (sql: string, values: Record<string, unknown> = {}) => dashboards.executeDraftQuery(dashboardId, sql, LIMITS, { userId }, values);

  it("runs the query as the role, its function handed to it - typed and traced to its columns as on TotalBase's role", async () => {
    const result = await dashboards.executeQuery(`SELECT current_user AS who, status, total, total AS again, 1::int8 AS one FROM public.${OPEN} ORDER BY id LIMIT 1`, LIMITS, NO_VARS);
    expect(result.rows).toEqual([{ who: READER, status: "PAID", total: 10.5, again: 10.5, one: 1 }]);
    expect(result.columns.map((column) => [column.name, column.dataType])).toEqual([["who", "name"], ["status", "text"], ["total", "numeric"], ["again", "numeric"], ["one", "bigint"]]);
    expect(result.columns[1]!.origin).toMatchObject({ schema: "public", table: OPEN, column: "status" });
    const { rows } = await database.query<{ owner: string }>(`SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid = $1::regprocedure`, [FUNCTION]);
    expect(rows[0]!.owner).toBe(READER);
  });

  it("reads nothing the role can't: TotalBase's tables, a table not granted to it", async () => {
    await expect(dashboards.executeQuery(`SELECT password_hash FROM totalbase.users`, LIMITS, NO_VARS)).rejects.toThrow(/permission denied for schema totalbase/);
    await expect(dashboards.executeQuery(`SELECT token FROM public.${SECRET}`, LIMITS, NO_VARS)).rejects.toThrow(/permission denied for table/);
  });

  it("can't leave the role: set_config('role', ...) is refused inside the function (security regression)", async () => {
    await expect(dashboards.executeQuery(`SELECT set_config('role', 'none', true) AS escaped, current_user AS who`, LIMITS, NO_VARS)).rejects.toThrow(/cannot set parameter "role" within security-definer function/);
    await expect(dashboards.executeQuery(`SELECT set_config('role', 'none', true) AS e, query_to_xml('SELECT token FROM public.${SECRET}', true, false, '')::text AS x`, LIMITS, NO_VARS)).rejects.toThrow(/cannot set parameter "role"/);
    // Dynamic SQL alone runs as the role too.
    await expect(dashboards.executeQuery(`SELECT query_to_xml('SELECT password_hash FROM totalbase.users', true, false, '')::text AS x`, LIMITS, NO_VARS)).rejects.toThrow(/permission denied/);
  });

  it("confines SQL a variable's value becomes - an author's dynamic SQL, injected (security regression)", async () => {
    const dynamic = `SELECT query_to_xml('SELECT status FROM public.${OPEN} WHERE status = ''' || $VAR.note || '''', true, false, '')::text AS x`;
    await expect(draft(dynamic, { note: "PAID" })).resolves.toMatchObject({ rows: [{ x: expect.stringContaining("PAID") }] });
    await expect(draft(dynamic, { note: `' UNION SELECT token FROM public.${SECRET} --` })).rejects.toThrow(/permission denied for table/);
    await expect(draft(dynamic, { note: `' UNION SELECT set_config('role', 'none', true) --` })).rejects.toThrow(/cannot set parameter "role"/);
  });

  it("binds $USER.* and $VAR.* as before - TotalBase reads the viewer's row, the role never does", async () => {
    const result = await draft(
      `SELECT $USER.name AS name, count(*) AS n, sum(total) AS total FROM public.${OPEN} WHERE total >= $VAR.min_total AND status = ANY($VAR.statuses)`,
      { min_total: 4, statuses: ["PAID", "PENDING"] },
    );
    expect(result.rows).toEqual([{ name: "Role Tester", n: 2, total: 15 }]);
    const options = await dashboards.variableOptions(dashboardId, "statuses", "DRAFT", LIMITS, { userId });
    expect(options.map((option) => option.value)).toEqual(["PAID", "PENDING"]);
  });

  it("runs a widget's totals as the role too, and plans what it can't read as a refusal", async () => {
    const widget = await dashboards.addWidget(dashboardId, {
      type: "TABLE", gridX: 0, gridY: 0, gridW: 6, gridH: 4,
      query: `SELECT status, total FROM public.${OPEN}`,
      config: { columnSettings: { total: { total: "sum" } } },
    });
    const run = await dashboards.executeDraftWidget(dashboardId, widget.id, LIMITS, { userId }, {});
    expect(run.totals).toEqual({ total: "18.00" });
    await dashboards.updateWidget(dashboardId, widget.id, { query: `SELECT token FROM public.${SECRET}` });
    await expect(dashboards.executeDraftWidget(dashboardId, widget.id, LIMITS, { userId }, {})).rejects.toMatchObject({ code: "DASHBOARD_WIDGET_QUERY_FAILED" });
    await dashboards.deleteWidget(dashboardId, widget.id);
  });

  // A domain's column is described as its base type, and RETURN QUERY takes the exact type only.
  it("reads a domain's column, as its base type", async () => {
    const result = await dashboards.executeQuery(`SELECT contact, contact AS again FROM public.${OPEN} ORDER BY id LIMIT 1`, LIMITS, NO_VARS);
    expect(result.rows).toEqual([{ contact: "a@example.com", again: "a@example.com" }]);
    expect(result.columns[0]!.origin).toMatchObject({ table: OPEN, column: "contact" });
  });

  it("finds the tables a query reads through EXPLAIN, as the role", async () => {
    const ctx = (dashboards as unknown as { ctx: DashboardsContext }).ctx;
    expect(await queryTables(ctx, `SELECT status FROM public.${OPEN}`, [], 5_000)).toEqual([{ schema: "public", name: OPEN }]);
  });

  it("asks for a real type where a column has none (an anonymous record)", async () => {
    await expectCode(dashboards.executeQuery(`SELECT row(1, 2) AS pair`, LIMITS, NO_VARS), "DASHBOARD_QUERY_INVALID", /pair/);
    await expect(dashboards.executeQuery(`SELECT row(1, 2)::text AS pair`, LIMITS, NO_VARS)).resolves.toMatchObject({ rows: [{ pair: "(1,2)" }] });
  });

  it("refuses to run when its function was given to someone else, and takes it back on the next run", async () => {
    await database.query(`ALTER FUNCTION ${FUNCTION} OWNER TO CURRENT_USER`);
    await expectCode(dashboards.executeQuery(`SELECT 1 AS n`, LIMITS, NO_VARS), "DASHBOARD_QUERY_ROLE_UNAVAILABLE");
    await expect(dashboards.executeQuery(`SELECT current_user AS who`, LIMITS, NO_VARS)).resolves.toMatchObject({ rows: [{ who: READER }] });
  });

  it("refuses a role it can't use, and Status names what's wrong", async () => {
    expect(await dashboards.queryRoleProblems()).toEqual([]);
    const { rows } = await database.query<{ me: string }>(`SELECT current_user AS me`);
    for (const [name, problem] of [["dashboards_pkg_test_nobody", "missing"], [rows[0]!.me, "own_role"]] as const) {
      const other = new DashboardsAdminService(database, { queryRole: async () => name });
      await expectCode(other.executeQuery(`SELECT 1 AS n`, LIMITS, NO_VARS), "DASHBOARD_QUERY_ROLE_UNAVAILABLE");
      expect(await other.queryRoleProblems()).toContain(problem);
    }
    // PostgreSQL 16+: a membership that doesn't inherit the role's privileges can't call the function it owns.
    const { rows: version } = await database.query<{ n: number }>(`SELECT current_setting('server_version_num')::int AS n`);
    if (version[0]!.n >= 160000) {
      await database.query(`GRANT ${READER} TO CURRENT_USER WITH INHERIT FALSE`);
      try {
        const fresh = new DashboardsAdminService(database, { queryRole: async () => READER });
        await expectCode(fresh.executeQuery(`SELECT 1 AS n`, LIMITS, NO_VARS), "DASHBOARD_QUERY_ROLE_UNAVAILABLE", /INHERIT TRUE/);
        expect(await fresh.queryRoleProblems()).toContain("not_granted");
      } finally {
        await database.query(`GRANT ${READER} TO CURRENT_USER WITH INHERIT TRUE`);
      }
    }
    await database.query(`GRANT USAGE ON SCHEMA totalbase TO ${READER}`);
    try {
      expect(await dashboards.queryRoleProblems()).toEqual(["reads_totalbase"]);
    } finally {
      await database.query(`REVOKE USAGE ON SCHEMA totalbase FROM ${READER}`);
    }
  });

  it("runs as TotalBase's role when the setting is empty", async () => {
    role = "";
    try {
      const { rows } = await database.query<{ me: string }>(`SELECT current_user AS me`);
      await expect(dashboards.executeQuery(`SELECT current_user AS who`, LIMITS, NO_VARS)).resolves.toMatchObject({ rows: [{ who: rows[0]!.me }] });
    } finally {
      role = READER;
    }
  });
});
