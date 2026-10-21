import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCESS_EVENTS, sanitizeForAudit } from "./access-audit.js";
import type { AppContext } from "./context.js";
import { adminToken as loginAdmin, cleanupTracked, setupTestApp, track, uniqueSuffix, waitFor } from "./test-support.js";

/**
 * Access-related events are always audited (Security.md §11.6), and repeated
 * wrong passwords lock the account (auth.lockout_*).
 */
describe("access audit and account lockout", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let roleId: string;
  // Short: a token name is at most 32 characters.
  const PREFIX = `aa-${uniqueSuffix()}`;
  const PASSWORD = "a-strong-enough-password";

  type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  const admin = (method: Method, url: string, payload?: Record<string, unknown>) =>
    payload === undefined
      ? app.inject({ method, url, headers: { authorization: `Bearer ${adminToken}` } })
      : app.inject({ method, url, headers: { authorization: `Bearer ${adminToken}` }, payload });

  const portalLogin = (email: string, password: string) =>
    app.inject({ method: "POST", url: "/admin/api/auth/login", payload: { email, password } });

  /** The hook writes after the response is sent - wait for the row instead of assuming it's there. */
  const waitForAudit = (sql: string, params: unknown[]): Promise<Record<string, any>> =>
    waitFor(async () => (await database.query(sql, params)).rows[0]);

  async function createUser(email: string, roles: string[] = []): Promise<string> {
    const res = await admin("POST", "/admin/api/users", { data: { email, name: email, password: PASSWORD, roleIds: roles } });
    expect(res.statusCode).toBe(201);
    return track("users", res.json().data.id as string);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    roleId = (await context.roles.create(`${PREFIX}-role`)).id;
    adminToken = await loginAdmin(context);
  });

  afterAll(async () => {
    await context.settings.reset("auth.lockout_max_attempts");
    await cleanupTracked(database);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await app.close();
  });

  it("every audited route actually exists", () => {
    for (const key of Object.keys(ACCESS_EVENTS)) {
      const [method, url] = key.split(" ") as [Method, string];
      expect(app.hasRoute({ method, url }), key).toBe(true);
    }
  });

  it("never stores credentials, but keeps setting names that mention them", () => {
    expect(sanitizeForAudit({ email: "a@b.c", password: "x", nested: { client_secret: "y" } })).toEqual({
      email: "a@b.c",
      password: "[redacted]",
      nested: { client_secret: "[redacted]" },
    });
    expect(sanitizeForAudit({ "auth.password_min_length": 14 })).toEqual({ "auth.password_min_length": 14 });
    // camelCase bodies too (PUT /admin/api/users/:id/password).
    expect(sanitizeForAudit({ currentPassword: "old", newPassword: "new", clientSecret: "s" })).toEqual({
      currentPassword: "[redacted]",
      newPassword: "[redacted]",
      clientSecret: "[redacted]",
    });
  });

  it("audits a failed sign-in with its reason, and a successful one with the user", async () => {
    const email = `${PREFIX}-login@example.com`;
    const userId = await createUser(email, [roleId]);

    const failed = await portalLogin(email, "wrong-password-123");
    expect(failed.statusCode).toBe(401);
    const denied = await waitForAudit(
      // This run's user only - earlier runs left rows for the same email.
      `SELECT * FROM totalbase.logs WHERE action = 'AUTH' AND status = 'DENIED' AND metadata->>'email' = $1 AND metadata->>'user_id' = $2`,
      [email, userId],
    );
    expect(denied.metadata).toMatchObject({ event: "auth.portal_login", reason: "wrong_password", user_id: userId });
    expect(JSON.stringify(denied.payload)).not.toContain("wrong-password-123");

    const ok = await portalLogin(email, PASSWORD);
    expect(ok.statusCode).toBe(200);
    const executed = await waitForAudit(
      `SELECT * FROM totalbase.logs WHERE action = 'AUTH' AND principal = $1 AND status = 'EXECUTED' AND metadata->>'event' = 'auth.portal_login'`,
      [userId],
    );
    expect(executed.principal_type).toBe("USER");
  });

  it("audits role changes with what was added and removed, queryable per role", async () => {
    const userId = await createUser(`${PREFIX}-roles@example.com`);
    expect((await admin("PUT", `/admin/api/users/${userId}/roles`, { data: { roleIds: [roleId] } })).statusCode).toBe(204);
    expect((await admin("PUT", `/admin/api/users/${userId}/roles`, { data: { roleIds: [] } })).statusCode).toBe(204);

    await waitForAudit(
      `SELECT 1 FROM totalbase.logs WHERE metadata @> $1::jsonb`,
      [JSON.stringify({ event: "user.roles_set", roles_removed: [roleId] })],
    );
    const history = (await admin("GET", `/admin/api/audit/logs?role_change=${roleId}&limit=50`)).json().data as Array<{
      metadata: { event: string; user_id: string; roles_added: string[]; roles_removed: string[] };
    }>;
    const mine = history.filter((entry) => entry.metadata.user_id === userId && entry.metadata.event === "user.roles_set");
    expect(mine.map((e) => [e.metadata.roles_added, e.metadata.roles_removed])).toEqual([
      [[], [roleId]],
      [[roleId], []],
    ]);
    const byEvent = (await admin("GET", "/admin/api/audit/logs?event=user.roles_set&limit=5")).json().data as unknown[];
    expect(byEvent.length).toBeGreaterThan(0);
  });

  it("records which admin token an admin acted through, keeping the user as the principal", async () => {
    const me = (await admin("GET", "/admin/api/auth/me")).json().data as { id?: string; user?: { id: string } };
    const adminId = me.id ?? me.user!.id;
    const created = await admin("POST", "/admin/api/tokens", { data: { userId: adminId, name: `${PREFIX}-via`, plane: "ADMIN", ttlDays: 1 } });
    const { id: tokenId, key } = created.json().data as { id: string; key: string };
    try {
      const viaToken = await app.inject({
        method: "POST",
        url: "/admin/api/tokens",
        headers: { authorization: `Bearer ${key}` },
        payload: { data: { userId: adminId, name: `${PREFIX}-child`, plane: "API", ttlDays: 1 } },
      });
      expect(viaToken.statusCode).toBe(201);
      const row = await waitForAudit(
        `SELECT principal_type, principal, payload FROM totalbase.logs WHERE metadata @> $1::jsonb`,
        [JSON.stringify({ event: "token.create", token: tokenId })],
      );
      expect([row.principal_type, row.principal]).toEqual(["ADMIN", adminId]);
      // What was sent, without the request's { data } envelope.
      expect(row.payload).toMatchObject({ name: `${PREFIX}-child`, plane: "API" });
      await context.usersApis.delete(viaToken.json().data.id);
    } finally {
      await context.usersApis.delete(tokenId);
    }
  });

  it("locks an account after the configured failed attempts, even for the right password", async () => {
    await context.settings.set("auth.lockout_max_attempts", 3);
    const email = `${PREFIX}-lock@example.com`;
    const userId = await createUser(email, [roleId]);

    for (let i = 0; i < 3; i += 1) expect((await portalLogin(email, "nope-nope-nope")).statusCode).toBe(401);
    const lockedAttempt = await portalLogin(email, PASSWORD);
    expect(lockedAttempt.statusCode).toBe(401);
    expect(lockedAttempt.json().errors[0].message).toBe("Invalid email or password.");

    const listed = (await admin("GET", `/admin/api/users/${userId}`)).json().data;
    expect(listed.lockedUntil).not.toBeNull();
    await waitForAudit(
      `SELECT 1 FROM totalbase.logs WHERE metadata @> $1::jsonb`,
      [JSON.stringify({ user_id: userId, reason: "locked" })],
    );

    // Unlocking is a Data API row update (Security.md §10).
    const unlocked = await admin("PATCH", `/api/totalbase/table/users/${userId}`, { data: { locked_until: null, failed_login_count: 0 } });
    expect(unlocked.statusCode, unlocked.body).toBe(200);
    expect((await admin("GET", `/admin/api/users/${userId}`)).json().data.lockedUntil).toBeNull();
    expect((await portalLogin(email, PASSWORD)).statusCode).toBe(200);
  });

  it("a successful sign-in resets the count; 0 turns lockout off", async () => {
    await context.settings.set("auth.lockout_max_attempts", 3);
    const email = `${PREFIX}-reset@example.com`;
    await createUser(email, [roleId]);
    for (let i = 0; i < 2; i += 1) await portalLogin(email, "nope-nope-nope");
    expect((await portalLogin(email, PASSWORD)).statusCode).toBe(200);
    for (let i = 0; i < 2; i += 1) await portalLogin(email, "nope-nope-nope");
    expect((await portalLogin(email, PASSWORD)).statusCode).toBe(200);

    await context.settings.set("auth.lockout_max_attempts", 0);
    for (let i = 0; i < 5; i += 1) await portalLogin(email, "nope-nope-nope");
    expect((await portalLogin(email, PASSWORD)).statusCode).toBe(200);
  });

  it("rejects out-of-range lockout settings", async () => {
    expect((await admin("PATCH", "/admin/api/settings/auth", { data: { lockout_max_attempts: -1 } })).statusCode).toBe(400);
    expect((await admin("PATCH", "/admin/api/settings/auth", { data: { lockout_duration_minutes: 0 } })).statusCode).toBe(400);
  });

  it("exposes each setting's default and bounds, and restores a default by dropping the override", async () => {
    const schema = (await admin("GET", "/admin/api/settings/auth/schema")).json().data;
    const field = schema.fields.find((f: { key: string }) => f.key === "auth.lockout_max_attempts");
    expect(field).toMatchObject({ default: 5, min: 0, max: 100, section: "Sign-in protection" });

    await context.settings.set("auth.lockout_max_attempts", 7);
    const reset = await admin("DELETE", "/admin/api/settings/auth/lockout_max_attempts");
    expect(reset.statusCode).toBe(200);
    expect(reset.json().data["auth.lockout_max_attempts"]).toBe(5);
    expect(await context.settings.isOverridden("auth.lockout_max_attempts")).toBe(false);
    await waitForAudit(
      `SELECT 1 FROM totalbase.logs WHERE action = 'AUTH' AND metadata->>'event' = 'settings.reset' AND metadata->'params'->>'key' = 'lockout_max_attempts'`,
      [],
    );

    expect((await admin("DELETE", "/admin/api/settings/auth/not_a_key")).statusCode).toBe(404);
    // A group the registry doesn't declare is not found either.
    for (const [method, url] of [["GET", "/admin/api/settings/nope"], ["GET", "/admin/api/settings/nope/schema"], ["DELETE", "/admin/api/settings/nope/key"]] as const) {
      expect((await admin(method, url)).statusCode, url).toBe(404);
    }
    expect((await admin("PATCH", "/admin/api/settings/nope", { data: {} })).statusCode).toBe(404);
    // A patch outside { data } is not read.
    expect((await admin("PATCH", "/admin/api/settings/auth", { lockout_max_attempts: 7 })).statusCode).toBe(400);

    const all = (await admin("GET", "/admin/api/settings/schema")).json().data;
    expect(all.fields.find((f: { key: string }) => f.key === "api.default_limit")).toMatchObject({
      group: "api",
      label: "Default page size",
      section: "Pagination",
    });
    expect(all.groups.security.label).toBe("Network");
  });

  it("sends a test email only to a real address, and reports an unconfigured relay", async () => {
    expect((await admin("POST", "/admin/api/settings/mail/test", { data: {} })).statusCode).toBe(400);
    expect((await admin("POST", "/admin/api/settings/mail/test", { data: { to: "not-an-address" } })).statusCode).toBe(400);

    // Blank host = not configured, whatever this database has saved.
    const hadHost = await context.settings.isOverridden("smtp.host");
    const previousHost = await context.settings.get("smtp.host");
    await context.settings.set("smtp.host", "");
    try {
      const res = await admin("POST", "/admin/api/settings/mail/test", { data: { to: "someone@example.com" } });
      expect([res.statusCode, res.json().errors[0].code]).toEqual([409, "SMTP_NOT_CONFIGURED"]);
    } finally {
      if (hadHost) await context.settings.set("smtp.host", previousHost);
      else await context.settings.reset("smtp.host");
    }
  });
});

