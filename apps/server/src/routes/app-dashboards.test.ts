import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { setupTestApp } from "../test-support.js";

/** Unique per run, so a run that crashed before its cleanup never collides with the next (cleanup is by primary key). */
const PREFIX = `app-dash-${Date.now().toString(36)}`;
const PASSWORD = "a-strong-enough-password";
const QUERY = `SELECT $USER.email AS me, 'published' AS version`;
const OPTIONS_QUERY = `SELECT 'a' AS value UNION ALL SELECT 'b'`;

/**
 * /app/api/dashboards - a viewer's side of dashboard widget SQL, the
 * narrow exception of AGENTS.md section 7: access per dashboard x role
 * (denied answers like missing), only published dashboards, the viewer
 * never sees or sends SQL, a widget runs from the published snapshot, and
 * $USER.* is the viewer's own row.
 */
describe("App dashboards (/app/api/dashboards)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let grantedToken: string;
  let otherToken: string;
  let dashboardId: string;
  let widgetId: string;
  /** A published widget that reports the transaction's TimeZone. */
  let zoneWidgetId: string;
  let draftOnlyId: string;
  /** What this file creates - removed by primary key. */
  const created = { dashboards: [] as string[], users: [] as string[], roles: [] as string[] };

  const get = (url: string, token?: string) =>
    app.inject({ method: "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {} });
  /** `payload` is the request's content - sent as `{ data: payload }` (Data_API.md §2.5). */
  const post = (url: string, token: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}`, ...headers }, payload: { data: payload } });

  async function viewer(email: string, roleId: string): Promise<string> {
    const user = await context.auth.users.create({ email, name: email.split("@")[0]!, passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    created.users.push(user.id);
    await context.roleAssignments.assignRoleToUser(user.id, roleId);
    return (await context.auth.login({ email, password: PASSWORD })).token;
  }

  async function cleanup(): Promise<void> {
    for (const id of created.dashboards) await database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [id]);
    for (const id of created.users) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    for (const id of created.roles) await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [id]);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());

    const grantedRole = (await context.roles.create(`${PREFIX}-granted`, { appAccess: true })).id;
    const otherRole = (await context.roles.create(`${PREFIX}-other`, { appAccess: true })).id;
    created.roles.push(grantedRole, otherRole);
    grantedToken = await viewer(`${PREFIX}-granted@example.com`, grantedRole);
    otherToken = await viewer(`${PREFIX}-other@example.com`, otherRole);

    const dashboards = context.dashboardsAdmin;
    dashboardId = (await dashboards.create({ name: `Live ${PREFIX}`, slug: `${PREFIX}-live` })).id;
    created.dashboards.push(dashboardId);
    await dashboards.update(dashboardId, {
      variables: [{ name: "pick", label: "Pick", type: "SELECT", options: { source: "QUERY", query: OPTIONS_QUERY } }],
    });
    widgetId = (await dashboards.addWidget(dashboardId, { type: "TABLE", gridX: 0, gridY: 0, gridW: 6, gridH: 4 })).id;
    await dashboards.updateWidget(dashboardId, widgetId, { query: QUERY });
    zoneWidgetId = (await dashboards.addWidget(dashboardId, { type: "TABLE", gridX: 6, gridY: 0, gridW: 6, gridH: 4 })).id;
    await dashboards.updateWidget(dashboardId, zoneWidgetId, { query: `SELECT current_setting('TimeZone') AS tz` });
    await dashboards.setRoles(dashboardId, [grantedRole]);
    await dashboards.publish(dashboardId, null);
    // A draft edit after publishing: viewers must keep getting the published query.
    await dashboards.updateWidget(dashboardId, widgetId, { query: `SELECT 'draft' AS version` });

    draftOnlyId = (await dashboards.create({ name: `Draft ${PREFIX}`, slug: `${PREFIX}-draft` })).id;
    created.dashboards.push(draftOnlyId);
    await dashboards.setRoles(draftOnlyId, [grantedRole]);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("needs a signed-in portal user", async () => {
    expect((await get("/app/api/dashboards")).statusCode).toBe(401);
  });

  it("lists only published dashboards granted to one of the viewer's roles", async () => {
    const granted = (await get("/app/api/dashboards", grantedToken)).json().data as Array<{ slug: string }>;
    expect(granted.map((d) => d.slug)).toContain(`${PREFIX}-live`);
    expect(granted.map((d) => d.slug)).not.toContain(`${PREFIX}-draft`);
    const other = (await get("/app/api/dashboards", otherToken)).json().data as Array<{ slug: string }>;
    expect(other.map((d) => d.slug)).not.toContain(`${PREFIX}-live`);
  });

  it("answers a dashboard the viewer may not see exactly like one that doesn't exist", async () => {
    for (const url of [
      `/app/api/dashboards/${PREFIX}-live`,
      `/app/api/dashboards/${PREFIX}-live/widgets`,
      `/app/api/dashboards/${PREFIX}-live/variables`,
    ]) {
      const denied = await get(url, otherToken);
      const missing = await get(url.replace(`${PREFIX}-live`, `${PREFIX}-nope`), otherToken);
      expect(denied.statusCode, url).toBe(404);
      expect(denied.json().errors[0].code).toBe(missing.json().errors[0].code);
    }
    expect((await get(`/app/api/dashboards/${PREFIX}-draft`, grantedToken)).statusCode).toBe(404);
    expect((await post(`/app/api/dashboards/${PREFIX}-live/widgets/${widgetId}/data`, otherToken, {})).statusCode).toBe(404);
  });

  it("hands the viewer the dashboard's auto-refresh interval, live as soon as it is set", async () => {
    expect((await get(`/app/api/dashboards/${PREFIX}-live`, grantedToken)).json().data.refreshIntervalSeconds).toBeNull();
    await context.dashboardsAdmin.update(dashboardId, { refreshIntervalSeconds: 30 });
    try {
      expect((await get(`/app/api/dashboards/${PREFIX}-live`, grantedToken)).json().data.refreshIntervalSeconds).toBe(30);
      const listed = (await get("/app/api/dashboards", grantedToken)).json().data as Array<{ slug: string; refreshIntervalSeconds: number | null }>;
      expect(listed.find((d) => d.slug === `${PREFIX}-live`)?.refreshIntervalSeconds).toBe(30);
    } finally {
      await context.dashboardsAdmin.update(dashboardId, { refreshIntervalSeconds: null });
    }
  });

  it("serves a dashboard by its id too - a DataView page embeds it by id - with the same access", async () => {
    const live = await get(`/app/api/dashboards/${PREFIX}-live`, grantedToken);
    const id = live.json().data.id as string;
    const byId = await get(`/app/api/dashboards/${id}`, grantedToken);
    expect(byId.statusCode, byId.body).toBe(200);
    expect(byId.json().data.slug).toBe(`${PREFIX}-live`);
    expect((await get(`/app/api/dashboards/${id}/widgets`, grantedToken)).statusCode).toBe(200);
    expect((await get(`/app/api/dashboards/${id}`, otherToken)).statusCode).toBe(404);
  });

  it("never hands the viewer SQL - not the widget query, not an options query, not the draft", async () => {
    const dashboard = (await get(`/app/api/dashboards/${PREFIX}-live`, grantedToken)).json().data;
    expect(dashboard).not.toHaveProperty("variables");
    const widgets = (await get(`/app/api/dashboards/${PREFIX}-live/widgets`, grantedToken)).json().data;
    expect(widgets).toHaveLength(2);
    for (const widget of widgets) {
      expect(widget).not.toHaveProperty("query");
      expect(widget.configured).toBe(true);
    }
    const variables = (await get(`/app/api/dashboards/${PREFIX}-live/variables`, grantedToken)).json().data;
    expect(variables[0].options).toEqual({ source: "QUERY", query: "" });
    const body = JSON.stringify([dashboard, widgets, variables]);
    for (const sql of [QUERY, OPTIONS_QUERY, "'draft' AS version"]) expect(body).not.toContain(sql);
  });

  it("runs the published snapshot's query with $USER.* bound to the viewer - SQL in the body is ignored", async () => {
    const res = await post(`/app/api/dashboards/${PREFIX}-live/widgets/${widgetId}/data`, grantedToken, {
      query: "SELECT 'injected' AS version",
      sql: "SELECT 'injected' AS version",
      variables: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.rows).toEqual([{ me: `${PREFIX}-granted@example.com`, version: "published" }]);
  });

  it("runs in the viewer's zone - the browser's as a last resort, spelled as PostgreSQL knows it - and says which in meta.timezone", async () => {
    const run = async (zone: string) => {
      const res = await post(`/app/api/dashboards/${PREFIX}-live/widgets/${zoneWidgetId}/data`, grantedToken, {}, { "x-totalbase-timezone": zone });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as { data: { rows: { tz: string }[] }; meta: { timezone: { name: string | null; source: string } } };
    };
    // With no instance zone (and the viewer no preference), the header decides; with one, it wins.
    const instanceZone = await context.settings.get("system.timezone");
    await context.settings.reset("system.timezone");
    try {
      const canonical = await run("America/Argentina/Salta");
      expect(canonical.data.rows[0]!.tz).toBe("America/Argentina/Salta");
      expect(canonical.meta.timezone).toEqual({ name: "America/Argentina/Salta", source: "BROWSER" });
      // ICU's spelling of Buenos Aires is IANA's legacy alias - read as the zone PostgreSQL names, never dropped.
      const alias = await run("America/Buenos_Aires");
      expect(alias.data.rows[0]!.tz).toMatch(/^America\/(Argentina\/)?Buenos_Aires$/);
      expect(alias.meta.timezone).toEqual({ name: alias.data.rows[0]!.tz, source: "BROWSER" });
      // A zone nobody knows: PostgreSQL's own ran, and the answer says so instead of pretending.
      const unknown = await run("Nowhere/Nope");
      expect(unknown.meta.timezone).toEqual({ name: null, source: "POSTGRESQL" });
      expect(unknown.data.rows[0]!.tz).not.toBe("Nowhere/Nope");
      await context.settings.set("system.timezone", "Europe/Madrid");
      const instance = await run("America/Argentina/Salta");
      expect(instance.data.rows[0]!.tz).toBe("Europe/Madrid");
      expect(instance.meta.timezone).toEqual({ name: "Europe/Madrid", source: "INSTANCE" });
    } finally {
      if (instanceZone) await context.settings.set("system.timezone", instanceZone);
      else await context.settings.reset("system.timezone");
    }
  });

  it("hands the viewer the dashboard's Show descriptions, live - presentation, never versioned", async () => {
    expect((await get(`/app/api/dashboards/${PREFIX}-live`, grantedToken)).json().data.showDescriptions).toBe(true);
    await context.dashboardsAdmin.update(dashboardId, { showDescriptions: false });
    expect((await get(`/app/api/dashboards/${PREFIX}-live`, grantedToken)).json().data.showDescriptions).toBe(false);
    await context.dashboardsAdmin.update(dashboardId, { showDescriptions: true });
  });

  it("serves a variable's options from its published options query", async () => {
    const res = await post(`/app/api/dashboards/${PREFIX}-live/variables/pick/options`, grantedToken, { variables: {} });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.stringify(res.json().data)).toContain("a");
  });

  it("answers 404 for a variable the published dashboard doesn't have", async () => {
    const res = await post(`/app/api/dashboards/${PREFIX}-live/variables/nope/options`, grantedToken, { variables: {} });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().errors[0].code).toBe("DASHBOARD_VARIABLE_NOT_FOUND");
  });

  it("returns the published widgets as snapshotted - no timestamps", async () => {
    const widgets = (await get(`/app/api/dashboards/${PREFIX}-live/widgets`, grantedToken)).json().data;
    expect(widgets[0]).not.toHaveProperty("createdAt");
  });
});
