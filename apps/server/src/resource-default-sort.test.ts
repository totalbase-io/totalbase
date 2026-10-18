import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

/**
 * A resource's default order (Specification.md §11.7, Specification_Data_API.md §3.6): a read without `order_by`
 * comes in it, then by primary key; `order_by` still wins; a new DataView starts from it.
 */
describe("resource default order", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let itemsId: string;
  let token: string;
  let userId: string;
  let tokenId: string;
  const ITEMS = "default_sort_test_items";
  const get = (query = "") => app.inject({ method: "GET", url: `/api/public/table/${ITEMS}?fields=name${query}`, headers: { authorization: `Bearer ${token}` } });
  const names = async (query = "") => (await get(query)).json().data.map((r: { name: string }) => r.name) as string[];

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`DROP TABLE IF EXISTS public.${ITEMS} CASCADE`);
    await database.query(`CREATE TABLE public.${ITEMS} (id serial PRIMARY KEY, name text NOT NULL, rank int NOT NULL)`);
    await database.query(`INSERT INTO public.${ITEMS} (name, rank) VALUES ('b', 2), ('a', 2), ('c', 1)`);
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', $3) RETURNING id`,
      [`public.${ITEMS}`, ITEMS, ["GET"]],
    );
    itemsId = rows[0]!.id;
    roleId = (await context.roles.create("default-sort-test-role", { apiAccess: true })).id;
    await context.permissions.set(roleId, itemsId, "READ", { effect: "ALLOW", fields: ["id", "name", "rank"].map((field) => ({ field, effect: "ALLOW" as const })) });
    ({ plainKey: token, userId, tokenId } = await createTestApiToken(context, { name: "default-sort-test-key", roleId, email: "default-sort-test-owner@example.com" }));
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.dataviews WHERE source_resource = $1`, [itemsId]);
    await database.query(`DELETE FROM totalbase.logs WHERE resource = $1`, [itemsId]);
    await database.query(`DELETE FROM totalbase.tokens WHERE id = $1`, [tokenId]);
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [itemsId]);
    await database.query(`DROP TABLE IF EXISTS public.${ITEMS} CASCADE`);
    await app.close();
    await database.close();
  });

  it("orders a read without order_by by the primary key, then by the resource's default order with the key as tiebreaker", async () => {
    expect(await names()).toEqual(["b", "a", "c"]);
    await context.resourcesAdmin.updateDefaultSort(itemsId, [{ column: "rank", direction: "asc" }]);
    // rank 1 first; the two with rank 2 by id (b was inserted before a).
    expect(await names()).toEqual(["c", "b", "a"]);
    await context.resourcesAdmin.updateDefaultSort(itemsId, [{ column: "rank", direction: "desc" }, { column: "name", direction: "asc" }]);
    expect(await names()).toEqual(["a", "b", "c"]);
    // The request's own order wins.
    expect(await names("&order_by=-name")).toEqual(["c", "b", "a"]);
  });

  it("seeds a new DataView's default sort from the resource's, unless the DataView brings its own", async () => {
    const seeded = await context.dataviewsAdmin.create({ name: "Default sort seeded", viewType: "TABLE", sourceResourceId: itemsId });
    expect((seeded.viewConfig.default_state as { sort?: string }).sort).toBe("-rank,name");
    const own = await context.dataviewsAdmin.create({ name: "Default sort own", viewType: "TABLE", sourceResourceId: itemsId, viewConfig: { default_state: { sort: "name" } } });
    expect((own.viewConfig.default_state as { sort?: string }).sort).toBe("name");
  });
});
