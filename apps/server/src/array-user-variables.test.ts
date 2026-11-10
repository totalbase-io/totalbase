import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp, uniqueSuffix } from "./test-support.js";

const COLUMN = "auv_test_tenants";
const ITEMS = "auv_test_items";

/**
 * Array user variables (Data_API.md §3.7): a `$USER.<column>` whose column is an array - `users.tenants uuid[]`,
 * one user in several tenants - contributes its elements to an `_in`/`_nin` list, in a row filter as in a
 * request's where; compared with a scalar operator it is refused.
 */
describe("array $USER variables in _in / _nin", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let userId: string;
  let key: string;
  let itemsId: string;
  const tenants = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];

  const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${key}` } });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`ALTER TABLE totalbase.users ADD COLUMN IF NOT EXISTS ${COLUMN} uuid[]`);
    await database.query(`DROP TABLE IF EXISTS public.${ITEMS}`);
    await database.query(`CREATE TABLE public.${ITEMS} (id serial PRIMARY KEY, tenant uuid NOT NULL, name text NOT NULL)`);
    await database.query(`INSERT INTO public.${ITEMS} (tenant, name) VALUES ($1, 'one'), ($2, 'two'), ($3, 'three')`, tenants);
    itemsId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', $3) RETURNING id`,
      [`public.${ITEMS}`, ITEMS, ["GET"]],
    )).rows[0]!.id;
    roleId = (await context.roles.create(`auv-test-${uniqueSuffix()}`, { apiAccess: true })).id;
    await context.permissions.set(roleId, itemsId, "READ", {
      effect: "ALLOW",
      fields: ["id", "tenant", "name"].map((field) => ({ field, effect: "ALLOW" as const })),
      where: { tenant: { _in: `$USER.${COLUMN}` } },
    });
    ({ plainKey: key, userId } = await createTestApiToken(context, { name: "auv-test", roleId, email: `auv-test-${uniqueSuffix()}@example.com` }));
    await database.query(`UPDATE totalbase.users SET ${COLUMN} = $1 WHERE id = $2`, [[tenants[0], tenants[1]], userId]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.logs WHERE resource = $1`, [itemsId]);
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [itemsId]);
    await database.query(`DROP TABLE IF EXISTS public.${ITEMS}`);
    await database.query(`ALTER TABLE totalbase.users DROP COLUMN IF EXISTS ${COLUMN}`);
    await app.close();
  });

  it("a row filter's _in over the user's array column keeps the rows of the user's tenants - and follows the column live", async () => {
    const res = await get(`/api/public/table/${ITEMS}?order_by=id`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.map((r: { name: string }) => r.name)).toEqual(["one", "two"]);

    await database.query(`UPDATE totalbase.users SET ${COLUMN} = $1 WHERE id = $2`, [[tenants[2]], userId]);
    expect((await get(`/api/public/table/${ITEMS}`)).json().data.map((r: { name: string }) => r.name)).toEqual(["three"]);

    // Empty, and null: no row.
    await database.query(`UPDATE totalbase.users SET ${COLUMN} = '{}' WHERE id = $1`, [userId]);
    expect((await get(`/api/public/table/${ITEMS}`)).json().data).toEqual([]);
    await database.query(`UPDATE totalbase.users SET ${COLUMN} = NULL WHERE id = $1`, [userId]);
    expect((await get(`/api/public/table/${ITEMS}`)).json().data).toEqual([]);
    await database.query(`UPDATE totalbase.users SET ${COLUMN} = $1 WHERE id = $2`, [[tenants[0], tenants[1]], userId]);
  });

  it("a request's _nin and a mixed list work the same; a scalar comparison with the array is 400 INVALID_QUERY", async () => {
    const mixed = await get(`/api/public/table/${ITEMS}?where[tenant][_in][]=$USER.${COLUMN}&where[tenant][_in][]=${tenants[2]}&order_by=id`);
    // The request narrows within the row filter: the third tenant stays out of reach.
    expect(mixed.json().data.map((r: { name: string }) => r.name)).toEqual(["one", "two"]);
    const nin = await get(`/api/public/table/${ITEMS}?where[tenant][_nin]=${tenants[0]}&order_by=id`);
    expect(nin.json().data.map((r: { name: string }) => r.name)).toEqual(["two"]);

    const scalar = await get(`/api/public/table/${ITEMS}?where[tenant][_eq]=$USER.${COLUMN}`);
    expect(scalar.statusCode).toBe(400);
    expect(scalar.json().errors[0].code).toBe("INVALID_QUERY");
    expect(scalar.json().errors[0].message).toContain("_in");
  });
});
