import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { cleanupTracked, setupTestApp, track, uniqueSuffix } from "../test-support.js";

const PREFIX = `app-me-test-${uniqueSuffix()}`;
const PASSWORD = "a-strong-enough-password";

/**
 * My account (Security.md §4): a portal user's
 * own account under /app/api/me/*, never anyone else's.
 */
describe("My account: /app/api/me", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let roleId: string;
  let userId: string;
  let otherUserId: string;

  const inject = (method: string, url: string, token: string, payload?: unknown) =>
    app.inject({
      method: method as "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
    });
  /** A write to /app/api/me*: its body goes in data. */
  const send = (method: string, url: string, token: string, data: unknown) => inject(method, url, token, { data });
  const login = async (email: string, password = PASSWORD) => (await context.auth.login({ email, password })).token;

  async function createUser(email: string, name: string): Promise<string> {
    const res = await send("POST", "/admin/api/users", adminToken, { email, name, password: PASSWORD, roleIds: [roleId] });
    expect(res.statusCode, res.body).toBe(201);
    return track("users", res.json().data.id);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = await login(env.adminEmail!, env.adminPassword!);
    roleId = track("roles", (await context.roles.create(`${PREFIX}-app`, { appAccess: true })).id);
    userId = await createUser(`${PREFIX}-user@example.com`, "App user");
    otherUserId = await createUser(`${PREFIX}-other@example.com`, "Other user");
  });

  afterAll(async () => {
    await cleanupTracked(database);
    await app.close();
  });

  it("serves an app-only user their own account, and which tokens they can hold", async () => {
    const token = await login(`${PREFIX}-user@example.com`);
    const res = await inject("GET", "/app/api/me", token);
    expect(res.statusCode, res.body).toBe(200);
    const { data } = res.json();
    expect(data).toMatchObject({ id: userId, name: "App user", hasPassword: true, tokens: { api: false, admin: false } });
    expect(data).not.toHaveProperty("roles");
  });

  it("refuses a plane=ADMIN token - account settings need a session", async () => {
    const created = await send("POST", "/admin/api/tokens", adminToken, { userId: (await context.auth.me(adminToken)).id, name: `${PREFIX}-token`, plane: "ADMIN", ttlDays: 1 });
    expect(created.statusCode, created.body).toBe(201);
    const { key, id } = created.json().data;
    try {
      const res = await inject("GET", "/app/api/me", key);
      expect(res.statusCode).toBe(403);
      expect(res.json().errors[0].code).toBe("PERMISSION_DENIED");
    } finally {
      await context.usersApis.delete(id);
    }
  });

  it("renames the caller, and rejects an empty name", async () => {
    const token = await login(`${PREFIX}-user@example.com`);
    const res = await send("PATCH", "/app/api/me", token, { name: "  Renamed  " });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.name).toBe("Renamed");
    expect((await send("PATCH", "/app/api/me", token, { name: " " })).statusCode).toBe(400);
  });

  it("changes the email only with the current password, leaving it unverified", async () => {
    const token = await login(`${PREFIX}-user@example.com`);
    const wrong = await send("PUT", "/app/api/me/email", token, { email: `${PREFIX}-new@example.com`, currentPassword: "nope" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().errors[0].code).toBe("INVALID_CURRENT_PASSWORD");

    const taken = await send("PUT", "/app/api/me/email", token, { email: `${PREFIX}-other@example.com`, currentPassword: PASSWORD });
    expect(taken.statusCode).toBe(409);

    const res = await send("PUT", "/app/api/me/email", token, { email: `${PREFIX}-new@example.com`, currentPassword: PASSWORD });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ email: `${PREFIX}-new@example.com`, emailVerifiedAt: null });

    // Back, for the tests below (still with the password).
    const back = await send("PUT", "/app/api/me/email", token, { email: `${PREFIX}-user@example.com`, currentPassword: PASSWORD });
    expect(back.statusCode, back.body).toBe(200);

    // Unverified, the next sign-in waits for the link (auth.email_verification_required,
    // Security.md §2.7) - the open session keeps working.
    await expect(login(`${PREFIX}-user@example.com`)).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect((await inject("GET", "/app/api/me", token)).statusCode).toBe(200);
    await context.auth.users.markEmailVerified(userId);
  });

  it("changes the password: keeps the current session, signs the others out", async () => {
    const current = await login(`${PREFIX}-user@example.com`);
    const other = await login(`${PREFIX}-user@example.com`);

    const wrong = await send("PUT", "/app/api/me/password", current, { currentPassword: "nope", password: "another-strong-password" });
    expect(wrong.json().errors[0].code).toBe("INVALID_CURRENT_PASSWORD");
    const weak = await send("PUT", "/app/api/me/password", current, { currentPassword: PASSWORD, password: "x" });
    expect(weak.statusCode).toBe(400);

    const res = await send("PUT", "/app/api/me/password", current, { currentPassword: PASSWORD, password: "another-strong-password" });
    expect(res.statusCode, res.body).toBe(204);
    expect(res.body).toBe("");
    expect((await inject("GET", "/app/api/me", current)).statusCode).toBe(200);
    expect((await inject("GET", "/app/api/me", other)).statusCode).toBe(401);

    // Restore the shared password.
    const restored = await send("PUT", "/app/api/me/password", current, { currentPassword: "another-strong-password", password: PASSWORD });
    expect(restored.statusCode, restored.body).toBe(204);
  });

  it("lists and revokes only the caller's own sessions", async () => {
    const token = await login(`${PREFIX}-user@example.com`);
    const second = await login(`${PREFIX}-user@example.com`);
    const otherToken = await login(`${PREFIX}-other@example.com`);

    const list = await inject("GET", "/app/api/me/sessions", token);
    expect(list.statusCode, list.body).toBe(200);
    const sessions = list.json().data as Array<{ id: string; user: string; current: boolean; lastSeenAt: string }>;
    expect(sessions.every((s) => s.user === userId)).toBe(true);
    // camelCase, like every key TotalBase defines.
    expect(sessions[0]).toHaveProperty("lastSeenAt");
    expect(sessions[0]).not.toHaveProperty("last_seen_at");
    expect(sessions.filter((s) => s.current)).toHaveLength(1);

    // Someone else's session is "not found", and keeps working.
    const otherSessionId = (await inject("GET", "/app/api/me/sessions", otherToken)).json().data.find((s: { current: boolean }) => s.current).id;
    const foreign = await inject("DELETE", `/app/api/me/sessions/${otherSessionId}`, token);
    expect(foreign.statusCode).toBe(404);
    expect((await inject("GET", "/app/api/me", otherToken)).statusCode).toBe(200);
    expect((await inject("DELETE", "/app/api/me/sessions/not-a-uuid", token)).statusCode).toBe(404);

    const secondId = (await inject("GET", "/app/api/me/sessions", second)).json().data.find((s: { current: boolean }) => s.current).id;
    expect((await inject("DELETE", `/app/api/me/sessions/${secondId}`, token)).statusCode).toBe(204);
    expect((await inject("GET", "/app/api/me", second)).statusCode).toBe(401);

    const third = await login(`${PREFIX}-user@example.com`);
    const revoked = await inject("POST", "/app/api/me/sessions/revoke-others", token);
    expect([revoked.statusCode, revoked.body]).toEqual([204, ""]);
    expect((await inject("GET", "/app/api/me", third)).statusCode).toBe(401);
    expect((await inject("GET", "/app/api/me", token)).statusCode).toBe(200);
    expect((await inject("GET", "/app/api/me", otherToken)).statusCode).toBe(200);
  });

  describe("preferences", () => {
    it("sets, clears and resolves them, and serves the result with /admin/api/auth/me", async () => {
      const token = await login(`${PREFIX}-user@example.com`);
      const set = await send("PATCH", "/app/api/me/preferences", token, { timezone: "America/Argentina/Buenos_Aires", dateFormat: "dd/MM/yyyy", timeFormat: "h:mm a" });
      expect(set.statusCode, set.body).toBe(200);
      expect(set.json().data.preferences).toEqual({ timezone: "America/Argentina/Buenos_Aires", dateFormat: "dd/MM/yyyy", timeFormat: "h:mm a" });
      expect(set.json().data.effective).toMatchObject({ timezone: "America/Argentina/Buenos_Aires", dateFormat: "dd/MM/yyyy", timeFormat: "h:mm a", datetimeFormat: "dd/MM/yyyy h:mm a" });

      const me = await inject("GET", "/admin/api/auth/me", token);
      expect(me.statusCode, me.body).toBe(200);
      expect(me.json().data.display).toMatchObject({ timezone: "America/Argentina/Buenos_Aires", datetimeFormat: "dd/MM/yyyy h:mm a" });

      // A partial patch leaves the other keys alone; null clears one.
      const cleared = await send("PATCH", "/app/api/me/preferences", token, { timeFormat: null });
      expect(cleared.json().data.preferences).toEqual({ timezone: "America/Argentina/Buenos_Aires", dateFormat: "dd/MM/yyyy" });
      // Stored under the column's own keys (its CHECK names them).
      const { rows } = await database.query<{ preferences: unknown }>(`SELECT preferences FROM totalbase.users WHERE id = $1`, [userId]);
      expect(rows[0]!.preferences).toEqual({ timezone: "America/Argentina/Buenos_Aires", date_format: "dd/MM/yyyy" });
      await send("PATCH", "/app/api/me/preferences", token, { timezone: null, dateFormat: null });
      expect((await inject("GET", "/app/api/me/preferences", token)).json().data.preferences).toEqual({});
    });

    it("takes a UI language - the user's, else the instance's, in /admin/api/auth/me (Admin_UI.md §14)", async () => {
      const token = await login(`${PREFIX}-user@example.com`);
      expect((await inject("GET", "/admin/api/auth/me", token)).json().data.display.language).toBe("en");
      const set = await send("PATCH", "/app/api/me/preferences", token, { language: "es" });
      expect(set.statusCode, set.body).toBe(200);
      expect(set.json().data).toMatchObject({ preferences: { language: "es" }, effective: { language: "es" }, instance: { language: "en" } });
      expect((await inject("GET", "/admin/api/auth/me", token)).json().data.display.language).toBe("es");
      await send("PATCH", "/app/api/me/preferences", token, { language: null });
      // The instance default for whoever chose none - and for pages with no user.
      await context.settings.set("system.language", "es");
      try {
        expect((await inject("GET", "/admin/api/auth/me", token)).json().data.display.language).toBe("es");
        expect((await app.inject({ method: "GET", url: "/api/instance" })).json().data).toMatchObject({ language: "es" });
        await expect(context.settings.set("system.language", "fr")).rejects.toMatchObject({ code: "INVALID_SETTING" });
      } finally {
        await context.settings.reset("system.language");
      }
      // PostgreSQL holds the shape of a stored code, whoever writes it.
      await expect(database.query(`UPDATE totalbase.users SET preferences = '{"language": "Spanish"}'::jsonb WHERE id = $1`, [userId])).rejects.toMatchObject({ code: "CHECK_VIOLATION" });
    });

    it("rejects unknown keys, off-list formats and timezones PostgreSQL doesn't know", async () => {
      const token = await login(`${PREFIX}-user@example.com`);
      for (const body of [{ language: "fr" }, { locale: "es" }, { dateFormat: "yyyy" }, { timeFormat: "HH:mm:ss" }, { date_format: "dd/MM/yyyy" }, { timezone: "Mars/Olympus" }, { timezone: 3 }, []]) {
        const res = await send("PATCH", "/app/api/me/preferences", token, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
      }
    });

    it("is guarded by PostgreSQL too, whoever writes the row", async () => {
      const write = (preferences: unknown) =>
        database.query(`UPDATE totalbase.users SET preferences = $2::jsonb WHERE id = $1`, [otherUserId, JSON.stringify(preferences)]);
      await expect(write({ date_format: "yyyy" })).rejects.toMatchObject({ code: "CHECK_VIOLATION" });
      await expect(write({ time_format: 12 })).rejects.toMatchObject({ code: "CHECK_VIOLATION" });
      await expect(write(["not", "an", "object"])).rejects.toMatchObject({ code: "CHECK_VIOLATION" });
      await write({ date_format: "yyyy-MM-dd" });
    });
  });
});
