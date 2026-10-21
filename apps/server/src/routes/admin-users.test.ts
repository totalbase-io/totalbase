import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { cleanupTracked, setupTestApp, track, uniqueSuffix } from "../test-support.js";

/** Per-run suffix on every email and role name this file creates. */
const SUFFIX = uniqueSuffix();

/**
 * POST /admin/api/users - "New user" (complete account: email, name,
 * password, roles) vs. the pre-existing passwordless + "Send invite"
 * flow. See admin's users/index.vue.
 */
describe("POST /admin/api/users", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let roleId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());

    const role = await context.roles.create(`admin-users-test-role-${SUFFIX}`, { apiAccess: true });
    roleId = role.id;

    const env = loadServerEnv();
    const login = await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! });
    adminToken = login.token;
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await database.query(`DELETE FROM totalbase.users WHERE id = ANY($1)`, [createdUserIds]);
    }
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await app.close();
  });

  it("creates a passwordless user when no password is given (unchanged 'invite later' path)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/api/users",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { email: `admin-users-test-passwordless-${SUFFIX}@example.com`, name: "Passwordless" } },
    });
    expect(res.statusCode).toBe(201);
    const { data } = res.json();
    createdUserIds.push(data.id);
    expect(data.emailVerifiedAt).toBeNull();

    const login = await context.auth
      .login({ email: `admin-users-test-passwordless-${SUFFIX}@example.com`, password: "anything" })
      .catch((err: unknown) => err);
    expect(login).toBeInstanceOf(Error);
  });

  it("creates a complete, ready-to-log-in user and assigns roles when a password is given", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/api/users",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: {
        email: `admin-users-test-complete-${SUFFIX}@example.com`,
        name: "Complete",
        password: "a-strong-enough-password",
        roleIds: [roleId],
      } },
    });
    expect(res.statusCode).toBe(201);
    const { data } = res.json();
    createdUserIds.push(data.id);
    // Admin vouched for the address directly - no verification link to
    // click for an address only they typed in.
    expect(data.emailVerifiedAt).not.toBeNull();

    const login = await context.auth.login({
      email: `admin-users-test-complete-${SUFFIX}@example.com`,
      password: "a-strong-enough-password",
    });
    expect(login.user.id).toBe(data.id);

    const roleIds = await context.roleAssignments.listRolesForUser(data.id);
    expect(roleIds).toEqual([roleId]);
  });

  it("answers 400, not 500, to a create with no body - a user or a sign-in provider", async () => {
    for (const url of ["/admin/api/users", "/admin/api/auth-providers"]) {
      const res = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${adminToken}` } });
      expect(res.statusCode, url).toBe(400);
    }
    const res = await app.inject({
      method: "POST",
      url: "/admin/api/auth-providers",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { type: "GOOGLE", name: "No configuration" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a password shorter than auth.password_min_length", async () => {
    const minLength = await context.settings.get("auth.password_min_length");
    const res = await app.inject({
      method: "POST",
      url: "/admin/api/users",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: {
        email: `admin-users-test-weak-${SUFFIX}@example.com`,
        password: "a".repeat(Math.max(1, minLength - 1)),
      } },
    });
    expect(res.statusCode).toBe(400);
    // Not INVALID_QUERY: nothing was a query.
    expect(res.json().errors[0].code).toBe("PASSWORD_TOO_SHORT");
  });
});

/**
 * GET /admin/api/users and /admin/api/users/:id - the Users screen filters
 * on each user's role ids and on whether a password is set yet (an
 * invited account), so both endpoints carry them, in camelCase.
 */
describe("GET /admin/api/users", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let roleId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());

    const role = await context.roles.create(`admin-users-list-test-role-${SUFFIX}`, { apiAccess: true });
    roleId = role.id;

    const env = loadServerEnv();
    const login = await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! });
    adminToken = login.token;
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await database.query(`DELETE FROM totalbase.users WHERE id = ANY($1)`, [createdUserIds]);
    }
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await app.close();
  });

  async function createUser(payload: Record<string, unknown>): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/admin/api/users",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: payload },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().data.id as string;
    createdUserIds.push(id);
    return id;
  }

  it("lists each user's role ids and whether a password is set", async () => {
    const invitedId = await createUser({ email: `admin-users-list-invited-${SUFFIX}@example.com`, name: "Invited", roleIds: [roleId] });
    const completeId = await createUser({
      email: `admin-users-list-complete-${SUFFIX}@example.com`,
      name: "Complete",
      password: "a-strong-enough-password",
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/api/users",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const users = res.json().data as Array<Record<string, unknown>>;

    const invited = users.find((u) => u.id === invitedId);
    expect(invited).toMatchObject({ roles: [roleId], hasPassword: false, canLogin: true, lastLoginAt: null });
    expect(invited).not.toHaveProperty("password_hash");
    expect(invited).not.toHaveProperty("passwordHash");

    const complete = users.find((u) => u.id === completeId);
    expect(complete).toMatchObject({ roles: [], hasPassword: true });
    expect(complete).toHaveProperty("createdAt");
  });

  it("returns the same shape for a single user", async () => {
    const id = await createUser({ email: `admin-users-list-single-${SUFFIX}@example.com`, name: "Single", roleIds: [roleId] });
    const res = await app.inject({
      method: "GET",
      url: `/admin/api/users/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ id, roles: [roleId], hasPassword: false });
  });

  it("requires an admin", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/users" });
    expect(res.statusCode).toBe(401);
  });
});

