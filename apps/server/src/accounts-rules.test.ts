import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp } from "./test-support.js";

const P = "accounts-rules-test";
const PASSWORD = "a-strong-enough-password";
const REQUEST_ID = randomUUID();

/**
 * Specification_Security.md §10.3 step 3: account and role rules the
 * services enforced alone, now PostgreSQL's - so a
 * write through the Data API, by an administrator included, obeys them.
 */
describe("Account and role rules in PostgreSQL", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let ownerId: string;

  const call = (method: string, url: string, token: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined && { payload: payload as Record<string, unknown> }) });

  async function cleanup(): Promise<void> {
    await database.query(`DELETE FROM totalbase.logs WHERE request_id = $1`, [REQUEST_ID]);
    await database.query(`DELETE FROM totalbase.users WHERE email LIKE '${P}%'`);
    await database.query(`DELETE FROM totalbase.permissions WHERE role IN (SELECT id FROM totalbase.roles WHERE name LIKE '${P}%')`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE '${P}%'`);
  }

  async function signIn(email: string, roleId?: string): Promise<{ id: string; token: string }> {
    const user = await context.auth.users.create({ email, name: "x", passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    if (roleId) await context.roleAssignments.assignRoleToUser(user.id, roleId);
    return { id: user.id, token: (await context.auth.login({ email, password: PASSWORD })).token };
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await cleanup();
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    ownerId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE owner`)).rows[0]!.id;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("keeps the owner and the Workflows account active, whoever writes", async () => {
    await expect(database.query(`UPDATE totalbase.users SET active = false WHERE id = $1`, [ownerId])).rejects.toMatchObject({ code: "INSUFFICIENT_PRIVILEGE" });
    await expect(database.query(`UPDATE totalbase.users SET active = false WHERE email = 'workflows@system.totalbase.internal'`)).rejects.toMatchObject({ code: "INSUFFICIENT_PRIVILEGE" });
    const res = await call("PATCH", `/api/totalbase/table/users/${ownerId}`, adminToken, { data: { active: false } });
    expect(res.statusCode).toBe(403);
  });

  it("signs a deactivated account out everywhere - through the Data API too - and never lets you deactivate yourself", async () => {
    const plain = await signIn(`${P}-plain@example.com`);
    const off = await call("PATCH", `/api/totalbase/table/users/${plain.id}`, adminToken, { data: { active: false } });
    expect(off.statusCode, off.body).toBe(200);
    const { rows } = await database.query(`SELECT 1 FROM totalbase.sessions WHERE "user" = $1 AND revoked_at IS NULL`, [plain.id]);
    expect(rows).toHaveLength(0);

    const role = (await context.roles.create(`${P}-self`, { appAccess: true })).id;
    const users = (await database.query<{ id: string }>(`SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'users'`)).rows[0]!.id;
    await context.permissions.set(role, users, "UPDATE", { effect: "ALLOW", fields: [{ field: "active", effect: "ALLOW" }] });
    const self = await signIn(`${P}-self@example.com`, role);
    const mine = await call("PATCH", `/api/totalbase/table/users/${self.id}`, self.token, { data: { active: false } });
    expect(mine.statusCode).toBe(403);
    expect(mine.json().errors[0].message).toContain("your own account");
  });

  it("keeps the owner's Administrators role - checked at commit, so replacing the set still works", async () => {
    const administrators = await context.roles.getAdministratorsRoleId();
    const extra = (await context.roles.create(`${P}-extra`, { appAccess: true })).id;
    await context.roleAssignments.setRolesForUser(ownerId, [administrators, extra]);
    await context.roleAssignments.setRolesForUser(ownerId, [administrators]);
    await expect(database.query(`DELETE FROM totalbase.users_roles WHERE "user" = $1 AND role = $2`, [ownerId, administrators]))
      .rejects.toMatchObject({ code: "INSUFFICIENT_PRIVILEGE" });
    expect(await context.roleAssignments.listRolesForUser(ownerId)).toContain(administrators);
  });

  it("never changes a reserved role through the Data API, not even for an administrator", async () => {
    const administrators = await context.roles.getAdministratorsRoleId();
    const res = await call("PATCH", `/api/totalbase/table/roles/${administrators}`, adminToken, { data: { name: "Renamed" } });
    expect(res.statusCode).toBe(403);
    expect((await context.roles.findById(administrators))?.name).toBe("Administrators");
  });

  it("exposes a log entry's event as a column the filter grammar reaches", async () => {
    await context.audit.record(database, {
      requestId: REQUEST_ID,
      principal: { type: "SYSTEM", id: null },
      action: "AUTH",
      status: "EXECUTED",
      source: "admin",
      metadata: { event: "user.invite" },
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    const res = await call("GET", `/api/totalbase/table/logs?where[event][_eq]=user.invite&where[request_id][_eq]=${REQUEST_ID}&fields=id,event`, adminToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual([expect.objectContaining({ event: "user.invite" })]);
  });
});
