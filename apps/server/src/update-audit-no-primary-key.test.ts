import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

/**
 * Specification_Security.md §11.4: an UPDATE on a table without a primary
 * key records old and new of what it changed on PostgreSQL 18+ (RETURNING
 * OLD); on PostgreSQL 15-17 the old row isn't known - the entry keeps the
 * resulting row only. Runs against whatever
 * server POSTGRES_* points at; each version's expectation applies there.
 */
describe("UPDATE audit on a table without a primary key", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let major: number;
  let roleId: string;
  let resourceId: string;
  let token: { plainKey: string; tokenId: string; userId: string };
  const TABLE = "update_audit_nopk_items";

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    major = await database.serverMajorVersion();
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await database.query(`CREATE TABLE public.${TABLE} (code text NOT NULL, price numeric NOT NULL)`);
    await database.query(`INSERT INTO public.${TABLE} VALUES ('A', 1), ('B', 2)`);
    resourceId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', ARRAY['GET', 'PATCH']) RETURNING id`,
      [`public.${TABLE}`, TABLE],
    )).rows[0]!.id;
    roleId = (await context.roles.create("update-audit-nopk-role", { apiAccess: true })).id;
    const allow = (...fields: string[]) => fields.map((field) => ({ field, effect: "ALLOW" as const }));
    await context.permissions.set(roleId, resourceId, "READ", { effect: "ALLOW", fields: allow("code", "price") });
    await context.permissions.set(roleId, resourceId, "UPDATE", { effect: "ALLOW", fields: allow("price") });
    token = await createTestApiToken(context, { name: "update-audit-nopk-key", roleId, email: "update-audit-nopk@example.com" });
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.logs WHERE resource = $1`, [resourceId]);
    await database.query(`DELETE FROM totalbase.outbox WHERE resource = $1`, [resourceId]);
    await database.query(`DELETE FROM totalbase.audits_exclusions WHERE resource = $1`, [resourceId]);
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [token.userId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await app.close();
    await database.close();
  });

  it("PATCH by filter records old and new on PostgreSQL 18+, the resulting row only before", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/public/table/${TABLE}?where[code][_eq]=A`,
      headers: { authorization: `Bearer ${token.plainKey}` },
      payload: { data: { price: 10 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("__old");
    const { rows } = await database.query<{ changes: unknown; payload: unknown }>(
      `SELECT changes, payload FROM totalbase.logs WHERE resource = $1 AND action = 'UPDATE' AND status = 'EXECUTED'`,
      [resourceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ code: "A", price: "10" });
    expect(rows[0]!.changes).toEqual(major >= 18 ? { price: { old: "1", new: "10" } } : null);
  });
});
