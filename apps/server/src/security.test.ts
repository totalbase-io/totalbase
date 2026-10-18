import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp, uniqueSuffix } from "./test-support.js";

const SUFFIX = uniqueSuffix();

/**
 * Registers one table directly in totalbase.resources, bypassing
 * @totalbase/resources' reconcileResources(). That function snapshots
 * the whole catalog and marks anything missing from the snapshot as
 * MISSING - safe in isolation, but this suite runs concurrently with
 * every other package's tests against the same shared totalbase_test
 * database (scripts/test-integration.sh), and a concurrently-running
 * reconcileResources() elsewhere (snapshot taken before this table
 * existed, UPDATE running after) can retroactively flip this resource
 * back to MISSING mid-suite. Registering directly sidesteps that
 * cross-process race entirely for these test-only resources.
 */
async function registerTestResource(
  database: Database,
  schema: string,
  table: string,
  exposed: boolean,
): Promise<string> {
  const { rows } = await database.query<{ id: string }>(
    `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
     VALUES (to_regclass($1)::oid, $2, $3, 'TABLE', 'ACTIVE', $4)
     RETURNING id`,
    [`${schema}.${table}`, schema, table, exposed ? ["GET", "POST", "PATCH", "DELETE"] : []],
  );
  return rows[0]!.id;
}

/**
 * Regression suite for Specification.md §23's "Security"
 * Definition of Done: SQL injection, permission bypass, secret leakage,
 * and hidden-resource tests. Every security defect this project has
 * found gets a permanent test here (AGENTS.md section 23). Runs
 * against the real bootstrapped app via Fastify's inject() - no socket
 * actually opens, but every real hook/route/service runs.
 */
