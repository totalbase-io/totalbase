import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { adminToken, setupTestApp, uniqueSuffix } from "./test-support.js";

/**
 * Security regression (Security.md §10.2): protected and Password columns were denied by name on a request's own
 * table only - through a relation path (`user.password_hash`, `customer.pin`) they read, filtered and sorted for
 * whoever's grant allowed the path, an administrator's full access and ADMIN-plane tokens included.
 */
describe("protected and Password columns through a relation path", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let admin: string;
  const resourceIds: string[] = [];
  let customersId: string;
  const suffix = uniqueSuffix();
  const CUSTOMERS = `rpc_customers_${suffix}`;
  const ORDERS = `rpc_orders_${suffix}`;

  const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${admin}` } });
  const outcome = (response: { statusCode: number; json: () => { errors?: { code: string }[] } }) => [response.statusCode, response.json().errors?.[0]?.code];

  async function register(table: string): Promise<string> {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', '{GET}') RETURNING id`,
      [`public.${table}`, table],
    );
    resourceIds.push(rows[0]!.id);
    return rows[0]!.id;
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    admin = await adminToken(context);
    await database.query(`CREATE TABLE public.${CUSTOMERS} (id integer PRIMARY KEY, name text NOT NULL, pin text NOT NULL, referrer integer REFERENCES public.${CUSTOMERS} (id))`);
    await database.query(`CREATE TABLE public.${ORDERS} (id integer PRIMARY KEY, customer integer NOT NULL REFERENCES public.${CUSTOMERS} (id))`);
    await database.query(`INSERT INTO public.${CUSTOMERS} VALUES (1, 'Acme', '$argon2id$hash')`);
    await database.query(`INSERT INTO public.${ORDERS} VALUES (10, 1)`);
    const customers = await register(CUSTOMERS);
    customersId = customers;
    await register(ORDERS);
    await database.query(
      `INSERT INTO totalbase.resources_columns (resource, attnum, name, config)
       SELECT $1, attnum, 'pin', '{"input": "password"}'::jsonb FROM pg_attribute WHERE attrelid = $2::regclass AND attname = 'pin'`,
      [customers, `public.${CUSTOMERS}`],
    );
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1)`, [resourceIds]);
    await database.query(`DROP TABLE IF EXISTS public.${ORDERS}, public.${CUSTOMERS}`);
    await app.close();
  });

  it("never reads, filters on or sorts by a protected column through a relation, even for an administrator", async () => {
    for (const url of [
      "/api/totalbase/table/users_roles?fields=id,user.password_hash",
      "/api/totalbase/table/users_roles?where[user.password_hash][_like]=%24argon2id%25",
      "/api/totalbase/table/users_roles?order_by=user.password_hash",
    ]) {
      expect(outcome(await get(url)), url).toEqual([403, "FIELD_PERMISSION_DENIED"]);
    }
    // The rest of the related row still reads.
    expect((await get("/api/totalbase/table/users_roles?fields=id,user.email&limit=1")).statusCode).toBe(200);
  });

  it("never reaches a Password column of a related table", async () => {
    for (const url of [`/api/public/table/${ORDERS}?fields=id,customer.pin`, `/api/public/table/${ORDERS}?where[customer.pin][_like]=%24argon2id%25`]) {
      expect(outcome(await get(url)), url).toEqual([403, "FIELD_PERMISSION_DENIED"]);
    }
    const named = await get(`/api/public/table/${ORDERS}?fields=id,customer.name`);
    expect(named.statusCode, named.body).toBe(200);
    expect(named.json().data).toEqual([{ id: 10, "customer.name": "Acme" }]);
  });

  // Security regression (Security.md §10.2): the request's own table was cached as loaded for the request - without
  // its Password columns - so a relation back to it (a self-reference) read them: `referrer.pin`.
  it("never reaches a Password column through a relation back to the request's own table", async () => {
    for (const url of [`/api/public/table/${CUSTOMERS}?fields=id,referrer.pin`, `/api/public/table/${CUSTOMERS}?where[referrer.pin][_like]=%24argon2id%25`]) {
      expect(outcome(await get(url)), url).toEqual([403, "FIELD_PERMISSION_DENIED"]);
    }
    expect((await get(`/api/public/table/${CUSTOMERS}?fields=id,referrer.name`)).statusCode).toBe(200);
  });

  // Security regression (Security.md §10.2): Password columns were looked up by their recorded name, which follows a
  // rename only at the next catalog sync - renamed in the SQL Console, the column read as a plain one until then.
  it("keeps a Password column one through a rename the catalog hasn't synced yet", async () => {
    await database.query(`ALTER TABLE public.${CUSTOMERS} RENAME COLUMN pin TO pin_code`);
    try {
      expect(outcome(await get(`/api/public/table/${ORDERS}?fields=id,customer.pin_code`))).toEqual([403, "FIELD_PERMISSION_DENIED"]);
      const own = await get(`/api/public/table/${CUSTOMERS}?fields=id,pin_code`);
      expect(own.body).not.toContain("$argon2id$hash");
    } finally {
      await database.query(`ALTER TABLE public.${CUSTOMERS} RENAME COLUMN pin_code TO pin`);
    }
  });

  // Security regression (Administration.md §4.1): the admin's rows preview dropped TotalBase's protected columns only
  // - a project table's Password column still showed its hashes there.
  it("leaves a Password column out of the admin's rows preview", async () => {
    const page = (await get(`/admin/api/catalog/table/${customersId}/rows?limit=5`)).json().data as { columns: { name: string }[]; rows: Record<string, unknown>[] };
    expect(page.columns.map((column) => column.name)).not.toContain("pin");
    expect(JSON.stringify(page.rows)).not.toContain("$argon2id$hash");
  });
});
