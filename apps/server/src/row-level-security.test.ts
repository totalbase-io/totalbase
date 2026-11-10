import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { hashPassword } from "@totalbase/auth";
import { runWorkflow, validateExecutionReadiness } from "@totalbase/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp } from "./test-support.js";

const PREFIX = "rls-test";
const PROJECTS = "rls_test_projects";
const MEMBERS = "rls_test_members";
const VIEW = "rls_test_projects_view";
const FUNCTION = "rls_test_count_projects";
const PASSWORD = "a-strong-enough-password";

/**
 * Row Level Security (Security.md §10.3): every transaction the Data API runs for a principal sets
 * `totalbase.actor_user_id`, so a PostgreSQL policy keyed on it decides for reads as for writes - the list, the
 * count, the read by key, a view, a function, GraphQL, a workflow's Read records step as its executor and a
 * dashboard widget run for its viewer. The SQL Console runs with no actor and sees every row; a row the
 * policy refuses on INSERT is 403 INSUFFICIENT_PRIVILEGE with nothing written.
 */
describe("Row Level Security sees who reads", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let projectsId: string;
  let adminToken: string;
  const users: { id: string; email: string; token: string }[] = [];
  const resourceIds: string[] = [];
  const created = { dashboards: [] as string[], workflows: [] as string[] };

  const get = (url: string, token: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  const post = (url: string, token: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload: payload as Record<string, unknown> });

  async function expose(name: string, methods: string[], type: "TABLE" | "VIEW" | "FUNCTION" = "TABLE", signature = name): Promise<string> {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (CASE WHEN $4 = 'FUNCTION' THEN to_regprocedure($1)::oid ELSE to_regclass($1)::oid END, 'public', $2, $4, 'ACTIVE', $3)
       RETURNING id`,
      [`public.${signature}`, name, methods, type],
    );
    resourceIds.push(rows[0]!.id);
    return rows[0]!.id;
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`DROP FUNCTION IF EXISTS public.${FUNCTION}()`);
    await database.query(`DROP VIEW IF EXISTS public.${VIEW}`);
    await database.query(`DROP TABLE IF EXISTS public.${MEMBERS}, public.${PROJECTS} CASCADE`);
    for (const { id } of (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email LIKE '${PREFIX}-%'`)).rows) {
      await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    }
    await database.query(`DELETE FROM totalbase.roles WHERE name = $1`, [`${PREFIX}-role`]);

    await database.query(`CREATE TABLE public.${PROJECTS} (id serial PRIMARY KEY, name text NOT NULL)`);
    await database.query(`CREATE TABLE public.${MEMBERS} (project integer NOT NULL REFERENCES public.${PROJECTS}(id) ON DELETE CASCADE, "user" uuid NOT NULL, PRIMARY KEY (project, "user"))`);
    await database.query(`INSERT INTO public.${PROJECTS} (name) VALUES ('alpha'), ('beta')`);
    await database.query(`CREATE VIEW public.${VIEW} AS SELECT id, name FROM public.${PROJECTS}`);
    await database.query(`CREATE FUNCTION public.${FUNCTION}() RETURNS integer LANGUAGE sql STABLE AS 'SELECT count(*)::int FROM public.${PROJECTS}'`);
    // The pattern of the documentation: no actor passes everything (TotalBase's own work, the SQL Console); an
    // actor passes the projects they are a member of. FORCE: TotalBase's role owns the table. NULLIF, not a bare
    // cast: a pooled connection that once ran a Data API transaction reads the setting as '' afterwards, and
    // PostgreSQL doesn't promise to skip the OR's second branch.
    await database.query(`ALTER TABLE public.${PROJECTS} ENABLE ROW LEVEL SECURITY`);
    await database.query(`ALTER TABLE public.${PROJECTS} FORCE ROW LEVEL SECURITY`);
    await database.query(
      `CREATE POLICY rls_test_members_policy ON public.${PROJECTS} USING (
         NULLIF(current_setting('totalbase.actor_user_id', true), '') IS NULL
         OR EXISTS (SELECT 1 FROM public.${MEMBERS} m
                    WHERE m.project = ${PROJECTS}.id AND m."user" = NULLIF(current_setting('totalbase.actor_user_id', true), '')::uuid))`,
    );

    projectsId = await expose(PROJECTS, ["GET", "POST"]);
    const viewId = await expose(VIEW, ["GET"], "VIEW");
    const functionId = await expose(FUNCTION, ["POST"], "FUNCTION", `${FUNCTION}()`);
    roleId = (await context.roles.create(`${PREFIX}-role`, { apiAccess: true, appAccess: true })).id;
    const allow = (fields: string[]) => fields.map((field) => ({ field, effect: "ALLOW" as const }));
    await context.permissions.set(roleId, projectsId, "READ", { effect: "ALLOW", fields: allow(["id", "name"]) });
    await context.permissions.set(roleId, projectsId, "CREATE", { effect: "ALLOW", fields: allow(["name"]) });
    await context.permissions.set(roleId, viewId, "READ", { effect: "ALLOW", fields: allow(["id", "name"]) });
    await context.permissions.set(roleId, functionId, "EXECUTE", { effect: "ALLOW" });

    for (const name of ["member", "outsider"]) {
      const email = `${PREFIX}-${name}@example.com`;
      const user = await context.auth.users.create({ email, name, passwordHash: await hashPassword(PASSWORD), emailVerified: true });
      await context.roleAssignments.assignRoleToUser(user.id, roleId);
      users.push({ id: user.id, email, token: (await context.auth.login({ email, password: PASSWORD })).token });
    }
    await database.query(`INSERT INTO public.${MEMBERS} (project, "user") VALUES (1, $1)`, [users[0]!.id]);
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    await context.settings.set("graphql.enabled", true);
  });

  afterAll(async () => {
    await context.settings.set("graphql.enabled", false);
    for (const id of created.dashboards) await database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [id]);
    for (const id of created.workflows) await database.query(`DELETE FROM totalbase.workflows WHERE id = $1`, [id]);
    for (const id of resourceIds) {
      await database.query(`DELETE FROM totalbase.logs WHERE resource = $1`, [id]);
      await database.query(`DELETE FROM totalbase.outbox WHERE resource = $1`, [id]);
    }
    for (const user of users) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [user.id]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1)`, [resourceIds]);
    await database.query(`DROP FUNCTION IF EXISTS public.${FUNCTION}()`);
    await database.query(`DROP VIEW IF EXISTS public.${VIEW}`);
    await database.query(`DROP TABLE IF EXISTS public.${MEMBERS}, public.${PROJECTS} CASCADE`);
    await app.close();
  });

  const [member, outsider] = [0, 1] as const;
  const names = (res: { json: () => { data: { name: string }[] } }) => res.json().data.map((r) => r.name);

  it("filters the list, the count and the read by key by the policy's actor", async () => {
    const mine = await get(`/api/public/table/${PROJECTS}?count=true`, users[member]!.token);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(names(mine)).toEqual(["alpha"]);
    expect(mine.json().meta.count).toBe(1);

    const none = await get(`/api/public/table/${PROJECTS}?count=true`, users[outsider]!.token);
    expect(names(none)).toEqual([]);
    expect(none.json().meta.count).toBe(0);

    expect((await get(`/api/public/table/${PROJECTS}/1`, users[member]!.token)).statusCode).toBe(200);
    expect((await get(`/api/public/table/${PROJECTS}/2`, users[member]!.token)).statusCode).toBe(404);
    expect((await get(`/api/public/table/${PROJECTS}/1`, users[outsider]!.token)).statusCode).toBe(404);
  });

  it("applies through a view, a function and GraphQL", async () => {
    expect(names(await get(`/api/public/view/${VIEW}`, users[member]!.token))).toEqual(["alpha"]);
    expect(names(await get(`/api/public/view/${VIEW}`, users[outsider]!.token))).toEqual([]);

    const counted = await post(`/api/public/function/${FUNCTION}`, users[member]!.token, { data: {} });
    expect(counted.statusCode, counted.body).toBe(200);
    expect(JSON.stringify(counted.json().data)).toContain("1");
    const countedByOutsider = await post(`/api/public/function/${FUNCTION}`, users[outsider]!.token, { data: {} });
    expect(JSON.stringify(countedByOutsider.json().data)).toContain("0");

    const graphql = await post("/api/graphql", users[member]!.token, { query: `{ ${PROJECTS} { name } }` });
    expect(graphql.statusCode, graphql.body).toBe(200);
    expect(graphql.json().data[PROJECTS].map((r: { name: string }) => r.name)).toEqual(["alpha"]);
    const graphqlOutsider = await post("/api/graphql", users[outsider]!.token, { query: `{ ${PROJECTS} { name } }` });
    expect(graphqlOutsider.json().data[PROJECTS]).toEqual([]);
  });

  it("applies to an administrator's Data API read too - the bypass is TotalBase's, the policy PostgreSQL's - while the SQL Console sees every row", async () => {
    expect(names(await get(`/api/public/table/${PROJECTS}`, adminToken))).toEqual([]);
    await context.settings.set("sql_console.enabled", true);
    const console = await post("/admin/api/sql/execute", adminToken, { data: { sql: `SELECT name FROM public.${PROJECTS} ORDER BY id` } });
    expect(console.statusCode, console.body).toBe(200);
    expect(console.json().data.rows.map((r: { name: string }) => r.name)).toEqual(["alpha", "beta"]);
  });

  it("refuses a row the policy doesn't pass on INSERT with 403 INSUFFICIENT_PRIVILEGE, nothing written", async () => {
    const res = await post(`/api/public/table/${PROJECTS}`, users[member]!.token, { data: { name: "gamma" } });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().errors[0].code).toBe("INSUFFICIENT_PRIVILEGE");
    const { rows } = await database.query(`SELECT 1 FROM public.${PROJECTS} WHERE name = 'gamma'`);
    expect(rows).toHaveLength(0);
  });

  it("a workflow's Read records step reads as its executor", async () => {
    const step = (key: string, type: string, configuration: Record<string, unknown> = {}) =>
      ({ id: randomUUID(), type, key, label: key, configuration_version: 1 as const, configuration });
    const start = step("start", "totalbase.start", { trigger: "MANUAL" });
    const read = step("read", "totalbase.read-records", { resource: projectsId, query: { fields: "name", order_by: "id" } });
    const definition = { operations: [start, read], connections: [{ source: start.id, target: read.id, output: "next" }] };
    const slug = `${PREFIX}-${randomUUID().slice(0, 8)}`;
    const id = (await context.workflowsAdmin.create({ name: slug, slug, historyLevel: "DETAILED" })).id;
    created.workflows.push(id);
    await context.workflowsAdmin.saveDraft(id, (await context.workflowsAdmin.get(id)).revision, definition);
    await context.workflowsAdmin.publish(id, (await context.workflowsAdmin.get(id)).revision, (d) => validateExecutionReadiness(d, context));
    const { workflow, definition: published } = await context.workflowsAdmin.getPublished(id);

    const readAs = async (userId: string) => {
      const principal = { principal: { type: "USER" as const, id: userId }, roleIds: await context.roleAssignments.listEffectiveRolesForUser(userId), userRow: {}, actorUserId: userId };
      const outcome = await runWorkflow(context, principal, workflow, workflow.publishedVersion, published, { trigger: "MANUAL", mode: "PRODUCTION" }, null);
      const readStep = outcome.steps.find((s) => s.operationType === "totalbase.read-records")!;
      expect(readStep.status, JSON.stringify(readStep)).toBe("SUCCEEDED");
      return (readStep.result as { data: { name: string }[] }).data.map((r) => r.name);
    };
    expect(await readAs(users[member]!.id)).toEqual(["alpha"]);
    expect(await readAs(users[outsider]!.id)).toEqual([]);
  });

  it("a dashboard widget runs as its viewer", async () => {
    const dashboards = context.dashboardsAdmin;
    const slug = `${PREFIX}-${randomUUID().slice(0, 8)}`;
    const dashboardId = (await dashboards.create({ name: `RLS ${slug}`, slug })).id;
    created.dashboards.push(dashboardId);
    const widgetId = (await dashboards.addWidget(dashboardId, { type: "TABLE", gridX: 0, gridY: 0, gridW: 6, gridH: 4 })).id;
    await dashboards.updateWidget(dashboardId, widgetId, { query: `SELECT name FROM public.${PROJECTS} ORDER BY id` });
    await dashboards.setRoles(dashboardId, [roleId]);
    await dashboards.publish(dashboardId, null);

    const mine = await post(`/app/api/dashboards/${slug}/widgets/${widgetId}/data`, users[member]!.token, { data: {} });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().data.rows).toEqual([{ name: "alpha" }]);
    const none = await post(`/app/api/dashboards/${slug}/widgets/${widgetId}/data`, users[outsider]!.token, { data: {} });
    expect(none.json().data.rows).toEqual([]);
  });
});
