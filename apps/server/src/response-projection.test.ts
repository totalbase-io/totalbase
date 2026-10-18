import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

/**
 * Security regression: every mutation is `RETURNING *`, and responses used
 * to hand that whole row back - a role that could CREATE a row but only
 * READ `id`/`name` still got `secret` in the POST response. A mutation now
 * returns only what the caller's READ grant shows (only the primary key
 * without one), across every write path: CREATE/UPDATE/DELETE, nested
 * writes, and transactions (including their backward references).
 */
describe("Mutation responses are projected through the READ grant", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let itemsId: string;
  let notesId: string;
  let apiKeyPlain: string;
  let apiKeyUserId: string;
  let apiKeyId: string;

  const ITEMS = "projection_test_items";
  const NOTES = "projection_test_notes";

  async function register(table: string, methods: string[]): Promise<string> {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', $3) RETURNING id`,
      [`public.${table}`, table, methods],
    );
    return rows[0]!.id;
  }

  function request(method: "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${apiKeyPlain}` }, ...(payload ? { payload: payload as object } : {}) });
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());

    await database.query(`DROP TABLE IF EXISTS public.${NOTES} CASCADE`);
    await database.query(`DROP TABLE IF EXISTS public.${ITEMS} CASCADE`);
    await database.query(`CREATE TABLE public.${ITEMS} (id serial PRIMARY KEY, name text, secret text DEFAULT 'TOP-SECRET')`);
    await database.query(`
      CREATE TABLE public.${NOTES} (
        id serial PRIMARY KEY,
        item integer NOT NULL REFERENCES public.${ITEMS}(id),
        body text,
        hidden text DEFAULT 'CHILD-SECRET'
      )
    `);
    itemsId = await register(ITEMS, ["GET", "POST", "PATCH", "DELETE"]);
    notesId = await register(NOTES, ["POST"]);

    const role = await context.roles.create("projection-test-role", { apiAccess: true });
    roleId = role.id;
    const allow = (...fields: string[]) => fields.map((field) => ({ field, effect: "ALLOW" as const }));
    await context.permissions.set(roleId, itemsId, "READ", { effect: "ALLOW", fields: allow("id", "name") });
    await context.permissions.set(roleId, itemsId, "CREATE", { effect: "ALLOW", fields: allow("name", "secret") });
    await context.permissions.set(roleId, itemsId, "UPDATE", { effect: "ALLOW", fields: allow("name") });
    await context.permissions.set(roleId, itemsId, "DELETE", { effect: "ALLOW" });
    // No READ on notes at all: responses carry only its primary key.
    await context.permissions.set(roleId, notesId, "CREATE", { effect: "ALLOW", fields: allow("item", "body") });
    await context.capabilityPermissions.setGrant(roleId, "TRANSACTIONS", "ALLOW");

    ({ plainKey: apiKeyPlain, userId: apiKeyUserId, tokenId: apiKeyId } = await createTestApiToken(context, {
      name: "projection-test-key",
      roleId,
      email: "projection-test-key-owner@example.com",
    }));
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.tokens WHERE id = $1`, [apiKeyId]);
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [apiKeyUserId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1)`, [[itemsId, notesId]]);
    await database.query(`DROP TABLE IF EXISTS public.${NOTES} CASCADE`);
    await database.query(`DROP TABLE IF EXISTS public.${ITEMS} CASCADE`);
    await app.close();
    await database.close();
  });

  it("CREATE returns only READ-granted fields, even for a column the caller just wrote", async () => {
    const res = await request("POST", `/api/public/table/${ITEMS}`, { data: { name: "a", secret: "written-by-caller" } });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toEqual({ id: expect.any(Number), name: "a" });
  });

  it("bulk CREATE, UPDATE and DELETE never return a non-readable column", async () => {
    const bulk = await request("POST", `/api/public/table/${ITEMS}?bulk=true`, { data: [{ name: "b" }, { name: "c" }] });
    expect(bulk.statusCode).toBe(201);
    const ids = (bulk.json().data as { id: number }[]).map((row) => row.id);

    const update = await request("PATCH", `/api/public/table/${ITEMS}/${ids[0]}`, { data: { name: "b2" } });
    expect(update.statusCode).toBe(200);
    expect(update.json().data).toEqual({ id: ids[0], name: "b2" });

    const remove = await request("DELETE", `/api/public/table/${ITEMS}/${ids[1]}`);
    expect(remove.statusCode).toBe(200);
    expect(remove.json().data).toEqual({ id: ids[1], name: "c" });

    for (const res of [bulk, update, remove]) expect(res.body).not.toContain("TOP-SECRET");
  });

  it("nested writes project every node through its own resource's READ grant", async () => {
    const res = await request("POST", `/api/public/table/${ITEMS}`, { data: { name: "parent", [`$${NOTES}`]: [{ body: "hello" }] } });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data).toEqual({ id: expect.any(Number), name: "parent", [`$${NOTES}`]: [{ id: expect.any(Number) }] });
    expect(res.body).not.toContain("SECRET");
  });

  it("transactions return projected rows, and a backward reference can't read a hidden column", async () => {
    const ok = await app.inject({
      method: "POST",
      url: "/api/transactions",
      headers: { authorization: `Bearer ${apiKeyPlain}` },
      payload: { operations: [{ key: "a", operation: "insert", schema: "public", table: ITEMS, data: { name: "tx" } }] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.a).toEqual({ id: expect.any(Number), name: "tx" });

    const leak = await app.inject({
      method: "POST",
      url: "/api/transactions",
      headers: { authorization: `Bearer ${apiKeyPlain}` },
      payload: {
        operations: [
          { key: "a", operation: "insert", schema: "public", table: ITEMS, data: { name: "src" } },
          { key: "b", operation: "insert", schema: "public", table: ITEMS, data: { name: "$a.secret" } },
        ],
      },
    });
    expect(leak.statusCode).toBeGreaterThanOrEqual(400);
    const { rows } = await database.query(`SELECT 1 FROM public.${ITEMS} WHERE name = 'TOP-SECRET'`);
    expect(rows).toHaveLength(0);
  });
});
