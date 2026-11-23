import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp, uniqueSuffix } from "./test-support.js";

/**
 * Security regression (Security.md §6.6): a write's answer projected the READ grant's fields but ignored its row
 * filter - a role whose UPDATE or DELETE reaches rows its READ doesn't got those rows' readable columns back.
 */
describe("a write answers only what a read of the row would", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let token: string;
  let resourceId: string;
  let roleId: string;
  const suffix = uniqueSuffix();
  const TABLE = `wrp_tasks_${suffix}`;
  const url = `/api/public/table/${TABLE}`;
  const send = (method: "PATCH" | "DELETE", path: string, payload?: unknown) =>
    app.inject({ method, url: path, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`CREATE TABLE public.${TABLE} (id integer PRIMARY KEY, team text NOT NULL, secret_note text NOT NULL)`);
    await database.query(`INSERT INTO public.${TABLE} VALUES (1, 'mine', 'readable'), (2, 'other', 'hidden from me'), (3, 'other', 'gone')`);
    resourceId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', '{GET,PATCH,DELETE}') RETURNING id`,
      [`public.${TABLE}`, TABLE],
    )).rows[0]!.id;
    roleId = (await context.roles.create(`wrp-${suffix}`, { apiAccess: true })).id;
    const allow = (fields: string[]) => fields.map((field) => ({ field, effect: "ALLOW" as const }));
    // Reads its own team's rows; may update and delete any.
    await context.permissions.set(roleId, resourceId, "READ", { effect: "ALLOW", where: { team: { _eq: "mine" } }, fields: allow(["id", "team", "secret_note"]) });
    await context.permissions.set(roleId, resourceId, "UPDATE", { effect: "ALLOW", fields: allow(["team"]) });
    await context.permissions.set(roleId, resourceId, "DELETE", { effect: "ALLOW" });
    token = (await createTestApiToken(context, { name: `wrp-${suffix}`, roleId, email: `wrp-${suffix}@example.com` })).plainKey;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await context.roles.delete(roleId).catch(() => undefined);
    await app.close();
  });

  it("gives back only the key of a row outside the READ filter, the whole readable row inside it", async () => {
    const outside = await send("PATCH", `${url}/2`, { data: { team: "other" } });
    expect(outside.statusCode, outside.body).toBe(200);
    expect(outside.json().data).toEqual({ id: 2 });
    const inside = await send("PATCH", `${url}/1`, { data: { team: "mine" } });
    expect(inside.json().data).toEqual({ id: 1, team: "mine", secret_note: "readable" });
    const deleted = await send("DELETE", `${url}/3`);
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(JSON.stringify(deleted.json().data)).not.toContain("gone");
    // A deleted row the caller could read comes back whole, as it was.
    const mine = await send("DELETE", `${url}/1`);
    expect(JSON.stringify(mine.json().data)).toContain("readable");
  });
});
