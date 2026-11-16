import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp, uniqueSuffix, waitFor } from "./test-support.js";

const P = `user-removal-${uniqueSuffix()}`;
const PASSWORD = "a-strong-enough-password";
const IN_SCOPE = `${P} in scope`;

/**
 * Removing a user (Security.md §1.12): the row kept - the audit log goes on naming them - and no way in
 * left. A delegable action on the Data API's surface, under UPDATE on users and its row filter, never
 * reaching outside it, the owner, oneself or (for a non-administrator) an administrator.
 */
describe("removing a user", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let adminId: string;
  let ownerId: string;
  let delegateId: string;
  let delegateToken: string;
  let memberRole: string;

  const call = (method: string, url: string, token: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined && { payload: payload as Record<string, unknown> }) });
  const remove = (id: string, token = delegateToken) => call("POST", `/api/totalbase/table/users/${id}/remove`, token);
  const signIn = (email: string, password = PASSWORD) => app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const row = async (id: string) =>
    (await database.query<{ active: boolean; removed_at: Date | null; has_password: boolean; email: string; name: string | null }>(
      `SELECT active, removed_at, password_hash IS NOT NULL AS has_password, email, name FROM totalbase.users WHERE id = $1`, [id],
    )).rows[0];
  const count = async (sql: string, id: string) => Number((await database.query<{ n: string }>(`SELECT count(*) AS n FROM ${sql}`, [id])).rows[0]!.n);

  async function member(key: string, name = IN_SCOPE): Promise<{ id: string; email: string }> {
    const email = `${P}-${key}@example.com`;
    const user = await context.auth.users.create({ email, name, passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    await context.roleAssignments.assignRoleToUser(user.id, memberRole);
    return { id: user.id, email };
  }

  async function cleanup(): Promise<void> {
    await database.query(`DELETE FROM totalbase.users WHERE email LIKE '${P}%'`);
    await database.query(`DELETE FROM totalbase.permissions WHERE role IN (SELECT id FROM totalbase.roles WHERE name LIKE '${P}%')`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE '${P}%'`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    adminId = (await context.auth.me(adminToken)).id;
    ownerId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE owner`)).rows[0]!.id;
    expect((await call("POST", "/admin/api/catalog/refresh", adminToken)).statusCode).toBeLessThan(300);

    // The tenant's Owner of the Multitenancy guide: UPDATE on users, inside a row filter.
    memberRole = (await context.roles.create(`${P}-member`, { apiAccess: true, appAccess: false })).id;
    const delegateRole = (await context.roles.create(`${P}-delegates`, { apiAccess: true, appAccess: false })).id;
    const users = (await database.query<{ id: string }>(`SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'users'`)).rows[0]!.id;
    const fields = ["id", "name", "active", "removed_at"].map((field) => ({ field, effect: "ALLOW" as const }));
    await context.permissions.set(delegateRole, users, "READ", { effect: "ALLOW", fields, where: { name: { _eq: IN_SCOPE } } });
    await context.permissions.set(delegateRole, users, "UPDATE", { effect: "ALLOW", fields, where: { name: { _eq: IN_SCOPE } } });
    const delegate = await context.auth.users.create({ email: `${P}-delegate@example.com`, name: IN_SCOPE, passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    delegateId = delegate.id;
    await context.roleAssignments.assignRoleToUser(delegate.id, delegateRole);
    delegateToken = (await signIn(`${P}-delegate@example.com`)).json().data.token;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("keeps the row and takes away every way in - password, sessions, tokens, two-factor, pending links, roles", async () => {
    const ana = await member("ana");
    const session = (await signIn(ana.email)).json().data.token as string;
    const key = await context.usersApis.create({ userId: ana.id, name: `${P}-key`, plane: "API" });
    await context.auth.mfa.startEnrollment(ana.id, ana.email);
    await context.auth.sendPasswordReset({ id: ana.id, email: ana.email, name: IN_SCOPE }, "link");
    // Something they did, in the audit log under their name.
    expect((await call("GET", "/api/auth/account", session)).statusCode).toBe(200);
    expect((await call("PATCH", "/api/auth/account", session, { data: { name: IN_SCOPE } })).statusCode).toBe(200);
    for (const table of ["tokens", "factors", "emails_tokens", "users_roles"]) {
      expect(await count(`totalbase.${table} WHERE "user" = $1`, ana.id), table).toBeGreaterThan(0);
    }

    const res = await remove(ana.id);
    expect([res.statusCode, res.body]).toEqual([204, ""]);

    expect(await row(ana.id)).toMatchObject({ active: false, has_password: false, email: ana.email, name: IN_SCOPE });
    expect((await row(ana.id))!.removed_at).toBeInstanceOf(Date);
    for (const table of ["tokens", "factors", "challenges", "identities", "emails_tokens", "users_roles"]) {
      expect(await count(`totalbase.${table} WHERE "user" = $1`, ana.id), table).toBe(0);
    }
    expect(await count(`totalbase.sessions WHERE "user" = $1 AND revoked_at IS NULL`, ana.id)).toBe(0);

    // Nothing they held works, and nothing gets them a new credential.
    expect((await call("GET", "/api/auth/account", session)).statusCode).toBe(401);
    expect((await call("GET", "/api/totalbase/table/users", key.plainKey)).statusCode).toBe(401);
    expect((await signIn(ana.email)).statusCode).toBe(401);
    await app.inject({ method: "POST", url: "/api/auth/password/forgot", payload: { email: ana.email } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await count(`totalbase.emails_tokens WHERE "user" = $1`, ana.id)).toBe(0);

    // The audit log still says who did what: their entries resolve to the row, and the removal names them.
    const { rows: theirs } = await database.query<{ email: string }>(
      `SELECT u.email FROM totalbase.logs l JOIN totalbase.users u ON u.id = l.actor WHERE l.actor = $1 LIMIT 1`, [ana.id],
    );
    expect(theirs[0]?.email).toBe(ana.email);
    const entry = await waitFor(async () => (await database.query<{ actor: string; metadata: Record<string, unknown> }>(
      `SELECT actor, metadata FROM totalbase.logs WHERE event = 'user.remove' AND metadata ->> 'user_id' = $1`, [ana.id],
    )).rows[0]);
    expect(entry.actor).toBe(delegateId);
    expect(entry.metadata).toMatchObject({ user_id: ana.id, email: ana.email, name: IN_SCOPE, roles_removed: [memberRole], statusCode: 204 });

    // Removing again changes nothing.
    const before = (await row(ana.id))!.removed_at;
    expect((await remove(ana.id)).statusCode).toBe(204);
    expect((await row(ana.id))!.removed_at).toEqual(before);
  });

  it("never reaches a user outside the caller's row filter - they don't exist for them", async () => {
    const other = await member("other-tenant", `${P} elsewhere`);
    const res = await remove(other.id);
    expect([res.statusCode, res.json().errors[0].code]).toEqual([404, "RESOURCE_NOT_FOUND"]);
    expect(await row(other.id)).toMatchObject({ active: true, removed_at: null, has_password: true });
    expect((await signIn(other.email)).statusCode).toBe(200);
    expect((await remove("00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
    expect((await remove("not-a-uuid")).statusCode).toBe(404);
  });

  it("never removes the owner, one's own account, or - for a non-administrator - an administrator's", async () => {
    // One's own: the delegate is inside its own row filter.
    const own = await remove(delegateId);
    expect([own.statusCode, own.json().errors[0].code]).toEqual([403, "PERMISSION_DENIED"]);

    // An administrator's account inside the filter.
    const boss = await member("boss");
    await context.roleAssignments.assignRoleToUser(boss.id, await context.roles.getAdministratorsRoleId());
    const refused = await remove(boss.id);
    expect([refused.statusCode, refused.json().errors[0].code]).toEqual([403, "PERMISSION_DENIED"]);
    expect(await row(boss.id)).toMatchObject({ active: true, removed_at: null, has_password: true });

    // The owner and oneself, even for an administrator, by either route.
    for (const url of [`/api/totalbase/table/users/${ownerId}/remove`, `/admin/api/users/${ownerId}/remove`, `/admin/api/users/${adminId}/remove`]) {
      const res = await call("POST", url, adminToken);
      expect([res.statusCode, res.json().errors[0].code], url).toEqual([403, "PERMISSION_DENIED"]);
    }
    expect((await row(ownerId))!.active).toBe(true);
    expect((await call("GET", "/admin/api/auth/me", adminToken)).statusCode).toBe(200);
  });

  it("needs UPDATE on users", async () => {
    const plain = await member("plain");
    const token = (await signIn(plain.email)).json().data.token as string;
    const target = await member("target");
    expect((await remove(target.id, token)).statusCode).toBe(403);
    expect(await row(target.id)).toMatchObject({ active: true, removed_at: null });
  });

  it("is not a column to write: a removed account is never made active again but by invitation", async () => {
    const bea = await member("bea");
    // Not through the Data API - an administrator-written column, even with the field granted.
    const set = await call("PATCH", `/api/totalbase/table/users/${bea.id}`, delegateToken, { data: { removed_at: new Date().toISOString() } });
    expect(set.statusCode).toBe(403);
    expect((await row(bea.id))!.removed_at).toBeNull();

    expect((await remove(bea.id)).statusCode).toBe(204);
    const clear = await call("PATCH", `/api/totalbase/table/users/${bea.id}`, delegateToken, { data: { removed_at: null } });
    expect(clear.statusCode).toBe(403);
    // Reactivating is PostgreSQL's to refuse (users_removed_inactive) - for the delegate and for an administrator.
    for (const token of [delegateToken, adminToken]) {
      const reactivate = await call("PATCH", `/api/totalbase/table/users/${bea.id}`, token, { data: { active: true } });
      expect(reactivate.statusCode, reactivate.body).toBeGreaterThanOrEqual(400);
      expect(reactivate.statusCode, reactivate.body).toBeLessThan(500);
    }
    expect(await row(bea.id)).toMatchObject({ active: false, has_password: false });
    expect((await row(bea.id))!.removed_at).not.toBeNull();
  });

  it("an invitation brings a removed user back - and only once accepted do they sign in", async () => {
    const caro = await member("caro");
    expect((await remove(caro.id)).statusCode).toBe(204);

    // The same address can't be invited as a new account: the row is theirs (and may be another tenant's).
    const again = await call("POST", "/api/totalbase/table/users/invitations", adminToken, { data: { email: caro.email } });
    expect(again.statusCode).toBe(409);

    const invited = await call("POST", `/api/totalbase/table/users/${caro.id}/invite`, adminToken, { data: { delivery: "link" } });
    expect(invited.statusCode, invited.body).toBe(200);
    expect(await row(caro.id)).toMatchObject({ active: true, removed_at: null, has_password: false });
    expect((await signIn(caro.email)).statusCode).toBe(401);

    await context.roleAssignments.assignRoleToUser(caro.id, memberRole);
    const token = new URL(invited.json().data.actionUrl as string).searchParams.get("token")!;
    const accepted = await app.inject({ method: "POST", url: "/api/auth/invitations/accept", payload: { token, password: "a-brand-new-password" } });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await signIn(caro.email, "a-brand-new-password")).statusCode).toBe(200);
    // The old password died with the removal.
    expect((await signIn(caro.email)).statusCode).toBe(401);
  });

  it("the Admin API removes too, lists removed users as their own status, and OpenAPI shows the action to who may use it", async () => {
    const dani = await member("dani");
    const res = await call("POST", `/admin/api/users/${dani.id}/remove`, adminToken);
    expect([res.statusCode, res.body]).toEqual([204, ""]);
    expect(await row(dani.id)).toMatchObject({ active: false, has_password: false });
    expect((await call("POST", "/admin/api/users/00000000-0000-4000-8000-000000000000/remove", adminToken)).statusCode).toBe(404);

    const removed = await call("GET", `/admin/api/users?limit=10&status=REMOVED&q=${encodeURIComponent(dani.email)}`, adminToken);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().data.map((user: { id: string }) => user.id)).toEqual([dani.id]);
    expect(removed.json().data[0].removedAt).toBeTruthy();
    const inactive = await call("GET", `/admin/api/users?limit=10&status=INACTIVE&q=${encodeURIComponent(dani.email)}`, adminToken);
    expect(inactive.json().data).toEqual([]);

    const paths = (token: string) => call("GET", "/api/openapi.json", token).then((doc) => Object.keys(doc.json().paths));
    expect(await paths(delegateToken)).toContain("/api/totalbase/table/users/{id}/remove");
    const plain = await member("reader");
    expect(await paths((await signIn(plain.email)).json().data.token)).not.toContain("/api/totalbase/table/users/{id}/remove");
  });
});
