import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { hashPassword } from "@totalbase/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp } from "./test-support.js";

const PREFIX = "user-extra-test";
const COLUMN = "user_extra_test_tenant";
const PASSWORD = "a-strong-enough-password";

/**
 * `user.extra` (Security.md §2.5): the project's columns of the signed-in user's own row, as their grants on
 * users let them read them - in /api/auth/me, the sign-in answers and the portal's me. Decided by the
 * security engine: no READ on users, or a row filter that hides the row, gives {}.
 */
describe("user.extra in the signed-in user", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let userId: string;
  let token: string;
  let usersResourceId: string;
  const email = `${PREFIX}@example.com`;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`DELETE FROM totalbase.users WHERE email = $1`, [email]);
    await database.query(`DELETE FROM totalbase.roles WHERE name = $1`, [`${PREFIX}-role`]);
    await database.query(`ALTER TABLE totalbase.users ADD COLUMN IF NOT EXISTS ${COLUMN} text`);
    roleId = (await context.roles.create(`${PREFIX}-role`, { apiAccess: true, appAccess: true })).id;
    const user = await context.auth.users.create({ email, passwordHash: await hashPassword(PASSWORD) });
    userId = user.id;
    await database.query(`UPDATE totalbase.users SET ${COLUMN} = 'acme', email_verified_at = now() WHERE id = $1`, [userId]);
    await context.roleAssignments.assignRoleToUser(userId, roleId);
    usersResourceId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.resources WHERE schema = 'totalbase' AND name = 'users'`)).rows[0]!.id;
    token = (await context.auth.login({ email, password: PASSWORD })).token;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`ALTER TABLE totalbase.users DROP COLUMN IF EXISTS ${COLUMN}`);
    await app.close();
  });

  const me = () => app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } });

  it("is empty without READ on users", async () => {
    const res = await me();
    expect(res.statusCode).toBe(200);
    expect(res.json().data.extra).toEqual({});
  });

  it("carries the project's columns the grants allow on the user's own row - in me, login and the portal's me", async () => {
    await context.permissions.set(roleId, usersResourceId, "READ", {
      effect: "ALLOW",
      where: { id: { _eq: "$USER.id" } },
      fields: [{ field: "id", effect: "ALLOW" }, { field: COLUMN, effect: "ALLOW" }],
    });
    const res = await me();
    expect(res.json().data.extra).toEqual({ [COLUMN]: "acme" });
    expect(res.json().data.email).toBe(email);

    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    expect(login.json().data.user.extra).toEqual({ [COLUMN]: "acme" });

    const portal = await app.inject({ method: "GET", url: "/admin/api/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(portal.statusCode).toBe(200);
    expect(portal.json().data.extra).toEqual({ [COLUMN]: "acme" });
  });

  it("is empty when the row filter hides the user's own row, and leaves out a column the field grants don't allow", async () => {
    await context.permissions.set(roleId, usersResourceId, "READ", {
      effect: "ALLOW",
      where: { id: { _eq: "$USER.id" } },
      fields: [{ field: "id", effect: "ALLOW" }, { field: "name", effect: "ALLOW" }],
    });
    expect((await me()).json().data.extra).toEqual({});

    await context.permissions.set(roleId, usersResourceId, "READ", {
      effect: "ALLOW",
      where: { email: { _eq: "nobody@example.com" } },
      fields: [{ field: "id", effect: "ALLOW" }, { field: COLUMN, effect: "ALLOW" }],
    });
    expect((await me()).json().data.extra).toEqual({});
  });

  it("gives an administrator every project column", async () => {
    const env = loadServerEnv();
    const adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    const res = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${adminToken}` } });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().data.extra)).toContain(COLUMN);
  });
});
