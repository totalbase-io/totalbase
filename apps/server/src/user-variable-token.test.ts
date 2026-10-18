import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

/**
 * Regression: `$USER.*` resolves the token owner's real users row
 * for an API token exactly as for a session (Specification_Security.md §6.5,
 * Specification_Data_API.md §3.7). Before, a token principal carried no user
 * row and every `$USER.*` - in a request filter, a row filter or a payload
 * check - failed with 400 INVALID_QUERY, so a row filter like
 * `owner = $USER.id` locked tokens out entirely.
 */
describe("$USER.* with an API token", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let itemsId: string;
  let roleId: string;
  let ownerKey: string;
  let ownerId: string;
  let otherId: string;
  const userIds: string[] = [];

  const ITEMS = "user_variable_token_test_items";
  const URL = `/api/public/table/${ITEMS}`;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`DROP TABLE IF EXISTS public.${ITEMS} CASCADE`);
    await database.query(`CREATE TABLE public.${ITEMS} (id serial PRIMARY KEY, owner uuid NOT NULL, name text NOT NULL)`);
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', $3) RETURNING id`,
      [`public.${ITEMS}`, ITEMS, ["GET", "POST", "PATCH"]],
    );
    itemsId = rows[0]!.id;

    roleId = (await context.roles.create("user-variable-token-test-role", { apiAccess: true })).id;
    const all = ["id", "owner", "name"].map((field) => ({ field, effect: "ALLOW" as const }));
    const own = { owner: { _eq: "$USER.id" } };
    await context.permissions.set(roleId, itemsId, "READ", { effect: "ALLOW", where: own, fields: all });
    await context.permissions.set(roleId, itemsId, "CREATE", {
      effect: "ALLOW",
      fields: all,
      payloadChecks: [{ rule: own, label: "A row is created for yourself." }],
    });
    await context.permissions.set(roleId, itemsId, "UPDATE", { effect: "ALLOW", where: own, fields: [{ field: "name", effect: "ALLOW" }] });

    const owner = await createTestApiToken(context, { name: "user-variable-token-test-owner", roleId, email: "user-variable-token-test-owner@example.com" });
    ownerKey = owner.plainKey;
    ownerId = owner.userId;
    userIds.push(ownerId);
    otherId = (await context.auth.users.create({ email: "user-variable-token-test-other@example.com" })).id;
    userIds.push(otherId);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.logs WHERE resource = $1`, [itemsId]);
    await database.query(`DELETE FROM totalbase.outbox WHERE resource = $1`, [itemsId]);
    for (const id of userIds) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [itemsId]);
    await database.query(`DROP TABLE IF EXISTS public.${ITEMS} CASCADE`);
    await app.close();
    await database.close();
  });

  it("a row filter owner = $USER.id returns only the token owner's rows", async () => {
    await database.query(`INSERT INTO public.${ITEMS} (owner, name) VALUES ($1, 'mine'), ($2, 'theirs')`, [ownerId, otherId]);
    const res = await app.inject({ method: "GET", url: `${URL}?fields=name`, headers: { authorization: `Bearer ${ownerKey}` } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual([{ name: "mine" }]);
  });

  it("a request filter may use $USER.* with a token", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${URL}?fields=name&where[owner][_eq]=${encodeURIComponent("$USER.id")}`,
      headers: { authorization: `Bearer ${ownerKey}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual([{ name: "mine" }]);
  });

  it("a payload check and an UPDATE row filter on $USER.id hold for a token", async () => {
    const forSelf = await app.inject({ method: "POST", url: URL, headers: { authorization: `Bearer ${ownerKey}` }, payload: { data: { owner: ownerId, name: "created" } } });
    expect(forSelf.statusCode, forSelf.body).toBe(201);

    const forOther = await app.inject({ method: "POST", url: URL, headers: { authorization: `Bearer ${ownerKey}` }, payload: { data: { owner: otherId, name: "planted" } } });
    expect(forOther.statusCode).toBe(422);

    const { rows } = await database.query<{ id: number }>(`SELECT id FROM public.${ITEMS} WHERE owner = $1 AND name = 'theirs'`, [otherId]);
    const theirs = await app.inject({ method: "PATCH", url: `${URL}/${rows[0]!.id}`, headers: { authorization: `Bearer ${ownerKey}` }, payload: { data: { name: "hijacked" } } });
    expect([403, 404]).toContain(theirs.statusCode);
    const { rows: after } = await database.query<{ name: string }>(`SELECT name FROM public.${ITEMS} WHERE id = $1`, [rows[0]!.id]);
    expect(after[0]!.name).toBe("theirs");
  });

  it("reads the owner's row live, never values frozen into the token", async () => {
    const read = () => app.inject({
      method: "GET",
      url: `${URL}?fields=name&where[name][_eq]=${encodeURIComponent("$USER.name")}`,
      headers: { authorization: `Bearer ${ownerKey}` },
    });
    await database.query(`UPDATE totalbase.users SET name = 'mine' WHERE id = $1`, [ownerId]);
    expect((await read()).json().data).toEqual([{ name: "mine" }]);
    await database.query(`UPDATE totalbase.users SET name = 'created' WHERE id = $1`, [ownerId]);
    expect((await read()).json().data).toEqual([{ name: "created" }]);
  });
});
