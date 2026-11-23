import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SETTINGS_DEFAULTS, type SettingKey } from "@totalbase/settings";
import type { AppContext } from "./context.js";
import { lockdownPausesWorkflows } from "./lockdown.js";
import { loadServerEnv } from "./env.js";
import { resolveSubscriberPrincipal } from "./realtime.js";
import { setupTestApp, uniqueSuffix } from "./test-support.js";

type Spec = { paths: Record<string, Record<string, unknown>> };

/**
 * Lockdown (Security.md §2.21): on now or inside its scheduled window, the instance answers
 * administrators only - their sessions and their plane="ADMIN" tokens - and tells everyone else 503 LOCKDOWN.
 */
describe("Lockdown (integration)", () => {
  const PASSWORD = "a-strong-enough-password";
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminSession: string;
  let adminAdminToken: string;
  let adminApiToken: string;
  let userSession: string;
  let userApiToken: string;
  let userEmail: string;
  let roleId: string;
  let adminEmail: string;
  let adminPassword: string;

  let requests = 0;
  /** Each request from its own address, so the per-IP rate limit never answers first. */
  const call = (method: string, url: string, token?: string, body?: unknown) =>
    app.inject({
      method: method as "POST",
      url,
      remoteAddress: `10.9.${(requests >> 8) & 255}.${requests++ & 255}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
  const refusal = (response: { statusCode: number; json: () => { errors?: { code: string }[] } }) => [response.statusCode, response.json().errors?.[0]?.code];
  const LOCKED = [503, "LOCKDOWN"];

  const lock = () => context.settings.set("lockdown.enabled", true);
  async function unlock(): Promise<void> {
    for (const key of Object.keys(SETTINGS_DEFAULTS).filter((k) => k.startsWith("lockdown.")) as SettingKey[]) await context.settings.reset(key);
  }
  const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await unlock();
    const env = loadServerEnv();
    adminEmail = env.adminEmail!;
    adminPassword = env.adminPassword!;
    const admin = await context.auth.login({ email: adminEmail, password: adminPassword });
    adminSession = admin.token;
    adminAdminToken = (await context.usersApis.create({ userId: admin.user.id, name: `lockdown-admin-${uniqueSuffix()}`, plane: "ADMIN" })).plainKey;
    adminApiToken = (await context.usersApis.create({ userId: admin.user.id, name: `lockdown-api-${uniqueSuffix()}`, plane: "API" })).plainKey;

    roleId = (await context.roles.create(`lockdown-test-${uniqueSuffix()}`, { appAccess: true, apiAccess: true })).id;
    userEmail = `lockdown-${uniqueSuffix()}@example.com`;
    const created = await call("POST", "/admin/api/users", adminSession, { data: { email: userEmail, name: "Locked out", password: PASSWORD, roleIds: [roleId] } });
    expect(created.statusCode, created.body).toBe(201);
    userSession = (await context.auth.login({ email: userEmail, password: PASSWORD })).token;
    userApiToken = (await context.usersApis.create({ userId: created.json().data.id, name: `lockdown-user-${uniqueSuffix()}`, plane: "API" })).plainKey;
  });

  afterEach(unlock);

  afterAll(async () => {
    await unlock();
    await database.query(`DELETE FROM totalbase.tokens WHERE name LIKE 'lockdown-%'`);
    await database.query(`DELETE FROM totalbase.users WHERE email = $1`, [userEmail]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await app.close();
    await database.close();
  });

  it("off: everyone is answered, and the instance says so", async () => {
    expect((await call("GET", "/api/auth/me", userSession)).statusCode).toBe(200);
    expect((await call("GET", "/api/auth/me", userApiToken)).statusCode).not.toBe(503);
    expect((await call("GET", "/api/instance")).json().data.lockdown).toEqual({ active: false, mode: "FULL", from: null, until: null, message: "", noticeMinutes: 0 });
  });

  it("on: only an administrator's session or ADMIN token is answered", async () => {
    await lock();
    await context.settings.set("lockdown.message", "Back at noon.");

    // Everyone else: no credential, a user's session, a user's token - and an administrator's API token, an integration like any other.
    for (const credential of [undefined, userSession, userApiToken, adminApiToken, "tb_not-a-token"]) {
      const response = await call("GET", "/api/totalbase/table/users", credential);
      expect(refusal(response), String(credential)).toEqual(LOCKED);
      expect(response.json().errors[0].message).toBe("This instance is in lockdown: only administrators are answered. Back at noon.");
      // Held on by the switch: nobody knows when it ends.
      expect(response.headers["retry-after"]).toBeUndefined();
    }
    for (const [method, url] of [
      ["GET", "/api/auth/me"], ["GET", "/admin/api/auth/me"], ["GET", "/app/api/menu"], ["POST", "/api/auth/register"],
      ["POST", "/api/auth/invitations/accept"], ["POST", "/api/workflows/nothing/webhook"], ["GET", "/embed/api/dashboard"],
      ["POST", "/mcp"], ["POST", "/api/graphql"], ["GET", "/api/openapi"], ["GET", "/api/no-such-route"],
    ] as const) {
      expect(refusal(await call(method, url, userSession, method === "POST" ? {} : undefined)), `${method} ${url}`).toEqual(LOCKED);
    }
    // A percent-encoded path is the route it reaches (Foundations.md §4.1), never a way around the gate.
    for (const url of ["/%61pi/totalbase/table/users", "/api/t%6Ftalbase/table/users"]) {
      expect(refusal(await call("GET", url, userSession)), url).toEqual(LOCKED);
    }

    // Administrators: both planes, by session and by ADMIN token.
    for (const credential of [adminSession, adminAdminToken]) {
      expect((await call("GET", "/admin/api/settings/system", credential)).statusCode).toBe(200);
      expect((await call("GET", "/api/totalbase/table/users", credential)).statusCode).toBe(200);
    }
    expect((await call("GET", "/app/api/menu", adminSession)).statusCode).toBe(200);
  });

  it("on: what an administrator needs to get in stays open", async () => {
    await lock();
    expect((await call("GET", "/health/live")).statusCode).toBe(200);
    expect((await call("GET", "/health/ready")).statusCode).toBe(200);
    const instance = await call("GET", "/api/instance", userSession);
    expect(instance.statusCode).toBe(200);
    expect(instance.json().data.lockdown).toMatchObject({ active: true, from: null, until: null });
    // A forgotten password is still recovered: a lockdown never shuts its own administrators out.
    expect((await call("POST", "/api/auth/password/forgot", undefined, { email: "nobody@example.com" })).statusCode).not.toBe(503);
    // Signing out is nobody's to refuse.
    expect((await call("POST", "/api/auth/logout", (await context.auth.login({ email: userEmail, password: PASSWORD })).token)).statusCode).not.toBe(503);
  });

  it("on: a sign-in admits administrators only, told once the password matched", async () => {
    await lock();
    for (const url of ["/api/auth/login", "/admin/api/auth/login"]) {
      expect(refusal(await call("POST", url, undefined, { email: userEmail, password: PASSWORD })), url).toEqual(LOCKED);
      // A wrong password learns nothing: the same 401 as ever.
      expect((await call("POST", url, undefined, { email: userEmail, password: "not-the-password-at-all" })).statusCode, url).toBe(401);
      const admin = await call("POST", url, undefined, { email: adminEmail, password: adminPassword });
      expect(admin.statusCode, admin.body).toBe(200);
    }
    // No session came of the refused sign-ins.
    const { rows } = await database.query(`SELECT count(*)::int AS open FROM totalbase.sessions s JOIN totalbase.users u ON u.id = s."user" WHERE u.email = $1 AND s.revoked_at IS NULL`, [userEmail]);
    expect(rows[0]!.open).toBe(1);
  });

  it("on: a WebSocket's credential is held to it too - at the upgrade, at its first message, before each delivery", async () => {
    const user = { token: userApiToken, address: undefined };
    await expect(resolveSubscriberPrincipal(context, user)).resolves.toBeDefined();
    await lock();
    await expect(resolveSubscriberPrincipal(context, user)).rejects.toMatchObject({ code: "LOCKDOWN" });
    await expect(resolveSubscriberPrincipal(context, { token: userSession, address: undefined })).rejects.toMatchObject({ code: "LOCKDOWN" });
    await expect(resolveSubscriberPrincipal(context, { token: adminApiToken, address: undefined })).rejects.toMatchObject({ code: "LOCKDOWN" });
    await expect(resolveSubscriberPrincipal(context, { token: adminSession, address: undefined })).resolves.toBeDefined();
    await expect(resolveSubscriberPrincipal(context, { token: adminAdminToken, address: undefined })).resolves.toBeDefined();
  });

  it("on: every Admin API route refuses a user who is not an administrator with LOCKDOWN", async () => {
    const spec: Spec = (await call("GET", "/admin/api/openapi", adminSession)).json();
    await lock();
    const open = new Set(["POST /admin/api/auth/login", "POST /admin/api/auth/mfa/verify", "POST /admin/api/auth/password/renew", "POST /admin/api/auth/logout", "GET /admin/api/backups/{id}/archive"]);
    const answered: string[] = [];
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const method of Object.keys(operations)) {
        const route = `${method.toUpperCase()} ${path}`;
        if (open.has(route)) continue;
        const url = path.replace(/\{[^}]+\}/g, "00000000-0000-4000-8000-000000000000");
        const response = await call(method.toUpperCase(), url, userSession, method === "get" || method === "delete" ? undefined : {});
        if (response.statusCode !== 503) answered.push(`${route} -> ${response.statusCode}`);
      }
    }
    expect(answered).toEqual([]);
  });

  it("a scheduled window starts and ends by the clock, and says when it ends", async () => {
    // Ahead: nothing is refused, and the instance announces it.
    const from = minutesFromNow(60);
    const until = minutesFromNow(120);
    expect((await call("PATCH", "/admin/api/settings/lockdown", adminSession, { data: { enabled: true, when: "ONCE", from, until } })).statusCode).toBe(200);
    expect((await call("GET", "/api/auth/me", userSession)).statusCode).toBe(200);
    expect((await call("GET", "/api/instance")).json().data.lockdown).toEqual({ active: false, mode: "FULL", from, until, message: "", noticeMinutes: 0 });

    // Running: refused, with the wait.
    const end = minutesFromNow(10);
    expect((await call("PATCH", "/admin/api/settings/lockdown", adminSession, { data: { from: minutesFromNow(-10), until: end } })).statusCode).toBe(200);
    const refused = await call("GET", "/api/auth/me", userSession);
    expect(refusal(refused)).toEqual(LOCKED);
    expect(refused.json().errors[0].meta.until).toBe(end);
    const wait = Number(refused.headers["retry-after"]);
    expect(wait).toBeGreaterThan(590);
    expect(wait).toBeLessThanOrEqual(600);
    expect((await call("GET", "/api/auth/me", adminSession)).statusCode).toBe(200);
    // A sign-in refused inside a window says when it ends too.
    expect((await call("POST", "/api/auth/login", undefined, { email: userEmail, password: PASSWORD })).headers["retry-after"]).toBeDefined();

    // Passed: the window is inert - nothing was written to end it.
    await database.query(`UPDATE totalbase.settings SET value = to_jsonb($1::text) WHERE key = 'lockdown.until'`, [minutesFromNow(-1)]);
    context.settings.forget();
    expect((await call("GET", "/api/auth/me", userSession)).statusCode).toBe(200);
    expect((await call("GET", "/api/instance")).json().data.lockdown).toMatchObject({ active: false, from: null, until: null });
    // ... and doesn't keep its page from being saved.
    expect((await call("PATCH", "/admin/api/settings/lockdown", adminSession, { data: { message: "Later." } })).statusCode).toBe(200);
  });

  it("a window is both its ends, the end after the start and still ahead", async () => {
    const patch = (data: Record<string, unknown>) => call("PATCH", "/admin/api/settings/lockdown", adminSession, { data });
    for (const data of [
      { from: minutesFromNow(10) },
      { until: minutesFromNow(10) },
      { from: minutesFromNow(20), until: minutesFromNow(10) },
      { from: minutesFromNow(-20), until: minutesFromNow(-10) },
      { from: "tomorrow", until: minutesFromNow(10) },
      { from: "2030-01-01T00:00:00", until: "2030-01-02T00:00:00" },
      // Turned on as "scheduled once", it has its two ends.
      { enabled: true, when: "ONCE" },
      { when: "sometimes" },
    ]) {
      expect(refusal(await patch(data)), JSON.stringify(data)).toEqual([400, "INVALID_SETTING"]);
    }
    expect((await call("GET", "/api/instance")).json().data.lockdown).toMatchObject({ from: null, until: null });
    // Cleared the same way: both, empty.
    expect((await patch({ from: minutesFromNow(10), until: minutesFromNow(20) })).statusCode).toBe(200);
    expect((await patch({ from: "", until: "" })).statusCode).toBe(200);
  });

  it("a listed role gets in beside administrators - its users' sessions and tokens, and their sign-in", async () => {
    const patch = (data: Record<string, unknown>) => call("PATCH", "/admin/api/settings/lockdown", adminSession, { data });
    // Only roles that exist, and none of the reserved ones.
    const { rows } = await database.query<{ id: string }>(`SELECT id FROM totalbase.roles WHERE reserved AND name = 'Administrators'`);
    for (const allowed_roles of [[rows[0]!.id], ["00000000-0000-4000-8000-000000000000"], ["not-a-role"], [roleId, roleId]]) {
      expect(refusal(await patch({ allowed_roles })), JSON.stringify(allowed_roles)).toEqual([400, "INVALID_SETTING"]);
    }
    await lock();
    expect(refusal(await call("GET", "/api/auth/me", userSession))).toEqual(LOCKED);

    expect((await patch({ allowed_roles: [roleId] })).statusCode).toBe(200);
    expect((await call("GET", "/api/auth/me", userSession)).statusCode).toBe(200);
    expect((await call("GET", "/api/auth/me", userApiToken)).statusCode).not.toBe(503);
    expect((await call("POST", "/api/auth/login", undefined, { email: userEmail, password: PASSWORD })).statusCode).toBe(200);
    await expect(resolveSubscriberPrincipal(context, { token: userApiToken, address: undefined })).resolves.toBeDefined();
    // Nobody else: no credential, and an administrator's API token - their role isn't the listed one.
    expect(refusal(await call("GET", "/api/auth/me"))).toEqual(LOCKED);
    expect(refusal(await call("GET", "/api/auth/me", adminApiToken))).toEqual(LOCKED);
    // As themselves: the Admin API stays the administrators'.
    expect((await call("GET", "/admin/api/settings/system", userSession)).statusCode).toBe(403);
  });

  it("a repeating window is a lockdown from each occurrence of its schedule, for its length", async () => {
    const patch = (data: Record<string, unknown>) => call("PATCH", "/admin/api/settings/lockdown", adminSession, { data });
    expect(refusal(await patch({ recurring_schedule: "every night" }))).toEqual([400, "INVALID_SETTING"]);
    expect(refusal(await patch({ recurring_minutes: 0 }))).toEqual([400, "INVALID_SETTING"]);

    // Every minute, for five: one is always running. Nothing until the switch is on.
    expect((await patch({ when: "RECURRING", recurring_schedule: "* * * * *", recurring_minutes: 5 })).statusCode).toBe(200);
    expect((await call("GET", "/api/auth/me", userSession)).statusCode).toBe(200);
    expect((await patch({ enabled: true })).statusCode).toBe(200);
    const refused = await call("GET", "/api/auth/me", userSession);
    expect(refusal(refused)).toEqual(LOCKED);
    const wait = Number(refused.headers["retry-after"]);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(300);
    const { lockdown } = (await call("GET", "/api/instance")).json().data;
    expect(lockdown).toMatchObject({ active: true });
    expect(Date.parse(lockdown.until) - Date.parse(lockdown.from)).toBe(300_000);
    expect((await call("GET", "/api/auth/me", adminSession)).statusCode).toBe(200);

    // One a year, far from now: ahead, announced, nothing refused.
    const far = new Date(Date.now() + 180 * 86_400_000);
    expect((await patch({ recurring_schedule: `0 3 ${far.getUTCDate()} ${far.getUTCMonth() + 1} *`, recurring_minutes: 60, notice_minutes: 30 })).statusCode).toBe(200);
    expect((await call("GET", "/api/auth/me", userSession)).statusCode).toBe(200);
    const ahead = (await call("GET", "/api/instance")).json().data.lockdown;
    expect(ahead).toMatchObject({ active: false, noticeMinutes: 30 });
    expect(Date.parse(ahead.from)).toBeGreaterThan(Date.now());
  });

  it("workflows wait only during a lockdown that pauses them", async () => {
    expect(await lockdownPausesWorkflows(context)).toBe(false);
    await context.settings.set("lockdown.pause_workflows", true);
    expect(await lockdownPausesWorkflows(context)).toBe(false);
    await lock();
    expect(await lockdownPausesWorkflows(context)).toBe(true);
    await context.settings.set("lockdown.pause_workflows", false);
    expect(await lockdownPausesWorkflows(context)).toBe(false);
  });

  it("read-only: everyone signs in and reads, only who gets in writes", async () => {
    await context.settings.set("lockdown.mode", "READ_ONLY");
    await lock();
    expect((await call("GET", "/api/instance")).json().data.lockdown).toMatchObject({ active: true, mode: "READ_ONLY" });

    // Reads, as ever: a session, a token, a sign-in, a GraphQL query, a subscription.
    expect((await call("GET", "/api/auth/me", userSession)).statusCode).toBe(200);
    expect((await call("GET", "/api/auth/me", userApiToken)).statusCode).not.toBe(503);
    expect((await call("POST", "/api/auth/login", undefined, { email: userEmail, password: PASSWORD })).statusCode).toBe(200);
    expect((await call("POST", "/api/graphql", userSession, { query: "{ __typename }" })).statusCode).not.toBe(503);
    await expect(resolveSubscriberPrincipal(context, { token: userSession, address: undefined })).resolves.toBeDefined();

    // Writes: refused before their route, whatever it is - a new route is a write until it is listed as a read.
    const writes: [string, string][] = [
      ["POST", "/api/totalbase/table/users"], ["PATCH", "/api/totalbase/table/users"], ["DELETE", "/api/totalbase/table/users"],
      ["PATCH", "/api/totalbase/table/users/00000000-0000-4000-8000-000000000000"], ["POST", "/api/public/function/anything"],
      ["POST", "/api/transactions"], ["POST", "/api/workflows/nothing/run"], ["POST", "/api/workflows/nothing/webhook"],
      ["GET", "/api/workflows/nothing/webhook"], ["POST", "/api/auth/register"], ["POST", "/api/auth/invitations/accept"],
      ["PATCH", "/api/auth/account"], ["PUT", "/api/auth/account/password"], ["POST", "/api/tokens"], ["POST", "/api/totalbase/table/files"],
      ["PATCH", "/app/api/me/preferences"], ["PUT", "/app/api/dataviews/nothing/user-prefs"], ["POST", "/app/api/dataviews/nothing/save"],
      ["POST", "/mcp"], ["POST", "/api/no-such-route"],
    ];
    for (const [method, url] of writes) {
      for (const credential of [undefined, userSession, userApiToken, adminApiToken]) {
        const response = await call(method, url, credential, method === "GET" || method === "DELETE" ? undefined : {});
        expect(refusal(response), `${method} ${url} ${String(credential)}`).toEqual(LOCKED);
        expect(response.json().errors[0]).toMatchObject({ message: "This instance is in lockdown, read-only: only administrators can change anything.", meta: { mode: "READ_ONLY" } });
      }
    }
    // Who gets in writes: administrators, and a listed role.
    const patched = await call("PATCH", "/admin/api/settings/lockdown", adminSession, { data: { allowed_roles: [roleId] } });
    expect(patched.statusCode).toBe(200);
    expect((await call("PATCH", "/app/api/me/preferences", userSession, { data: {} })).statusCode).not.toBe(503);
    expect((await call("POST", "/api/totalbase/table/users", userApiToken, {})).statusCode).not.toBe(503);
  });
});
