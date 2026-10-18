import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { adminToken, setupTestApp, uniqueSuffix } from "./test-support.js";

/**
 * See as (Specification_Security.md §8.4): an administrator's session sends X-TotalBase-View-As and the resolver
 * decides with the target's roles - and a user's $USER - while every write is refused. A header never widens
 * anyone's access: from a non-administrator or a token it is refused.
 */
describe("see as a role or a user", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let admin: string;
  let userToken: string;
  let roleId: string;
  let resourceId: string;
  const userIds: string[] = [];
  const suffix = uniqueSuffix();
  const TABLE = `view_as_orders_${suffix}`;
  const PASSWORD = "a-strong-enough-password";

  const get = (token: string, url: string, viewAs?: string) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}`, ...(viewAs && { "x-totalbase-view-as": viewAs }) } });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    admin = await adminToken(context);
    await database.query(`CREATE TABLE public.${TABLE} (id serial PRIMARY KEY, owner uuid NOT NULL, name text NOT NULL)`);
    resourceId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', '{GET,PATCH}') RETURNING id`,
      [`public.${TABLE}`, TABLE],
    )).rows[0]!.id;
    roleId = (await context.roles.create(`view-as-${suffix}`, { appAccess: true, apiAccess: true })).id;
    // The role reads its own rows only.
    await context.permissions.set(roleId, resourceId, "READ", { effect: "ALLOW", where: { owner: { _eq: "$USER.id" } }, fields: ["id", "owner", "name"].map((field) => ({ field, effect: "ALLOW" as const })) });
    await context.permissions.set(roleId, resourceId, "UPDATE", { effect: "ALLOW", where: { owner: { _eq: "$USER.id" } } });
    const created = await app.inject({
      method: "POST", url: "/admin/api/users", headers: { authorization: `Bearer ${admin}` },
      payload: { data: { email: `view-as-${suffix}@example.com`, name: "Previewed", password: PASSWORD, roleIds: [roleId] } },
    });
    expect(created.statusCode, created.body).toBe(201);
    const userId = created.json().data.id as string;
    userIds.push(userId);
    userToken = (await context.auth.login({ email: `view-as-${suffix}@example.com`, password: PASSWORD })).token;
    await database.query(`INSERT INTO public.${TABLE} (owner, name) VALUES ($1, 'theirs'), (gen_random_uuid(), 'someone else''s')`, [userId]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.logs WHERE resource = $1`, [resourceId]);
    for (const id of userIds) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await app.close();
    await database.close();
  });

  const url = `/api/public/table/${TABLE}`;

  it("as a user: their roles and their $USER - only their rows", async () => {
    const res = await get(admin, url, `user:${userIds[0]}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.map((r: { name: string }) => r.name)).toEqual(["theirs"]);
    // Without the header the administrator reads everything, as always.
    expect((await get(admin, url)).json().data).toHaveLength(2);
  });

  it("as a role: its grants, with the administrator's own $USER - none of the rows are theirs", async () => {
    const res = await get(admin, url, `role:${roleId}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual([]);
  });

  it("never writes: a write while previewing is refused and nothing changes", async () => {
    const res = await app.inject({
      method: "PATCH", url: `${url}?where[name][_eq]=theirs`,
      headers: { authorization: `Bearer ${admin}`, "x-totalbase-view-as": `user:${userIds[0]}` }, payload: { data: { name: "changed" } },
    });
    expect([res.statusCode, res.json().errors?.[0]?.code]).toEqual([403, "VIEW_AS_READ_ONLY"]);
    expect((await database.query(`SELECT count(*)::int AS n FROM public.${TABLE} WHERE name = 'changed'`)).rows[0]).toEqual({ n: 0 });
  });

  it("a refusal says the action and the table, and - previewing - the role that lacks it", async () => {
    const res = await get(admin, "/api/totalbase/table/files", `role:${roleId}`);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().errors[0]).toMatchObject({ code: "ACTION_DENIED", message: `No READ grant on totalbase.files for view-as-${suffix}.` });
  });

  it("never widens: a non-administrator's header is refused, as is a malformed one", async () => {
    const res = await get(userToken, url, `role:${roleId}`);
    expect([res.statusCode, res.json().errors?.[0]?.code]).toEqual([400, "INVALID_VIEW_AS"]);
    expect((await get(admin, url, "role:not-a-uuid")).json().errors?.[0]?.code).toBe("INVALID_VIEW_AS");
  });

  it("the App's own reads follow the target too", async () => {
    // The App's DataViews list: an administrator previewing a role sees what that role opens (here, none).
    const res = await get(admin, "/app/api/dataviews", `role:${roleId}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual([]);
  });

  it("starting a preview records who previews whom", async () => {
    const res = await app.inject({
      method: "POST", url: "/admin/api/view-as", headers: { authorization: `Bearer ${admin}` }, payload: { data: { kind: "user", id: userIds[0] } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ kind: "user", id: userIds[0], name: "Previewed" });
    const { rows } = await database.query(`SELECT 1 FROM totalbase.logs WHERE metadata->>'event' = 'view_as.start' AND metadata->>'target' = $1`, [userIds[0]]);
    expect(rows).toHaveLength(1);
    await database.query(`DELETE FROM totalbase.logs WHERE metadata->>'event' = 'view_as.start' AND metadata->>'target' = $1`, [userIds[0]]);
  });
});
