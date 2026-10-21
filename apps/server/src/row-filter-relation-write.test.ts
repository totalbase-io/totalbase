import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

/**
 * Regression: a grant's row filter through a relation - an order's `technician.owner`, a part's
 * `work_order.technician.owner` - holds on writes as on reads (Security.md §6.5, §6.6). The write
 * compiler refused any relation path (400 INVALID_RELATION), so a technician could update none of their orders.
 * Now the OLD row is checked in the statement's WHERE and the NEW one by __authorized, each following the foreign
 * keys; a request's own `where` on a write still names the table's own columns only.
 */
describe("a row filter through a relation, on writes", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  const resourceIds: string[] = [];
  let roleId: string;
  let key: string;
  const userIds: string[] = [];

  const TECHS = "row_filter_relation_write_techs";
  const ORDERS = "row_filter_relation_write_orders";
  const PARTS = "row_filter_relation_write_parts";
  const send = (method: "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${key}` }, ...(payload !== undefined && { payload: payload as Record<string, unknown> }) });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`DROP TABLE IF EXISTS public.${PARTS}, public.${ORDERS}, public.${TECHS} CASCADE`);
    await database.query(`CREATE TABLE public.${TECHS} (id serial PRIMARY KEY, owner uuid NOT NULL, name text NOT NULL)`);
    await database.query(`CREATE TABLE public.${ORDERS} (id serial PRIMARY KEY, technician integer NOT NULL REFERENCES public.${TECHS} (id), name text NOT NULL)`);
    await database.query(`CREATE TABLE public.${PARTS} (id serial PRIMARY KEY, work_order integer NOT NULL REFERENCES public.${ORDERS} (id), quantity integer NOT NULL)`);
    const register = async (name: string, methods: string[]) => (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', $3) RETURNING id`,
      [`public.${name}`, name, methods],
    )).rows[0]!.id;
    const techsId = await register(TECHS, ["GET"]);
    const ordersId = await register(ORDERS, ["GET", "PATCH"]);
    const partsId = await register(PARTS, ["GET", "POST", "DELETE"]);
    resourceIds.push(techsId, ordersId, partsId);

    roleId = (await context.roles.create("row-filter-relation-write-role", { apiAccess: true })).id;
    const mine = { "technician.owner": { _eq: "$USER.id" } };
    const fields = (names: string[]) => names.map((field) => ({ field, effect: "ALLOW" as const }));
    await context.permissions.set(roleId, ordersId, "READ", { effect: "ALLOW", where: mine, fields: fields(["id", "technician", "name"]) });
    await context.permissions.set(roleId, ordersId, "UPDATE", { effect: "ALLOW", where: mine, fields: fields(["technician", "name"]) });
    await context.permissions.set(roleId, partsId, "CREATE", { effect: "ALLOW", where: { "work_order.technician.owner": { _eq: "$USER.id" } }, fields: fields(["work_order", "quantity"]) });
    await context.permissions.set(roleId, partsId, "READ", { effect: "ALLOW", where: { "work_order.technician.owner": { _eq: "$USER.id" } }, fields: fields(["id", "work_order", "quantity"]) });
    await context.permissions.set(roleId, partsId, "DELETE", { effect: "ALLOW", where: { "work_order.technician.owner": { _eq: "$USER.id" } } });
    await database.query(`INSERT INTO totalbase.roles_capabilities (role, capability, effect) VALUES ($1, 'TRANSACTIONS', 'ALLOW')`, [roleId]);

    const caller = await createTestApiToken(context, { name: "row-filter-relation-write", roleId, email: "row-filter-relation-write@example.com" });
    key = caller.plainKey;
    userIds.push(caller.userId);
    const other = (await context.auth.users.create({ email: "row-filter-relation-write-other@example.com" })).id;
    userIds.push(other);
    await database.query(`INSERT INTO public.${TECHS} (id, owner, name) VALUES (1, $1, 'Mine'), (2, $2, 'Theirs')`, [caller.userId, other]);
    await database.query(`INSERT INTO public.${ORDERS} (id, technician, name) VALUES (1, 1, 'my order'), (2, 2, 'their order')`);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.outbox WHERE resource = ANY($1::uuid[])`, [resourceIds]);
    await database.query(`DELETE FROM totalbase.logs WHERE resource = ANY($1::uuid[])`, [resourceIds]);
    await database.query(`DELETE FROM totalbase.roles_capabilities WHERE role = $1`, [roleId]);
    for (const id of userIds) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1::uuid[])`, [resourceIds]);
    await database.query(`DROP TABLE IF EXISTS public.${PARTS}, public.${ORDERS}, public.${TECHS} CASCADE`);
    await app.close();
    await database.close();
  });

  it("updates one of the caller's orders", async () => {
    const res = await send("PATCH", `/api/public/table/${ORDERS}/1`, { data: { name: "my order, done" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ id: 1, name: "my order, done" });
  });

  it("never touches an order the filter hides: 404, and the row is unchanged", async () => {
    expect((await send("PATCH", `/api/public/table/${ORDERS}/2`, { data: { name: "taken" } })).statusCode).toBe(404);
    expect((await database.query(`SELECT name FROM public.${ORDERS} WHERE id = 2`)).rows[0]).toEqual({ name: "their order" });
  });

  it("refuses an update whose new row leaves the filter, and rolls it back", async () => {
    const res = await send("PATCH", `/api/public/table/${ORDERS}/1`, { data: { technician: 2 } });
    expect([res.statusCode, res.json().errors?.[0]?.code]).toEqual([403, "ACTION_DENIED"]);
    expect((await database.query(`SELECT technician FROM public.${ORDERS} WHERE id = 1`)).rows[0]).toEqual({ technician: 1 });
  });

  it("creates a part on the caller's order through two relations, and refuses one on another's", async () => {
    expect((await send("POST", `/api/public/table/${PARTS}`, { data: { work_order: 1, quantity: 2 } })).statusCode).toBe(201);
    const refused = await send("POST", `/api/public/table/${PARTS}`, { data: { work_order: 2, quantity: 2 } });
    expect([refused.statusCode, refused.json().errors?.[0]?.code]).toEqual([403, "ACTION_DENIED"]);
    expect((await database.query(`SELECT count(*)::int AS n FROM public.${PARTS} WHERE work_order = 2`)).rows[0]).toEqual({ n: 0 });
  });

  it("deletes a part of the caller's order through two relations, and never one of another's", async () => {
    const [mine, theirs] = (await database.query<{ id: number }>(
      `INSERT INTO public.${PARTS} (work_order, quantity) VALUES (1, 5), (2, 5) RETURNING id`,
    )).rows.map((row) => row.id);
    expect((await send("DELETE", `/api/public/table/${PARTS}/${theirs}`)).statusCode).toBe(404);
    expect((await database.query(`SELECT count(*)::int AS n FROM public.${PARTS} WHERE id = $1`, [theirs])).rows[0]).toEqual({ n: 1 });
    const res = await send("DELETE", `/api/public/table/${PARTS}/${mine}`);
    expect([200, 204], res.body).toContain(res.statusCode);
    expect((await database.query(`SELECT count(*)::int AS n FROM public.${PARTS} WHERE id = $1`, [mine])).rows[0]).toEqual({ n: 0 });
  });

  it("keeps a request's own where on a write to the table's columns", async () => {
    const res = await send("PATCH", `/api/public/table/${ORDERS}?where[technician.name][_eq]=Theirs`, { data: { name: "taken" } });
    expect([res.statusCode, res.json().errors?.[0]?.code]).toEqual([400, "INVALID_RELATION"]);
    expect((await database.query(`SELECT name FROM public.${ORDERS} WHERE id = 2`)).rows[0]).toEqual({ name: "their order" });
  });

  it("holds inside a transaction too", async () => {
    const ok = await app.inject({ method: "POST", url: "/api/transactions", headers: { authorization: `Bearer ${key}` }, payload: { operations: [
      { key: "order", operation: "update", schema: "public", table: ORDERS, id: 1, data: { name: "closed" } },
      { key: "part", operation: "insert", schema: "public", table: PARTS, data: { work_order: "$order.id", quantity: 1 } },
    ] } });
    expect(ok.statusCode, ok.body).toBe(200);
    const refused = await app.inject({ method: "POST", url: "/api/transactions", headers: { authorization: `Bearer ${key}` }, payload: { operations: [
      { key: "order", operation: "update", schema: "public", table: ORDERS, id: 2, data: { name: "taken" } },
    ] } });
    expect(refused.statusCode).toBe(404);
    expect((await database.query(`SELECT name FROM public.${ORDERS} WHERE id = 2`)).rows[0]).toEqual({ name: "their order" });
  });
});
