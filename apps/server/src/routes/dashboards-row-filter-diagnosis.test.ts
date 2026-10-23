import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

const RUN = Date.now().toString(36);
const ACCESSES = `diag_rf_accesses_${RUN}`;
const OPEN = `diag_rf_open_${RUN}`;
const VIEW = `diag_rf_view_${RUN}`;

/**
 * WIDGET_IGNORES_ROW_FILTER (DataViews.md §18): a published widget whose SQL never names $USER, reading a table a
 * role that opens the dashboard may read only some rows of - the tables as PostgreSQL plans them (a view's, a
 * partition's parent), the row filters as the Permission Resolver decides them.
 */
describe("Dashboard diagnosis - widgets that ignore a role's row filter", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let dashboardId: string;
  let filteredRole: string;
  let openRole: string;
  const resourceIds: string[] = [];
  const widgets: Record<string, string> = {};

  type Issue = { code: string; role: { id: string } | null; resource: { name: string } | null; widget: { id: string; name: string } | null };
  const diagnosis = async (): Promise<Issue[]> => {
    const res = await app.inject({ method: "GET", url: `/admin/api/dashboards/${dashboardId}/diagnosis`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().data as Issue[]).filter((issue) => issue.code === "WIDGET_IGNORES_ROW_FILTER");
  };

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    adminToken = (await context.auth.login({ email: loadServerEnv().adminEmail!, password: loadServerEnv().adminPassword! })).token;
    // Partitioned: the plan reads the partitions, the resource is their table.
    await database.query(`CREATE TABLE public.${ACCESSES} (id serial, org text NOT NULL, owner uuid, PRIMARY KEY (id, org)) PARTITION BY LIST (org)`);
    await database.query(`CREATE TABLE public.${ACCESSES}_a PARTITION OF public.${ACCESSES} FOR VALUES IN ('a')`);
    await database.query(`CREATE TABLE public.${ACCESSES}_b PARTITION OF public.${ACCESSES} FOR VALUES IN ('b')`);
    await database.query(`CREATE TABLE public.${OPEN} (id serial PRIMARY KEY, name text)`);
    await database.query(`CREATE VIEW public.${VIEW} AS SELECT id, org FROM public.${ACCESSES}`);
    const register = async (name: string) => (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', '{GET}') RETURNING id`,
      [`public.${name}`, name],
    )).rows[0]!.id;
    const accessesId = await register(ACCESSES);
    const openId = await register(OPEN);
    resourceIds.push(accessesId, openId);

    filteredRole = (await context.roles.create(`diag-rf-filtered-${RUN}`, {})).id;
    openRole = (await context.roles.create(`diag-rf-open-${RUN}`, {})).id;
    const fields = [{ field: "id", effect: "ALLOW" as const }, { field: "org", effect: "ALLOW" as const }];
    await context.permissions.set(filteredRole, accessesId, "READ", { effect: "ALLOW", where: { org: { _eq: "a" } }, fields });
    await context.permissions.set(filteredRole, openId, "READ", { effect: "ALLOW", fields: [{ field: "id", effect: "ALLOW" }] });
    await context.permissions.set(openRole, accessesId, "READ", { effect: "ALLOW", fields });

    const dashboards = context.dashboardsAdmin;
    dashboardId = (await dashboards.create({ name: `Diag RF ${RUN}`, slug: `diag-rf-${RUN}` })).id;
    await dashboards.setRoles(dashboardId, [filteredRole, openRole]);
    const add = async (key: string, query: string, gridY: number) => {
      widgets[key] = (await dashboards.addWidget(dashboardId, { type: "TABLE", label: key, gridX: 0, gridY, gridW: 12, gridH: 3, query, config: {} })).id;
    };
    await add("table", `SELECT org, count(*) AS n FROM public.${ACCESSES} GROUP BY org`, 0);
    await add("view", `SELECT count(*) AS n FROM public.${VIEW}`, 3);
    await add("scoped", `SELECT count(*) AS n FROM public.${ACCESSES} WHERE owner = $USER.id`, 6);
    await add("open", `SELECT count(*) AS n FROM public.${OPEN}`, 9);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [dashboardId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = ANY($1::uuid[])`, [[filteredRole, openRole]]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1::uuid[])`, [resourceIds]);
    await database.query(`DROP VIEW IF EXISTS public.${VIEW}`);
    await database.query(`DROP TABLE IF EXISTS public.${ACCESSES}, public.${OPEN} CASCADE`);
    await app.close();
  });

  it("says nothing before the dashboard is published - only the live version reaches viewers", async () => {
    expect(await diagnosis()).toEqual([]);
  });

  it("warns for the filtered role only, on the widgets that read its table without $USER - through a view and partitions too", async () => {
    await context.dashboardsAdmin.publish(dashboardId, null);
    const issues = await diagnosis();
    expect(issues.every((issue) => issue.role?.id === filteredRole && issue.resource?.name === `public.${ACCESSES}`)).toBe(true);
    expect(issues.map((issue) => issue.widget?.id).sort()).toEqual([widgets["table"], widgets["view"]].sort());
  });

  it("stops warning once a grant without a filter gives the role every row", async () => {
    const accessesId = resourceIds[0]!;
    await context.permissions.set(filteredRole, accessesId, "READ", { effect: "ALLOW", fields: [{ field: "id", effect: "ALLOW" }, { field: "org", effect: "ALLOW" }] });
    expect(await diagnosis()).toEqual([]);
  });
});
