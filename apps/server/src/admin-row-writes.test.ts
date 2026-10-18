import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

const P = "admin-row-writes-test";
const PASSWORD = "a-strong-enough-password";

/**
 * Specification_Security.md §10.3 step 4: roles, users and personal
 * access tokens written as Data API rows (the tokens_limited_changes trigger keeps
 * updated_at, the owner and a token's fixed columns), and a user deleted
 * through its own delegated endpoint, which also clears the avatar.
 */
describe("Admin writes on TotalBase's own rows", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let delegateToken: string;
  let delegateRole: string;

  const call = (method: string, url: string, token: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined && { payload: payload as Record<string, unknown> }) });

  async function cleanup(): Promise<void> {
    await database.query(`DELETE FROM totalbase.users WHERE email LIKE '${P}%'`);
    await database.query(`DELETE FROM totalbase.permissions WHERE role IN (SELECT id FROM totalbase.roles WHERE name LIKE '${P}%')`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE '${P}%'`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await cleanup();
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    expect((await call("POST", "/admin/api/catalog/refresh", adminToken)).statusCode).toBeLessThan(300);

    delegateRole = (await context.roles.create(`${P}-delegates`, { appAccess: true })).id;
    const users = (await database.query<{ id: string }>(`SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'users'`)).rows[0]!.id;
    await context.permissions.set(delegateRole, users, "DELETE", { effect: "ALLOW" });
    const delegate = await context.auth.users.create({ email: `${P}-delegate@example.com`, name: "Delegate", passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    await context.roleAssignments.assignRoleToUser(delegate.id, delegateRole);
    delegateToken = (await context.auth.login({ email: `${P}-delegate@example.com`, password: PASSWORD })).token;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("lets an administrator set a role's access flags as a row - and keeps updated_at current", async () => {
    const created = await call("POST", "/api/totalbase/table/roles", adminToken, { data: { name: `${P}-api-only`, app_access: false, api_access: true } });
    expect(created.statusCode, created.body).toBe(201);
    const role = created.json().data;
    expect([role.app_access, role.api_access]).toEqual([false, true]);
    await database.query(`UPDATE totalbase.roles SET updated_at = now() - interval '1 day' WHERE id = $1`, [role.id]);
    expect((await call("PATCH", `/api/totalbase/table/roles/${role.id}`, adminToken, { data: { app_access: true } })).statusCode).toBe(200);
    const { rows } = await database.query<{ app_access: boolean; updated_at: Date }>(`SELECT app_access, updated_at FROM totalbase.roles WHERE id = $1`, [role.id]);
    expect(rows[0]!.app_access).toBe(true);
    expect(Date.now() - rows[0]!.updated_at.getTime()).toBeLessThan(60_000);
    // admin_access stays reserved-only, even for an administrator.
    expect((await call("PATCH", `/api/totalbase/table/roles/${role.id}`, adminToken, { data: { admin_access: true } })).statusCode).toBe(403);
  });

  it("lists, revokes and deletes a token as a row - never its secret, never moved, extended or un-revoked", async () => {
    const apiRole = (await context.roles.create(`${P}-api`, { apiAccess: true })).id;
    const { tokenId, userId } = await createTestApiToken(context, { name: `${P}-token`, roleId: apiRole, email: `${P}-owner@example.com` });
    const owner = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE owner`)).rows[0]!.id;
    const listed = await call("GET", `/api/totalbase/table/tokens?where[user][_eq]=${userId}`, adminToken);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().data[0]).not.toHaveProperty("key_hash");
    expect((await call("GET", `/api/totalbase/table/tokens?limit=1`, delegateToken)).statusCode).toBe(403);

    const before = (await database.query<{ expires_at: Date }>(`SELECT expires_at FROM totalbase.tokens WHERE id = $1`, [tokenId])).rows[0]!;
    const revoked = await call("PATCH", `/api/totalbase/table/tokens/${tokenId}`, adminToken, {
      data: { active: false, revoked_at: "2000-01-01T00:00:00Z", expires_at: "2100-01-01T00:00:00Z", user: owner },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    const after = (await database.query<{ user: string; active: boolean; revoked_at: Date | null; expires_at: Date }>(
      `SELECT "user", active, revoked_at, expires_at FROM totalbase.tokens WHERE id = $1`, [tokenId],
    )).rows[0]!;
    expect(after.user).toBe(userId);
    expect(after.active).toBe(false);
    expect(Math.abs(after.revoked_at!.getTime() - Date.now())).toBeLessThan(60_000);
    expect(after.expires_at.getTime()).toBe(before.expires_at.getTime());
    await call("PATCH", `/api/totalbase/table/tokens/${tokenId}`, adminToken, { data: { revoked_at: null } });
    expect((await database.query<{ revoked_at: Date | null }>(`SELECT revoked_at FROM totalbase.tokens WHERE id = $1`, [tokenId])).rows[0]!.revoked_at).not.toBeNull();

    expect((await call("DELETE", `/api/totalbase/table/tokens/${tokenId}`, adminToken)).statusCode).toBe(200);
  });

  it("never deletes the instance owner through the Data API, not even as an administrator", async () => {
    const owner = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE owner`)).rows[0]!.id;
    expect((await call("DELETE", `/api/totalbase/table/users/${owner}`, adminToken)).statusCode).toBe(403);
  });

  it("deletes a user in scope through the delegated endpoint - never an administrator", async () => {
    const plain = await context.auth.users.create({ email: `${P}-plain@example.com`, name: "Plain" });
    expect((await call("DELETE", `/app/api/users/${plain.id}`, delegateToken)).statusCode).toBe(204);
    expect(await context.auth.users.findById(plain.id)).toBeNull();

    const admin = await context.auth.users.create({ email: `${P}-admin@example.com`, name: "Admin" });
    await context.roleAssignments.assignRoleToUser(admin.id, await context.roles.getAdministratorsRoleId());
    expect((await call("DELETE", `/app/api/users/${admin.id}`, delegateToken)).statusCode).toBe(403);
    expect(await context.auth.users.findById(admin.id)).not.toBeNull();
  });

  it("answers a broken rule with the constraint's own message, not PostgreSQL's raw one", async () => {
    const dup = await call("POST", "/api/totalbase/table/roles", adminToken, { data: { name: "Administrators" } });
    expect([dup.statusCode, dup.json().errors[0].code, dup.json().errors[0].message]).toEqual([409, "UNIQUE_VIOLATION", "A role with this name already exists."]);
    const icon = await call("POST", "/api/totalbase/table/roles", adminToken, { data: { name: `${P}-icon`, icon: "not an icon" } });
    expect([icon.statusCode, icon.json().errors[0].message]).toEqual([422, "Unknown role icon."]);
    // A uniqueness enforced by a unique index (lower(email)) reads the index's comment.
    const env = loadServerEnv();
    const email = await call("POST", "/api/totalbase/table/users", adminToken, { data: { email: env.adminEmail!.toUpperCase() } });
    expect([email.statusCode, email.json().errors[0].message]).toEqual([409, "A user with this email already exists."]);
  });

  it("shows a Data API assignment in the role's access history", async () => {
    const role = (await context.roles.create(`${P}-history`, { appAccess: true })).id;
    const user = await context.auth.users.create({ email: `${P}-member@example.com`, name: "Member" });
    const assigned = await call("POST", "/api/totalbase/table/users_roles", adminToken, { data: { user: user.id, role } });
    expect(assigned.statusCode, assigned.body).toBe(201);
    const history = await call("GET", `/admin/api/audit/logs?role_change=${role}&limit=10`, adminToken);
    expect(history.statusCode, history.body).toBe(200);
    const entry = (history.json().data as Array<{ metadata: { event?: string }; payload?: { user?: string } }>)[0]!;
    expect(entry.metadata.event).toBe("assignment.create");
    expect(entry.payload?.user).toBe(user.id);
  });
});

