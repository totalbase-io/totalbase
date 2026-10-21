import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

/**
 * Regression: a grant's row filter through a relation - an order's `technician.owner` -
 * needs no field grant (Security.md §6.5). A list read applied it as the row filter, but a read
 * by primary key merged it into the request's where, where every path needs the caller's field grant: a
 * technician listed their orders and couldn't open one (403 FIELD_PERMISSION_DENIED technician.owner).
 */
describe("a row filter through a relation, on a read by primary key", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let ordersId: string;
  let techsId: string;
  let roleId: string;
  let key: string;
  const userIds: string[] = [];

  const TECHS = "row_filter_relation_pk_techs";
  const ORDERS = "row_filter_relation_pk_orders";
  const URL = `/api/public/table/${ORDERS}`;
  const get = (path: string) => app.inject({ method: "GET", url: path, headers: { authorization: `Bearer ${key}` } });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`DROP TABLE IF EXISTS public.${ORDERS}, public.${TECHS} CASCADE`);
    await database.query(`CREATE TABLE public.${TECHS} (id serial PRIMARY KEY, owner uuid NOT NULL, name text NOT NULL)`);
    await database.query(`CREATE TABLE public.${ORDERS} (id serial PRIMARY KEY, technician integer NOT NULL REFERENCES public.${TECHS} (id), name text NOT NULL)`);
    const register = async (name: string) => (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', $3) RETURNING id`,
      [`public.${name}`, name, ["GET"]],
    )).rows[0]!.id;
    techsId = await register(TECHS);
    ordersId = await register(ORDERS);

    roleId = (await context.roles.create("row-filter-relation-pk-role", { apiAccess: true })).id;
    // The order's own columns only - technician.owner is the administrator's filter, not a field the role reads.
    await context.permissions.set(roleId, ordersId, "READ", {
      effect: "ALLOW",
      where: { "technician.owner": { _eq: "$USER.id" } },
      fields: ["id", "technician", "name"].map((field) => ({ field, effect: "ALLOW" as const })),
    });

    const caller = await createTestApiToken(context, { name: "row-filter-relation-pk", roleId, email: "row-filter-relation-pk@example.com" });
    key = caller.plainKey;
    userIds.push(caller.userId);
    const other = (await context.auth.users.create({ email: "row-filter-relation-pk-other@example.com" })).id;
    userIds.push(other);
    await database.query(`INSERT INTO public.${TECHS} (id, owner, name) VALUES (1, $1, 'Mine'), (2, $2, 'Theirs')`, [caller.userId, other]);
    await database.query(`INSERT INTO public.${ORDERS} (id, technician, name) VALUES (1, 1, 'my order'), (2, 2, 'their order')`);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.logs WHERE resource = ANY($1::uuid[])`, [[ordersId, techsId]]);
    for (const id of userIds) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1::uuid[])`, [[ordersId, techsId]]);
    await database.query(`DROP TABLE IF EXISTS public.${ORDERS}, public.${TECHS} CASCADE`);
    await app.close();
    await database.close();
  });

  it("lists only the caller's orders", async () => {
    const res = await get(`${URL}?fields=id,name`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual([{ id: 1, name: "my order" }]);
  });

  it("opens one of them by its key", async () => {
    const res = await get(`${URL}/1`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ id: 1, technician: 1, name: "my order" });
  });

  it("answers 404 for a row the filter hides, never revealing it", async () => {
    expect((await get(`${URL}/2`)).statusCode).toBe(404);
  });

  it("still refuses the path when the caller asks for it", async () => {
    const res = await get(`${URL}?fields=id,technician.owner`);
    expect(res.statusCode).toBe(403);
  });
});