describe("Security regression suite", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let resourceId: string;
  let apiKeyUserId: string;
  let plainUserId: string | undefined;
  let apiKeyPlain: string;
  let apiKeyId: string;
  let adminToken: string;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());

    await database.query(`DROP TABLE IF EXISTS public.security_pkg_test_items CASCADE`);
    await database.query(`
      CREATE TABLE public.security_pkg_test_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        secret text NOT NULL
      )
    `);
    await database.query(
      `INSERT INTO public.security_pkg_test_items (name, secret) VALUES ('injection-target', 'topsecret')`,
    );

    resourceId = await registerTestResource(database, "public", "security_pkg_test_items", true);

    const role = await context.roles.create(`security-pkg-test-role-${SUFFIX}`, { apiAccess: true });
    roleId = role.id;
    await context.permissions.set(roleId, resourceId, "READ", {
      effect: "ALLOW",
      fields: [
        { field: "id", effect: "ALLOW" },
        { field: "name", effect: "ALLOW" },
        // "secret" deliberately NOT granted.
      ],
    });

    const apiKeyUser = await context.auth.users.create({ email: `security-pkg-test-key-owner-${SUFFIX}@example.com` });
    apiKeyUserId = apiKeyUser.id;
    await context.roleAssignments.assignRoleToUser(apiKeyUserId, roleId);
    const created = await context.usersApis.create({ userId: apiKeyUserId, name: `security-pkg-test-key-${SUFFIX}`, plane: "API" });
    apiKeyPlain = created.plainKey;
    apiKeyId = created.userApi.id;

    const env = loadServerEnv();
    const login = await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! });
    adminToken = login.token;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.tokens WHERE id = $1`, [apiKeyId]);
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [apiKeyUserId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(
      `DELETE FROM totalbase.resources WHERE "schema" = 'public' AND name IN ('security_pkg_test_items', 'security_pkg_test_hidden')`,
    );
    await database.query(`DROP TABLE IF EXISTS public.security_pkg_test_items CASCADE`);
    await database.query(`DROP TABLE IF EXISTS public.security_pkg_test_hidden CASCADE`);
    if (plainUserId) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [plainUserId]);
    await app.close();
    await database.close();
  });

  describe("SQL injection", () => {
    it("treats an injected Data API filter value as a literal parameter, never executed SQL", async () => {
      const injected = encodeURIComponent("x'; DROP TABLE public.security_pkg_test_items; --");
      const res = await app.inject({
        method: "GET",
        url: `/api/public/table/security_pkg_test_items?where[name][_eq]=${injected}`,
        headers: { authorization: `Bearer ${apiKeyPlain}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([]);

      const { rows } = await database.query<{ oid: string | null }>(
        `SELECT to_regclass('public.security_pkg_test_items')::text AS oid`,
      );
      expect(rows[0]?.oid).not.toBeNull();
    });

    it("rejects a semicolon-stacked injection attempt through Schema Management's CHECK endpoint", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/admin/api/schema/public/tables/security_pkg_test_items/checks",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { data: { name: "evil", expression: "1=1); DROP TABLE totalbase.users; --" } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors[0].code).toBe("INVALID_SCHEMA_OPERATION");

      const { rows } = await database.query<{ count: string }>(`SELECT count(*)::text AS count FROM totalbase.users`);
      expect(Number(rows[0]?.count)).toBeGreaterThan(0);
    });
  });

  describe("Permission bypass", () => {
    it("denies CREATE to a principal only granted READ", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/public/table/security_pkg_test_items",
        headers: { authorization: `Bearer ${apiKeyPlain}` },
        payload: { data: { name: "hacked", secret: "x" } },
      });
      expect(res.statusCode).toBe(403);
    });

    it("never returns a field the principal has no field-level grant for", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/public/table/security_pkg_test_items",
        headers: { authorization: `Bearer ${apiKeyPlain}` },
      });
      expect(res.statusCode).toBe(200);
      const rows = res.json().data as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).not.toHaveProperty("secret");
    });

    it("rejects an unauthenticated request outright", async () => {
      const res = await app.inject({ method: "GET", url: "/api/public/table/security_pkg_test_items" });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("Hidden resources", () => {
    it("is indistinguishable from a nonexistent resource - same status and code", async () => {
      await database.query(`DROP TABLE IF EXISTS public.security_pkg_test_hidden`);
      await database.query(`CREATE TABLE public.security_pkg_test_hidden (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`);
      await registerTestResource(database, "public", "security_pkg_test_hidden", false); // new resources start hidden

      const hidden = await app.inject({
        method: "GET",
        url: "/api/public/table/security_pkg_test_hidden",
        headers: { authorization: `Bearer ${apiKeyPlain}` },
      });
      const missing = await app.inject({
        method: "GET",
        url: "/api/public/table/security_pkg_test_does_not_exist_xyz",
        headers: { authorization: `Bearer ${apiKeyPlain}` },
      });

      expect(hidden.statusCode).toBe(404);
      expect(hidden.statusCode).toBe(missing.statusCode);
      expect(hidden.json().errors[0].code).toBe(missing.json().errors[0].code);
    });
  });

  describe("Secret leakage", () => {
    it("never re-exposes an API key's plaintext or hash after creation", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/totalbase/table/tokens?where[id][_eq]=${apiKeyId}&fields=id,name,key_hash`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode, res.body).toBeLessThan(500);
      const everything = await app.inject({
        method: "GET",
        url: `/api/totalbase/table/tokens?where[id][_eq]=${apiKeyId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(everything.statusCode, everything.body).toBe(200);
      expect(everything.json().data[0]).not.toHaveProperty("key");
      expect(everything.json().data[0]).not.toHaveProperty("key_hash");
      for (const body of [res.body, everything.body]) expect(body).not.toContain(apiKeyPlain);
    });

    it("never exposes a user's password_hash via the Admin API", async () => {
      const { rows } = await database.query<{ id: string }>(
        `INSERT INTO totalbase.users (email) VALUES ($1) RETURNING id`,
        [`security-pkg-test-user-${SUFFIX}@example.com`],
      );
      plainUserId = rows[0]!.id;
      const res = await app.inject({
        method: "GET",
        url: `/admin/api/users/${rows[0]!.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.toLowerCase()).not.toContain("password_hash");
      expect(res.body.toLowerCase()).not.toContain("passwordhash");
    });

    it("never exposes TOTALBASE_MASTER_KEY through the settings endpoint", async () => {
      const env = loadServerEnv();
      const res = await app.inject({
        method: "GET",
        url: "/admin/api/settings",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(env.masterKey);
    });
  });

  describe("Defensive request limits (Specification_Data_API.md §12)", () => {
    it("rejects an oversized request body with REQUEST_BODY_TOO_LARGE", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/public/table/security_pkg_test_items",
        headers: { authorization: `Bearer ${apiKeyPlain}`, "content-type": "application/json" },
        payload: JSON.stringify({ data: { name: "x", secret: "y".repeat(6_000_000) } }),
      });
      expect(res.statusCode).toBe(413);
      expect(res.json().errors[0].code).toBe("REQUEST_BODY_TOO_LARGE");
    });

    it("bounds a collection write's where by api.max_query_nodes too (UPDATE and DELETE)", async () => {
      // 20 OR branches (qs keeps array indexes up to 20) of 3 comparisons over a 3-hop path each:
      // 20 * (1 + 3 * (1 + 3)) + 1 = 261 nodes, with only 60 query parameters.
      const where = Array.from({ length: 60 }, (_, i) => `where[_or][${i % 20}][a.b.c.d${Math.floor(i / 20)}][_eq]=x`).join("&");
      for (const method of ["PATCH", "DELETE"] as const) {
        const res = await app.inject({
          method,
          url: `/api/public/table/security_pkg_test_items?${where}`,
          headers: { authorization: `Bearer ${apiKeyPlain}` },
          ...(method === "PATCH" ? { payload: { data: { name: "never" } } } : {}),
        });
        expect([res.statusCode, res.json().errors[0].code], method).toEqual([400, "QUERY_COMPLEXITY_LIMIT_EXCEEDED"]);
      }
    });

    it("rejects an overly complex query with QUERY_COMPLEXITY_LIMIT_EXCEEDED", async () => {
      const manyFields = Array.from({ length: 250 }, (_, i) => `f${i}`).join(",");
      const res = await app.inject({
        method: "GET",
        url: `/api/public/table/security_pkg_test_items?fields=${manyFields}`,
        headers: { authorization: `Bearer ${apiKeyPlain}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors[0].code).toBe("QUERY_COMPLEXITY_LIMIT_EXCEEDED");
    });
  });
});
