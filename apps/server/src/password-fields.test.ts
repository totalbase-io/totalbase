import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { setupTestApp } from "./test-support.js";

/**
 * Password column end-to-end (the `password` entry of the column input
 * catalog, packages/tb-catalog/src/columns/column-inputs.ts): a password column hashes on write and is never returned by the generic
 * Data API, exercised through the real HTTP surface (app.inject - no
 * socket opens, but every real hook/route/service runs), same pattern
 * security.test.ts's regression suite already uses.
 */
async function registerTestResource(database: Database, schema: string, table: string): Promise<string> {
  const { rows } = await database.query<{ id: string }>(
    `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
     VALUES (to_regclass($1)::oid, $2, $3, 'TABLE', 'ACTIVE', $4)
     RETURNING id`,
    [`${schema}.${table}`, schema, table, ["GET", "POST", "PATCH", "DELETE"]],
  );
  return rows[0]!.id;
}

describe("Password fields", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let resourceId: string;
  let apiKeyPlain: string;
  let apiKeyUserId: string;
  let apiKeyId: string;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());

    await database.query(`DROP TABLE IF EXISTS public.password_fields_test_accounts CASCADE`);
    await database.query(`
      CREATE TABLE public.password_fields_test_accounts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        password text NOT NULL
      )
    `);

    resourceId = await registerTestResource(database, "public", "password_fields_test_accounts");
    const { rows: attrRows } = await database.query<{ attnum: number }>(
      `SELECT attnum FROM pg_attribute WHERE attrelid = 'public.password_fields_test_accounts'::regclass AND attname = 'password'`,
    );
    await database.query(
      `INSERT INTO totalbase.resources_columns (resource, attnum, name, config)
       VALUES ($1, $2, 'password', '{"input": "password"}'::jsonb)`,
      [resourceId, attrRows[0]!.attnum],
    );

    const role = await context.roles.create("password-fields-test-role", { apiAccess: true });
    roleId = role.id;
    // Full field grants on every action, including "password" itself -
    // proves the DENY-on-read comes from the password-column mechanism,
    // not from a missing/narrower field grant.
    const fields = [
      { field: "id", effect: "ALLOW" as const },
      { field: "name", effect: "ALLOW" as const },
      { field: "password", effect: "ALLOW" as const },
    ];
    await context.permissions.set(roleId, resourceId, "READ", { effect: "ALLOW", fields });
    await context.permissions.set(roleId, resourceId, "CREATE", { effect: "ALLOW", fields });
    await context.permissions.set(roleId, resourceId, "UPDATE", { effect: "ALLOW", fields });
    await context.permissions.set(roleId, resourceId, "DELETE", { effect: "ALLOW" });

    const apiKeyUser = await context.auth.users.create({ email: "password-fields-test-key-owner@example.com" });
    apiKeyUserId = apiKeyUser.id;
    await context.roleAssignments.assignRoleToUser(apiKeyUserId, roleId);
    const created = await context.usersApis.create({ userId: apiKeyUserId, name: "password-fields-test-key", plane: "API" });
    apiKeyPlain = created.plainKey;
    apiKeyId = created.userApi.id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.tokens WHERE id = $1`, [apiKeyId]);
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [apiKeyUserId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await database.query(`DROP TABLE IF EXISTS public.password_fields_test_accounts CASCADE`);
    await app.close();
    await database.close();
  });

  it("hashes the plaintext value on CREATE and never echoes it back", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/public/table/password_fields_test_accounts",
      headers: { authorization: `Bearer ${apiKeyPlain}` },
      payload: { data: { name: "alice", password: "correct-horse-battery-staple" } },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json().data as Record<string, unknown>;
    expect(created).not.toHaveProperty("password");

    const { rows } = await database.query<{ password: string }>(
      `SELECT password FROM public.password_fields_test_accounts WHERE id = $1`,
      [created["id"]],
    );
    expect(rows[0]?.password).toMatch(/^\$argon2id\$/);
    expect(rows[0]?.password).not.toBe("correct-horse-battery-staple");
  });

  it("never returns the column on GET, even with a full field grant", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/public/table/password_fields_test_accounts",
      headers: { authorization: `Bearer ${apiKeyPlain}` },
      payload: { data: { name: "bob", password: "correct-horse-battery-staple" } },
    });
    const id = (create.json().data as Record<string, unknown>)["id"];

    const res = await app.inject({
      method: "GET",
      url: `/api/public/table/password_fields_test_accounts/${id}`,
      headers: { authorization: `Bearer ${apiKeyPlain}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).not.toHaveProperty("password");
  });

  it("rejects a password shorter than auth.password_min_length before hashing", async () => {
    const minLength = await context.settings.get("auth.password_min_length");
    const res = await app.inject({
      method: "POST",
      url: "/api/public/table/password_fields_test_accounts",
      headers: { authorization: `Bearer ${apiKeyPlain}` },
      payload: { data: { name: "carol", password: "a".repeat(minLength - 1) } },
    });
    expect(res.statusCode).toBe(400);

    const { rows } = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.password_fields_test_accounts WHERE name = 'carol'`,
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it("re-hashes on UPDATE and still never echoes it back", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/public/table/password_fields_test_accounts",
      headers: { authorization: `Bearer ${apiKeyPlain}` },
      payload: { data: { name: "dave", password: "correct-horse-battery-staple" } },
    });
    const id = (create.json().data as Record<string, unknown>)["id"];

    const res = await app.inject({
      method: "PATCH",
      url: `/api/public/table/password_fields_test_accounts/${id}`,
      headers: { authorization: `Bearer ${apiKeyPlain}` },
      payload: { data: { password: "a-brand-new-passphrase" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).not.toHaveProperty("password");

    const { rows } = await database.query<{ password: string }>(
      `SELECT password FROM public.password_fields_test_accounts WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.password).toMatch(/^\$argon2id\$/);
  });
});
