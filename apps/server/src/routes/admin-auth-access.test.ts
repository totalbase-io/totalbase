import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { adminToken as loginAdmin, cleanupTracked, setupTestApp, track, uniqueSuffix } from "../test-support.js";

const SUFFIX = uniqueSuffix();

/**
 * Role access flags, each OR-ed across a user's ACTIVE
 * roles and re-checked on every request, never read from the session:
 * - adminAccess (reserved roles only): portal in admin mode, /admin/api;
 * - appAccess: portal in app mode, /app/api only - 403 on /admin/api;
 * - apiAccess: programmatic credentials - /api/auth/login and plane=API
 *   tokens. Without it, those are refused; without app/admin, the portal is.
 */
describe("role access flags", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let appRoleId: string;
  let apiRoleId: string;
  const PASSWORD = "role-access-test-password";
  const APP_EMAIL = `role-access-test-app-${SUFFIX}@example.com`;
  const API_EMAIL = `role-access-test-api-${SUFFIX}@example.com`;
  const BOTH_EMAIL = `role-access-test-both-${SUFFIX}@example.com`;

  async function createUser(email: string, roles: string[]): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/admin/api/users",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { email, name: email, password: PASSWORD, roleIds: roles } },
    });
    expect(res.statusCode).toBe(201);
    return track("users", res.json().data.id as string);
  }

  function portalLogin(email: string) {
    return app.inject({ method: "POST", url: "/admin/api/auth/login", payload: { email, password: PASSWORD } });
  }

  function apiLogin(email: string) {
    return app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD } });
  }

  function get(url: string, token: string) {
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  }

  async function activeSessions(email: string): Promise<number> {
    const { rows } = await database.query(
      `SELECT 1 FROM totalbase.sessions s JOIN totalbase.users u ON u.id = s."user"
       WHERE u.email = $1 AND s.revoked_at IS NULL`,
      [email],
    );
    return rows.length;
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    adminToken = await loginAdmin(context);

    appRoleId = track("roles", (await context.roles.create(`role-access-test-app-${SUFFIX}`)).id);
    apiRoleId = track("roles", (await context.roles.create(`role-access-test-api-${SUFFIX}`, { appAccess: false, apiAccess: true })).id);
    await createUser(APP_EMAIL, [appRoleId]);
    await createUser(API_EMAIL, [apiRoleId]);
    await createUser(BOTH_EMAIL, [apiRoleId, appRoleId]);
  });

  afterAll(async () => {
    await cleanupTracked(database);
    await app.close();
  });

  it("a new role defaults to app access only", async () => {
    expect(await context.roles.findById(appRoleId)).toMatchObject({ adminAccess: false, appAccess: true, apiAccess: false });
  });

  it("an admin logs in with access ADMIN and reaches /admin/api", async () => {
    const env = loadServerEnv();
    const res = await app.inject({
      method: "POST",
      url: "/admin/api/auth/login",
      payload: { email: env.adminEmail, password: env.adminPassword },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.admin.access).toBe("ADMIN");
    expect((await get("/admin/api/auth/me", adminToken)).json().data.access).toBe("ADMIN");
    expect((await get("/admin/api/dataviews", adminToken)).statusCode).toBe(200);
  });

  it("an app-only user reaches the app but not /admin/api", async () => {
    const res = await portalLogin(APP_EMAIL);
    expect(res.statusCode).toBe(200);
    const { token, admin } = res.json().data;
    expect(admin.access).toBe("APP");

    expect((await get("/admin/api/auth/me", token)).json().data.access).toBe("APP");
    expect((await get("/app/api/dataviews", token)).statusCode).toBe(200);
    for (const url of ["/admin/api/sessions", "/admin/api/dataviews", "/admin/api/dashboard"]) {
      const denied = await get(url, token);
      expect(denied.statusCode, url).toBe(403);
      expect(denied.json().errors[0].code).toBe("PERMISSION_DENIED");
    }
  });

  it("an app-only user gets no API credentials - no /api/auth/login, no plane=API token", async () => {
    const before = await activeSessions(APP_EMAIL);
    const res = await apiLogin(APP_EMAIL);
    expect(res.statusCode).toBe(401);
    expect(res.json().errors[0].code).toBe("AUTHENTICATION_REQUIRED");
    expect(await activeSessions(APP_EMAIL)).toBe(before);

    const userId = (await context.auth.users.findByEmail(APP_EMAIL))!.id;
    await expect(context.usersApis.create({ userId, name: "no api", plane: "API" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("an API-only user logs in through /api but not the portal - same generic 401 as a wrong password", async () => {
    const portal = await portalLogin(API_EMAIL);
    expect(portal.statusCode).toBe(401);
    expect(portal.json().errors[0].code).toBe("AUTHENTICATION_REQUIRED");
    expect(await activeSessions(API_EMAIL)).toBe(0);

    const api = await apiLogin(API_EMAIL);
    expect(api.statusCode).toBe(200);
    expect(api.json().data.token).toBeTruthy();
  });

  it("changes the signed-in user's password with camelCase keys, like every key TotalBase defines", async () => {
    const token = (await apiLogin(API_EMAIL)).json().data.token as string;
    const change = (data: Record<string, string>) =>
      app.inject({ method: "POST", url: "/api/auth/password/change", headers: { authorization: `Bearer ${token}` }, payload: data });
    const wrong = await change({ currentPassword: "not-the-password", newPassword: "role-access-test-password-2" });
    expect([wrong.statusCode, wrong.json().errors[0].code]).toEqual([400, "INVALID_CURRENT_PASSWORD"]);
    // Nothing to return: 204, never { success: true } (Data_API.md §2.5).
    expect((await change({ currentPassword: PASSWORD, newPassword: "role-access-test-password-2" })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: API_EMAIL, password: "role-access-test-password-2" } })).statusCode).toBe(200);
    // Back, so the other cases keep signing in with PASSWORD.
    const fresh = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: API_EMAIL, password: "role-access-test-password-2" } })).json().data.token as string;
    const back = await app.inject({ method: "POST", url: "/api/auth/password/change", headers: { authorization: `Bearer ${fresh}` }, payload: { currentPassword: "role-access-test-password-2", newPassword: PASSWORD } });
    expect(back.statusCode).toBe(204);
  });

  it("flags add up across a user's roles", async () => {
    expect((await portalLogin(BOTH_EMAIL)).json().data.admin.access).toBe("APP");
    expect((await apiLogin(BOTH_EMAIL)).statusCode).toBe(200);
  });

  it("a flag change takes effect on the next request - sessions and tokens alike", async () => {
    const { token } = (await portalLogin(APP_EMAIL)).json().data;
    expect((await get("/app/api/dataviews", token)).statusCode).toBe(200);

    const userId = (await context.auth.users.findByEmail(API_EMAIL))!.id;
    const { plainKey } = await context.usersApis.create({ userId, name: "flag change", plane: "API" });
    expect(await context.usersApis.validate(plainKey)).not.toBeNull();

    await context.roles.update(appRoleId, { appAccess: false });
    await context.roles.update(apiRoleId, { apiAccess: false });
    try {
      expect((await get("/app/api/dataviews", token)).statusCode).toBe(403);
      expect((await get("/admin/api/auth/me", token)).statusCode).toBe(403);
      expect(await context.usersApis.validate(plainKey)).toBeNull();
    } finally {
      await context.roles.update(appRoleId, { appAccess: true });
      await context.roles.update(apiRoleId, { apiAccess: true });
    }
  });

  it("a deactivated role grants nothing", async () => {
    await context.roles.update(appRoleId, { active: false });
    try {
      expect((await portalLogin(APP_EMAIL)).statusCode).toBe(401);
      const userId = (await context.auth.users.findByEmail(APP_EMAIL))!.id;
      expect(await context.roleAssignments.listEffectiveRolesForUser(userId)).toEqual([]);
      expect(await context.roleAssignments.listRolesForUser(userId)).toEqual([appRoleId]);
    } finally {
      await context.roles.update(appRoleId, { active: true });
    }
  });

  it("no request can grant admin access to an ordinary role", async () => {
    // Roles are Data API rows: admin_access is refused in every payload, an administrator's included.
    const res = await app.inject({
      method: "PATCH",
      url: `/api/totalbase/table/roles/${apiRoleId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { admin_access: true } },
    });
    expect(res.statusCode).toBe(403);
    expect((await context.roles.findById(apiRoleId))!.adminAccess).toBe(false);

    // PostgreSQL itself refuses it too, whatever path a write takes.
    await expect(
      database.query(`UPDATE totalbase.roles SET admin_access = true WHERE id = $1`, [apiRoleId]),
    ).rejects.toThrow(/roles_admin_access_reserved_check/);
  });

  it("validates role names and leaves duplicates to PostgreSQL's unique constraint", async () => {
    const post = (data: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/totalbase/table/roles", headers: { authorization: `Bearer ${adminToken}` }, payload: { data } });
    expect((await post({ name: "   " })).statusCode).toBe(422);
    expect((await post({ name: "x".repeat(65) })).statusCode).toBe(422);
    const dup = await post({ name: `role-access-test-app-${SUFFIX}` });
    expect([dup.statusCode, dup.json().errors[0].code]).toEqual([409, "UNIQUE_VIOLATION"]);
    expect(
      (await app.inject({
        method: "PATCH",
        url: `/api/totalbase/table/roles/${appRoleId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        // "no" would be a valid boolean to PostgreSQL - the authority on input.
        payload: { data: { active: "maybe" } },
      })).statusCode,
    ).toBe(400);
    expect((await context.roles.findById(appRoleId))!.active).toBe(true);
  });
});
