import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { signEmbedToken } from "@totalbase/dashboards";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";
import { embedFrameAncestors } from "./embed-dashboards.js";

const PREFIX = `embed-dash-${Date.now().toString(36)}`;
const SECRET_KEY = `${PREFIX}-secret`;
const SECRET = "embed-secret-for-tests-0123456789";
const PARTNER = "https://partner.example";
const OTHER = "https://other.example";

/**
 * Dashboard embeds (Dashboards.md §9.5): public links and
 * signed embeds an administrator creates, for visitors with no TotalBase
 * account - each request checked (revoked, expired, embedding on,
 * published), variables EDITABLE / HIDDEN / LOCKED with locked values never
 * the browser's, failing closed when a locked variable disappears, the
 * dashboard's id never sent, and the sites that may frame each embed.
 */
describe("Dashboard embeds", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let dashboardId: string;
  let varsWidget: string;
  let rangeWidget: string;
  let userWidget: string;
  let link: string;
  let linkId: string;
  let signedId: string;

  const exp = (seconds = 600) => Math.floor(Date.now() / 1000) + seconds;
  const admin = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, data?: unknown) =>
    app.inject({ method, url: `/admin/api/dashboards/${dashboardId}/embeds${url}`, headers: { authorization: `Bearer ${adminToken}` }, ...(data !== undefined && { payload: { data } }) });
  const get = (url: string, credential?: string) =>
    app.inject({ method: "GET", url, headers: credential ? { "x-totalbase-embed-token": credential } : {} });
  const post = (url: string, credential: string, variables: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url, headers: { "x-totalbase-embed-token": credential }, payload: { data: { variables } } });
  const rows = async (widget: string, credential: string, variables: Record<string, unknown> = {}) => {
    const res = await post(`/embed/api/dashboard/widgets/${widget}/data`, credential, variables);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data.rows;
  };

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    await context.secrets.set(SECRET_KEY, SECRET);
    await context.settings.set("dashboards.embed_secret_key", SECRET_KEY);
    await context.settings.set("dashboards.embed_allowed_origins", [PARTNER, OTHER]);

    const dashboards = context.dashboardsAdmin;
    dashboardId = (await dashboards.create({ name: `Embed ${PREFIX}`.slice(0, 32), slug: PREFIX.slice(0, 32) })).id;
    await dashboards.update(dashboardId, {
      variables: [
        { name: "customer", label: "Customer", type: "TEXT" },
        { name: "region", label: "Region", type: "SELECT", options: { source: "STATIC", values: ["north", "south", "east"] } },
        { name: "periodo", label: "Periodo", type: "DATE_RANGE" },
      ],
    });
    varsWidget = (await dashboards.addWidget(dashboardId, { type: "TABLE", gridX: 0, gridY: 0, gridW: 6, gridH: 4 })).id;
    await dashboards.updateWidget(dashboardId, varsWidget, { query: `SELECT $VAR.customer AS customer, $VAR.region AS region` });
    rangeWidget = (await dashboards.addWidget(dashboardId, { type: "TABLE", gridX: 6, gridY: 0, gridW: 6, gridH: 4 })).id;
    await dashboards.updateWidget(dashboardId, rangeWidget, { query: `SELECT to_char($VAR.periodo.from, 'YYYY-MM-DD') AS desde` });
    userWidget = (await dashboards.addWidget(dashboardId, { type: "TABLE", gridX: 0, gridY: 4, gridW: 6, gridH: 4 })).id;
    await dashboards.updateWidget(dashboardId, userWidget, { query: `SELECT $USER.email AS me` });
    await dashboards.publish(dashboardId, null);
  });

  afterAll(async () => {
    // Cascades to its embeds.
    await database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [dashboardId]);
    await context.settings.reset("dashboards.embed_secret_key");
    await context.settings.reset("dashboards.embed_allowed_origins");
    await context.secrets.delete(SECRET_KEY);
    await app.close();
    await database.close();
  });

  it("creates embeds through the Admin API - validated, a link's secret generated and copyable again, audited", async () => {
    expect((await admin("POST", "", { name: "No value", type: "LINK", variables: { customer: { mode: "LOCKED" } } })).statusCode).toBe(422);
    expect((await admin("POST", "", { name: "Elsewhere", type: "LINK", origins: ["https://evil.example"] })).statusCode).toBe(422);

    const created = await admin("POST", "", {
      name: "Website",
      type: "LINK",
      display: { theme: "dark", titled: true },
      variables: { customer: { mode: "LOCKED", value: "acme" }, region: { mode: "HIDDEN", value: "south" }, periodo: { mode: "EDITABLE", value: { from: "2026-01-01", to: "2026-03-31" } } },
      origins: [PARTNER],
    });
    expect(created.statusCode, created.body).toBe(201);
    link = created.json().data.link;
    linkId = created.json().data.id;
    expect(link).toMatch(/^tbe_/);
    expect((await admin("GET", "")).json().data[0].link).toBe(link);
    expect((await admin("POST", "", { name: "Website", type: "LINK" })).statusCode).toBe(409);

    const signed = await admin("POST", "", { name: "Portal", type: "SIGNED", variables: { customer: { mode: "LOCKED" } } });
    expect(signed.statusCode).toBe(201);
    signedId = signed.json().data.id;
    expect(signed.json().data.link).toBeNull();
    // Its page under the public URL - system.public_url, else TOTALBASE_PUBLIC_URL - an absolute
    // address even while the setting is empty.
    const publicUrl = await context.auth.mailer.publicUrl();
    expect(publicUrl).toMatch(/^https?:\/\//);
    expect(created.json().data.url).toBe(`${publicUrl}/admin/embed/${link}`);
    expect(signed.json().data.url).toBe(`${publicUrl}/admin/embed/${signedId}`);

    const { rows: audit } = await database.query(`SELECT metadata->>'event' AS event FROM totalbase.logs WHERE metadata->>'embed' = $1`, [linkId]);
    expect(audit).toEqual([{ event: "dashboard_embed.create" }]);
  });

  it("previews an embed being designed - before embedding is on, a locked value left out is locked to nothing", async () => {
    const preview = await admin("POST", "/preview", { display: { theme: "light" }, variables: { customer: { mode: "LOCKED" } } });
    expect(preview.statusCode).toBe(200);
    const token = preview.json().data.token;
    expect((await get("/embed/api/dashboard", token)).json().data).toMatchObject({ kind: "PREVIEW", display: { theme: "light" } });
    expect(await rows(varsWidget, token, { customer: "evil" })).toEqual([{ customer: null, region: null }]);
  });

  it("shows nothing while the dashboard's embedding is off", async () => {
    expect((await get("/embed/api/dashboard", link)).statusCode).toBe(404);
    await context.dashboardsAdmin.update(dashboardId, { embeddingEnabled: true });
  });

  it("a public link: its display and its starting values, never the dashboard's id", async () => {
    const dashboard = await get("/embed/api/dashboard", link);
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().data).toMatchObject({ kind: "LINK", display: { theme: "dark", titled: true }, startingValues: { periodo: { from: "2026-01-01", to: "2026-03-31" } } });
    const variables = await get("/embed/api/dashboard/variables", link);
    expect((variables.json().data as Array<{ name: string }>).map((v) => v.name)).toEqual(["periodo"]);
    const widgets = await get("/embed/api/dashboard/widgets", link);
    for (const body of [dashboard.body, variables.body, widgets.body]) expect(body).not.toContain(dashboardId);
  });

  it("binds a link's locked and hidden values whatever the browser sends; its editable ones start where configured", async () => {
    expect(await rows(varsWidget, link, { customer: "evil", region: "north" })).toEqual([{ customer: "acme", region: "south" }]);
    expect(await rows(rangeWidget, link)).toEqual([{ desde: "2026-01-01" }]);
    expect(await rows(rangeWidget, link, { periodo: { from: "2025-05-01", to: "2025-06-01" } })).toEqual([{ desde: "2025-05-01" }]);
    expect((await post(`/embed/api/dashboard/widgets/${userWidget}/data`, link)).statusCode).toBe(422);
    expect((await post("/embed/api/dashboard/variables/region/options", link)).statusCode).toBe(404);
  });

  it("a signed embed: the token names it and gives what it leaves to the token - nothing else", async () => {
    const token = (params: Record<string, unknown>, embed = signedId) => signEmbedToken({ embed, params, exp: exp() }, SECRET);
    expect(await rows(varsWidget, token({ customer: "globex" }), { customer: "evil", region: "east" })).toEqual([{ customer: "globex", region: "east" }]);
    expect((await get("/embed/api/dashboard", token({}))).statusCode).toBe(401);
    expect((await get("/embed/api/dashboard", token({ customer: "globex", region: "north" }))).statusCode).toBe(401);
    // A token naming a link's embed, or signed with another secret, gets nowhere.
    expect((await get("/embed/api/dashboard", token({ customer: "x" }, linkId))).statusCode).toBe(404);
    expect((await get("/embed/api/dashboard", signEmbedToken({ embed: signedId, params: { customer: "x" }, exp: exp() }, "another-secret"))).statusCode).toBe(401);
  });

  it("an embed of one widget serves that widget alone - any other is 404 - and fails closed once it's gone", async () => {
    expect((await admin("POST", "", { name: "Bad widget", type: "LINK", widget: "00000000-0000-4000-8000-000000000000" })).statusCode).toBe(422);
    const created = await admin("POST", "", { name: "KPI", type: "SIGNED", widget: varsWidget, variables: { customer: { mode: "LOCKED" } } });
    expect(created.statusCode, created.body).toBe(201);
    const kpi = created.json().data;
    expect(kpi.widget).toBe(varsWidget);
    const token = signEmbedToken({ embed: kpi.id, params: { customer: "initech" }, exp: exp() }, SECRET);

    expect((await get("/embed/api/dashboard", token)).json().data).toMatchObject({ widget: varsWidget, tabs: [] });
    expect((await get("/embed/api/dashboard/widgets", token)).json().data.map((w: { id: string }) => w.id)).toEqual([varsWidget]);
    expect(await rows(varsWidget, token, { customer: "evil" })).toEqual([{ customer: "initech", region: null }]);
    const other = await post(`/embed/api/dashboard/widgets/${rangeWidget}/data`, token);
    expect([other.statusCode, other.json().errors[0].code]).toEqual([404, "DASHBOARD_WIDGET_NOT_FOUND"]);

    const preview = (await admin("POST", "/preview", { widget: rangeWidget })).json().data.token;
    expect((await get("/embed/api/dashboard/widgets", preview)).json().data.map((w: { id: string }) => w.id)).toEqual([rangeWidget]);

    // Back to the whole dashboard: the same token.
    expect((await admin("PATCH", `/${kpi.id}`, { widget: null })).json().data.widget).toBeNull();
    expect((await get("/embed/api/dashboard/widgets", token)).json().data).toHaveLength(3);

    // Its widget leaves the draft: the editor says so before publishing; published, it stops.
    const extra = (await context.dashboardsAdmin.addWidget(dashboardId, { type: "TABLE", gridX: 6, gridY: 4, gridW: 6, gridH: 4 })).id;
    await context.dashboardsAdmin.updateWidget(dashboardId, extra, { query: "SELECT 1 AS one" });
    await context.dashboardsAdmin.publish(dashboardId, null);
    await admin("PATCH", `/${kpi.id}`, { widget: extra });
    await context.dashboardsAdmin.deleteWidget(dashboardId, extra);
    const impact = (await admin("GET", "/impact")).json().data as Array<{ name: string; widgetMissing: boolean }>;
    expect(impact.filter((e) => e.widgetMissing).map((e) => e.name)).toEqual(["KPI"]);
    await context.dashboardsAdmin.publish(dashboardId, null);
    const stopped = await get("/embed/api/dashboard", token);
    expect([stopped.statusCode, stopped.json().errors[0].code]).toEqual([409, "EMBED_NEEDS_UPDATE"]);
    await admin("POST", `/${kpi.id}/revoke`);
  });

  it("frames an embed only from its sites, within the instance's - TotalBase itself always", async () => {
    expect(await embedFrameAncestors(context, `/admin/embed/${link}`)).toBe(`'self' ${PARTNER}`);
    expect(await embedFrameAncestors(context, `/admin/embed/${signedId}`)).toBe(`'self' ${PARTNER} ${OTHER}`);
    expect(await embedFrameAncestors(context, "/admin/embed/preview")).toBe("'self'");
    expect(await embedFrameAncestors(context, "/admin/embed/tbe_unknown")).toBe("'self'");
  });

  it("fails closed when a variable it locks leaves the dashboard - and the editor can tell before publishing", async () => {
    await context.dashboardsAdmin.update(dashboardId, {
      variables: [
        { name: "region", label: "Region", type: "SELECT", options: { source: "STATIC", values: ["north", "south", "east"] } },
        { name: "periodo", label: "Periodo", type: "DATE_RANGE" },
      ],
    });
    const impact = (await admin("GET", "/impact")).json().data as Array<{ name: string; missing: string[] }>;
    expect(impact.map((e) => [e.name, e.missing])).toEqual([["Website", ["customer"]], ["Portal", ["customer"]]]);
    await context.dashboardsAdmin.updateWidget(dashboardId, varsWidget, { query: `SELECT 'all' AS customer, $VAR.region AS region` });
    await context.dashboardsAdmin.publish(dashboardId, null);
    const res = await get("/embed/api/dashboard", link);
    expect(res.statusCode).toBe(409);
    expect(res.json().errors[0].code).toBe("EMBED_NEEDS_UPDATE");
  });

  it("revoked or expired, it stops at once", async () => {
    const fresh = (await admin("POST", "", { name: "Fresh", type: "LINK" })).json().data;
    expect((await get("/embed/api/dashboard", fresh.link)).statusCode).toBe(200);
    await database.query(`UPDATE totalbase.dashboards_embeds SET expires_at = now() - interval '1 minute' WHERE id = $1`, [fresh.id]);
    expect((await get("/embed/api/dashboard", fresh.link)).statusCode).toBe(404);
    await database.query(`UPDATE totalbase.dashboards_embeds SET expires_at = NULL WHERE id = $1`, [fresh.id]);
    expect((await admin("POST", `/${fresh.id}/revoke`)).statusCode).toBe(200);
    expect((await get("/embed/api/dashboard", fresh.link)).statusCode).toBe(404);
    expect((await admin("DELETE", `/${fresh.id}`)).statusCode).toBe(204);
  });
});
