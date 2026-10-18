import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp } from "./test-support.js";

const P = "admin-reads-test";
const PASSWORD = "a-strong-enough-password";

/**
 * Specification_Security.md §10.3 step 2: the administrator's screens
 * read TotalBase's own tables through the Data API (fixed exposure, the
 * administrator bypassing permissions), and revoke sessions as a plain row
 * update - which PostgreSQL keeps to a revocation only.
 */
describe("Admin reads and session revocation through the Data API", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let plainToken: string;
  let plainUserId: string;

  const call = (method: string, url: string, token: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined && { payload: payload as Record<string, unknown> }) });

  async function cleanup(): Promise<void> {
    await database.query(`DELETE FROM totalbase.users WHERE email LIKE '${P}%'`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE '${P}%'`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await cleanup();
    const env = loadServerEnv();
    // A reconcile applies the fixed exposure, whatever earlier suites left.
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    expect((await call("POST", "/admin/api/catalog/refresh", adminToken)).statusCode).toBeLessThan(300);

    const role = (await context.roles.create(`${P}-plain`, { appAccess: true })).id;
    const user = await context.auth.users.create({ email: `${P}-plain@example.com`, name: "Plain", passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    plainUserId = user.id;
    await context.roleAssignments.assignRoleToUser(user.id, role);
    plainToken = (await context.auth.login({ email: `${P}-plain@example.com`, password: PASSWORD })).token;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("serves the administrator's registry and access tables, and nothing to a user without a grant", async () => {
    for (const table of ["resources", "permissions", "roles_managers", "dataviews_roles", "dashboards_roles", "sessions"]) {
      const admin = await call("GET", `/api/totalbase/table/${table}?limit=1`, adminToken);
      expect(admin.statusCode, `${table}: ${admin.body}`).toBe(200);
      expect((await call("GET", `/api/totalbase/table/${table}?limit=1`, plainToken)).statusCode, table).toBe(403);
    }
    // A session's secret never comes out, not even to an administrator.
    const sessions = await call("GET", "/api/totalbase/table/sessions?limit=5", adminToken);
    for (const row of sessions.json().data as Record<string, unknown>[]) expect(row).not.toHaveProperty("token_hash");
  });

  it("revokes a session with PostgreSQL's clock - and nothing else about it changes", async () => {
    const { rows } = await database.query<{ id: string; expires_at: Date }>(
      `SELECT id, expires_at FROM totalbase.sessions WHERE "user" = $1 AND revoked_at IS NULL`,
      [plainUserId],
    );
    const target = rows[0]!;
    const res = await call("PATCH", `/api/totalbase/table/sessions/${target.id}`, adminToken, {
      data: { revoked_at: "2000-01-01T00:00:00Z", expires_at: "2100-01-01T00:00:00Z" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = (await database.query<{ revoked_at: Date; expires_at: Date }>(`SELECT revoked_at, expires_at FROM totalbase.sessions WHERE id = $1`, [target.id])).rows[0]!;
    expect(Math.abs(after.revoked_at.getTime() - Date.now())).toBeLessThan(60_000);
    expect(after.expires_at.getTime()).toBe(target.expires_at.getTime());
    expect((await call("GET", "/admin/api/auth/me", plainToken)).statusCode).toBe(401);

    // Never un-revoked.
    await call("PATCH", `/api/totalbase/table/sessions/${target.id}`, adminToken, { data: { revoked_at: null } });
    const again = (await database.query<{ revoked_at: Date | null }>(`SELECT revoked_at FROM totalbase.sessions WHERE id = $1`, [target.id])).rows[0]!;
    expect(again.revoked_at).not.toBeNull();
  });

  it("lets an administrator's plane=\"ADMIN\" token drive the Data API - only while its owner is an administrator", async () => {
    const administrators = await context.roles.getAdministratorsRoleId();
    const owner = await context.auth.users.create({ email: `${P}-agent@example.com`, name: "Agent" });
    await context.roleAssignments.assignRoleToUser(owner.id, administrators);
    const { plainKey } = await context.usersApis.create({ userId: owner.id, name: `${P}-agent`, plane: "ADMIN" });

    const read = await call("GET", "/api/totalbase/table/roles?limit=1", plainKey);
    expect(read.statusCode, read.body).toBe(200);

    await database.query(`DELETE FROM totalbase.users_roles WHERE "user" = $1 AND role = $2`, [owner.id, administrators]);
    expect((await call("GET", "/api/totalbase/table/roles?limit=1", plainKey)).statusCode).toBe(401);
  });
});

