import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

/** Unique per run, so a run that crashed before its cleanup never collides with the next (cleanup is by primary key). */
const RUN = Date.now().toString(36);
const SLUG = `adm-dash-${RUN}`;
const TABLE = "admin_dashboards_test_orders";

/**
 * /admin/api/dashboards over HTTP - the author's side: identity, widgets,
 * draft SQL (read-only, enforced by PostgreSQL), role grants, publish,
 * versions, restore, duplicate, delete. The package tests cover the
 * service in depth; this pins the routes' wiring and status codes.
 */
describe("Admin dashboards (/admin/api/dashboards)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let dashboardId: string;
  let widgetId: string;
  /** Every dashboard this file creates - removed by primary key. */
  const dashboardIds: string[] = [];
  const MISSING = "00000000-0000-4000-8000-000000000000";

  /** `payload` is the request's content - sent as `{ data: payload }` (Specification_Data_API.md §2.5). */
  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as "GET",
      url: `/admin/api/dashboards${url}`,
      headers: { authorization: `Bearer ${adminToken}` },
      ...(payload !== undefined && { payload: { data: payload } }),
    });

  async function cleanup(): Promise<void> {
    for (const id of dashboardIds) await database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [id]);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await cleanup();
    await database.query(`CREATE TABLE public.${TABLE} (id serial PRIMARY KEY, total int NOT NULL)`);
    await database.query(`INSERT INTO public.${TABLE} (total) SELECT i FROM generate_series(1, 5) i`);
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("creates, renames and lists a dashboard", async () => {
    const created = await call("POST", "", { name: `Admin dashboards ${RUN}`, slug: SLUG });
    expect(created.statusCode, created.body).toBe(201);
    dashboardId = created.json().data.id;
    dashboardIds.push(dashboardId);
    const renamed = await call("PATCH", `/${dashboardId}`, { name: `Renamed dashboard ${RUN}` });
    expect(renamed.json().data.name).toBe(`Renamed dashboard ${RUN}`);
    expect((await call("GET", "")).json().data.some((d: { id: string }) => d.id === dashboardId)).toBe(true);
  });

  it("sets the auto-refresh interval - one of the listed ones, or null for off", async () => {
    expect((await call("GET", `/${dashboardId}`)).json().data.refreshIntervalSeconds).toBeNull();
    const set = await call("PATCH", `/${dashboardId}`, { refreshIntervalSeconds: 60 });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().data.refreshIntervalSeconds).toBe(60);
    expect((await call("GET", "")).json().data.find((d: { id: string }) => d.id === dashboardId).refreshIntervalSeconds).toBe(60);

    const tooShort = await call("PATCH", `/${dashboardId}`, { refreshIntervalSeconds: 5 });
    expect(tooShort.statusCode).toBe(422);
    expect(tooShort.json().errors[0].code).toBe("INVALID_DASHBOARD_REFRESH_INTERVAL");
    expect((await call("GET", `/${dashboardId}`)).json().data.refreshIntervalSeconds).toBe(60);

    const off = await call("PATCH", `/${dashboardId}`, { refreshIntervalSeconds: null });
    expect(off.json().data.refreshIntervalSeconds).toBeNull();
  });

  it("adds a widget, gives it a query and runs the draft", async () => {
    const widget = await call("POST", `/${dashboardId}/widgets`, { type: "TABLE", gridX: 0, gridY: 0, gridW: 6, gridH: 4 });
    expect(widget.statusCode, widget.body).toBe(201);
    widgetId = widget.json().data.id;
    await call("PATCH", `/${dashboardId}/widgets/${widgetId}`, { query: `SELECT sum(total)::int AS total FROM public.${TABLE}` });
    const data = await call("POST", `/${dashboardId}/widgets/${widgetId}/data`, {});
    expect(data.statusCode, data.body).toBe(200);
    expect(data.json().data.rows).toEqual([{ total: 15 }]);
  });

  it("runs ad-hoc draft SQL read-only - a write is refused and nothing changes", async () => {
    const read = await call("POST", `/${dashboardId}/query`, { query: `SELECT count(*)::int AS n FROM public.${TABLE}` });
    expect(read.json().data.rows).toEqual([{ n: 5 }]);
    const write = await call("POST", `/${dashboardId}/query`, { query: `DELETE FROM public.${TABLE}` });
    expect(write.statusCode).toBeGreaterThanOrEqual(400);
    const stacked = await call("POST", `/${dashboardId}/query`, { query: `SELECT 1; DROP TABLE public.${TABLE}` });
    expect(stacked.statusCode).toBeGreaterThanOrEqual(400);
    expect((await database.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${TABLE}`)).rows[0]!.n).toBe(5);
  });

  it("publishes, lists versions, rolls back and duplicates a version", async () => {
    const published = await call("POST", `/${dashboardId}/publish`);
    expect(published.statusCode, published.body).toBe(201);
    expect(published.json().data.version).toBe(1);

    await call("PATCH", `/${dashboardId}/widgets/${widgetId}`, { query: `SELECT 0 AS total` });
    expect((await call("POST", `/${dashboardId}/publish`)).json().data.version).toBe(2);
    expect((await call("GET", `/${dashboardId}/versions`)).json().data).toHaveLength(2);

    const v1 = await call("GET", `/${dashboardId}/versions/1`);
    expect(v1.statusCode, v1.body).toBe(200);
    const v1Data = await call("POST", `/${dashboardId}/versions/1/widgets/${widgetId}/data`, {});
    expect(v1Data.json().data.rows).toEqual([{ total: 15 }]);

    // Restore replaces the draft only - nothing is published.
    const restored = await call("POST", `/${dashboardId}/versions/1/restore`);
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().data.id).toBe(dashboardId);
    expect((await call("GET", `/${dashboardId}/versions`)).json().data).toHaveLength(2);
    expect((await call("POST", `/${dashboardId}/publish`)).json().data).toMatchObject({ version: 3, restoredFromVersion: 1 });

    const copy = await call("POST", `/${dashboardId}/versions/1/duplicate`, { name: `Dashboard copy ${RUN}`, slug: `${SLUG}-copy` });
    expect(copy.statusCode, copy.body).toBe(201);
    dashboardIds.push(copy.json().data.id);
  });

  it("returns a version's widgets as snapshotted - content only, no timestamps", async () => {
    const widget = (await call("GET", `/${dashboardId}/versions/1`)).json().data.widgets[0];
    expect(widget).toMatchObject({ id: widgetId, gridW: 6 });
    expect(widget).not.toHaveProperty("createdAt");
    expect(widget).not.toHaveProperty("updatedAt");
  });

  it("answers 400 for a version that isn't a number and 404 for one that doesn't exist", async () => {
    expect((await call("GET", `/${dashboardId}/versions/abc`)).statusCode).toBe(400);
    expect((await call("GET", `/${dashboardId}/versions/1.5`)).statusCode).toBe(400);
    expect((await call("POST", `/${dashboardId}/versions/abc/variables/region/options`, {})).statusCode).toBe(400);
    expect((await call("POST", `/${dashboardId}/versions/abc/restore`)).statusCode).toBe(400);
    expect((await call("POST", `/${dashboardId}/versions/abc/duplicate`, { name: "Nope" })).statusCode).toBe(400);
    expect((await call("GET", `/${dashboardId}/versions/99`)).statusCode).toBe(404);
    expect((await call("POST", `/${dashboardId}/versions/99/restore`)).statusCode).toBe(404);
    expect((await call("POST", `/${dashboardId}/versions/99/widgets/${widgetId}/data`, {})).statusCode).toBe(404);
  });

  it("answers 404 for a dashboard that doesn't exist - also on its children and on DELETE", async () => {
    const reads = ["", "/widgets", "/versions", "/versions/1"];
    for (const path of reads) expect((await call("GET", `/${MISSING}${path}`)).statusCode, path).toBe(404);
    expect((await call("POST", `/${MISSING}/variables/region/options`, {})).statusCode).toBe(404);
    expect((await call("PATCH", `/${MISSING}`, { name: "Nope" })).statusCode).toBe(404);
    expect((await call("PUT", `/${MISSING}/roles`, { roleIds: [] })).statusCode).toBe(404);
    expect((await call("POST", `/${MISSING}/widgets`, { type: "TABLE", gridX: 0, gridY: 0, gridW: 6, gridH: 4 })).statusCode).toBe(404);
    expect((await call("PATCH", `/${MISSING}/widgets/${widgetId}`, { label: "Nope" })).statusCode).toBe(404);
    expect((await call("POST", `/${MISSING}/query`, { query: "SELECT 1" })).statusCode).toBe(404);
    expect((await call("POST", `/${MISSING}/publish`)).statusCode).toBe(404);
    expect((await call("DELETE", `/${MISSING}`)).statusCode).toBe(404);
    expect((await call("DELETE", `/${dashboardId}/widgets/${MISSING}`)).statusCode).toBe(404);
  });

  it("answers 404 for a variable that doesn't exist and 422 for one that isn't a SELECT", async () => {
    const patched = await call("PATCH", `/${dashboardId}`, { variables: [{ name: "note", label: "Note", type: "TEXT" }] });
    expect(patched.statusCode, patched.body).toBe(200);
    const missing = await call("POST", `/${dashboardId}/variables/nope/options`, {});
    expect([missing.statusCode, missing.json().errors[0].code]).toEqual([404, "DASHBOARD_VARIABLE_NOT_FOUND"]);
    const notSelect = await call("POST", `/${dashboardId}/variables/note/options`, {});
    expect(notSelect.statusCode).toBe(422);
    expect(notSelect.json().errors[0].code).toBe("DASHBOARD_VARIABLE_INVALID");
  });

  it("grants roles, then deletes a widget and the dashboard", async () => {
    const role = await context.roles.create(`adm-dash-role-${RUN}`, { appAccess: true });
    try {
      // The pre-contract shape is a bad request, not "no roles".
      expect((await call("PUT", `/${dashboardId}/roles`, { role_ids: [role.id] })).statusCode).toBe(400);
      const granted = await call("PUT", `/${dashboardId}/roles`, { roleIds: [role.id] });
      expect(granted.statusCode, granted.body).toBe(200);
      const { rows } = await database.query<{ role: string }>(`SELECT role FROM totalbase.dashboards_roles WHERE dashboard = $1`, [dashboardId]);
      expect(rows.map((r) => r.role)).toEqual([role.id]);
    } finally {
      await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [role.id]);
    }
    expect((await call("DELETE", `/${dashboardId}/widgets/${widgetId}`)).statusCode).toBe(204);
    expect((await call("DELETE", `/${dashboardId}`)).statusCode).toBe(204);
    expect((await call("GET", `/${dashboardId}`)).statusCode).toBe(404);
  });
});
