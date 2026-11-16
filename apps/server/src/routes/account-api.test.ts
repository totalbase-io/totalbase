import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { hashPassword, totpCode, totpStep } from "@totalbase/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { cleanupTracked, setupTestApp, track, uniqueSuffix, waitFor } from "../test-support.js";

const PREFIX = `account-api-test-${uniqueSuffix()}`;
const PASSWORD = "a-strong-enough-password";

/**
 * My account for any session (Security.md §4.1): a user with API access alone - signed in to a frontend of
 * the project's own, never to the App - manages their account under /api/auth/account/*, the same
 * operations as /app/api/me/*.
 */
describe("My account for any session: /api/auth/account", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let userId: string;
  const email = `${PREFIX}-user@example.com`;
  const otherEmail = `${PREFIX}-other@example.com`;

  const inject = (method: string, url: string, token: string, payload?: unknown) =>
    app.inject({
      method: method as "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
    });
  const send = (method: string, url: string, token: string, data: unknown) => inject(method, url, token, { data });
  const login = async (address: string, password = PASSWORD) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: address, password } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data.token as string;
  };

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const roleId = track("roles", (await context.roles.create(`${PREFIX}-api`, { apiAccess: true, appAccess: false })).id);
    for (const address of [email, otherEmail]) {
      const user = await context.auth.users.create({ email: address, name: "Api user", passwordHash: await hashPassword(PASSWORD), emailVerified: true });
      track("users", user.id);
      await context.roleAssignments.assignRoleToUser(user.id, roleId);
      if (address === email) userId = user.id;
    }
  });

  afterAll(async () => {
    await cleanupTracked(database);
    await app.close();
  });

  it("serves the account to a user the App refuses", async () => {
    const token = await login(email);
    expect((await inject("GET", "/app/api/me", token)).statusCode).toBe(403);

    const res = await inject("GET", "/api/auth/account", token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ id: userId, email, hasPassword: true, tokens: { api: true, admin: false }, mfa: { enabled: false } });
  });

  it("needs a session - nothing, a personal access token and a revoked session are refused", async () => {
    expect((await app.inject({ method: "GET", url: "/api/auth/account" })).statusCode).toBe(401);

    const key = await context.usersApis.create({ userId, name: `${PREFIX}-key`, plane: "API" });
    try {
      for (const [method, url] of [["GET", "/api/auth/account"], ["GET", "/api/auth/account/sessions"], ["POST", "/api/auth/account/sessions/revoke-others"], ["POST", "/api/auth/account/mfa"]] as const) {
        expect((await inject(method, url, key.plainKey)).statusCode, url).toBe(401);
      }
    } finally {
      await context.usersApis.delete(key.userApi.id);
    }

    const token = await login(email);
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { authorization: `Bearer ${token}` } });
    expect((await inject("GET", "/api/auth/account", token)).statusCode).toBe(401);
  });

  it("renames, and reads and changes preferences", async () => {
    const token = await login(email);
    const renamed = await send("PATCH", "/api/auth/account", token, { name: "Renamed" });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().data.name).toBe("Renamed");
    expect((await send("PATCH", "/api/auth/account", token, {})).statusCode).toBe(400);

    const patched = await send("PATCH", "/api/auth/account/preferences", token, { language: "es" });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().data.preferences.language).toBe("es");
    expect((await inject("GET", "/api/auth/account/preferences", token)).json().data.effective.language).toBe("es");
    await send("PATCH", "/api/auth/account/preferences", token, { language: null });
  });

  it("lists and revokes only the caller's own sessions", async () => {
    const token = await login(email);
    const second = await login(email);
    const otherToken = await login(otherEmail);

    const list = await inject("GET", "/api/auth/account/sessions", token);
    expect(list.statusCode, list.body).toBe(200);
    const sessions = list.json().data as Array<{ id: string; user: string; current: boolean }>;
    expect(sessions.every((s) => s.user === userId)).toBe(true);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(list.json().meta.total).toBeGreaterThanOrEqual(2);

    const currentOf = async (t: string) => (await inject("GET", "/api/auth/account/sessions", t)).json().data.find((s: { current: boolean }) => s.current).id as string;
    expect((await inject("DELETE", `/api/auth/account/sessions/${await currentOf(otherToken)}`, token)).statusCode).toBe(404);
    expect((await inject("GET", "/api/auth/account", otherToken)).statusCode).toBe(200);
    expect((await inject("DELETE", "/api/auth/account/sessions/not-a-uuid", token)).statusCode).toBe(404);

    expect((await inject("DELETE", `/api/auth/account/sessions/${await currentOf(second)}`, token)).statusCode).toBe(204);
    expect((await inject("GET", "/api/auth/account", second)).statusCode).toBe(401);

    const third = await login(email);
    const revoked = await inject("POST", "/api/auth/account/sessions/revoke-others", token);
    expect([revoked.statusCode, revoked.body]).toEqual([204, ""]);
    expect((await inject("GET", "/api/auth/account", third)).statusCode).toBe(401);
    expect((await inject("GET", "/api/auth/account", token)).statusCode).toBe(200);
    expect((await inject("GET", "/api/auth/account", otherToken)).statusCode).toBe(200);
  });

  it("changes the password with the current one, keeping this session and ending the others", async () => {
    const current = await login(email);
    const other = await login(email);
    const wrong = await send("PUT", "/api/auth/account/password", current, { currentPassword: "nope", password: "another-strong-password" });
    expect(wrong.json().errors[0].code).toBe("INVALID_CURRENT_PASSWORD");

    const res = await send("PUT", "/api/auth/account/password", current, { currentPassword: PASSWORD, password: "another-strong-password" });
    expect(res.statusCode, res.body).toBe(204);
    expect((await inject("GET", "/api/auth/account", current)).statusCode).toBe(200);
    expect((await inject("GET", "/api/auth/account", other)).statusCode).toBe(401);
    const restored = await send("PUT", "/api/auth/account/password", current, { currentPassword: "another-strong-password", password: PASSWORD });
    expect(restored.statusCode, restored.body).toBe(204);
  });

  it("changes the email only with the current password", async () => {
    const token = await login(otherEmail);
    const refused = await send("PUT", "/api/auth/account/email", token, { email: `${PREFIX}-moved@example.com`, currentPassword: "nope" });
    expect(refused.statusCode).toBe(400);
    const res = await send("PUT", "/api/auth/account/email", token, { email: `${PREFIX}-moved@example.com`, currentPassword: PASSWORD });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ email: `${PREFIX}-moved@example.com`, emailVerifiedAt: null });
  });

  it("sets two-factor authentication up, and turns it off with the password and a code", async () => {
    const token = await login(email);
    expect((await send("POST", "/api/auth/account/mfa", token, { currentPassword: "nope" })).statusCode).toBe(400);
    const started = await send("POST", "/api/auth/account/mfa", token, { currentPassword: PASSWORD });
    expect(started.statusCode, started.body).toBe(201);
    const { secret } = started.json().data as { secret: string };

    const confirmed = await send("POST", "/api/auth/account/mfa/confirm", token, { code: totpCode(secret, totpStep()) });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const recoveryCodes = confirmed.json().data.recoveryCodes as string[];
    expect(recoveryCodes.length).toBeGreaterThan(0);
    expect((await inject("GET", "/api/auth/account", token)).json().data.mfa.enabled).toBe(true);

    expect((await send("POST", "/api/auth/account/mfa/disable", token, { currentPassword: PASSWORD, code: "000000" })).statusCode).toBeGreaterThanOrEqual(400);
    const off = await send("POST", "/api/auth/account/mfa/disable", token, { currentPassword: PASSWORD, recoveryCode: recoveryCodes[0] });
    expect(off.statusCode, off.body).toBe(204);
    expect((await inject("GET", "/api/auth/account", token)).json().data.mfa.enabled).toBe(false);
  });

  it("is audited under the same events, as the user", async () => {
    const token = await login(email);
    const res = await send("PATCH", "/api/auth/account", token, { name: "Audited" });
    const requestId = res.headers["x-request-id"] as string | undefined;
    const entry = await waitFor(async () => (await database.query<{ principal_type: string; principal: string; metadata: { event: string } }>(
      `SELECT principal_type, principal, metadata FROM totalbase.logs
        WHERE action = 'AUTH' AND principal = $1 AND metadata ->> 'event' = 'account.update' ${requestId ? "AND request_id = $2" : "AND $2::text IS NULL"}
        ORDER BY created_at DESC LIMIT 1`,
      [userId, requestId ?? null],
    )).rows[0]);
    expect(entry).toMatchObject({ principal_type: "USER", principal: userId });
  });

  it("is in the OpenAPI document of a role with API access alone - the App's routes are not", async () => {
    const token = await login(email);
    const res = await inject("GET", "/api/openapi.json", token);
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const paths = Object.keys(res.json().paths);
    for (const path of [
      "/api/auth/account", "/api/auth/account/email", "/api/auth/account/password", "/api/auth/account/mfa", "/api/auth/account/mfa/confirm",
      "/api/auth/account/mfa/disable", "/api/auth/account/mfa/recovery-codes", "/api/auth/account/avatar", "/api/auth/account/avatar/provider",
      "/api/auth/account/sessions", "/api/auth/account/sessions/{id}", "/api/auth/account/sessions/revoke-others", "/api/auth/account/preferences",
    ]) expect(paths, path).toContain(path);
    expect(paths.some((path) => path.startsWith("/app/"))).toBe(false);
    expect(res.json().paths["/api/auth/account/sessions/{id}"].delete.tags).toEqual(["account"]);
  });
});
