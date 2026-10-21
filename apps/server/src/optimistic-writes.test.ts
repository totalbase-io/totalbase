import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

/**
 * Optimistic writes (Data_API.md §4.2, §5.3, T56): a row's version is PostgreSQL's xmin, answered
 * by a read and an update by key; If-Match makes a PATCH or DELETE by key fail 409 ROW_VERSION_CONFLICT on a row
 * written since - and never tells a row hidden by the row filter from one that doesn't exist (404 both).
 */
describe("optimistic writes by key", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let itemsId: string;
  let token: string;
  let userId: string;
  let tokenId: string;

  const ITEMS = "optimistic_writes_test_items";

  const call = (method: "GET" | "PATCH" | "DELETE", id: number, payload?: unknown, ifMatch?: string) =>
    app.inject({
      method,
      url: `/api/public/table/${ITEMS}/${id}`,
      headers: { authorization: `Bearer ${token}`, ...(ifMatch !== undefined && { "if-match": ifMatch }) },
      ...(payload !== undefined && { payload: payload as object }),
    });

  async function insertItem(name: string, visible = true): Promise<number> {
    const { rows } = await database.query<{ id: number }>(`INSERT INTO public.${ITEMS} (name, visible) VALUES ($1, $2) RETURNING id`, [name, visible]);
    return rows[0]!.id;
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`DROP TABLE IF EXISTS public.${ITEMS} CASCADE`);
    await database.query(`CREATE TABLE public.${ITEMS} (id serial PRIMARY KEY, name text, visible boolean NOT NULL DEFAULT true)`);
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', $3) RETURNING id`,
      [`public.${ITEMS}`, ITEMS, ["GET", "POST", "PATCH", "DELETE"]],
    );
    itemsId = rows[0]!.id;
    roleId = (await context.roles.create("optimistic-writes-test-role", { apiAccess: true })).id;
    const fields = ["id", "name", "visible"].map((field) => ({ field, effect: "ALLOW" as const }));
    const onlyVisible = { visible: { _eq: "true" } };
    for (const action of ["READ", "UPDATE", "DELETE"] as const) {
      await context.permissions.set(roleId, itemsId, action, { effect: "ALLOW", fields, where: onlyVisible });
    }
    ({ plainKey: token, userId, tokenId } = await createTestApiToken(context, {
      name: "optimistic-writes-test-key",
      roleId,
      email: "optimistic-writes-test-owner@example.com",
    }));
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.logs WHERE resource = $1`, [itemsId]);
    await database.query(`DELETE FROM totalbase.outbox WHERE resource = $1`, [itemsId]);
    await database.query(`DELETE FROM totalbase.tokens WHERE id = $1`, [tokenId]);
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [itemsId]);
    await database.query(`DROP TABLE IF EXISTS public.${ITEMS} CASCADE`);
    await app.close();
    await database.close();
  });

  it("answers the version on a read and an update, and refuses a write over a newer one with 409", async () => {
    const id = await insertItem("first");
    const read = await call("GET", id);
    expect(read.statusCode).toBe(200);
    const version = read.json().meta.version as string;
    expect(version).toMatch(/^\d+$/);
    expect(read.headers.etag).toBe(`"${version}"`);
    expect(read.json().data).not.toHaveProperty("__version");

    // Someone else writes it meanwhile.
    await database.query(`UPDATE public.${ITEMS} SET name = 'theirs' WHERE id = $1`, [id]);

    const stale = await call("PATCH", id, { data: { name: "mine" } }, `"${version}"`);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().errors[0].code).toBe("ROW_VERSION_CONFLICT");
    expect((await database.query(`SELECT name FROM public.${ITEMS} WHERE id = $1`, [id])).rows[0]).toEqual({ name: "theirs" });

    // With the current version it writes, and answers the next one; without If-Match it is unconditional.
    const current = (await call("GET", id)).json().meta.version as string;
    const saved = await call("PATCH", id, { data: { name: "mine" } }, `"${current}"`);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().meta.version).not.toBe(current);
    expect(saved.json().data).toEqual({ id, name: "mine", visible: true });
    expect((await call("PATCH", id, { data: { name: "anyway" } })).statusCode).toBe(200);

    expect((await call("DELETE", id, undefined, `"${current}"`)).statusCode).toBe(409);
    const latest = (await call("GET", id)).json().meta.version as string;
    expect((await call("DELETE", id, undefined, `W/"${latest}"`)).statusCode).toBe(200);
  });

  it("keeps a row the filter hides a 404, never a 409 - its existence isn't revealed", async () => {
    const hidden = await insertItem("hidden", false);
    const res = await call("PATCH", hidden, { data: { name: "x" } }, '"1"');
    expect(res.statusCode).toBe(404);
    expect((await call("PATCH", 999999, { data: { name: "x" } }, '"1"')).statusCode).toBe(404);
    expect((await call("PATCH", hidden, { data: { name: "x" } }, '"not-a-version"')).statusCode).toBe(400);
  });
});
