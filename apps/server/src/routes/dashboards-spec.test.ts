import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

const RUN = Date.now().toString(36);

/**
 * A dashboard as one document (Dashboards.md §8.3, DM2) and the reasons of its automatic decisions
 * (§5.19, DM3): get returns the draft as a spec, apply replaces it in one transaction - every problem at once, each
 * at its path - and a run says which column each role took and why.
 */
describe("Dashboards - the draft as a spec (DM2, DM3)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  const dashboardIds: string[] = [];

  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${adminToken}` }, ...(payload !== undefined && { payload: { data: payload } }) });
  const getSpec = async (id: string) => (await call("GET", `/admin/api/dashboards/${id}/spec`)).json().data;

  const SALES = "SELECT * FROM (VALUES ('North', 120, 80), ('South', 90, 95)) AS t(branch, billed, paid) WHERE $VAR.branch IS NULL OR branch = $VAR.branch";
  const spec = (name: string) => ({
    name,
    slug: `spec-${RUN}-${name.length}`,
    description: "Sales by branch",
    variables: [
      { name: "period", label: "Period", type: "DATE_RANGE", default: { source: "constant", value: "last_30_days" } },
      { name: "branch", label: "Branch", type: "SELECT", options: { source: "STATIC", values: ["North", "South"] } },
    ],
    tabs: [{ value: "general", label: "General" }, { value: "detail", label: "Detail" }],
    widgets: [
      { type: "KPI", label: "Billed", query: "SELECT 210 AS billed" },
      { type: "BAR", label: "By branch", query: SALES, config: { roles: { category: "branch", values: ["billed", "paid"] }, click: { action: "FILTER", variable: "branch", value: "{{row.branch}}" } } },
      { type: "DONUT", label: "Share", query: SALES, config: { roles: { category: "branch", value: "billed" } } },
      { type: "TABLE", label: "Rows", tab: "detail", query: SALES },
    ],
  });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    adminToken = (await context.auth.login({ email: loadServerEnv().adminEmail!, password: loadServerEnv().adminPassword! })).token;
  });

  afterAll(async () => {
    for (const id of dashboardIds) await database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [id]);
    await app.close();
  });

  it("creates a whole dashboard in one call; get gives it back as a spec that applies unchanged as nothing", async () => {
    const res = await call("POST", "/admin/api/dashboards/spec", { spec: spec(`Spec ${RUN}`) });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json().data;
    dashboardIds.push(created.id);
    expect(created).toMatchObject({ created: true, applied: true });
    expect(created.diff.widgets.created).toHaveLength(4);
    // Widgets without a grid: placed in order at their default size, never overlapping.
    const document = await getSpec(created.id);
    const grids = document.spec.widgets.map((w: { grid: { x: number; y: number; w: number; h: number } }) => w.grid);
    for (const [i, a] of grids.entries()) {
      for (const b of grids.slice(i + 1)) expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, JSON.stringify([a, b])).toBe(false);
    }
    expect(document.spec.variables.every((v: Record<string, unknown>) => !("defaultValue" in v))).toBe(true);
    expect(document.access).toEqual({ roleIds: [], embeddingEnabled: false, embeds: [] });

    expect((await call("POST", `/admin/api/dashboards/${created.id}/publish`, {})).statusCode).toBe(201);
    const published = await getSpec(created.id);
    expect(published.hasUnpublishedChanges).toBe(false);
    // Applied back unchanged: nothing changes - still published as is.
    const again = await call("PUT", `/admin/api/dashboards/${created.id}/spec`, { spec: published.spec, draftVersion: published.draftVersion });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().data).toMatchObject({ applied: false, draftVersion: published.draftVersion });
    expect((await getSpec(created.id)).hasUnpublishedChanges).toBe(false);
    // A copy: the spec without ids, another name and slug - the same widgets.
    const copy = await call("POST", "/admin/api/dashboards/spec", {
      spec: { ...published.spec, name: `Copy ${RUN}`, slug: `copy-${RUN}`, widgets: published.spec.widgets.map(({ id: _id, ...w }: { id: string }) => w) },
    });
    expect(copy.statusCode, copy.body).toBe(201);
    dashboardIds.push(copy.json().data.id);
    const copied = await getSpec(copy.json().data.id);
    const strip = (widgets: Record<string, unknown>[]) => widgets.map(({ id: _id, ...w }) => w);
    expect(strip(copied.spec.widgets)).toEqual(strip(published.spec.widgets));
    expect(copied.spec.variables).toEqual(published.spec.variables);
  });

  it("refuses a spec with every problem at once, each at its path - the draft unchanged", async () => {
    const id = dashboardIds[0]!;
    const before = await getSpec(id);
    const widgets = [...before.spec.widgets];
    // A role of another kind, an unknown key inside series, a click to a variable that isn't there.
    widgets[1] = { ...widgets[1], config: { ...widgets[1].config, roles: { category: "billed", values: ["paid"] }, series: { paid: { colorr: "red" } } } };
    widgets[2] = { ...widgets[2], config: { ...widgets[2].config, click: { action: "FILTER", variable: "nope", value: "{{row.branch}}" } } };
    const res = await call("PUT", `/admin/api/dashboards/${id}/spec`, { spec: { ...before.spec, widgets }, draftVersion: before.draftVersion });
    expect(res.statusCode, res.body).toBe(422);
    const errors = res.json().errors as { code: string; path: string; message: string }[];
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => [e.path, e.code])).toEqual(expect.arrayContaining([
      ["widgets[1].config.series.paid.colorr", "DASHBOARD_WIDGET_INVALID"],
      ["widgets[2].config.click", "DASHBOARD_WIDGET_REFERENCE_INVALID"],
    ]));
    // The role error waits for the config's own (a config refused isn't run) - alone, it comes with its path.
    const roleOnly = [...before.spec.widgets];
    roleOnly[2] = { ...roleOnly[2], config: { ...roleOnly[2].config, roles: { category: "branch", value: "branch" } } };
    const role = await call("PUT", `/admin/api/dashboards/${id}/spec`, { spec: { ...before.spec, widgets: roleOnly }, dryRun: true });
    expect(role.statusCode, role.body).toBe(422);
    expect(role.json().errors[0]).toMatchObject({ path: "widgets[2].config.roles.value", code: "DASHBOARD_WIDGET_ROLES_INVALID" });
    // The same code save_widget gives for it on its own.
    const single = await call("PATCH", `/admin/api/dashboards/${id}/widgets/${before.spec.widgets[2].id}`, { config: roleOnly[2].config });
    expect(single.json().errors[0].code).toBe("DASHBOARD_WIDGET_ROLES_INVALID");
    expect((await getSpec(id)).draftVersion).toBe(before.draftVersion);
  });

  it("keeps, creates and deletes widgets by id; a dry run answers the difference only; an old draftVersion is refused", async () => {
    const id = dashboardIds[0]!;
    const before = await getSpec(id);
    const [kpi, bar, , table] = before.spec.widgets;
    const next = { ...before.spec, widgets: [{ ...kpi, query: "SELECT 211 AS billed" }, bar, table, { type: "KPI", label: "Paid", query: "SELECT 175 AS paid" }] };
    const dry = await call("PUT", `/admin/api/dashboards/${id}/spec`, { spec: next, draftVersion: before.draftVersion, dryRun: true });
    expect(dry.statusCode, dry.body).toBe(200);
    expect(dry.json().data).toMatchObject({ applied: false, diff: { widgets: { changed: [{ id: kpi.id, keys: ["query"] }], deleted: [{ id: before.spec.widgets[2].id }], created: [{ path: "widgets[3]" }] } } });
    expect((await getSpec(id)).draftVersion).toBe(before.draftVersion);

    const applied = await call("PUT", `/admin/api/dashboards/${id}/spec`, { spec: next, draftVersion: before.draftVersion, rows: 1 });
    expect(applied.statusCode, applied.body).toBe(200);
    const after = await getSpec(id);
    expect(after.spec.widgets.map((w: { id: string }) => w.id)).toEqual(expect.arrayContaining([kpi.id, bar.id, table.id]));
    expect(after.spec.widgets).toHaveLength(4);
    expect(after.hasUnpublishedChanges).toBe(true);
    expect(applied.json().data.widgets[0].rows).toEqual([{ billed: 211 }]);
    // Each role's columns and why (DM3).
    expect(applied.json().data.widgets[1].roles.category).toMatchObject({ columns: ["branch"], source: "config", reason: { code: "role-config" } });

    // The editor changed it in between: the old version is refused.
    await call("PATCH", `/admin/api/dashboards/${id}/widgets/${kpi.id}`, { label: "Billed (edited)" });
    const stale = await call("PUT", `/admin/api/dashboards/${id}/spec`, { spec: next, draftVersion: after.draftVersion });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().errors[0].code).toBe("DASHBOARD_DRAFT_CHANGED");
    // An id that isn't this dashboard's is an error, not a new widget.
    const foreign = await call("PUT", `/admin/api/dashboards/${id}/spec`, { spec: { ...next, widgets: [{ ...kpi, id: "00000000-0000-0000-0000-000000000000" }] } });
    expect(foreign.json().errors[0]).toMatchObject({ path: "widgets[0].id", code: "DASHBOARD_WIDGET_NOT_FOUND" });
  });

  it("says each variable's problem at its own path, never again in what uses it, and every problem of one widget (DB41)", async () => {
    const id = dashboardIds[0]!;
    const before = await getSpec(id);
    const variables = before.spec.variables.map((v: Record<string, unknown>) => (v.name === "branch" ? { ...v, defecto: "x" } : v));
    const widgets = [...before.spec.widgets];
    const kpi = widgets.findIndex((w: { type: string }) => w.type === "KPI");
    // One widget, two problems of its own: a prop it doesn't have, a threshold reading a column that isn't there.
    widgets[kpi] = { ...widgets[kpi], config: { ...widgets[kpi].config, colorr: "red", thresholds: [{ color: "red" }, { from: { column: "nope" }, color: "green" }] } };
    const res = await call("PUT", `/admin/api/dashboards/${id}/spec`, { spec: { ...before.spec, variables, widgets }, dryRun: true });
    expect(res.statusCode, res.body).toBe(422);
    const errors = res.json().errors as { path: string; code: string }[];
    expect(errors.map((e) => e.path)).toEqual(expect.arrayContaining(["variables[1].defecto", `widgets[${kpi}].config.colorr`, `widgets[${kpi}].config.thresholds`]));
    // The bar's click uses the broken variable: no false error for it.
    expect(errors.filter((e) => e.path.endsWith(".click"))).toEqual([]);
  });

  it("names a default role in the App's language (DB42)", async () => {
    const saved = { overridden: await context.settings.isOverridden("system.language"), value: await context.settings.get("system.language") };
    await context.settings.set("system.language", "es");
    try {
      const id = dashboardIds[0]!;
      const widget = (await call("POST", `/admin/api/dashboards/${id}/widgets`, { type: "PIE", gridX: 0, gridY: 30, gridW: 6, gridH: 4, query: SALES })).json().data;
      const run = (await call("POST", `/admin/api/dashboards/${id}/widgets/${widget.id}/data`, {})).json().data;
      expect(run.roles.category.reason.message).toBe("La primera columna del tipo que toma Categoría.");
    } finally {
      if (saved.overridden) await context.settings.set("system.language", saved.value);
      else await context.settings.reset("system.language");
    }
  });

  it("says which column each default role took and by which rule (DM3)", async () => {
    const id = dashboardIds[0]!;
    const widget = (await call("POST", `/admin/api/dashboards/${id}/widgets`, { type: "BAR", gridX: 0, gridY: 20, gridW: 6, gridH: 4, query: SALES })).json().data;
    const run = (await call("POST", `/admin/api/dashboards/${id}/widgets/${widget.id}/data`, {})).json().data;
    expect(run.roles.category).toMatchObject({ columns: ["branch"], source: "default", rule: "first-of-kind", reason: { code: "role-first-of-kind", detail: "branch" } });
    expect(run.roles.values).toMatchObject({ columns: ["billed", "paid"], source: "default", rule: "all-of-kind", reason: { code: "role-all-of-kind" } });
    // A viewer's run carries none.
    expect((await call("POST", `/admin/api/dashboards/${id}/publish`, {})).statusCode).toBe(201);
  });
});
