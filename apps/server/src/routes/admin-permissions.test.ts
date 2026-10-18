import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { createTestApiToken, setupTestApp } from "../test-support.js";

/**
 * PUT /admin/api/roles/:role/resources/:resource/permissions/:action -
 * structural validation of `where` before it's persisted (regression:
 * the admin used to accept and store a {field, value, operator} shape
 * that parseFilter() - the same parser buildRowFilter() uses at request
 * time - can't actually read, so it only failed once someone holding the
 * grant made a real request).
 */
describe("PUT /admin/api/roles/:role/resources/:resource/permissions/:action - where validation", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let roleId: string;
  let resourceId: string;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());

    await database.query(`DROP TABLE IF EXISTS public.admin_permissions_test_items CASCADE`);
    await database.query(`
      CREATE TABLE public.admin_permissions_test_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        status text NOT NULL
      )
    `);
    await database.query(
      `INSERT INTO public.admin_permissions_test_items (name, status) VALUES
       ('item-active', 'ACTIVE'), ('item-archived', 'ARCHIVED')`,
    );

    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass('public.admin_permissions_test_items')::oid, 'public', 'admin_permissions_test_items', 'TABLE', 'ACTIVE', ARRAY['GET'])
       RETURNING id`,
    );
    resourceId = rows[0]!.id;

    const role = await context.roles.create("admin-permissions-where-test-role", { apiAccess: true });
    roleId = role.id;

    const env = loadServerEnv();
    const login = await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! });
    adminToken = login.token;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await database.query(`DROP TABLE IF EXISTS public.admin_permissions_test_items CASCADE`);
    await app.close();
  });

  it("rejects the old flat {field, value, operator} shape and never persists it", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/admin/api/roles/${roleId}/resources/${resourceId}/permissions/READ`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { effect: "ALLOW", fields: [], where: { field: "status", value: "ACTIVE", operator: "_eq" } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe("INVALID_QUERY");

    const permissions = await context.permissions.listForRole(roleId);
    expect(permissions.find((p) => p.resource === resourceId && p.action === "READ")).toBeUndefined();
  });

  it("accepts the nested {field: {operator: value}} shape - same grammar as where[...] - and actually filters rows at request time", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/admin/api/roles/${roleId}/resources/${resourceId}/permissions/READ`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        data: {
          effect: "ALLOW",
          fields: [{ field: "id", effect: "ALLOW" }, { field: "name", effect: "ALLOW" }, { field: "status", effect: "ALLOW" }],
          where: { status: { _eq: "ACTIVE" } },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.whereClause).toEqual({ status: { _eq: "ACTIVE" } });

    const { plainKey, userId } = await createTestApiToken(context, {
      name: "where-validation-test-token",
      roleId,
      email: "admin-permissions-where-test-user@example.com",
    });
    try {
      const getRes = await app.inject({
        method: "GET",
        url: "/api/public/table/admin_permissions_test_items",
        headers: { authorization: `Bearer ${plainKey}` },
      });
      expect(getRes.statusCode).toBe(200);
      const rows = getRes.json().data as { name: string }[];
      expect(rows.map((r) => r.name)).toEqual(["item-active"]);
    } finally {
      await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]);
    }
  });

  it("rejects an unknown operator", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/admin/api/roles/${roleId}/resources/${resourceId}/permissions/UPDATE`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { effect: "ALLOW", fields: [], where: { status: { _bogus: "ACTIVE" } } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe("INVALID_OPERATOR");
  });

  it("still allows an unrestricted grant (where omitted or null)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/admin/api/roles/${roleId}/resources/${resourceId}/permissions/DELETE`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { effect: "ALLOW", fields: [] } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.whereClause).toBeNull();
  });

  it("removes a grant with 204, and answers 404 when there is none to remove", async () => {
    const url = `/admin/api/roles/${roleId}/resources/${resourceId}/permissions/DELETE`;
    const headers = { authorization: `Bearer ${adminToken}` };
    await context.permissions.set(roleId, resourceId, "DELETE", { effect: "ALLOW" });
    expect((await app.inject({ method: "DELETE", url, headers })).statusCode).toBe(204);
    const again = await app.inject({ method: "DELETE", url, headers });
    expect([again.statusCode, again.json().errors[0].code]).toEqual([404, "RESOURCE_NOT_FOUND"]);
  });

  it("takes the grant inside data", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/admin/api/roles/${roleId}/resources/${resourceId}/permissions/DELETE`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { effect: "ALLOW" },
    });
    expect(res.statusCode).toBe(400);
  });
});

/**
 * "Payload checks" (totalbase.permissions.payload_checks) - a
 * role-scoped CREATE/UPDATE business-rule check, not a PostgreSQL CHECK
 * constraint. The example this was designed around: a
 * data-entry role restricted to creating adult residents of Argentina.
 */
describe("Payload checks (payload_checks)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let roleId: string;
  let resourceId: string;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());

    await database.query(`DROP TABLE IF EXISTS public.admin_payload_checks_test_people CASCADE`);
    await database.query(`
      CREATE TABLE public.admin_payload_checks_test_people (
        id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name    text NOT NULL,
        age     int NOT NULL,
        country text NOT NULL
      )
    `);

    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass('public.admin_payload_checks_test_people')::oid, 'public', 'admin_payload_checks_test_people', 'TABLE', 'ACTIVE', ARRAY['GET', 'POST', 'PATCH'])
       RETURNING id`,
    );
    resourceId = rows[0]!.id;

    const role = await context.roles.create("admin-payload-checks-dataenter-role", { apiAccess: true });
    roleId = role.id;
    await context.permissions.set(roleId, resourceId, "CREATE", {
      effect: "ALLOW",
      fields: [{ field: "name", effect: "ALLOW" }, { field: "age", effect: "ALLOW" }, { field: "country", effect: "ALLOW" }],
    });

    const env = loadServerEnv();
    const login = await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! });
    adminToken = login.token;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await database.query(`DROP TABLE IF EXISTS public.admin_payload_checks_test_people CASCADE`);
    await app.close();
  });

  it("rejects a malformed rule the same way where is rejected", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/admin/api/roles/${roleId}/resources/${resourceId}/permissions/CREATE`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        data: {
          effect: "ALLOW",
          payloadChecks: [{ rule: { field: "age", value: 18, operator: "_gte" }, label: "Must be 18 or older" }],
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe("INVALID_QUERY");
  });

  it("saves two labeled rules and round-trips them", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/admin/api/roles/${roleId}/resources/${resourceId}/permissions/CREATE`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        data: {
          effect: "ALLOW",
          fields: [{ field: "name", effect: "ALLOW" }, { field: "age", effect: "ALLOW" }, { field: "country", effect: "ALLOW" }],
          payloadChecks: [
            { rule: { age: { _gte: "18" } }, label: "Must be 18 or older" },
            { rule: { country: { _eq: "AR" } }, label: "Must be a resident of Argentina" },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.payloadChecks).toEqual([
      { rule: { age: { _gte: "18" } }, label: "Must be 18 or older" },
      { rule: { country: { _eq: "AR" } }, label: "Must be a resident of Argentina" },
    ]);
  });

  it("rejects a CREATE that violates one rule, with that rule's label as the message", async () => {
    const { plainKey, userId } = await createTestApiToken(context, {
      name: "payload-checks-test-token-1",
      roleId,
      email: "admin-payload-checks-test-user-1@example.com",
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/public/table/admin_payload_checks_test_people",
        headers: { authorization: `Bearer ${plainKey}` },
        payload: { data: { name: "Juan", age: 16, country: "AR" } },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().errors[0]).toMatchObject({ code: "PAYLOAD_CHECK_FAILED", message: "Must be 18 or older" });

      const { rows } = await database.query(`SELECT * FROM public.admin_payload_checks_test_people WHERE name = 'Juan'`);
      expect(rows).toHaveLength(0); // rolled back, not left half-written
    } finally {
      await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]);
    }
  });

  it("reports every failing rule's label, not just the first", async () => {
    const { plainKey, userId } = await createTestApiToken(context, {
      name: "payload-checks-test-token-2",
      roleId,
      email: "admin-payload-checks-test-user-2@example.com",
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/public/table/admin_payload_checks_test_people",
        headers: { authorization: `Bearer ${plainKey}` },
        payload: { data: { name: "Kim", age: 16, country: "UY" } },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().errors[0].message).toBe("Must be 18 or older; Must be a resident of Argentina");
    } finally {
      await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]);
    }
  });

  it("allows a CREATE that satisfies every rule", async () => {
    const { plainKey, userId } = await createTestApiToken(context, {
      name: "payload-checks-test-token-3",
      roleId,
      email: "admin-payload-checks-test-user-3@example.com",
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/public/table/admin_payload_checks_test_people",
        headers: { authorization: `Bearer ${plainKey}` },
        payload: { data: { name: "Maria", age: 30, country: "AR" } },
      });
      expect(res.statusCode).toBe(201);
      // The role has no READ grant, so the response carries only the primary key - check the row itself.
      const { rows } = await database.query(`SELECT name FROM public.admin_payload_checks_test_people WHERE name = 'Maria'`);
      expect(rows).toHaveLength(1);
    } finally {
      await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]);
    }
  });

  it("re-checks rules on UPDATE against the resulting row, not just at CREATE", async () => {
    await context.permissions.set(roleId, resourceId, "UPDATE", {
      effect: "ALLOW",
      fields: [{ field: "age", effect: "ALLOW" }],
      payloadChecks: [{ rule: { age: { _gte: "18" } }, label: "Must be 18 or older" }],
    });
    const { rows: seeded } = await database.query<{ id: string }>(
      `INSERT INTO public.admin_payload_checks_test_people (name, age, country) VALUES ('Adult', 25, 'AR') RETURNING id`,
    );
    const id = seeded[0]!.id;

    const { plainKey, userId } = await createTestApiToken(context, {
      name: "payload-checks-test-token-4",
      roleId,
      email: "admin-payload-checks-test-user-4@example.com",
    });
    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/public/table/admin_payload_checks_test_people/${id}`,
        headers: { authorization: `Bearer ${plainKey}` },
        payload: { data: { age: 10 } },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().errors[0]).toMatchObject({ code: "PAYLOAD_CHECK_FAILED", message: "Must be 18 or older" });

      const { rows: check } = await database.query<{ age: number }>(
        `SELECT age FROM public.admin_payload_checks_test_people WHERE id = $1`,
        [id],
      );
      expect(check[0]?.age).toBe(25); // rolled back, unchanged
    } finally {
      await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]);
    }
  });
});
