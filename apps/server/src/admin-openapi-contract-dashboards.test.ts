import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAdminContract, type AdminContract } from "./admin-openapi-contract-support.js";

const P = "dashoapi";
const TABLE = `${P}_audit_items`;

/**
 * The Admin API document for dashboards and audit matches what those
 * routes really return (admin-openapi-contract-support.ts): every JSON GET,
 * and the JSON responses of the writes. Fixtures are this file's own,
 * removed by primary key.
 */
describe("Admin OpenAPI matches real responses - dashboards and audit", () => {
  let contract: AdminContract;
  const dashboardIds: string[] = [];
  let resourceId: string | undefined;
  let dashboardId: string;
  let widgetId: string;

  const send = (method: "POST" | "PATCH" | "PUT", url: string, payload: Record<string, unknown> = {}) =>
    contract.app.inject({ method, url, headers: { authorization: `Bearer ${contract.adminToken}` }, payload });

  async function expectWrite(method: "POST" | "PATCH" | "PUT", url: string, path: string, status: number, payload?: Record<string, unknown>) {
    const res = await send(method, url, payload);
    expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(status);
    const data = res.json().data;
    const schema = contract.dataSchema(path, method.toLowerCase(), String(status));
    const sample = schema.type === "array" ? data[0] : data;
    expect(sample, `${method} ${url} returned no rows to compare`).toBeDefined();
    contract.expectKeys(sample, schema.type === "array" ? schema.items! : schema, `${method} ${url}`);
    return data;
  }

  beforeAll(async () => {
    contract = await setupAdminContract();
  });

  afterAll(async () => {
    if (!contract) return;
    const { database } = contract;
    for (const id of dashboardIds) await database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [id]);
    if (resourceId) {
      await database.query(`DELETE FROM totalbase.audits_exclusions WHERE resource = $1`, [resourceId]);
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    }
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await contract.close();
  });

  it("dashboard writes", async () => {
    const base = "/admin/api/dashboards";
    const created = await expectWrite("POST", base, base, 201, { data: { name: `${P} report ${Date.now()}`, slug: `${P}-${Date.now()}` } });
    dashboardId = created.id;
    dashboardIds.push(dashboardId);

    const patched = await expectWrite("PATCH", `${base}/${dashboardId}`, `${base}/{id}`, 200, {
      data: { refreshIntervalSeconds: 300, variables: [
        { name: "region", label: "Region", type: "SELECT", options: { source: "STATIC", values: ["North", "South"] }, default: { source: "constant", value: "North" } },
        // A dependent variable carries every documented key, dependsOn included.
        { name: "city", label: "City", type: "SELECT", options: { source: "QUERY", query: "SELECT 'Rosario' WHERE $VAR.region IS NOT NULL" }, default: { source: "constant", value: "Rosario" } },
      ] },
    });
    expect(patched.refreshIntervalSeconds).toBe(300);
    // The documented request body offers exactly the intervals the server accepts.
    type DataBodySchema = { properties: { data: { properties: Record<string, { enum?: unknown[] }> } } };
    const patchOperation = contract.spec.paths[`${base}/{id}`]!["patch"] as unknown as { requestBody: { content: Record<string, { schema: DataBodySchema }> } };
    const patchBody = patchOperation.requestBody.content["application/json"]!.schema.properties.data;
    expect(patchBody.properties["refreshIntervalSeconds"]!.enum).toEqual([30, 60, 300, 900, 3600, null]);
    // Role ids, not objects.
    const roleId = (await contract.context.roles.list())[0]!.id;
    const roles = await send("PUT", `${base}/${dashboardId}/roles`, { data: { roleIds: [roleId, roleId] } });
    expect(roles.statusCode, roles.body).toBe(200);
    expect(roles.json().data).toEqual([roleId]);
    expect(contract.dataSchema(`${base}/{id}/roles`, "put").items!.type).toBe("string");

    const widget = await expectWrite("POST", `${base}/${dashboardId}/widgets`, `${base}/{id}/widgets`, 201, { data: { type: "TABLE", gridX: 0, gridY: 0, gridW: 6, gridH: 4 } });
    widgetId = widget.id;
    await expectWrite("PATCH", `${base}/${dashboardId}/widgets/${widgetId}`, `${base}/{id}/widgets/{widgetId}`, 200, {
      data: { query: "SELECT * FROM (VALUES ('North', 1), ('South', 2)) AS t(region, n) WHERE region = $VAR.region" },
    });

    await expectWrite("POST", `${base}/${dashboardId}/query`, `${base}/{id}/query`, 200, { data: { query: "SELECT 1 AS n", variables: { region: "South" } } });
    await expectWrite("POST", `${base}/${dashboardId}/widgets/${widgetId}/data`, `${base}/{id}/widgets/{widgetId}/data`, 200, { data: { variables: { region: "South" } } });

    await expectWrite("POST", `${base}/${dashboardId}/publish`, `${base}/{id}/publish`, 201);
    await expectWrite("POST", `${base}/${dashboardId}/versions/1/widgets/${widgetId}/data`, `${base}/{id}/versions/{version}/widgets/{widgetId}/data`, 200, { data: {} });
    await expectWrite("POST", `${base}/${dashboardId}/versions/1/restore`, `${base}/{id}/versions/{version}/restore`, 200);
    const copy = await expectWrite("POST", `${base}/${dashboardId}/versions/1/duplicate`, `${base}/{id}/versions/{version}/duplicate`, 201, {
      data: { name: `${P} copy ${Date.now()}`, slug: `${P}-copy-${Date.now()}` },
    });
    dashboardIds.push(copy.id);
  });

  it("dashboard reads", async () => {
    const base = "/admin/api/dashboards";
    // The list's first row may be anyone's dashboard - every row carries the same keys.
    await contract.expectMatches(base, base);
    await contract.expectMatches(`${base}/${dashboardId}`, `${base}/{id}`);
    await contract.expectMatches(`${base}/${dashboardId}/widgets`, `${base}/{id}/widgets`);
    await contract.expectMatches(`${base}/${dashboardId}/versions`, `${base}/{id}/versions`);
    await contract.expectMatches(`${base}/${dashboardId}/versions/1`, `${base}/{id}/versions/{version}`);
    // A SELECT's options are a POST: the current values travel in the body (dependent variables, §3.6).
    for (const [url, path] of [
      [`${base}/${dashboardId}/variables/region/options`, `${base}/{id}/variables/{name}/options`],
      [`${base}/${dashboardId}/versions/1/variables/region/options`, `${base}/{id}/versions/{version}/variables/{name}/options`],
    ] as const) {
      const res = await contract.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${contract.adminToken}` }, payload: { data: { variables: {} } } });
      expect(res.statusCode, res.body).toBe(200);
      contract.expectKeys(res.json().data[0], contract.dataSchema(path, "post").items as never, `POST ${path}`);
    }

    // A version's widgets carry the widget schema's keys too.
    const snapshot = (await contract.get(`${base}/${dashboardId}/versions/1`)).json().data;
    contract.expectKeys(snapshot.widgets[0], { $ref: "#/components/schemas/DashboardWidgetContent" }, "version widget");
    contract.expectKeys(snapshot.variables.find((v: { name: string }) => v.name === "city"), { $ref: "#/components/schemas/DashboardVariable" }, "version variable");
  });

  it("dashboard embeds", async () => {
    const base = `/admin/api/dashboards/${dashboardId}/embeds`;
    const path = "/admin/api/dashboards/{id}/embeds";
    const embed = await expectWrite("POST", base, path, 201, {
      data: { name: "Contract", type: "LINK", display: { theme: "dark" }, variables: { region: { mode: "HIDDEN", value: "North" } }, expiresAt: null },
    });
    await expectWrite("PATCH", `${base}/${embed.id}`, `${path}/{embedId}`, 200, { data: { display: { titled: true } } });
    await contract.expectMatches(base, path);
    await expectWrite("POST", `${base}/preview`, `${path}/preview`, 200, { data: { display: {} } });
    await expectWrite("POST", `${base}/${embed.id}/revoke`, `${path}/{embedId}/revoke`, 200);
  });

  it("a dashboard as a spec (DM2)", async () => {
    const base = "/admin/api/dashboards";
    await contract.expectMatches(`${base}/${dashboardId}/spec`, `${base}/{id}/spec`);
    const document = (await contract.get(`${base}/${dashboardId}/spec`)).json().data;
    await expectWrite("PUT", `${base}/${dashboardId}/spec`, `${base}/{id}/spec`, 200, { data: { spec: document.spec, draftVersion: document.draftVersion, dryRun: true } });
    const created = await expectWrite("POST", `${base}/spec`, `${base}/spec`, 201, {
      data: { spec: { name: `${P} spec ${Date.now()}`, widgets: [{ type: "KPI", query: "SELECT 1 AS n" }] }, rows: 1 },
    });
    dashboardIds.push(created.id);
  });

  it("audit log", async () => {
    await contract.expectMatches("/admin/api/audit/activity", "/admin/api/audit/activity");
    await contract.expectMatches("/admin/api/audit/logs?limit=5", "/admin/api/audit/logs");
    await contract.expectMatches("/admin/api/audit/logs/summary", "/admin/api/audit/logs/summary");
    const res = await contract.get("/admin/api/audit/logs?limit=1");
    const meta = contract.spec.paths["/admin/api/audit/logs"]!["get"]!.responses["200"]!.content!["application/json"]!.schema.properties!["meta"]!;
    contract.expectKeys(res.json().meta, meta, "audit logs meta");
    const id = res.json().data[0].id;
    await contract.expectMatches(`/admin/api/audit/logs/${id}`, "/admin/api/audit/logs/{id}");
  });

  it("audit insights", async () => {
    await contract.expectMatches("/admin/api/audit/insights/sign-ins?days=7&tz=UTC", "/admin/api/audit/insights/sign-ins");
    await contract.expectMatches("/admin/api/audit/insights/activity?days=7&tz=UTC", "/admin/api/audit/insights/activity");
  });

  it("a resource's audit exclusions", async () => {
    const { database } = contract;
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await database.query(`CREATE TABLE public.${TABLE} (id serial PRIMARY KEY, title text)`);
    // Registered directly, not through a reconcile (see security.test.ts's registerTestResource).
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', '{}') RETURNING id`,
      [`public.${TABLE}`, TABLE],
    );
    resourceId = rows[0]!.id;
    await expectWrite("PUT", `/admin/api/resources/${resourceId}/audit`, "/admin/api/resources/{resource}/audit", 200, { data: { excludedFields: ["title"] } });
    await contract.expectMatches(`/admin/api/resources/${resourceId}/audit`, "/admin/api/resources/{resource}/audit");
  });
});
