import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

const RUN = Date.now().toString(36);
const TABLE = `dash_t3_${RUN}`;
/** A 1x1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/**
 * Dashboards, tanda 3 (Dashboards.md §5): the new widgets' server side - a PIVOT aggregated by
 * PostgreSQL, a COMBO's two values, a funnel's negative step, a file column's signed links (and an embed's
 * allowFiles), and the 2b leftovers checked on save (DB14, DB20, DB24, DB27, DB28, DB29).
 */
describe("Dashboards - tanda 3", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let dashboardId: string;
  const fileIds: string[] = [];

  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${adminToken}` }, ...(payload !== undefined && { payload: { data: payload } }) });
  const errorOf = (res: { json: () => { errors: { code: string; message: string }[] } }) => res.json().errors[0]!;
  const widget = (body: Record<string, unknown>) => call("POST", `/admin/api/dashboards/${dashboardId}/widgets`, { gridX: 0, gridY: 0, gridW: 12, gridH: 5, ...body });
  const run = (id: string) => call("POST", `/admin/api/dashboards/${dashboardId}/widgets/${id}/data`, {});

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    adminToken = (await context.auth.login({ email: loadServerEnv().adminEmail!, password: loadServerEnv().adminPassword! })).token;
    await database.query(`CREATE TABLE public.${TABLE} (id serial PRIMARY KEY, branch text NOT NULL, sex text NOT NULL, month text NOT NULL, total numeric(12,2) NOT NULL)`);
    await database.query(`INSERT INTO public.${TABLE} (branch, sex, month, total)
      SELECT (ARRAY['North', 'South'])[1 + i % 2], (ARRAY['F', 'M'])[1 + (i / 2) % 2], (ARRAY['Jan', 'Feb', 'Mar'])[1 + i % 3], (i * 7.25) % 500 FROM generate_series(1, 300) i`);
    dashboardId = (await context.dashboardsAdmin.create({ name: `Tanda3 ${RUN}`, slug: `tanda3-${RUN}` })).id;
    await context.dashboardsAdmin.update(dashboardId, { variables: [{ name: "goal", label: "Goal", type: "NUMBER" }] });
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [dashboardId]);
    for (const id of fileIds) await database.query(`DELETE FROM totalbase.files WHERE id = $1`, [id]);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await app.close();
  });

  it("aggregates a pivot in PostgreSQL - each cell, subtotal and total the query's own, the real average (D17)", async () => {
    const query = `SELECT branch, sex, month, total FROM public.${TABLE}`;
    expect(errorOf(await widget({ type: "PIVOT", query, config: { roles: { rows: ["branch", "sex"], columns: ["month"], values: ["total"] } } }))).toMatchObject({ code: "DASHBOARD_PIVOT_AGGREGATE_REQUIRED", message: expect.stringContaining('"total" - one of sum, avg, min, max, count') });
    expect(errorOf(await widget({ type: "PIVOT", query, config: { roles: { rows: ["branch"], values: ["total"] }, aggregates: { total: "suma" } } })).code).toBe("DASHBOARD_WIDGET_INVALID");
    const pivot = await widget({ type: "PIVOT", query, config: { roles: { rows: ["branch", "sex"], columns: ["month"], values: ["total"] }, aggregates: { total: "avg" } } });
    expect(pivot.statusCode, pivot.body).toBe(201);
    const data = (await run(pivot.json().data.id)).json().data as { rows: Record<string, unknown>[] };
    const { rows: expected } = await database.query<Record<string, unknown>>(
      `SELECT branch, sex, month, avg(total) AS total, GROUPING(branch, sex, month) AS __grouping FROM public.${TABLE} GROUP BY ROLLUP(branch, sex), ROLLUP(month)`,
    );
    expect(data.rows).toHaveLength(expected.length);
    const key = (r: Record<string, unknown>) => `${r.branch}|${r.sex}|${r.month}|${r.__grouping}`;
    const got = new Map(data.rows.map((r) => [key(r), Number(r.total)]));
    for (const row of expected) expect(got.get(key(row)), key(row)).toBeCloseTo(Number(row.total), 6);
    // The grand total first: the real average, never an average of averages.
    expect(data.rows[0]).toMatchObject({ branch: null, sex: null, month: null, __grouping: 7 });
    // Too many column values.
    const wide = await widget({ type: "PIVOT", query: `SELECT branch, id::text AS ticket, total FROM public.${TABLE}`, config: { roles: { rows: ["branch"], columns: ["ticket"], values: ["total"] }, aggregates: { total: "sum" } } });
    expect(errorOf(await run(wide.json().data.id))).toMatchObject({ code: "DASHBOARD_PIVOT_TOO_MANY_COLUMNS", message: expect.stringContaining("300 values - at most 60") });
  });

  it("orders a pivot's and a funnel's rows in PostgreSQL before the row cap - the largest past it is kept (DB36)", async () => {
    // 1500 groups, more than a widget sends (dashboards.query_max_rows 1000): the largest totals are the last ids.
    const query = "SELECT i AS account, (i * 10)::numeric AS total, i % 3 AS month FROM generate_series(1, 1500) i";
    const pivot = await widget({ type: "PIVOT", query, config: { roles: { rows: ["account"], values: ["total"] }, aggregates: { total: "sum" }, sortBy: { value: "total", direction: "DESC" } } });
    const data = (await run(pivot.json().data.id)).json().data as { rows: Record<string, unknown>[]; truncated: boolean };
    expect(data.truncated).toBe(true);
    // The grand total first (never cut), then the groups largest first.
    expect(data.rows[0]).toMatchObject({ account: null, total: 11257500 });
    expect(data.rows.slice(1, 3).map((r) => r.account)).toEqual([1500, 1499]);
    // With Columns, each group keeps its cells next to its row total.
    const wide = await widget({ type: "PIVOT", query, config: { roles: { rows: ["account"], columns: ["month"], values: ["total"] }, aggregates: { total: "sum" }, sortBy: { value: "total", direction: "DESC" } } });
    const cut = (await run(wide.json().data.id)).json().data as { rows: { account: number | null; month: number | null }[] };
    const top = cut.rows.filter((r) => r.account === 1500);
    expect(top.map((r) => r.month)).toEqual([null, 0]);
    const funnel = await widget({ type: "FUNNEL", query: "SELECT i::text AS step, i AS n FROM generate_series(1, 1500) i", config: { sort: "DESC" } });
    expect(((await run(funnel.json().data.id)).json().data.rows as { n: number }[])[0]!.n).toBe(1500);
    // A calendar past the cap keeps its latest days, not its oldest (DB35).
    const calendar = await widget({ type: "CALENDAR", query: "SELECT d::date AS day, 1 AS n FROM generate_series(date '2022-01-01', date '2026-12-31', interval '1 day') d ORDER BY 1" });
    const days = ((await run(calendar.json().data.id)).json().data.rows as { day: string }[]).map((r) => r.day).sort();
    expect(days.at(-1)).toBe("2026-12-31");
  });

  it("refuses a combo with one value, and a funnel's negative step when it runs (D11, D13)", async () => {
    const one = await widget({ type: "COMBO", query: "SELECT 'Jan' AS m, 10 AS a" });
    expect(errorOf(one)).toMatchObject({ code: "DASHBOARD_COMBO_NEEDS_TWO_VALUES", message: expect.stringContaining("at least two columns in Values") });
    expect((await widget({ type: "COMBO", query: "SELECT 'Jan' AS m, 10 AS a, 2.5 AS b" })).statusCode).toBe(201);
    const funnel = await widget({ type: "FUNNEL", query: "SELECT * FROM (VALUES ('Visits', 10), ('Paid', -2)) AS t(step, n)" });
    expect(errorOf(await run(funnel.json().data.id))).toMatchObject({ code: "DASHBOARD_WIDGET_NEGATIVE_VALUE", message: expect.stringContaining("negative in row 2 (step: Paid, n: -2)") });
  });

  it("signs each file a query returns - the link serves it, an altered one is refused; an embed shows PRIVATE files only when allowed (D14)", async () => {
    const privateFile = await context.filesAdmin.upload({ folder: null, content: PNG, filename: "photo.png", declaredContentType: "image/png", visibility: "PRIVATE" });
    const publicFile = await context.filesAdmin.upload({ folder: null, content: PNG, filename: "logo.png", declaredContentType: "image/png", visibility: "PUBLIC" });
    fileIds.push(privateFile.id, publicFile.id);
    const detail = await widget({
      type: "DETAIL",
      query: `SELECT 'Ana' AS name, f.id AS photo FROM totalbase.files f WHERE f.id IN ('${privateFile.id}', '${publicFile.id}') ORDER BY f.visibility`,
    });
    expect(detail.statusCode, detail.body).toBe(201);
    const files = (await run(detail.json().data.id)).json().data.files as Record<string, { url: string; image: boolean }>;
    expect(files[privateFile.id]).toMatchObject({ image: true, url: expect.stringContaining(`/app/api/dashboards/${dashboardId}/widgets/${detail.json().data.id}/files/${privateFile.id}?token=`) });
    // Served by its signature alone - no header.
    const served = await app.inject({ method: "GET", url: files[privateFile.id]!.url });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    const altered = await app.inject({ method: "GET", url: `${files[privateFile.id]!.url.slice(0, -3)}AAA` });
    expect(errorOf(altered).code).toBe("DASHBOARD_FILE_TOKEN_INVALID");
    // The private file stays private elsewhere.
    expect((await app.inject({ method: "GET", url: `/api/totalbase/table/files/${privateFile.id}` })).statusCode).not.toBe(200);

    // An embed: the PRIVATE photo isn't served without allowFiles; the PUBLIC one is.
    await context.dashboardsAdmin.publish(dashboardId, null);
    await context.dashboardsAdmin.update(dashboardId, { embeddingEnabled: true });
    const embed = await call("POST", `/admin/api/dashboards/${dashboardId}/embeds`, { name: "Web", type: "LINK" });
    const link = embed.json().data.link as string;
    const visitor = (url: string) => app.inject({ method: "POST", url, headers: { "x-totalbase-embed-token": link }, payload: { data: { variables: {} } } });
    let embedded = (await visitor(`/embed/api/dashboard/widgets/${detail.json().data.id}/data`)).json().data.files as Record<string, { url: string | null; blocked?: boolean }>;
    expect(embedded[privateFile.id]).toMatchObject({ url: null, blocked: true });
    expect((await app.inject({ method: "GET", url: embedded[publicFile.id]!.url! })).statusCode).toBe(200);
    await call("PATCH", `/admin/api/dashboards/${dashboardId}/embeds/${embed.json().data.id}`, { display: { allowFiles: true } });
    embedded = (await visitor(`/embed/api/dashboard/widgets/${detail.json().data.id}/data`)).json().data.files;
    const allowedUrl = embedded[privateFile.id]!.url!;
    expect((await app.inject({ method: "GET", url: allowedUrl })).statusCode).toBe(200);
    // Turned off again: the link already handed out stops serving it.
    await call("PATCH", `/admin/api/dashboards/${dashboardId}/embeds/${embed.json().data.id}`, { display: { allowFiles: false } });
    expect(errorOf(await app.inject({ method: "GET", url: allowedUrl })).code).toBe("DASHBOARD_FILE_NOT_ALLOWED");

    // A fixed image (DB14): an https URL or a PUBLIC file.
    const image = (src: string) => widget({ type: "TImage", gridW: 3, gridH: 3, config: { props: { src } } });
    expect(errorOf(await image("http://example.com/a.png")).message).toContain("an https URL or an uploaded file's id");
    expect(errorOf(await image("00000000-0000-4000-8000-000000000000")).message).toContain("no file");
    expect(errorOf(await image(privateFile.id)).message).toContain("the file is PRIVATE");
    expect((await image(publicFile.id)).statusCode).toBe(201);
  });

  it("checks on save what 2b let through (DB20, DB24, DB27, DB28, DB29)", async () => {
    // DB27: a sum of text.
    const sumText = await widget({ type: "TABLE", query: "SELECT 'a' AS name, 1 AS n", config: { columnSettings: { name: { total: "sum" } } } });
    expect(errorOf(sumText)).toMatchObject({ code: "DASHBOARD_WIDGET_REFERENCE_INVALID", message: expect.stringContaining('sum adds numbers - "name" is not a number') });
    // DB29: a series by a column the query doesn't return.
    const series = await widget({ type: "BAR", query: "SELECT 'Jan' AS m, 1 AS a", config: { series: { b: { label: "B" } } } });
    expect(errorOf(series).message).toContain('series.b: the query returns no column "b"');
    // DB24: a threshold's variable is something the widget reads.
    const kpi = await widget({ type: "KPI", gridW: 3, gridH: 2, query: "SELECT 5 AS v", config: { thresholds: [{ color: "red" }, { from: { variable: "goal" }, color: "green" }] } });
    expect(kpi.json().data.referencedVariables).toEqual(["goal"]);
    // DB20: a variable's key it doesn't know, at its path.
    const variables = await call("PATCH", `/admin/api/dashboards/${dashboardId}`, { variables: [{ name: "goal", label: "Goal", type: "NUMBER", defecto: 1 }] });
    expect(errorOf(variables)).toMatchObject({ code: "DASHBOARD_VARIABLE_INVALID", message: 'variables[0] has no "defecto" - it takes: name, label, type, multiple, options, default, dependsOn.' });
    // DB28: an embed's variable the dashboard doesn't have.
    const embed = await call("POST", `/admin/api/dashboards/${dashboardId}/embeds`, { name: "Other", type: "LINK", variables: { nope: { mode: "EDITABLE" } } });
    expect(errorOf(embed)).toMatchObject({ code: "DASHBOARD_EMBED_INVALID", message: expect.stringContaining('no variable "nope" - its variables: goal') });
  });
});
