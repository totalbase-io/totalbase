import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

const RUN = Date.now().toString(36);
const TABLE = `dash_marks_${RUN}`;

/**
 * Dashboards, tanda 2b (Specification_Dashboards.md §5, §7.2, §9.5): what a widget reads beyond its query - its
 * thresholds' and reference lines' values (D5), a table's totals by PostgreSQL (D28), its click's targets and
 * formulas (D6) - checked on save and on publish; tabs (D7); a download's audit entry (D8); and what an embed runs.
 */
describe("Dashboards - marks, totals, clicks, tabs and downloads", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let dashboardId: string;
  let targetId: string;
  const dashboardIds: string[] = [];

  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${adminToken}` }, ...(payload !== undefined && { payload: { data: payload } }) });
  const errorOf = (res: { json: () => { errors: { code: string; message: string }[] } }) => res.json().errors[0]!;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    adminToken = (await context.auth.login({ email: loadServerEnv().adminEmail!, password: loadServerEnv().adminPassword! })).token;
    await database.query(`CREATE TABLE public.${TABLE} (id serial PRIMARY KEY, sucursal text NOT NULL, importe numeric(12,2) NOT NULL, pct numeric(5,1) NOT NULL)`);
    // 1500 rows - more than a widget sends (dashboards.query_max_rows 1000): totals are PostgreSQL's over all of them.
    await database.query(`INSERT INTO public.${TABLE} (sucursal, importe, pct) SELECT CASE WHEN i % 2 = 0 THEN 'norte' ELSE 'sur' END, i, (i % 100) FROM generate_series(1, 1500) i`);
    const dashboards = context.dashboardsAdmin;
    dashboardId = (await dashboards.create({ name: `Marks ${RUN}`, slug: `marks-${RUN}` })).id;
    targetId = (await dashboards.create({ name: `Target ${RUN}`, slug: `target-${RUN}` })).id;
    dashboardIds.push(dashboardId, targetId);
    await dashboards.update(dashboardId, {
      variables: [
        { name: "meta", label: "Meta", type: "NUMBER", default: { source: "constant", value: 75 } },
        { name: "sucursal", label: "Sucursal", type: "SELECT", options: { source: "STATIC", values: [{ value: "norte" }, { value: "sur" }] } },
        { name: "periodo", label: "Periodo", type: "DATE_RANGE" },
      ],
    });
    await dashboards.update(targetId, { variables: [{ name: "sucursal", label: "Sucursal", type: "TEXT" }], tabs: [{ value: "resumen", label: "Resumen" }] });
  });

  afterAll(async () => {
    for (const id of dashboardIds) await database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [id]);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await app.close();
  });

  it("totals a table's columns by PostgreSQL over every row - only those that ask (D28)", async () => {
    const created = await call("POST", `/admin/api/dashboards/${dashboardId}/widgets`, {
      type: "TABLE", gridX: 0, gridY: 0, gridW: 12, gridH: 4,
      query: `SELECT id, importe, pct FROM public.${TABLE}`,
      config: { columnSettings: { importe: { total: "sum", displayFormat: "$ #,##0.00" }, pct: { total: "avg" } } },
    });
    expect(created.statusCode, created.body).toBe(201);
    const run = await call("POST", `/admin/api/dashboards/${dashboardId}/widgets/${created.json().data.id}/data`, {});
    expect(run.json().data.truncated).toBe(true);
    const { rows } = await database.query<{ s: string; a: string }>(`SELECT sum(importe) AS s, avg(pct) AS a FROM public.${TABLE}`);
    expect(run.json().data.totals).toEqual({ importe: rows[0]!.s, pct: rows[0]!.a });
    // A total on a column the query doesn't return, and one of another kind.
    const missing = await call("PATCH", `/admin/api/dashboards/${dashboardId}/widgets/${created.json().data.id}`, { config: { columnSettings: { saldo: { total: "sum" } } } });
    expect(errorOf(missing)).toMatchObject({ code: "DASHBOARD_WIDGET_REFERENCE_INVALID", message: expect.stringContaining('columnSettings.saldo.total: the query returns no column "saldo"') });
    const kind = await call("PATCH", `/admin/api/dashboards/${dashboardId}/widgets/${created.json().data.id}`, { config: { columnSettings: { importe: { total: "suma" } }, showTotals: true } });
    expect(errorOf(kind).code).toBe("DASHBOARD_WIDGET_INVALID");
    expect(errorOf(kind).message).toContain('columnSettings.importe.total is one of sum, avg, min, max, count - got "suma"');
    expect(errorOf(kind).message).toContain('Table has no prop "showTotals"');
  });

  it("resolves thresholds and reference lines on the server - a number, a column, a variable (D5)", async () => {
    const kpi = await call("POST", `/admin/api/dashboards/${dashboardId}/widgets`, {
      type: "KPI", gridX: 0, gridY: 4, gridW: 3, gridH: 2,
      query: "SELECT 70 AS cobrado, 60 AS piso",
      config: { displayFormat: "0.0 %", thresholds: [{ color: "red" }, { from: { column: "piso" }, color: "amber" }, { from: { variable: "meta" }, color: "green" }] },
    });
    expect(kpi.statusCode, kpi.body).toBe(201);
    const run = await call("POST", `/admin/api/dashboards/${dashboardId}/widgets/${kpi.json().data.id}/data`, { variables: { meta: 80 } });
    expect(run.json().data.marks).toEqual({ thresholds: [null, 60, 80] });
    // The default when the viewer chose none.
    expect((await call("POST", `/admin/api/dashboards/${dashboardId}/widgets/${kpi.json().data.id}/data`, {})).json().data.marks.thresholds[2]).toBe(75);

    const line = await call("POST", `/admin/api/dashboards/${dashboardId}/widgets`, {
      type: "LINE", gridX: 3, gridY: 4, gridW: 6, gridH: 4,
      query: "SELECT * FROM (VALUES ('ene', 10), ('feb', 30)) AS t(mes, total)",
      config: { references: [{ type: "line", value: "average", label: "Promedio" }, { type: "band", from: 15, to: { variable: "meta" }, color: "amber" }] },
    });
    expect(line.statusCode, line.body).toBe(201);
    expect((await call("POST", `/admin/api/dashboards/${dashboardId}/widgets/${line.json().data.id}/data`, {})).json().data.marks).toEqual({ references: [{ value: "average" }, { from: 15, to: 75 }] });

    // What isn't there is refused on save, saying what was expected.
    const wrong = await call("POST", `/admin/api/dashboards/${dashboardId}/widgets`, {
      type: "GAUGE", gridX: 0, gridY: 8, gridW: 4, gridH: 3, query: "SELECT 1 AS v",
      config: { thresholds: [{ color: "red" }, { from: { column: "nope" }, color: "green" }, { from: { variable: "periodo" }, color: "blue" }, { from: { variable: "x" }, color: "blue" }] },
    });
    expect(errorOf(wrong).code).toBe("DASHBOARD_WIDGET_REFERENCE_INVALID");
    expect(errorOf(wrong).message).toContain('thresholds[1].from.column: the query returns no column "nope" - it returns v');
    expect(errorOf(wrong).message).toContain('thresholds[2].from.variable: "periodo" is a DATE_RANGE variable - it takes NUMBER or SELECT');
    expect(errorOf(wrong).message).toContain('thresholds[3].from.variable: the dashboard has no variable "x"');
  });

  it("checks a click's targets and formulas on save and on publish, and lists one whose target is gone (D6)", async () => {
    const base = { type: "BAR", gridX: 0, gridY: 12, gridW: 6, gridH: 4, query: `SELECT sucursal, sum(importe) AS total, min(id) AS _id FROM public.${TABLE} GROUP BY 1` };
    const filter = await call("POST", `/admin/api/dashboards/${dashboardId}/widgets`, { ...base, config: { click: { action: "FILTER", variable: "sucursal", value: "{{row.sucursal}}" } } });
    expect(filter.statusCode, filter.body).toBe(201);
    const bad = await call("POST", `/admin/api/dashboards/${dashboardId}/widgets`, {
      ...base,
      config: { click: { action: "DASHBOARD", dashboard: targetId, tab: "detalle", variables: { sucursal: "{{row.sucursal}} {{row.nope}} {{vars.nada}} {{controls.x}}", otra: "1" } } },
    });
    expect(errorOf(bad).code).toBe("DASHBOARD_WIDGET_REFERENCE_INVALID");
    for (const part of ['click.variables.sucursal: the query returns no column "nope"', 'click.variables.sucursal: the dashboard has no variable "nada"', "{{controls.x}} - a click's formulas read", 'click.tab: that dashboard has no tab "detalle" - its tabs: resumen', 'click.variables.otra: that dashboard has no variable "otra"']) {
      expect(errorOf(bad).message).toContain(part);
    }
    const url = await call("POST", `/admin/api/dashboards/${dashboardId}/widgets`, { ...base, config: { click: { action: "URL", url: "https://{{row.sucursal}}.example/" } } });
    expect(errorOf(url).message).toContain("click.url: The Frame's site must be written out");
    const to = await call("POST", `/admin/api/dashboards/${dashboardId}/widgets`, { ...base, config: { click: { action: "DASHBOARD", dashboard: targetId, tab: "resumen", variables: { sucursal: "{{row.sucursal}}" } } } });
    expect(to.statusCode, to.body).toBe(201);

    // Its target deleted: listed as broken, and publishing refuses it.
    const gone = (await context.dashboardsAdmin.create({ name: `Gone ${RUN}`, slug: `gone-${RUN}` })).id;
    dashboardIds.push(gone);
    const orphan = await call("POST", `/admin/api/dashboards/${dashboardId}/widgets`, { ...base, gridY: 16, config: { click: { action: "DASHBOARD", dashboard: gone } } });
    expect(orphan.statusCode, orphan.body).toBe(201);
    await database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [gone]);
    const broken = (await call("GET", "/admin/api/catalog/broken-references")).json().data.dashboards;
    expect(broken.find((b: { widget: { id: string } }) => b.widget.id === orphan.json().data.id)).toMatchObject({ code: "CLICK_TARGET_MISSING", version: null });
    const published = await call("POST", `/admin/api/dashboards/${dashboardId}/publish`, {});
    expect(errorOf(published).code).toBe("DASHBOARD_PUBLISH_BROKEN_WIDGETS");
    expect(errorOf(published).message).toContain(`click.dashboard: no dashboard "${gone}"`);
    await call("DELETE", `/admin/api/dashboards/${dashboardId}/widgets/${orphan.json().data.id}`);
  });

  it("puts widgets on tabs - a tab with widgets stays, an unknown one is refused, `tab` is no variable (D7)", async () => {
    const tabs = await call("PATCH", `/admin/api/dashboards/${dashboardId}`, { tabs: [{ value: "general", label: "General" }, { value: "detalle", label: "Detalle", icon: "i-lucide-list" }] });
    expect(tabs.statusCode, tabs.body).toBe(200);
    const widget = await call("POST", `/admin/api/dashboards/${dashboardId}/widgets`, { type: "TText", gridX: 0, gridY: 20, gridW: 6, gridH: 2, tab: "detalle" });
    expect(widget.json().data.tab).toBe("detalle");
    expect(errorOf(await call("POST", `/admin/api/dashboards/${dashboardId}/widgets`, { type: "TText", gridX: 0, gridY: 22, gridW: 6, gridH: 2, tab: "otra" }))).toMatchObject({ code: "DASHBOARD_TABS_INVALID", message: "No tab \"otra\" - its tabs: general, detalle." });
    const removed = await call("PATCH", `/admin/api/dashboards/${dashboardId}`, { tabs: [{ value: "general", label: "General" }] });
    expect(removed.statusCode).toBe(409);
    expect(errorOf(removed)).toMatchObject({ code: "DASHBOARD_TAB_NOT_EMPTY", message: expect.stringContaining('"detalle" holds "TText"') });
    // Renamed and reordered: kept.
    expect((await call("PATCH", `/admin/api/dashboards/${dashboardId}`, { tabs: [{ value: "general", label: "Resumen" }, { value: "detalle", label: "Detalle" }] })).statusCode).toBe(200);
    expect(errorOf(await call("PATCH", `/admin/api/dashboards/${dashboardId}`, { variables: [{ name: "tab", label: "Tab", type: "TEXT" }] })).code).toBe("DASHBOARD_VARIABLE_RESERVED");
    const moved = await call("PATCH", `/admin/api/dashboards/${dashboardId}/widgets/${widget.json().data.id}`, { tab: null });
    expect(moved.json().data.tab).toBeNull();
  });

  it("publishes the tabs; the App reads them, records a download, and an embed runs only what it can (D7, D8, D6)", async () => {
    // A click an embed can't run reads an _ column - kept on the server there.
    const widget = await call("POST", `/admin/api/dashboards/${dashboardId}/widgets`, {
      type: "LEADERBOARD", gridX: 6, gridY: 20, gridW: 4, gridH: 4,
      query: `SELECT sucursal, sum(importe) AS total, min(id) AS _id FROM public.${TABLE} GROUP BY 1 ORDER BY 2 DESC`,
      config: { click: { action: "RECORD", dataview: (await database.query<{ id: string }>(`SELECT id FROM totalbase.dataviews LIMIT 1`)).rows[0]?.id ?? "00000000-0000-4000-8000-000000000000", pk: "{{row._id}}" } },
    });
    if (widget.statusCode !== 201) expect(errorOf(widget).message).toContain("click.dataview"); // no DataView in this database: nothing more to check here
    const published = await call("POST", `/admin/api/dashboards/${dashboardId}/publish`, {});
    expect(published.statusCode, published.body).toBe(201);
    const slug = `marks-${RUN}`;
    expect((await call("GET", `/app/api/dashboards/${slug}`)).json().data.tabs).toEqual([{ value: "general", label: "Resumen" }, { value: "detalle", label: "Detalle" }]);
    const widgets = (await call("GET", `/app/api/dashboards/${slug}/widgets`)).json().data as { id: string; type: string }[];
    const exported = await call("POST", `/app/api/dashboards/${slug}/widgets/${widgets[0]!.id}/exports`, { format: "csv", rowCount: 2 });
    expect(exported.statusCode, exported.body).toBe(201);
    const { rows: audit } = await database.query(`SELECT action, metadata FROM totalbase.logs WHERE id = $1`, [exported.json().data.id]);
    expect(audit[0]).toMatchObject({ action: "EXPORT", metadata: { dashboard: dashboardId, widget: widgets[0]!.id, rowCount: 2, format: "csv" } });
    expect((await call("POST", `/app/api/dashboards/${slug}/widgets/${widgets[0]!.id}/exports`, { format: "pdf" })).statusCode).toBe(400);

    // An embed: a FILTER on a variable its visitor changes, no click on a LOCKED one, nothing that opens the App.
    await context.dashboardsAdmin.update(dashboardId, { embeddingEnabled: true });
    const embed = await call("POST", `/admin/api/dashboards/${dashboardId}/embeds`, { name: "Web", type: "LINK", variables: { sucursal: { mode: "LOCKED", value: "norte" } } });
    expect(embed.statusCode, embed.body).toBe(201);
    const link = embed.json().data.link as string;
    const visitor = (method: string, url: string, data?: unknown) => app.inject({ method: method as "GET", url, headers: { "x-totalbase-embed-token": link }, ...(data !== undefined && { payload: { data } }) });
    const embedded = (await visitor("GET", "/embed/api/dashboard/widgets")).json().data as { id: string; type: string; config: Record<string, unknown> }[];
    expect(embedded.every((w) => w.config.click === undefined)).toBe(true);
    expect((await visitor("GET", "/embed/api/dashboard")).json().data.tabs).toHaveLength(2);
    if (widget.statusCode === 201) {
      const run = (await visitor("POST", `/embed/api/dashboard/widgets/${widget.json().data.id}/data`, { variables: {} })).json().data;
      expect(run.columns.map((c: { name: string }) => c.name)).toEqual(["sucursal", "total"]);
    }
    // Downloads only where the embed allows them.
    expect((await visitor("POST", `/embed/api/dashboard/widgets/${embedded[0]!.id}/exports`, { format: "csv" })).statusCode).toBe(403);
    await call("PATCH", `/admin/api/dashboards/${dashboardId}/embeds/${embed.json().data.id}`, { display: { allowExport: true } });
    const allowed = await visitor("POST", `/embed/api/dashboard/widgets/${embedded[0]!.id}/exports`, { format: "xlsx", rowCount: 1 });
    expect(allowed.statusCode, allowed.body).toBe(201);
    const { rows: embedAudit } = await database.query(`SELECT metadata FROM totalbase.logs WHERE id = $1`, [allowed.json().data.id]);
    expect(embedAudit[0]!.metadata).toMatchObject({ embed: embed.json().data.id, format: "xlsx" });
  });
});
