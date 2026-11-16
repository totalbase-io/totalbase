import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

const PREFIX = "read-by-key-fields-test";

/**
 * A read by key takes `fields` as a list read does (Data_API.md §4.2): the same paths, relations and
 * field permissions, and the READ audit row records them.
 */
describe("Data API read by key - fields", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let ordersId: string;
  let customersId: string;
  let roleId: string;
  let reader: { plainKey: string; userId: string; tokenId: string };
  let orderId: number;

  const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${reader.plainKey}` } });

  async function dropObjects(): Promise<void> {
    await database.query(`DROP TABLE IF EXISTS public.rbk_orders, public.rbk_customers`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await dropObjects();
    await database.query(`CREATE TABLE public.rbk_customers (id serial PRIMARY KEY, name text NOT NULL)`);
    await database.query(
      `CREATE TABLE public.rbk_orders (id serial PRIMARY KEY, code text NOT NULL, total numeric NOT NULL, internal text,
         customer int NOT NULL REFERENCES public.rbk_customers (id))`,
    );
    await database.query(`INSERT INTO public.rbk_customers (name) VALUES ('Acme')`);
    orderId = (await database.query<{ id: number }>(
      `INSERT INTO public.rbk_orders (code, total, internal, customer) VALUES ('O-1', 10, 'hidden', 1) RETURNING id`,
    )).rows[0]!.id;

    // The relation's target is a resource too, or its path is INVALID_RELATION.
    const register = async (name: string) => (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods, audit_read)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', ARRAY['GET'], true)
       RETURNING id`,
      [`public.${name}`, name],
    )).rows[0]!.id;
    ordersId = await register("rbk_orders");
    customersId = await register("rbk_customers");

    roleId = (await context.roles.create(`${PREFIX}-role`, { apiAccess: true })).id;
    const fields = ["id", "code", "total", "customer", "customer.name"].map((field) => ({ field, effect: "ALLOW" as const }));
    await context.permissions.set(roleId, ordersId, "READ", { effect: "ALLOW", fields });
    reader = await createTestApiToken(context, { name: `${PREFIX}-reader`, roleId, email: `${PREFIX}-reader@example.com` });
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.logs WHERE resource = $1`, [ordersId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1::uuid[])`, [[ordersId, customersId]]);
    if (reader) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [reader.userId]);
    if (roleId) await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await dropObjects();
    await app.close();
  });

  it("without fields, every root column the grant allows - as before", async () => {
    const res = await get(`/api/public/table/rbk_orders/${orderId}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ id: orderId, code: "O-1", total: "10", customer: 1 });
    expect(res.json().meta.version).toBeTruthy();
  });

  it("returns the fields asked for, relation paths and aliases included, the same as the list read", async () => {
    const byKey = await get(`/api/public/table/rbk_orders/${orderId}?fields=id,customer.name`);
    expect(byKey.statusCode, byKey.body).toBe(200);
    expect(byKey.json().data).toEqual({ id: orderId, "customer.name": "Acme" });
    expect(byKey.json().meta.version).toBeTruthy();
    expect(byKey.headers.etag).toBe(`"${byKey.json().meta.version}"`);

    const list = await get(`/api/public/table/rbk_orders?where[id][_eq]=${orderId}&fields=id,customer.name`);
    expect(list.json().data).toEqual([byKey.json().data]);

    const aliased = await get(`/api/public/table/rbk_orders/${orderId}?fields[code]=Code&fields[customer.name]=Customer`);
    expect(aliased.json().data).toEqual({ Code: "O-1", Customer: "Acme" });
  });

  it("refuses a field the caller may not read, and an unknown one, as the list read does", async () => {
    for (const fields of ["id,internal", "id,nope", "id,customer.id"]) {
      const byKey = await get(`/api/public/table/rbk_orders/${orderId}?fields=${fields}`);
      const list = await get(`/api/public/table/rbk_orders?where[id][_eq]=${orderId}&fields=${fields}`);
      expect(byKey.statusCode, fields).toBe(403);
      expect(byKey.json().errors[0].code).toBe("FIELD_PERMISSION_DENIED");
      expect(byKey.json().errors[0].code).toBe(list.json().errors[0].code);
    }
  });

  it("applies the relation depth limit", async () => {
    const depth = await context.settings.get("api.max_relation_depth");
    const path = `${Array.from({ length: depth + 1 }, () => "customer").join(".")}.name`;
    const res = await get(`/api/public/table/rbk_orders/${orderId}?fields=${path}`);
    expect(res.statusCode).toBe(400);
  });

  it("the READ audit row records the fields", async () => {
    await database.query(`DELETE FROM totalbase.logs WHERE resource = $1`, [ordersId]);
    await get(`/api/public/table/rbk_orders/${orderId}?fields=id,customer.name`);
    const { rows } = await database.query<Record<string, unknown>>(
      `SELECT status, fields, metadata FROM totalbase.logs WHERE resource = $1 AND action = 'READ' ORDER BY created_at`,
      [ordersId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "EXECUTED", fields: ["id", "customer.name"], metadata: { rowCount: 1, pk: String(orderId) } });
  });
});
