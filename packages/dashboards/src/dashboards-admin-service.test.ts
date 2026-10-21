import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DashboardsAdminService } from "./dashboards-admin-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));
const TABLE = "dashboards_pkg_test_orders";
const SEQUENCE = "dashboards_pkg_test_seq";
const LIMITS = { timeoutMs: 5_000, maxRows: 100 };
const NO_VARS = { userId: null, variables: [], values: {} };

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy((error: unknown) => error instanceof TotalBaseError && error.code === code);
}

describe("DashboardsAdminService (integration)", () => {
  let database: Database;
  let dashboards: DashboardsAdminService;
  let dashboardId: string;
  let roleA: string;
  let roleB: string;

  async function orderCount(): Promise<number> {
    const { rows } = await database.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${TABLE}`);
    return rows[0]!.n;
  }

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    dashboards = new DashboardsAdminService(database);

    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await database.query(`DROP SEQUENCE IF EXISTS public.${SEQUENCE}`);
    await database.query(`DELETE FROM totalbase.dashboards WHERE slug LIKE 'dashboards-pkg-test%'`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE 'dashboards-pkg-test%'`);

    await database.query(`CREATE TABLE public.${TABLE} (id serial PRIMARY KEY, status text NOT NULL, total numeric(12,2) NOT NULL)`);
    await database.query(`INSERT INTO public.${TABLE} (status, total) SELECT CASE WHEN i % 2 = 0 THEN 'PAID' ELSE 'PENDING' END, i FROM generate_series(1, 10) AS i`);
    await database.query(`CREATE SEQUENCE public.${SEQUENCE}`);

    const { rows: roles } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.roles (name) VALUES ('dashboards-pkg-test-a'), ('dashboards-pkg-test-b') RETURNING id`,
    );
    roleA = roles[0]!.id;
    roleB = roles[1]!.id;

    dashboardId = (await dashboards.create({ name: "dashboards pkg test", slug: "dashboards-pkg-test" })).id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.dashboards WHERE slug LIKE 'dashboards-pkg-test%'`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE 'dashboards-pkg-test%'`);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await database.query(`DROP SEQUENCE IF EXISTS public.${SEQUENCE}`);
    await database.close();
  });

  describe("executeQuery - read-only guarantees (AGENTS.md section 7)", () => {
    it("runs in the viewer's time zone - a day is cut where they see it, and nothing else keeps it", async () => {
      const zone = async (timezone?: string) =>
        (await dashboards.executeQuery(`SELECT current_setting('TimeZone') AS tz, ('2026-09-30T23:30:00Z'::timestamptz)::date::text AS day`, LIMITS, { ...NO_VARS, timezone })).rows[0];
      expect(await zone("America/Argentina/Buenos_Aires")).toEqual({ tz: "America/Argentina/Buenos_Aires", day: "2026-09-30" });
      expect(await zone("Europe/Madrid")).toEqual({ tz: "Europe/Madrid", day: "2026-10-01" });
      const { rows } = await database.query<{ tz: string }>(`SELECT current_setting('TimeZone') AS tz`);
      expect(rows[0]!.tz).not.toBe("Europe/Madrid");
    });

    it("returns rows and resolved column types", async () => {
      const result = await dashboards.executeQuery(
        `SELECT status, sum(total) AS total FROM public.${TABLE} GROUP BY status ORDER BY status;`,
        LIMITS,
        NO_VARS,
      );
      // status is the table's column (its origin); sum(total) an expression, with none - and a number.
      expect(result.columns).toMatchObject([
        { name: "status", dataType: "text", origin: { table: TABLE, column: "status" } },
        { name: "total", dataType: "numeric" },
      ]);
      expect(result.columns[1]!.origin).toBeUndefined();
      expect(result.rows).toEqual([
        { status: "PAID", total: 30 },
        { status: "PENDING", total: 25 },
      ]);
      expect(result.truncated).toBe(false);
    });

    it("rejects a write performed inside a function call (READ ONLY transaction)", async () => {
      await expectCode(dashboards.executeQuery(`SELECT nextval('public.${SEQUENCE}')`, LIMITS, NO_VARS), "READ_ONLY_SQL_TRANSACTION");
      const { rows } = await database.query<{ is_called: boolean }>(`SELECT is_called FROM public.${SEQUENCE}`);
      expect(rows[0]!.is_called).toBe(false);
    });

    it("rejects plain DML", async () => {
      await expect(dashboards.executeQuery(`DELETE FROM public.${TABLE}`, LIMITS, NO_VARS)).rejects.toBeInstanceOf(TotalBaseError);
      expect(await orderCount()).toBe(10);
    });

    it("rejects a data-modifying CTE", async () => {
      await expect(
        dashboards.executeQuery(`WITH gone AS (DELETE FROM public.${TABLE} RETURNING *) SELECT * FROM gone`, LIMITS, NO_VARS),
      ).rejects.toBeInstanceOf(TotalBaseError);
      expect(await orderCount()).toBe(10);
    });

    it("rejects stacked statements without running the second one", async () => {
      await expect(dashboards.executeQuery(`SELECT 1; DROP TABLE public.${TABLE}`, LIMITS, NO_VARS)).rejects.toBeInstanceOf(TotalBaseError);
      await expect(dashboards.executeQuery(`SELECT 1) AS x; DROP TABLE public.${TABLE}; SELECT (1`, LIMITS, NO_VARS)).rejects.toBeInstanceOf(TotalBaseError);
      expect(await orderCount()).toBe(10);
    });

    it("enforces statement_timeout", async () => {
      await expectCode(dashboards.executeQuery(`SELECT pg_sleep(2)`, { timeoutMs: 200, maxRows: 10 }, NO_VARS), "QUERY_CANCELED");
    });

    it("caps rows and reports truncation", async () => {
      const result = await dashboards.executeQuery(`SELECT * FROM public.${TABLE} ORDER BY id`, { timeoutMs: 5_000, maxRows: 3 }, NO_VARS);
      expect(result.rows).toHaveLength(3);
      expect(result.truncated).toBe(true);
    });

    it("tolerates a trailing line comment", async () => {
      const result = await dashboards.executeQuery(`SELECT 1 AS one -- trailing comment`, LIMITS, NO_VARS);
      expect(result.rows).toEqual([{ one: 1 }]);
    });

    it("rejects an empty query", async () => {
      await expectCode(dashboards.executeQuery("  ;  ", LIMITS, NO_VARS), "DASHBOARD_QUERY_INVALID");
    });
  });

  describe("widgets", () => {
    it("is added unconfigured and refuses to run until it has a query", async () => {
      const widget = await dashboards.addWidget(dashboardId, { type: "KPI", gridX: 0, gridY: 0, gridW: 3, gridH: 2 });
      expect(widget.query).toBeNull();
      await expectCode(dashboards.executeDraftWidget(dashboardId, widget.id, LIMITS, { userId: null }, {}), "DASHBOARD_WIDGET_NOT_CONFIGURED");
    });

    it("holds the page catalog's display widgets - their props and formulas a page control's, a query optional (D3)", async () => {
      const text = await dashboards.addWidget(dashboardId, {
        type: "TText",
        gridX: 0,
        gridY: 2,
        gridW: 6,
        gridH: 2,
        config: { props: { label: "Hello" }, bindings: { label: { kind: "formula", formula: '"Revenue: " + {{row.n}}' }, title: { kind: "formula", formula: '"Of " + {{vars.status.label}}' } } },
      });
      expect(text).toMatchObject({ type: "TText", query: null, config: { props: { label: "Hello" } } });
      // Its formulas' rows: a query, run as any widget's.
      await dashboards.updateWidget(dashboardId, text.id, { query: "SELECT 5 AS n" });
      expect((await dashboards.executeDraftWidget(dashboardId, text.id, LIMITS, { userId: null }, {})).rows).toEqual([{ n: 5 }]);
      await expectCode(dashboards.updateWidget(dashboardId, text.id, { config: { props: { visible: false } } }), "DASHBOARD_WIDGET_INVALID");
      await expectCode(dashboards.addWidget(dashboardId, { type: "TFrame", gridX: 0, gridY: 2, gridW: 6, gridH: 5, config: { props: { url: "https://{{vars.host}}/" } } }), "DASHBOARD_WIDGET_INVALID");
      await dashboards.deleteWidget(dashboardId, text.id);
    });

    it("keeps a widget's config to its type's properties, each of its kind (the dashboard widget catalog)", async () => {
      const kpi = await dashboards.addWidget(dashboardId, { type: "KPI", gridX: 9, gridY: 2, gridW: 3, gridH: 2 });
      const saved = await dashboards.updateWidget(dashboardId, kpi.id, { config: { roles: { value: "n" }, displayFormat: "#,##0.00", showDelta: true } });
      expect(saved.config).toEqual({ roles: { value: "n" }, displayFormat: "#,##0.00", showDelta: true });
      await expectCode(dashboards.updateWidget(dashboardId, kpi.id, { config: { cluster: true } }), "DASHBOARD_WIDGET_INVALID");
      await expectCode(dashboards.updateWidget(dashboardId, kpi.id, { config: { compact: "2" } }), "DASHBOARD_WIDGET_INVALID");
      // A type the catalog doesn't have, as an HTTP body could send it.
      await expectCode(dashboards.addWidget(dashboardId, { type: "SCATTER" as never, gridX: 0, gridY: 4, gridW: 3, gridH: 2 }), "DASHBOARD_WIDGET_INVALID");
    });

    it("checks each role against what the query returns - on save and on run (D1)", async () => {
      const kpi = await dashboards.addWidget(dashboardId, { type: "KPI", gridX: 0, gridY: 20, gridW: 3, gridH: 2 });
      await dashboards.updateWidget(dashboardId, kpi.id, { query: "SELECT 'x' AS label, 5 AS n" });
      // A column the query doesn't return, or of a kind the role doesn't take: refused, naming the role and the columns.
      await expect(dashboards.updateWidget(dashboardId, kpi.id, { config: { roles: { value: "no_existe" } } })).rejects.toMatchObject({
        code: "DASHBOARD_WIDGET_ROLES_INVALID",
        message: 'KPI\'s Value: the query returns no column "no_existe" - it returns label (text), n (integer).',
      });
      await expect(dashboards.updateWidget(dashboardId, kpi.id, { config: { roles: { value: "label" } } })).rejects.toMatchObject({ code: "DASHBOARD_WIDGET_ROLES_INVALID" });
      // A query changed under a saved config is checked too.
      await dashboards.updateWidget(dashboardId, kpi.id, { config: { roles: { value: "n" } } });
      await expectCode(dashboards.updateWidget(dashboardId, kpi.id, { query: "SELECT 'x' AS label" }), "DASHBOARD_WIDGET_ROLES_INVALID");
      // A query PostgreSQL refuses saves as is - its run says why.
      await dashboards.updateWidget(dashboardId, kpi.id, { query: "SELECT n FROM no_such_table" });
      // On run: a column the query stopped returning (here, through a table changed after the save).
      await dashboards.updateWidget(dashboardId, kpi.id, { query: `SELECT count(*) AS n FROM public.${TABLE}` });
      await database.query(`UPDATE totalbase.dashboards_widgets SET query = 'SELECT 1 AS other' WHERE id = $1`, [kpi.id]);
      await expectCode(dashboards.executeDraftWidget(dashboardId, kpi.id, LIMITS, { userId: null }, {}), "DASHBOARD_WIDGET_ROLES_INVALID");
      await dashboards.deleteWidget(dashboardId, kpi.id);
    });

    it("creates a widget configured or not at all, at least its type's size (DB7, DB11)", async () => {
      const count = async () => (await dashboards.listWidgets(dashboardId)).length;
      const before = await count();
      await expectCode(dashboards.addWidget(dashboardId, { type: "KPI", gridX: 0, gridY: 30, gridW: 3, gridH: 2, query: "SELECT 1 AS a", config: { roles: { value: "no_existe" } } }), "DASHBOARD_WIDGET_ROLES_INVALID");
      await expectCode(dashboards.addWidget(dashboardId, { type: "KPI", gridX: 0, gridY: 30, gridW: 1, gridH: 1 }), "DASHBOARD_WIDGET_INVALID");
      expect(await count()).toBe(before);
      const made = await dashboards.addWidget(dashboardId, { type: "KPI", gridX: 0, gridY: 30, gridW: 3, gridH: 2, query: "SELECT 1 AS a", config: { roles: { value: "a" } } });
      expect(made).toMatchObject({ query: "SELECT 1 AS a", config: { roles: { value: "a" } } });
      await expectCode(dashboards.updateWidget(dashboardId, made.id, { gridW: 1 }), "DASHBOARD_WIDGET_INVALID");
      await dashboards.deleteWidget(dashboardId, made.id);
    });

    it("refuses to publish a widget that fails, naming it; its run fails with the dashboard's own error (DB10)", async () => {
      const { rows: [own] } = await database.query<{ id: string }>(`INSERT INTO totalbase.dashboards (name, slug) VALUES ('dashboards pkg test broken', 'dashboards-pkg-test-broken') RETURNING id`);
      try {
        const bad = await dashboards.addWidget(own!.id, { type: "KPI", label: "Roto", gridX: 0, gridY: 0, gridW: 3, gridH: 2, query: "SELECT n FROM public.no_such_table" });
        await expect(dashboards.publish(own!.id, null)).rejects.toMatchObject({ code: "DASHBOARD_PUBLISH_BROKEN_WIDGETS", message: expect.stringContaining('"Roto": relation "public.no_such_table" does not exist') });
        await expect(dashboards.executeDraftWidget(own!.id, bad.id, LIMITS, { userId: null }, {})).rejects.toMatchObject({ code: "DASHBOARD_WIDGET_QUERY_FAILED", httpStatus: 422, sqlstate: "42P01" });
        await dashboards.updateWidget(own!.id, bad.id, { query: "SELECT pg_sleep(1)::text AS n, 1 AS v" });
        await expect(dashboards.executeDraftWidget(own!.id, bad.id, { timeoutMs: 100, maxRows: 10 }, { userId: null }, {})).rejects.toMatchObject({ code: "DASHBOARD_WIDGET_QUERY_TIMEOUT", httpStatus: 422 });
        await dashboards.updateWidget(own!.id, bad.id, { query: "SELECT 1 AS n" });
        expect((await dashboards.publish(own!.id, null)).version).toBe(1);
      } finally {
        await database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [own!.id]);
      }
    });

    it("switches a chart's type, keeping its query and what both types share - never to or from a presentation widget", async () => {
      const bar = await dashboards.addWidget(dashboardId, { type: "BAR", gridX: 0, gridY: 6, gridW: 6, gridH: 4 });
      await dashboards.updateWidget(dashboardId, bar.id, { query: "SELECT 'a' AS c, 1 AS n", config: { roles: { category: "c" }, stacked: true, showLegend: true } });
      const line = await dashboards.updateWidget(dashboardId, bar.id, { type: "LINE" });
      expect(line).toMatchObject({ type: "LINE", query: "SELECT 'a' AS c, 1 AS n", config: { roles: { category: "c" }, showLegend: true } });
      // Its roles carried to their equivalents: Category becomes a pie's Label.
      const pie = await dashboards.updateWidget(dashboardId, bar.id, { type: "PIE" });
      expect(pie.config).toEqual({ roles: { category: "c" }, showLegend: true });
      await dashboards.updateWidget(dashboardId, bar.id, { type: "BAR" });
      expect(line.config).not.toHaveProperty("stacked");
      await expectCode(dashboards.updateWidget(dashboardId, bar.id, { type: "TText" }), "DASHBOARD_WIDGET_INVALID");
      const text = await dashboards.addWidget(dashboardId, { type: "TText", gridX: 6, gridY: 6, gridW: 6, gridH: 2 });
      await expectCode(dashboards.updateWidget(dashboardId, text.id, { type: "KPI" }), "DASHBOARD_WIDGET_INVALID");
      await expectCode(dashboards.updateWidget(dashboardId, text.id, { type: "THeading" }), "DASHBOARD_WIDGET_INVALID");
      await expectCode(dashboards.updateWidget(dashboardId, bar.id, { type: "RADAR" }), "DASHBOARD_WIDGET_INVALID");
    });

    it("runs the published snapshot's query, not the live draft", async () => {
      const widget = await dashboards.addWidget(dashboardId, { type: "KPI", gridX: 0, gridY: 4, gridW: 3, gridH: 2 });
      await dashboards.updateWidget(dashboardId, widget.id, { query: `SELECT count(*) AS n FROM public.${TABLE}` });
      await dashboards.publish(dashboardId, null);

      await dashboards.updateWidget(dashboardId, widget.id, { query: `SELECT 42 AS n` });
      expect((await dashboards.executeDraftWidget(dashboardId, widget.id, LIMITS, { userId: null }, {})).rows).toEqual([{ n: 42 }]);
      expect((await dashboards.executePublishedWidget(dashboardId, widget.id, LIMITS, { userId: null }, {})).rows).toEqual([{ n: 10 }]);
    });
  });

  describe("role access", () => {
    it("lists a published dashboard only for granted roles; null scope (Administrator) sees all", async () => {
      await dashboards.publish(dashboardId, null);
      await dashboards.setRoles(dashboardId, [roleA]);

      const slugsFor = async (scope: string[] | null) => (await dashboards.listPublished(scope)).map((d) => d.slug);
      expect(await slugsFor([roleA])).toContain("dashboards-pkg-test");
      expect(await slugsFor([roleB])).not.toContain("dashboards-pkg-test");
      expect(await slugsFor(null)).toContain("dashboards-pkg-test");
      expect(await dashboards.isVisibleToRoles(dashboardId, [roleB])).toBe(false);
      expect(await dashboards.listRoles(dashboardId)).toEqual([roleA]);
    });

    it("never lists an unpublished dashboard, even for a granted role", async () => {
      const draft = await dashboards.create({ name: "dashboards pkg test draft", slug: "dashboards-pkg-test-draft" });
      await dashboards.setRoles(draft.id, [roleA]);
      expect((await dashboards.listPublished([roleA])).map((d) => d.slug)).not.toContain("dashboards-pkg-test-draft");
    });
  });
  describe("variables ($USER.* / $VAR.*, Dashboards.md §3)", () => {
    let userId: string;
    const VARIABLES = [
      { name: "status", label: "Status", type: "SELECT", options: { source: "STATIC", values: ["PAID", "PENDING"] } },
      { name: "statuses", label: "Statuses", type: "SELECT", multiple: true, options: { source: "QUERY", query: `SELECT DISTINCT status FROM public.${TABLE} ORDER BY 1` } },
      { name: "note", label: "Note", type: "TEXT" },
      { name: "min_total", label: "Min total", type: "NUMBER", default: { source: "constant", value: 5 } },
      { name: "period", label: "Period", type: "DATE_RANGE", default: { source: "constant", value: "all" } },
    ];

    beforeAll(async () => {
      await database.query(`DELETE FROM totalbase.users WHERE email = 'dashboards-pkg-test@example.com'`);
      const { rows } = await database.query<{ id: string }>(
        `INSERT INTO totalbase.users (email, name, password_hash) VALUES ('dashboards-pkg-test@example.com', 'Dash Tester', 'secret-hash') RETURNING id`,
      );
      userId = rows[0]!.id;
      await dashboards.update(dashboardId, { variables: VARIABLES });
    });

    afterAll(async () => {
      await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]);
    });

    const run = (sql: string, values: Record<string, unknown> = {}, user: string | null = null) =>
      dashboards.executeDraftQuery(dashboardId, sql, LIMITS, { userId: user ?? userId }, values);

    it("resolves $USER.* from the caller's real row, typed by its column", async () => {
      const result = await run(`SELECT $USER.id AS id, $USER.name AS name, pg_typeof($USER.id)::text AS type`);
      expect(result.rows).toEqual([{ id: userId, name: "Dash Tester", type: "uuid" }]);
    });

    it("refuses $USER.password_hash and unknown columns", async () => {
      await expectCode(run(`SELECT $USER.password_hash AS h`), "DASHBOARD_QUERY_INVALID");
      await expectCode(run(`SELECT $USER.nope AS x`), "DASHBOARD_QUERY_INVALID");
    });

    it("keeps a $VAR value as data - an injection attempt is just a string", async () => {
      const evil = `x'); DROP TABLE public.${TABLE}; --`;
      const result = await run(`SELECT $VAR.note AS note`, { note: evil });
      expect(result.rows).toEqual([{ note: evil }]);
      expect(await orderCount()).toBe(10);
    });

    it("does not substitute inside string literals", async () => {
      const result = await run(`SELECT '$VAR.note' AS literal`, { note: "ignored" });
      expect(result.rows).toEqual([{ literal: "$VAR.note" }]);
    });

    it("binds single and multiple SELECT values; unset = NULL", async () => {
      const single = await run(`SELECT count(*)::int AS n FROM public.${TABLE} WHERE ($VAR.status IS NULL OR status = $VAR.status)`, { status: "PAID" });
      expect(single.rows).toEqual([{ n: 5 }]);
      const all = await run(`SELECT count(*)::int AS n FROM public.${TABLE} WHERE ($VAR.status IS NULL OR status = $VAR.status)`);
      expect(all.rows).toEqual([{ n: 10 }]);
      const multi = await run(`SELECT count(*)::int AS n FROM public.${TABLE} WHERE status = ANY($VAR.statuses)`, { statuses: ["PAID", "PENDING"] });
      expect(multi.rows).toEqual([{ n: 10 }]);
    });

    it("validates values: static options, numbers", async () => {
      await expectCode(run(`SELECT $VAR.status AS s`, { status: "SHIPPED" }), "DASHBOARD_VARIABLE_INVALID");
      await expectCode(run(`SELECT $VAR.min_total AS m`, { min_total: "abc" }), "DASHBOARD_VARIABLE_INVALID");
    });

    it("applies defaults when a value is missing", async () => {
      const result = await run(`SELECT count(*)::int AS n FROM public.${TABLE} WHERE total >= $VAR.min_total`);
      expect(result.rows).toEqual([{ n: 6 }]);
    });

    it("resolves DATE_RANGE bounds in PostgreSQL (custom range end day inclusive, 'all' = NULL)", async () => {
      const custom = await run(
        `SELECT ($VAR.period.to - $VAR.period.from) = interval '31 days' AS ok, pg_typeof($VAR.period.from)::text AS type`,
        { period: { from: "2026-01-01", to: "2026-01-31" } },
      );
      expect(custom.rows).toEqual([{ ok: true, type: "timestamp with time zone" }]);
      const all = await run(`SELECT $VAR.period.from IS NULL AND $VAR.period.to IS NULL AS unbounded`);
      expect(all.rows).toEqual([{ unbounded: true }]);
      await expectCode(run(`SELECT $VAR.period AS p`), "DASHBOARD_QUERY_INVALID");
    });

    it("rejects undefined variables", async () => {
      await expectCode(run(`SELECT $VAR.missing AS m`), "DASHBOARD_QUERY_INVALID");
    });

    it("lists options from an options query", async () => {
      const options = await dashboards.variableOptions(dashboardId, "statuses", "DRAFT", LIMITS, { userId });
      expect(options).toEqual([{ value: "PAID", label: "PAID" }, { value: "PENDING", label: "PENDING" }]);
    });

    it("dependent variables: an options query reads another variable, bound from the current values - acyclic", async () => {
      const country = { name: "country", label: "Country", type: "SELECT", options: { source: "STATIC", values: ["AR", "UY"] } };
      const city = {
        name: "city", label: "City", type: "SELECT",
        options: { source: "QUERY", query: `SELECT c FROM (VALUES ('AR', 'Rosario'), ('AR', 'Salta'), ('UY', 'Salto')) t(k, c) WHERE ($VAR.country IS NULL OR k = $VAR.country) ORDER BY 1` },
      };
      const saved = await dashboards.update(dashboardId, { variables: [...VARIABLES, country, city] });
      expect(saved.variables.find((v) => v.name === "city")?.dependsOn).toEqual(["country"]);

      const cities = (values: Record<string, unknown>) => dashboards.variableOptions(dashboardId, "city", "DRAFT", LIMITS, { userId }, values).then((o) => o.map((x) => x.value));
      expect(await cities({})).toEqual(["Rosario", "Salta", "Salto"]);
      expect(await cities({ country: "UY" })).toEqual(["Salto"]);
      // Only the variables it depends on are bound: anything else sent is ignored.
      expect(await cities({ country: "AR", status: "PAID" })).toEqual(["Rosario", "Salta"]);

      const withQuery = (name: string, query: string) => ({ name, label: name, type: "SELECT", options: { source: "QUERY", query } });
      await expectCode(dashboards.update(dashboardId, { variables: [withQuery("a", "SELECT $VAR.a")] }), "DASHBOARD_VARIABLE_INVALID");
      await expectCode(dashboards.update(dashboardId, { variables: [withQuery("a", "SELECT $VAR.nope")] }), "DASHBOARD_VARIABLE_INVALID");
      await expectCode(dashboards.update(dashboardId, { variables: [withQuery("a", "SELECT $VAR.b"), withQuery("b", "SELECT $VAR.a")] }), "DASHBOARD_VARIABLE_INVALID");
      await dashboards.update(dashboardId, { variables: VARIABLES });
    });

    it("binds a published widget against the published snapshot's definitions", async () => {
      const widget = await dashboards.addWidget(dashboardId, { type: "KPI", gridX: 0, gridY: 8, gridW: 3, gridH: 2 });
      await dashboards.updateWidget(dashboardId, widget.id, { query: `SELECT $VAR.min_total AS m` });
      await dashboards.publish(dashboardId, null);
      await dashboards.update(dashboardId, { variables: VARIABLES.map((v) => (v.name === "min_total" ? { ...v, default: { source: "constant", value: 99 } } : v)) });

      expect((await dashboards.executeDraftWidget(dashboardId, widget.id, LIMITS, { userId }, {})).rows).toEqual([{ m: 99 }]);
      expect((await dashboards.executePublishedWidget(dashboardId, widget.id, LIMITS, { userId }, {})).rows).toEqual([{ m: 5 }]);
    });

    it("rejects invalid definitions", async () => {
      await expectCode(dashboards.update(dashboardId, { variables: [{ name: "Bad Name", type: "TEXT" }] }), "DASHBOARD_VARIABLE_INVALID");
      await expectCode(dashboards.update(dashboardId, { variables: [{ name: "a", type: "TEXT" }, { name: "a", type: "NUMBER" }] }), "DASHBOARD_VARIABLE_INVALID");
      await expectCode(dashboards.update(dashboardId, { variables: [{ name: "s", type: "SELECT" }] }), "DASHBOARD_VARIABLE_INVALID");
    });
  });
  describe("versions (Foundations.md §13)", () => {
    let id: string;
    beforeAll(async () => {
      id = (await dashboards.create({ name: "dashboards pkg test versions", slug: "dashboards-pkg-test-versions" })).id;
    });

    it("starts unpublished, publishes, and treats an unchanged publish as a no-op", async () => {
      expect((await dashboards.getWithStatus(id)).hasUnpublishedChanges).toBe(true);
      const w = await dashboards.addWidget(id, { type: "KPI", gridX: 0, gridY: 0, gridW: 3, gridH: 2 });
      await dashboards.updateWidget(id, w.id, { query: "SELECT 1 AS n", label: "one" });
      const v1 = await dashboards.publish(id, null);
      expect(v1.version).toBe(1);
      expect((await dashboards.getWithStatus(id)).hasUnpublishedChanges).toBe(false);
      expect((await dashboards.publish(id, null)).version).toBe(1);
    });

    it("keeps old versions immutable and renders a widget from any version's snapshot", async () => {
      const [w] = await dashboards.listWidgets(id);
      await dashboards.updateWidget(id, w!.id, { query: "SELECT 2 AS n", label: "two" });
      expect((await dashboards.getWithStatus(id)).hasUnpublishedChanges).toBe(true);
      expect((await dashboards.publish(id, null)).version).toBe(2);

      const v1 = await dashboards.getVersion(id, 1);
      expect(v1.widgets.map((x) => x.label)).toEqual(["one"]);
      expect((await dashboards.executeVersionWidget(id, 1, w!.id, LIMITS, { userId: null }, {})).rows).toEqual([{ n: 1 }]);
      expect((await dashboards.executePublishedWidget(id, w!.id, LIMITS, { userId: null }, {})).rows).toEqual([{ n: 2 }]);
    });

    it("restores an old version into the draft only - publishing it is a separate, explicit step", async () => {
      const [w] = await dashboards.listWidgets(id);
      await dashboards.updateWidget(id, w!.id, { label: "unpublished edit" });

      await dashboards.restore(id, 1);
      expect((await dashboards.listWidgets(id)).map((x) => x.label)).toEqual(["one"]);
      // Nothing went live: still v2, and the draft now differs from it.
      expect((await dashboards.listVersions(id)).map((v) => v.version)).toEqual([2, 1]);
      expect((await dashboards.executePublishedWidget(id, w!.id, LIMITS, { userId: null }, {})).rows).toEqual([{ n: 2 }]);
      expect((await dashboards.getWithStatus(id)).hasUnpublishedChanges).toBe(true);

      const v3 = await dashboards.publish(id, null);
      expect(v3.version).toBe(3);
      expect(v3.restoredFromVersion).toBe(1);
      expect((await dashboards.getWithStatus(id)).hasUnpublishedChanges).toBe(false);
      expect((await dashboards.executePublishedWidget(id, w!.id, LIMITS, { userId: null }, {})).rows).toEqual([{ n: 1 }]);
    });

    it("list() reports each dashboard's status, the same as the editor header", async () => {
      const statusInList = async () => {
        const row = (await dashboards.list()).find((d) => d.id === id)!;
        expect(row.hasUnpublishedChanges).toBe((await dashboards.getWithStatus(id)).hasUnpublishedChanges);
        return { live: row.liveVersion, changed: row.hasUnpublishedChanges };
      };
      const draft = await dashboards.create({ name: "dashboards pkg test status", slug: "dashboards-pkg-test-status" });
      try {
        expect((await dashboards.list()).find((d) => d.id === draft.id)).toMatchObject({ liveVersion: null, hasUnpublishedChanges: true });
      } finally {
        await dashboards.delete(draft.id);
      }

      expect(await statusInList()).toEqual({ live: 3, changed: false });
      const [w] = await dashboards.listWidgets(id);
      await dashboards.updateWidget(id, w!.id, { label: "edited", config: { color: "teal" } });
      expect(await statusInList()).toEqual({ live: 3, changed: true });
      await dashboards.restore(id, 3);
      expect(await statusInList()).toEqual({ live: 3, changed: false });
    });

    it("an EMBEDDED_ONLY dashboard is left out of the App's list, but still opens by its slug", async () => {
      expect((await dashboards.listPublished(null)).some((d) => d.id === id)).toBe(true);
      expect((await dashboards.update(id, { scope: "EMBEDDED_ONLY" })).scope).toBe("EMBEDDED_ONLY");
      expect((await dashboards.listPublished(null)).some((d) => d.id === id)).toBe(false);
      expect((await dashboards.list()).find((d) => d.id === id)?.scope).toBe("EMBEDDED_ONLY");
      expect((await dashboards.getBySlug("dashboards-pkg-test-versions")).id).toBe(id);
      await expect(dashboards.update(id, { scope: "HIDDEN" as never })).rejects.toMatchObject({ code: "CHECK_VIOLATION" });
      await dashboards.update(id, { scope: "LISTED" });
    });

    it("sets the auto-refresh interval from the short list - live at once, not versioned, copied by Save as", async () => {
      expect((await dashboards.get(id)).refreshIntervalSeconds).toBeNull();
      expect((await dashboards.getWithStatus(id)).hasUnpublishedChanges).toBe(false);

      expect((await dashboards.update(id, { refreshIntervalSeconds: 300 })).refreshIntervalSeconds).toBe(300);
      // Like scope: no publish needed, and the draft doesn't become "unpublished".
      expect((await dashboards.getWithStatus(id)).hasUnpublishedChanges).toBe(false);
      expect((await dashboards.listPublished(null)).find((d) => d.id === id)?.refreshIntervalSeconds).toBe(300);

      for (const invalid of [0, 10, 29, 45, -30, "60", 30.5]) {
        await expectCode(dashboards.update(id, { refreshIntervalSeconds: invalid as never }), "INVALID_DASHBOARD_REFRESH_INTERVAL");
      }
      await expectCode(
        dashboards.create({ name: "dashboards pkg test bad refresh", slug: "dashboards-pkg-test-bad-refresh", refreshIntervalSeconds: 5 }),
        "INVALID_DASHBOARD_REFRESH_INTERVAL",
      );
      // PostgreSQL's own CHECK backs the list, whoever writes.
      await expect(
        database.query(`UPDATE totalbase.dashboards SET refresh_interval_seconds = 10 WHERE id = $1`, [id]),
      ).rejects.toMatchObject({ code: "CHECK_VIOLATION" });
      expect((await dashboards.get(id)).refreshIntervalSeconds).toBe(300);

      const copy = await dashboards.duplicateVersion(id, 1, { name: "dashboards pkg test refresh copy", slug: "dashboards-pkg-test-refresh-copy" });
      try {
        expect(copy.refreshIntervalSeconds).toBe(300);
      } finally {
        await dashboards.delete(copy.id);
      }

      expect((await dashboards.update(id, { refreshIntervalSeconds: null })).refreshIntervalSeconds).toBeNull();
    });

    it("duplicates a version into a new, unpublished, admin-only dashboard", async () => {
      await dashboards.setRoles(id, [roleA]);
      const copy = await dashboards.duplicateVersion(id, 2, { name: "dashboards pkg test copy", slug: "dashboards-pkg-test-copy" });
      expect(copy.id).not.toBe(id);
      expect(copy.hasUnpublishedChanges).toBe(true);
      expect(await dashboards.listVersions(copy.id)).toEqual([]);
      expect(await dashboards.listRoles(copy.id)).toEqual([]);
      const widgets = await dashboards.listWidgets(copy.id);
      expect(widgets.map((x) => [x.label, x.query])).toEqual([["two", "SELECT 2 AS n"]]);
      const [original] = await dashboards.listWidgets(id);
      expect(widgets[0]!.id).not.toBe(original!.id);
    });

    it("duplicates the draft (D26) - its widgets and variables as they are now, no roles, unpublished", async () => {
      await dashboards.setRoles(id, [roleA]);
      const [draftWidget] = await dashboards.listWidgets(id);
      await dashboards.updateWidget(id, draftWidget!.id, { label: "draft only" });
      const copy = await dashboards.duplicate(id, { name: "dashboards pkg test dup", slug: "dashboards-pkg-test-dup" });
      expect(copy).toMatchObject({ name: "dashboards pkg test dup", slug: "dashboards-pkg-test-dup", hasUnpublishedChanges: true });
      expect(await dashboards.listVersions(copy.id)).toEqual([]);
      expect(await dashboards.listRoles(copy.id)).toEqual([]);
      expect((await dashboards.listWidgets(copy.id)).map((x) => x.label)).toEqual(["draft only"]);
      expect((await dashboards.get(copy.id)).variables).toEqual((await dashboards.get(id)).variables);
    });

    it("404s an unknown version", async () => {
      await expectCode(dashboards.getVersion(id, 99), "DASHBOARD_VERSION_NOT_FOUND");
    });
  });
});