/**
 * Review fixes (users): owner/system accounts can't be deactivated,
 * deactivation cuts sessions and tokens, creation is atomic and leaves
 * duplicates to PostgreSQL, request bodies are validated.
 */
describe("admin users - guards and validation", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let apiRoleId: string;
  const EMAIL_PREFIX = `admin-users-guard-test-${SUFFIX}`;

  const inject = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: Record<string, unknown>) =>
    payload === undefined
      ? app.inject({ method, url, headers: { authorization: `Bearer ${adminToken}` } })
      : app.inject({ method, url, headers: { authorization: `Bearer ${adminToken}` }, payload });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    apiRoleId = (await context.roles.create(`admin-users-guard-test-role-${SUFFIX}`, { apiAccess: true })).id;
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
  });

  afterAll(async () => {
    await cleanupTracked(database);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [apiRoleId]);
    await app.close();
  });

  it("refuses to deactivate the instance owner", async () => {
    const owner = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE owner`)).rows[0]!;
    const res = await inject("PATCH", `/api/totalbase/table/users/${owner.id}`, { data: { active: false } });
    expect(res.statusCode).toBe(403);
    expect((await context.auth.users.findById(owner.id))!.active).toBe(true);
  });

  it("deactivating a user ends their sessions and stops their API tokens", async () => {
    const created = await inject("POST", "/admin/api/users", { data: {
      email: `${EMAIL_PREFIX}-deact@example.com`,
      name: "Deact",
      password: "a-strong-enough-password",
      roleIds: [apiRoleId],
    } });
    const userId = track("users", created.json().data.id as string);
    const { token } = await context.auth.login({ email: `${EMAIL_PREFIX}-deact@example.com`, password: "a-strong-enough-password" });
    const { plainKey } = await context.usersApis.create({ userId, name: "deact", plane: "API" });
    expect(await context.usersApis.validate(plainKey)).not.toBeNull();

    expect((await inject("PATCH", `/api/totalbase/table/users/${userId}`, { data: { active: false } })).statusCode).toBe(200);
    expect(await context.auth.sessions.validate(token)).toBeNull();
    expect(await context.usersApis.validate(plainKey)).toBeNull();
    const { rows } = await database.query(`SELECT 1 FROM totalbase.sessions WHERE "user" = $1 AND revoked_at IS NULL`, [userId]);
    expect(rows.length).toBe(0);
  });

  it("leaves duplicate emails to PostgreSQL's case-insensitive unique index (409)", async () => {
    const first = await inject("POST", "/admin/api/users", { data: { email: `${EMAIL_PREFIX}-dup@example.com`, name: "A" } });
    expect(first.statusCode).toBe(201);
    track("users", first.json().data.id);
    const dup = await inject("POST", "/admin/api/users", { data: { email: `${EMAIL_PREFIX}-DUP@Example.com`, name: "B" } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().errors[0].message).toBe("A user with this email already exists.");
  });

  it("creates the user and its roles atomically - a bad role rolls the user back", async () => {
    const email = `${EMAIL_PREFIX}-atomic@example.com`;
    const res = await inject("POST", "/admin/api/users", { data: {
      email,
      name: "Atomic",
      roleIds: ["00000000-0000-0000-0000-000000000000"],
    } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(await context.auth.users.findByEmail(email)).toBeNull();
  });

  it("validates request bodies instead of failing with a 500", async () => {
    expect((await inject("POST", "/admin/api/users", { data: { email: "not-an-email", name: "X" } })).statusCode).toBe(400);
    expect((await inject("POST", "/admin/api/users", { data: { email: `${EMAIL_PREFIX}-r@example.com`, roleIds: "x" } })).statusCode).toBe(400);
    const created = await inject("POST", "/admin/api/users", { data: { email: `${EMAIL_PREFIX}-v@example.com`, name: "V" } });
    const userId = track("users", created.json().data.id as string);
    // Name and status are Data API rows: PostgreSQL judges them (a CHECK, the boolean input).
    expect((await inject("PATCH", `/api/totalbase/table/users/${userId}`, { data: { name: "   " } })).statusCode).toBe(422);
    expect((await inject("PATCH", `/api/totalbase/table/users/${userId}`, { data: { active: "maybe" } })).statusCode).toBe(400);
    expect((await inject("PUT", `/admin/api/users/${userId}/roles`, { data: { roleIds: [1, 2] } })).statusCode).toBe(400);
    expect((await inject("PUT", `/admin/api/users/${userId}/roles`, { data: {} })).statusCode).toBe(400);
    expect((await inject("PATCH", "/api/totalbase/table/users/00000000-0000-0000-0000-000000000000", { data: { name: "Ghost" } })).statusCode).toBe(404);
  });

  it("answers 404 for an unknown user - its roles, its effective permissions, deleting it - and 204 for set roles", async () => {
    const ghost = "00000000-0000-0000-0000-000000000000";
    const del = (url: string) => app.inject({ method: "DELETE", url, headers: { authorization: `Bearer ${adminToken}` } });
    for (const url of [`/admin/api/users/${ghost}/roles`, `/admin/api/users/${ghost}/effective-permissions`]) {
      const res = await inject("GET", url);
      expect([res.statusCode, res.json().errors[0].code], url).toEqual([404, "RESOURCE_NOT_FOUND"]);
    }
    expect((await del(`/admin/api/users/${ghost}`)).statusCode).toBe(404);

    const created = await inject("POST", "/admin/api/users", { data: { email: `${EMAIL_PREFIX}-gone@example.com`, name: "Gone" } });
    const userId = created.json().data.id as string;
    const setRoles = await inject("PUT", `/admin/api/users/${userId}/roles`, { data: { roleIds: [apiRoleId] } });
    expect([setRoles.statusCode, setRoles.body]).toEqual([204, ""]);
    expect((await inject("GET", `/admin/api/users/${userId}/roles`)).json().data).toEqual([apiRoleId]);
    // The old unwrapped body is not read.
    expect((await inject("PUT", `/admin/api/users/${userId}/roles`, { roleIds: [apiRoleId] })).statusCode).toBe(400);
    expect((await del(`/admin/api/users/${userId}`)).statusCode).toBe(204);
    expect((await del(`/admin/api/users/${userId}`)).statusCode).toBe(404);
  });

  it("changes a user's email: the admin picks verified or not, pending links die, duplicates are PostgreSQL's 409", async () => {
    const created = await inject("POST", "/admin/api/users", { data: { email: `${EMAIL_PREFIX}-mail@example.com`, name: "Mail" } });
    const userId = created.json().data.id as string;
    await context.auth.createInvitation({ id: userId, email: `${EMAIL_PREFIX}-mail@example.com`, name: "Mail" }, "link");

    const notify = vi.spyOn(context.auth, "notifyEmailChanged");
    const verified = await inject("PUT", `/admin/api/users/${userId}/email`, { data: { email: `${EMAIL_PREFIX}-mail2@example.com`, verification: "VERIFIED" } });
    // The previous address gets the security notice, naming the new one.
    expect(notify).toHaveBeenCalledWith({ email: `${EMAIL_PREFIX}-mail@example.com`, name: "Mail" }, `${EMAIL_PREFIX}-mail2@example.com`);
    notify.mockRestore();
    expect(verified.statusCode).toBe(200);
    expect(verified.json().data.email).toBe(`${EMAIL_PREFIX}-mail2@example.com`);
    expect(verified.json().data.emailVerifiedAt).not.toBeNull();
    // The invitation sent to the old address no longer works.
    const { rows: pending } = await database.query(`SELECT 1 FROM totalbase.emails_tokens WHERE "user" = $1 AND used_at IS NULL`, [userId]);
    expect(pending).toHaveLength(0);

    // Letter case only: not a new address - verification is kept.
    const recased = await inject("PUT", `/admin/api/users/${userId}/email`, { data: { email: `${EMAIL_PREFIX}-MAIL2@example.com`, verification: "SEND" } });
    expect(recased.json().data.emailVerifiedAt).not.toBeNull();
    expect(recased.json().meta.verificationSent).toBe(false);

    // A real change with SEND: unverified until the user confirms (the
    // email itself may fail without SMTP - reported, never rolled back).
    const unverified = await inject("PUT", `/admin/api/users/${userId}/email`, { data: { email: `${EMAIL_PREFIX}-mail3@example.com`, verification: "SEND" } });
    expect(unverified.statusCode).toBe(200);
    expect(unverified.json().data.emailVerifiedAt).toBeNull();

    const other = await inject("POST", "/admin/api/users", { data: { email: `${EMAIL_PREFIX}-taken@example.com`, name: "Taken" } });
    expect(other.statusCode).toBe(201);
    expect((await inject("PUT", `/admin/api/users/${userId}/email`, { data: { email: `${EMAIL_PREFIX}-TAKEN@example.com`, verification: "VERIFIED" } })).statusCode).toBe(409);
    expect((await inject("PUT", `/admin/api/users/${userId}/email`, { data: { email: "not-an-email", verification: "VERIFIED" } })).statusCode).toBe(400);
    expect((await inject("PUT", `/admin/api/users/${userId}/email`, { data: { email: `${EMAIL_PREFIX}-x@example.com` } })).statusCode).toBe(400);

    const { rows: system } = await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email = 'workflows@system.totalbase.internal'`);
    expect((await inject("PUT", `/admin/api/users/${system[0]!.id}/email`, { data: { email: `${EMAIL_PREFIX}-wf@example.com`, verification: "VERIFIED" } })).statusCode).toBe(403);
  });

  it("sets a user's avatar: re-encoded public file in Avatars, replaced files deleted, provider picture, removal", async () => {
    const created = await inject("POST", "/admin/api/users", { data: { email: `${EMAIL_PREFIX}-avatar@example.com`, name: "Avatar" } });
    const userId = created.json().data.id as string;
    const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const upload = (content: Buffer, type: string, name: string) => {
      const form = new FormData();
      form.append("file", new Blob([content], { type }), name);
      return app.inject({ method: "POST", url: `/admin/api/users/${userId}/avatar`, headers: { authorization: `Bearer ${adminToken}` }, payload: form });
    };

    // Whatever happens below, the avatar file doesn't outlive the test
    // (afterAll deletes users by SQL, not through the route that cleans up).
    const cleanup = () => app.inject({ method: "DELETE", url: `/admin/api/users/${userId}/avatar`, headers: { authorization: `Bearer ${adminToken}` } });
    try {
      const first = await upload(PNG, "image/png", "me.png");
      expect(first.statusCode).toBe(200);
      const firstUrl = first.json().data.avatarUrl as string;
      expect(firstUrl).toMatch(/^\/api\/totalbase\/table\/files\/[0-9a-f-]{36}$/);
      // Public (an <img> sends no token), re-encoded to a square WebP - never enlarged.
      const served = await app.inject({ method: "GET", url: firstUrl });
      expect(served.statusCode).toBe(200);
      expect(served.headers["content-type"]).toBe("image/webp");
      const firstFile = await context.filesAdmin.get(firstUrl.split("/").pop()!);
      expect([firstFile.width, firstFile.height, firstFile.visibility]).toEqual([1, 1, "PUBLIC"]);

      // Replacing it deletes the replaced file.
      const second = await upload(PNG, "image/png", "me2.png");
      const secondUrl = second.json().data.avatarUrl as string;
      expect((await app.inject({ method: "GET", url: firstUrl })).statusCode).toBe(404);

      // Only PNG/JPEG/WebP, whatever the declared type says.
      expect((await upload(Buffer.from("not an image"), "image/png", "fake.png")).statusCode).toBeGreaterThanOrEqual(400);

      // The sign-in provider's picture.
      const { rows: providerRows } = await database.query<{ id: string }>(
        `INSERT INTO totalbase.providers (type, name, slug) VALUES ('GITHUB', 'admin-users-guard-test-gh', 'github') RETURNING id`,
      );
      try {
        await database.query(
          `INSERT INTO totalbase.identities ("user", provider, provider_subject, provider_avatar_url, last_login_at)
           VALUES ($1, $2, 'avatar-test-subject', 'https://avatars.example.com/u/1', now())`,
          [userId, providerRows[0]!.id],
        );
        const detail = (await inject("GET", `/admin/api/users/${userId}`)).json().data;
        expect(detail.providerAvatar).toEqual({ url: "https://avatars.example.com/u/1", provider: "admin-users-guard-test-gh" });
        const fromProvider = await inject("POST", `/admin/api/users/${userId}/avatar/provider`);
        expect(fromProvider.json().data.avatarUrl).toBe("https://avatars.example.com/u/1");
        expect((await app.inject({ method: "GET", url: secondUrl })).statusCode).toBe(404);
      } finally {
        await database.query(`DELETE FROM totalbase.providers WHERE id = $1`, [providerRows[0]!.id]);
      }

      const removed = await cleanup();
      expect(removed.statusCode).toBe(204);
      expect((await inject("GET", `/admin/api/users/${userId}`)).json().data.avatarUrl).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("sets a user's password: strength-checked, links retired, sessions signed out, never logged", async () => {
    const email = `${EMAIL_PREFIX}-pw@example.com`;
    const created = await inject("POST", "/admin/api/users", { data: { email, name: "Pw", password: "first-password-123", roleIds: [apiRoleId] } });
    const userId = created.json().data.id as string;
    const { token: session } = await context.auth.login({ email, password: "first-password-123" });
    await context.auth.createInvitation({ id: userId, email, name: "Pw" }, "link");

    expect((await inject("PUT", `/admin/api/users/${userId}/password`, { data: { password: "short" } })).statusCode).toBe(400);
    const set = await inject("PUT", `/admin/api/users/${userId}/password`, { data: { password: "second-password-456" } });
    expect(set.statusCode).toBe(204);
    expect(set.body).toBe("");
    await expect(context.auth.login({ email, password: "second-password-456" })).resolves.toBeTruthy();
    expect(await context.auth.sessions.validate(session)).toBeNull();
    const { rows: pending } = await database.query(`SELECT 1 FROM totalbase.emails_tokens WHERE "user" = $1 AND used_at IS NULL`, [userId]);
    expect(pending).toHaveLength(0);

    // The caller's own session survives signing out "everywhere else".
    const { token: mine } = await context.auth.login({ email, password: "second-password-456" });
    const { token: other } = await context.auth.login({ email, password: "second-password-456" });
    await context.auth.sessions.revokeAllForUser(userId, (await context.auth.sessions.validate(mine))!.session.id);
    expect(await context.auth.sessions.validate(mine)).not.toBeNull();
    expect(await context.auth.sessions.validate(other)).toBeNull();

    // signOut: false keeps existing sessions.
    const { token: kept } = await context.auth.login({ email, password: "second-password-456" });
    await inject("PUT", `/admin/api/users/${userId}/password`, { data: { password: "third-password-789", signOut: false } });
    expect(await context.auth.sessions.validate(kept)).not.toBeNull();

    const { rows: logged } = await database.query<{ payload: unknown }>(
      `SELECT payload FROM totalbase.logs WHERE metadata->>'event' = 'user.password_set' AND metadata->>'user_id' = $1`,
      [userId],
    );
    expect(JSON.stringify(logged)).not.toContain("password-456");

    const { rows: system } = await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email = 'workflows@system.totalbase.internal'`);
    expect((await inject("PUT", `/admin/api/users/${system[0]!.id}/password`, { data: { password: "whatever-password-1" } })).statusCode).toBe(403);
  });

  it("an admin's own password needs the current one and keeps their session; they can't delete or deactivate themselves", async () => {
    const env = loadServerEnv();
    const me = (await inject("GET", "/admin/api/auth/me")).json().data as { id?: string; user?: { id: string } };
    const myId = me.id ?? me.user!.id;

    const missing = await inject("PUT", `/admin/api/users/${myId}/password`, { data: { password: env.adminPassword! } });
    expect([missing.statusCode, missing.json().errors[0].code]).toEqual([400, "INVALID_CURRENT_PASSWORD"]);
    const wrong = await inject("PUT", `/admin/api/users/${myId}/password`, { data: { password: env.adminPassword!, currentPassword: "not-it-at-all" } });
    expect([wrong.statusCode, wrong.json().errors[0].code]).toEqual([400, "INVALID_CURRENT_PASSWORD"]);
    // Same password again: exercises the path without changing the test
    // admin's credentials - which may be shorter than the policy, so the
    // minimum is relaxed to its lowest allowed value (8) for this call and
    // restored exactly as it was.
    const minKey = "auth.password_min_length" as const;
    const hadOverride = await context.settings.isOverridden(minKey);
    const previousMin = await context.settings.get(minKey);
    await context.settings.set(minKey, 8);
    try {
      // signOut: false - this is the dev database's real admin; signing
      // them out everywhere would end the developer's own browser session.
      const ok = await inject("PUT", `/admin/api/users/${myId}/password`, { data: { password: env.adminPassword!, currentPassword: env.adminPassword!, signOut: false } });
      expect(ok.statusCode, ok.body).toBe(204);
    } finally {
      if (hadOverride) await context.settings.set(minKey, previousMin);
      else await context.settings.reset(minKey);
    }
    expect((await inject("GET", "/admin/api/auth/me")).statusCode).toBe(200);

    expect((await app.inject({ method: "DELETE", url: `/admin/api/users/${myId}`, headers: { authorization: `Bearer ${adminToken}` } })).statusCode).toBe(403);
    expect((await inject("PATCH", `/api/totalbase/table/users/${myId}`, { data: { active: false } })).statusCode).toBe(403);
  });

  it("pages sessions in PostgreSQL: status filter and counts, search, the caller's own session marked", async () => {
    const email = `${EMAIL_PREFIX}-sess@example.com`;
    const created = await inject("POST", "/admin/api/users", { data: { email, name: "Sess", password: "sessions-password-1", roleIds: [apiRoleId] } });
    const userId = created.json().data.id as string;
    const login = (userAgent: string) => context.auth.login({ email, password: "sessions-password-1", ip: "10.1.2.3", userAgent });
    await login("Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36");
    const revoked = await login("Mozilla/5.0 (Macintosh) Firefox/130.0");
    await login("curl/8.5.0");
    await context.auth.sessions.revokeByToken(revoked.token);
    await database.query(
      `UPDATE totalbase.sessions SET expires_at = now() - interval '1 day' WHERE "user" = $1 AND user_agent = 'curl/8.5.0'`,
      [userId],
    );

    const active = (await inject("GET", `/admin/api/sessions?user=${userId}&limit=10`)).json();
    expect(active.meta).toEqual({ total: 1, counts: { ACTIVE: 1, EXPIRED: 1, REVOKED: 1 } });
    expect(active.data[0]).toMatchObject({ userEmail: email, userName: "Sess", current: false });
    expect(Object.keys(active.data[0]).sort()).toEqual(
      ["createdAt", "current", "expiresAt", "id", "ip", "lastSeenAt", "revokedAt", "user", "userAgent", "userEmail", "userName"],
    );
    expect((await inject("GET", `/admin/api/sessions?user=${userId}&status=ALL&limit=2`)).json().data).toHaveLength(2);
    expect((await inject("GET", `/admin/api/sessions?user=${userId}&status=ALL&limit=10&q=firefox`)).json().meta.total).toBe(1);
    expect((await inject("GET", `/admin/api/sessions?user=${userId}&status=ALL&limit=10&q=10.1.2`)).json().meta.total).toBe(3);
    // LIKE wildcards are literal.
    expect((await inject("GET", `/admin/api/sessions?user=${userId}&status=ALL&limit=10&q=%25`)).json().meta.total).toBe(0);
    expect((await inject("GET", "/admin/api/sessions?limit=10&status=nope")).statusCode).toBe(400);
    expect((await inject("GET", "/admin/api/sessions?limit=0")).statusCode).toBe(400);

    // The admin's own session is marked.
    const me = (await inject("GET", "/admin/api/auth/me")).json().data as { id?: string; user?: { id: string } };
    const mine = (await inject("GET", `/admin/api/sessions?user=${me.id ?? me.user!.id}&limit=200`)).json().data as Array<{ current: boolean }>;
    expect(mine.filter((s) => s.current)).toHaveLength(1);
  });

  it("purges sessions that ended more than auth.session_retention_days ago - never live ones", async () => {
    const email = `${EMAIL_PREFIX}-purge@example.com`;
    const created = await inject("POST", "/admin/api/users", { data: { email, name: "Purge", password: "purge-password-12", roleIds: [apiRoleId] } });
    const userId = created.json().data.id as string;
    for (const ua of ["old-revoked", "old-expired", "recent-revoked", "live"]) {
      await context.auth.login({ email, password: "purge-password-12", userAgent: ua });
    }
    const set = (ua: string, sql: string) =>
      database.query(`UPDATE totalbase.sessions SET ${sql} WHERE "user" = $1 AND user_agent = $2`, [userId, ua]);
    await set("old-revoked", "revoked_at = now() - interval '40 days'");
    await set("old-expired", "expires_at = now() - interval '40 days'");
    await set("recent-revoked", "revoked_at = now() - interval '5 days'");

    expect(await context.auth.sessions.purgeEnded(0)).toBe(0);
    expect(await context.auth.sessions.purgeEnded(30)).toBeGreaterThanOrEqual(2);
    const { rows } = await database.query<{ user_agent: string }>(
      `SELECT user_agent FROM totalbase.sessions WHERE "user" = $1 ORDER BY user_agent`,
      [userId],
    );
    expect(rows.map((r) => r.user_agent)).toEqual(["live", "recent-revoked"]);

    await expect(context.settings.set("auth.session_retention_days", -1)).rejects.toMatchObject({ code: "INVALID_SETTING" });
  });

  it("serves the Users → Insights aggregates, a user's activity including their tokens'", async () => {
    const signIns = await inject("GET", "/admin/api/audit/insights/sign-ins?days=7&tz=UTC");
    expect(signIns.statusCode).toBe(200);
    expect(signIns.json().data).toMatchObject({ byWeekday: expect.any(Array), byHour: expect.any(Array), lockedNow: expect.any(Number), activeSessions: expect.any(Number) });
    expect(signIns.json().data.byHour).toHaveLength(24);

    const email = `${EMAIL_PREFIX}-insights@example.com`;
    const created = await inject("POST", "/admin/api/users", { data: { email, name: "Insights", password: "insights-password-1", roleIds: [apiRoleId] } });
    const userId = created.json().data.id as string;
    const { userApi } = await context.usersApis.create({ userId, name: "insights", plane: "API" });
    await database.query(
      `INSERT INTO totalbase.logs (request_id, principal_type, principal, action, status, source, started_at)
       VALUES (gen_random_uuid(), 'USER', $1, 'CREATE', 'EXECUTED', 'api', now()), (gen_random_uuid(), 'API_KEY', $2, 'UPDATE', 'EXECUTED', 'api', now())`,
      [userId, userApi.id],
    );
    const activity = (await inject("GET", `/admin/api/audit/insights/activity?days=30&tz=UTC&user=${userId}`)).json().data;
    expect(activity.totals.writes).toBe(2);
    await database.query(`DELETE FROM totalbase.logs WHERE principal = ANY($1::uuid[])`, [[userId, userApi.id]]);

    expect((await inject("GET", "/admin/api/audit/insights/sign-ins?tz=Nowhere/Land")).statusCode).toBe(400);
    expect((await inject("GET", "/admin/api/audit/insights/activity?days=abc")).statusCode).toBe(400);
  });

  it("filters tokens and sessions by user on the server", async () => {
    const created = await inject("POST", "/admin/api/users", { data: {
      email: `${EMAIL_PREFIX}-filter@example.com`,
      name: "Filter",
      password: "a-strong-enough-password",
      roleIds: [apiRoleId],
    } });
    const userId = created.json().data.id as string;
    await context.auth.login({ email: `${EMAIL_PREFIX}-filter@example.com`, password: "a-strong-enough-password" });
    const { userApi } = await context.usersApis.create({ userId, name: "filter", plane: "API" });

    // Tokens are Data API rows (tokens).
    const tokens = (await inject("GET", `/api/totalbase/table/tokens?where[user][_eq]=${userId}`)).json().data as Array<{ user: string }>;
    expect(tokens.length).toBe(1);
    expect(tokens.every((t) => t.user === userId)).toBe(true);
    // Without limit: every active session, in the same shape as a page.
    const all = (await inject("GET", `/admin/api/sessions?user=${userId}`)).json();
    const sessions = all.data as Array<{ user: string; userEmail: string }>;
    expect(sessions.length).toBe(1);
    expect(sessions.every((s) => s.user === userId && s.userEmail === `${EMAIL_PREFIX}-filter@example.com`)).toBe(true);
    expect(all.meta).toEqual({ total: 1, counts: { ACTIVE: 1, EXPIRED: 0, REVOKED: 0 } });
    const byIds = (await inject("GET", `/api/totalbase/table/tokens?where[id][_in]=${userApi.id},00000000-0000-0000-0000-000000000000&fields=id,name`)).json().data as Array<{ id: string; name: string }>;
    expect(byIds.map((t) => [t.id, t.name])).toEqual([[userApi.id, "filter"]]);
  });
});

/** Server-side pagination, filtering and the panel's summary counts. */
describe("GET /admin/api/users - pages and summary", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let roleId: string;
  const PREFIX = `admin-users-page-test-${SUFFIX}`;

  const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${adminToken}` } });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    roleId = (await context.roles.create(`admin-users-page-test-role-${SUFFIX}`)).id;
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    for (let i = 0; i < 5; i += 1) {
      const created = await app.inject({
        method: "POST",
        url: "/admin/api/users",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { data: {
          email: `${PREFIX}-${i}@example.com`,
          name: `Page Test ${i}`,
          ...(i < 2 && { password: "a-strong-enough-password" }),
          ...(i === 4 && { roleIds: [roleId] }),
        } },
      });
      track("users", created.json().data.id);
    }
    const inactive = await context.auth.users.findByEmail(`${PREFIX}-1@example.com`);
    await context.auth.users.update(inactive!.id, { active: false });
  });

  afterAll(async () => {
    await cleanupTracked(database);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await app.close();
  });

  it("pages a search, newest first, with the total", async () => {
    const first = (await get(`/admin/api/users?q=${PREFIX}&limit=2&offset=0`)).json();
    expect(first.meta.total).toBe(5);
    expect(first.data.map((u: { email: string }) => u.email)).toEqual([`${PREFIX}-4@example.com`, `${PREFIX}-3@example.com`]);
    const last = (await get(`/admin/api/users?q=${PREFIX}&limit=2&offset=4`)).json();
    expect(last.data.map((u: { email: string }) => u.email)).toEqual([`${PREFIX}-0@example.com`]);
  });

  it("filters by status and role, and treats LIKE wildcards in q literally", async () => {
    const byStatus = async (status: string) =>
      (await get(`/admin/api/users?q=${PREFIX}&status=${status}&limit=50`)).json().data.map((u: { email: string }) => u.email).sort();
    expect(await byStatus("INACTIVE")).toEqual([`${PREFIX}-1@example.com`]);
    expect(await byStatus("ACTIVE")).toEqual([`${PREFIX}-0@example.com`]);
    expect(await byStatus("INVITED")).toEqual([`${PREFIX}-2@example.com`, `${PREFIX}-3@example.com`, `${PREFIX}-4@example.com`]);
    const byRole = (await get(`/admin/api/users?role=${roleId}&limit=50`)).json();
    expect(byRole.data.map((u: { email: string }) => u.email)).toEqual([`${PREFIX}-4@example.com`]);
    expect((await get("/admin/api/users?q=%25&limit=50")).json().meta.total).toBe(0);
  });

  it("summarizes counts per status and per role", async () => {
    const { data } = (await get("/admin/api/users/summary")).json();
    expect(data.byRole[roleId]).toBe(1);
    expect(data.byStatus.ACTIVE + data.byStatus.INVITED + data.byStatus.INACTIVE).toBe(data.total);
    // Credentials still in use - checked against PostgreSQL's own count.
    const { rows } = await database.query<{ tokens: number; sessions: number }>(
      `SELECT (SELECT count(*)::int FROM totalbase.tokens WHERE active AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS tokens,
              (SELECT count(*)::int FROM totalbase.sessions WHERE revoked_at IS NULL AND expires_at > now()) AS sessions`,
    );
    expect(data.credentials).toEqual(rows[0]);
  });

  it("looks up a batch of ids, and filters active accounts", async () => {
    const ids = (await get(`/admin/api/users?q=${PREFIX}&limit=50`)).json().data.map((u: { id: string }) => u.id) as string[];
    const lookup = (await get(`/admin/api/users?ids=${ids.slice(0, 2).join(",")}&limit=50`)).json();
    expect(lookup.data.map((u: { id: string }) => u.id).sort()).toEqual(ids.slice(0, 2).sort());
    const active = (await get(`/admin/api/users?q=${PREFIX}&active=true&limit=50`)).json();
    expect(active.data.map((u: { email: string }) => u.email)).not.toContain(`${PREFIX}-1@example.com`);
    expect(active.meta.total).toBe(4);
  });

  it("rejects bad paging parameters", async () => {
    for (const q of ["limit=0", "limit=500", "limit=10&offset=-1", "limit=10&status=NOPE", "limit=10&role=x", "limit=10&ids=x", "limit=10&active=maybe"]) {
      expect((await get(`/admin/api/users?${q}`)).statusCode, q).toBe(400);
    }
  });

  it("still lists every user without limit, with the same meta.total", async () => {
    const res = (await get("/admin/api/users")).json();
    expect(res.data.length).toBeGreaterThanOrEqual(5);
    expect(res.meta).toEqual({ total: res.data.length });
  });
});
