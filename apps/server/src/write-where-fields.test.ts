import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp, uniqueSuffix } from "./test-support.js";

/**
 * Security regression (Security.md §6.4): a write's own `where` names only fields the caller may read. A collection
 * PATCH or DELETE filtered on a hidden column answered which rows matched - its values, one guess at a time,
 * a password hash's included. The grant's own row filter keeps its rules (§6.5); a by-key write names its key.
 */
describe("a write's where names only what the caller may read", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let token: string;
  let roleId: string;
  let resourceId: string;
  let usersResourceId: string;
  const suffix = uniqueSuffix();
  const TABLE = `wwf_staff_${suffix}`;
  const url = `/api/public/table/${TABLE}`;
  const send = (method: "PATCH" | "DELETE" | "POST", path: string, payload?: unknown) =>
    app.inject({ method, url: path, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  const outcome = (response: { statusCode: number; json: () => { errors?: { code: string }[] } }) => [response.statusCode, response.json().errors?.[0]?.code];
  const salaries = async () => (await database.query<{ id: number; note: string }>(`SELECT id, note FROM public.${TABLE} ORDER BY id`)).rows;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`CREATE TABLE public.${TABLE} (id integer PRIMARY KEY, note text NOT NULL, salary integer NOT NULL)`);
    await database.query(`INSERT INTO public.${TABLE} VALUES (1, 'a', 10), (2, 'b', 90)`);
    resourceId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', '{GET,PATCH,DELETE}') RETURNING id`,
      [`public.${TABLE}`, TABLE],
    )).rows[0]!.id;
    usersResourceId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'users'`)).rows[0]!.id;
    roleId = (await context.roles.create(`wwf-${suffix}`, { apiAccess: true })).id;
    const allow = (fields: string[]) => fields.map((field) => ({ field, effect: "ALLOW" as const }));
    // Reads id and note, never salary; updates note; deletes.
    await context.permissions.set(roleId, resourceId, "READ", { effect: "ALLOW", fields: allow(["id", "note"]) });
    await context.permissions.set(roleId, resourceId, "UPDATE", { effect: "ALLOW", fields: allow(["note"]) });
    await context.permissions.set(roleId, resourceId, "DELETE", { effect: "ALLOW" });
    // A user manager: reads and updates users' names.
    await context.permissions.set(roleId, usersResourceId, "READ", { effect: "ALLOW", fields: allow(["id", "name"]) });
    await context.permissions.set(roleId, usersResourceId, "UPDATE", { effect: "ALLOW", fields: allow(["name"]) });
    await context.capabilityPermissions.setGrant(roleId, "TRANSACTIONS", "ALLOW");
    token = (await createTestApiToken(context, { name: `wwf-${suffix}`, roleId, email: `wwf-${suffix}@example.com` })).plainKey;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await context.roles.delete(roleId).catch(() => undefined);
    await app.close();
  });

  it("refuses a collection PATCH or DELETE filtered on a column the caller can't read", async () => {
    expect(outcome(await send("PATCH", `${url}?where[salary][_gt]=50`, { data: { note: "x" } }))).toEqual([403, "FIELD_PERMISSION_DENIED"]);
    expect(outcome(await send("DELETE", `${url}?where[salary][_gt]=50`))).toEqual([403, "FIELD_PERMISSION_DENIED"]);
    expect(outcome(await send("PATCH", `${url}?where[_or][0][salary][_lt]=5&where[_or][1][id][_eq]=1`, { data: { note: "x" } }))).toEqual([403, "FIELD_PERMISSION_DENIED"]);
    expect(await salaries()).toEqual([{ id: 1, note: "a" }, { id: 2, note: "b" }]);
  });

  it("refuses a protected column in a write's where - a password hash is never an oracle", async () => {
    const response = await send("PATCH", `/api/totalbase/table/users?where[password_hash][_like]=%24argon2id%25`, { data: { name: "same" } });
    expect(outcome(response)).toEqual([403, "FIELD_PERMISSION_DENIED"]);
  });

  it("still filters on what the caller reads, and writes by key", async () => {
    const byNote = await send("PATCH", `${url}?where[note][_eq]=a`, { data: { note: "a2" } });
    expect(byNote.statusCode, byNote.body).toBe(200);
    expect((await send("PATCH", `${url}/2`, { data: { note: "b2" } })).statusCode).toBe(200);
    const transaction = await send("POST", "/api/transactions", { operations: [{ key: "one", operation: "update", schema: "public", table: TABLE, id: 1, data: { note: "a3" } }] });
    expect(transaction.statusCode, transaction.body).toBe(200);
    expect(await salaries()).toEqual([{ id: 1, note: "a3" }, { id: 2, note: "b2" }]);
  });
});
