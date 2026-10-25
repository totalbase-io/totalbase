import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { adminToken as loginAdmin, cleanupTracked, setupTestApp, track, uniqueSuffix } from "./test-support.js";

const SUFFIX = uniqueSuffix();

/** Security.md §2.19: the operations that could hand over the instance ask a session to confirm its identity. */
describe("re-authentication", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let administratorsRoleId: string;
  let targetId: string;
  const PASSWORD = "reauth-test-password-1";
  const ADMIN_EMAIL = `reauth-test-admin-${SUFFIX}@example.com`;

  const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, token: string, payload?: object) => {
    const headers = { authorization: `Bearer ${token}` };
    return payload === undefined ? app.inject({ method, url, headers }) : app.inject({ method, url, headers, payload });
  };

  /** A fresh sign-in of the test's own administrator - the one that counts failures here. */
  async function signIn(): Promise<string> {
    return (await context.auth.login({ email: ADMIN_EMAIL, password: PASSWORD })).token;
  }

  /** The session signed in an hour ago and never confirmed since. */
  async function aged(token: string): Promise<string> {
    const { session } = (await context.auth.sessions.validate(token))!;
    await database.query(`UPDATE totalbase.sessions SET created_at = now() - interval '1 hour', reauthenticated_at = NULL WHERE id = $1`, [session.id]);
    return token;
  }

  const code = (res: { statusCode: number; json: () => { errors?: Array<{ code: string }> } }) => [res.statusCode, res.json().errors?.[0]?.code];

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const envAdmin = await loginAdmin(context);
    administratorsRoleId = await context.roles.getAdministratorsRoleId();
    const admin = await call("POST", "/admin/api/users", envAdmin, { data: { email: ADMIN_EMAIL, name: "Reauth", password: PASSWORD, roleIds: [administratorsRoleId] } });
    expect(admin.statusCode).toBe(201);
    track("users", admin.json().data.id as string);
    const target = await call("POST", "/admin/api/users", envAdmin, { data: { email: `reauth-test-target-${SUFFIX}@example.com`, name: "Target" } });
    targetId = track("users", target.json().data.id as string);
  });

  afterAll(async () => {
    await cleanupTracked(database);
    await app.close();
  });

  it("a fresh sign-in counts as recent: no question asked", async () => {
    const token = await signIn();
    const res = await call("PUT", `/admin/api/users/${targetId}/email`, token, { data: { email: `reauth-test-fresh-${SUFFIX}@example.com`, verification: "VERIFIED" } });
    expect(res.statusCode).toBe(200);
  });

  it("an older session is asked before each sensitive operation, and only those", async () => {
    const token = await aged(await signIn());
    const required = [403, "REAUTHENTICATION_REQUIRED"];
    expect(code(await call("PUT", `/admin/api/users/${targetId}/email`, token, { data: { email: `reauth-test-x-${SUFFIX}@example.com`, verification: "VERIFIED" } }))).toEqual(required);
    expect(code(await call("PUT", `/admin/api/users/${targetId}/password`, token, { data: { password: "a-new-password-for-target" } }))).toEqual(required);
    expect(code(await call("DELETE", `/admin/api/users/${targetId}/mfa`, token))).toEqual(required);
    expect(code(await call("POST", `/admin/api/users/${targetId}/reset-password`, token, { data: { delivery: "link" } }))).toEqual(required);
    expect(code(await call("PUT", `/admin/api/users/${targetId}/roles`, token, { data: { roleIds: [administratorsRoleId] } }))).toEqual(required);
    expect(code(await call("POST", "/admin/api/users", token, { data: { email: `reauth-test-new-${SUFFIX}@example.com`, roleIds: [administratorsRoleId] } }))).toEqual(required);
    const me = (await context.auth.me(token)).id;
    expect(code(await call("POST", "/admin/api/tokens", token, { data: { userId: me, name: `reauth-${SUFFIX}`, plane: "ADMIN" } }))).toEqual(required);
    expect(code(await call("POST", "/api/tokens", token, { data: { name: `reauth-self-${SUFFIX}`, plane: "ADMIN" } }))).toEqual(required);

    // Not sensitive: an API token, a rename, a role set without Administrators.
    expect((await call("POST", "/api/tokens", token, { data: { name: `reauth-api-${SUFFIX}`, plane: "API" } })).statusCode).not.toBe(403);
    expect((await call("PATCH", `/api/totalbase/table/users/${targetId}`, token, { data: { name: "Target renamed" } })).statusCode).toBe(200);
    expect((await call("PUT", `/admin/api/users/${targetId}/roles`, token, { data: { roleIds: [] } })).statusCode).toBe(204);
  });

  it("the password confirms it for auth.reauthentication_minutes; a wrong one counts toward the lockout", async () => {
    const token = await aged(await signIn());
    const failuresBefore = (await database.query<{ n: number }>(`SELECT failed_login_count AS n FROM totalbase.users WHERE email = $1`, [ADMIN_EMAIL])).rows[0]!.n;
    expect(code(await call("POST", "/admin/api/auth/reauthenticate", token, { password: "not-the-password" }))).toEqual([400, "REAUTHENTICATION_FAILED"]);
    const failuresAfter = (await database.query<{ n: number }>(`SELECT failed_login_count AS n FROM totalbase.users WHERE email = $1`, [ADMIN_EMAIL])).rows[0]!.n;
    expect(failuresAfter).toBe(failuresBefore + 1);
    expect(code(await call("POST", "/admin/api/auth/reauthenticate", token, { code: "123456" }))).toEqual([400, "REAUTHENTICATION_FAILED"]);

    expect((await call("POST", "/admin/api/auth/reauthenticate", token, { password: PASSWORD })).statusCode).toBe(204);
    const res = await call("PUT", `/admin/api/users/${targetId}/email`, token, { data: { email: `reauth-test-after-${SUFFIX}@example.com`, verification: "VERIFIED" } });
    expect(res.statusCode).toBe(200);
  });

  it("a plane=ADMIN token is never asked; a session can't set its own confirmation through the Data API", async () => {
    const fresh = await signIn();
    const me = (await context.auth.me(fresh)).id;
    const issued = await call("POST", "/admin/api/tokens", fresh, { data: { userId: me, name: `reauth-admin-${SUFFIX}`, plane: "ADMIN" } });
    expect(issued.statusCode).toBe(201);
    const adminKey = issued.json().data.key as string;
    expect((await call("PUT", `/admin/api/users/${targetId}/email`, adminKey, { data: { email: `reauth-test-token-${SUFFIX}@example.com`, verification: "VERIFIED" } })).statusCode).toBe(200);
    expect(code(await call("POST", "/admin/api/auth/reauthenticate", adminKey, { password: PASSWORD }))).toEqual([403, "PERMISSION_DENIED"]);

    const token = await aged(await signIn());
    const { session } = (await context.auth.sessions.validate(token))!;
    await call("PATCH", `/api/totalbase/table/sessions/${session.id}`, token, { data: { reauthenticated_at: new Date().toISOString() } });
    expect(code(await call("DELETE", `/admin/api/users/${targetId}/mfa`, token))).toEqual([403, "REAUTHENTICATION_REQUIRED"]);
  });

  it("an account's email is never changed through the Data API - its route asks; created with one, it is", async () => {
    const token = await signIn();
    const res = await call("PATCH", `/api/totalbase/table/users/${targetId}`, token, { data: { email: `reauth-test-data-api-${SUFFIX}@example.com` } });
    expect(code(res)).toEqual([403, "PERMISSION_DENIED"]);
    const created = await call("POST", "/api/totalbase/table/users", token, { data: { email: `reauth-test-created-${SUFFIX}@example.com` } });
    expect(created.statusCode).toBe(201);
    track("users", created.json().data.id as string);
  });
});
