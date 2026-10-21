import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { setupTestApp } from "../test-support.js";

const PREFIX = "dv-actions-test";
const PASSWORD = "a-strong-enough-password";

/**
 * A DataView's custom actions (DataViews.md §3.7, T72): checked when written, and offered to a viewer
 * only when they may run what each one runs.
 */
describe("custom actions", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let runner: string;
  let looker: string;
  let viewId: string;
  let slug: string;
  let fn: string;

  async function viewer(email: string, roleId: string): Promise<string> {
    const user = await context.auth.users.create({ email, name: email.split("@")[0]!, passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    await context.roleAssignments.assignRoleToUser(user.id, roleId);
    return (await context.auth.login({ email, password: PASSWORD })).token;
  }

  async function cleanup(): Promise<void> {
    await database.query(`DELETE FROM totalbase.dataviews WHERE slug LIKE '${PREFIX}%'`);
    await database.query(`DELETE FROM totalbase.users WHERE email LIKE '${PREFIX}%'`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE '${PREFIX}%'`);
    await database.query(`DELETE FROM totalbase.resources WHERE name LIKE 'dv_actions_test_%'`);
    await database.query(`DROP TABLE IF EXISTS public.dv_actions_test_items CASCADE`);
    await database.query(`DROP FUNCTION IF EXISTS public.dv_actions_test_void(uuid)`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await cleanup();
    await database.query(`CREATE TABLE public.dv_actions_test_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL DEFAULT 'OPEN')`);
    await database.query(`CREATE FUNCTION public.dv_actions_test_void(item uuid) RETURNS void LANGUAGE sql AS $$ UPDATE public.dv_actions_test_items SET status = 'VOID' WHERE id = item $$`);
    const { rows: [table] } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass('public.dv_actions_test_items')::oid, 'public', 'dv_actions_test_items', 'TABLE', 'ACTIVE', ARRAY['GET']) RETURNING id`,
    );
    const { rows: [fnRow] } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regprocedure('public.dv_actions_test_void(uuid)')::oid, 'public', 'dv_actions_test_void', 'FUNCTION', 'ACTIVE', ARRAY['POST']) RETURNING id`,
    );
    fn = fnRow!.id;

    const runnerRole = (await context.roles.create(`${PREFIX}-runner`, { appAccess: true })).id;
    const lookerRole = (await context.roles.create(`${PREFIX}-looker`, { appAccess: true })).id;
    for (const role of [runnerRole, lookerRole]) await context.permissions.set(role, table!.id, "READ", { effect: "ALLOW", fields: [{ field: "id", effect: "ALLOW" }, { field: "status", effect: "ALLOW" }] });
    await context.permissions.set(runnerRole, fn, "EXECUTE", { effect: "ALLOW" });

    const view = await context.dataviewsAdmin.create({ name: "Actions items", slug: `${PREFIX}-items`, sourceResourceId: table!.id, viewType: "TABLE" });
    viewId = view.id;
    slug = view.slug;
    await context.dataviewsAdmin.update(viewId, {
      viewConfig: {
        custom_actions: [
          { id: "void_item", label: "Void", icon: "i-lucide-ban", color: "error", target: { kind: "FUNCTION", resource: fn }, places: ["row", "record"], where: { status: { _eq: "OPEN" } }, confirm: { text: "Void {{id}}?", danger: true } },
        ],
      },
    });
    await context.dataviewsAdmin.setRoles(viewId, [runnerRole, lookerRole]);
    await context.dataviewsAdmin.publish(viewId, null);
    runner = await viewer(`${PREFIX}-runner@example.com`, runnerRole);
    looker = await viewer(`${PREFIX}-looker@example.com`, lookerRole);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  const openAs = async (token: string) =>
    (await app.inject({ method: "GET", url: `/app/api/dataviews/${slug}`, headers: { authorization: `Bearer ${token}` } })).json().data;

  it("offers an action only to a viewer who may run it - with what to call", async () => {
    expect((await openAs(runner)).actionTargets).toEqual({ void_item: { kind: "FUNCTION", schema: "public", name: "dv_actions_test_void" } });
    expect((await openAs(looker)).actionTargets).toEqual({});
  });

  it("refuses a malformed action - its target, its places, its condition in the Data API's grammar", async () => {
    const write = (action: Record<string, unknown>) => context.dataviewsAdmin.update(viewId, { viewConfig: { custom_actions: [{ id: "a", label: "A", target: { kind: "FUNCTION", resource: fn }, places: ["row"], ...action }] } });
    await expect(write({ target: { kind: "SQL", text: "DROP TABLE x" } })).rejects.toMatchObject({ code: "DATAVIEW_VIEW_CONFIG_INVALID" });
    await expect(write({ places: ["toolbar"] })).rejects.toMatchObject({ code: "DATAVIEW_VIEW_CONFIG_INVALID" });
    await expect(write({ where: { status: { _bogus: "x" } } })).rejects.toMatchObject({ code: "DATAVIEW_VIEW_CONFIG_INVALID" });
    await expect(write({ id: "Not An Id" })).rejects.toMatchObject({ code: "DATAVIEW_VIEW_CONFIG_INVALID" });
  });
});
