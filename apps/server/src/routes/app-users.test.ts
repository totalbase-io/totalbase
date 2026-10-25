import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { setupTestApp } from "../test-support.js";

const P = "app-users-test";
const PASSWORD = "a-strong-enough-password";

/**
 * Delegated user administration (Security.md §9.3 and
 * 6.8): inviting through /app/api/users, authorized like a Data API write
 * and limited to roles the caller may assign; and an administrator's
 * account, which no delegated user may change, delete or send a link to -
 * on any write path, enforced by PostgreSQL.
 */
describe("App users (/app/api/users) and administrator accounts", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let delegateToken: string;
  let noneToken: string;
  let ownRoleId: string;
  let foreignRoleId: string;
  let adminUserId: string;
  let plainUserId: string;
  let hadSmtpHost: boolean;
  let previousSmtpHost: string;

  const call = (method: string, url: string, token: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined && { payload: payload as Record<string, unknown> }) });
  const fields = (...names: string[]) => names.map((field) => ({ field, effect: "ALLOW" as const }));

  async function login(email: string, roleId: string): Promise<{ token: string; id: string }> {
    const user = await context.auth.users.create({ email, name: "x", passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    await context.roleAssignments.assignRoleToUser(user.id, roleId);
    return { token: (await context.auth.login({ email, password: PASSWORD })).token, id: user.id };
  }

  async function cleanup(): Promise<void> {
    await database.query(`DELETE FROM totalbase.users WHERE email LIKE '${P}%'`);
    await database.query(`DELETE FROM totalbase.permissions WHERE role IN (SELECT id FROM totalbase.roles WHERE name LIKE '${P}%')`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE '${P}%'`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await cleanup();
    // Deterministic: no mail server, so an email "fails" the same way everywhere.
    hadSmtpHost = await context.settings.isOverridden("smtp.host");
    previousSmtpHost = await context.settings.get("smtp.host");
    await context.settings.set("smtp.host", "");

    const resource = async (name: string) =>
      (await database.query<{ id: string }>(`SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = $1`, [name])).rows[0]!.id;
    const users = await resource("users");
    const roles = await resource("roles");
    const assignments = await resource("users_roles");
    const delegateRole = (await context.roles.create(`${P}-delegates`, { appAccess: true })).id;
    const noneRole = (await context.roles.create(`${P}-none`, { appAccess: true })).id;
    foreignRoleId = (await context.roles.create(`${P}-foreign`, { appAccess: true })).id;
    // Deliberately generous: every user, every column - the fixed rules must hold the line.
    await context.permissions.set(delegateRole, users, "CREATE", { effect: "ALLOW", fields: fields("email", "name") });
    await context.permissions.set(delegateRole, users, "UPDATE", { effect: "ALLOW", fields: fields("email", "name", "active") });
    await context.permissions.set(delegateRole, users, "DELETE", { effect: "ALLOW" });
    await context.permissions.set(delegateRole, assignments, "CREATE", { effect: "ALLOW", fields: fields("user", "role") });
    await context.permissions.set(delegateRole, roles, "CREATE", { effect: "ALLOW", fields: fields("name") });
    await context.permissions.set(delegateRole, roles, "READ", { effect: "ALLOW", fields: fields("id", "name") });

    const delegate = await login(`${P}-delegate@example.com`, delegateRole);
    delegateToken = delegate.token;
    noneToken = (await login(`${P}-none@example.com`, noneRole)).token;
    const own = await call("POST", "/api/totalbase/table/roles", delegateToken, { data: { name: `${P}-own` } });
    expect(own.statusCode, own.body).toBe(201);
    ownRoleId = own.json().data.id;

    const administrators = await context.roles.getAdministratorsRoleId();
    adminUserId = (await context.auth.users.create({ email: `${P}-admin@example.com`, name: "Admin" })).id;
    await context.roleAssignments.assignRoleToUser(adminUserId, administrators);
    plainUserId = (await context.auth.users.create({ email: `${P}-plain@example.com`, name: "Plain" })).id;
  });

  afterAll(async () => {
    if (hadSmtpHost) await context.settings.set("smtp.host", previousSmtpHost);
    else await context.settings.reset("smtp.host");
    await cleanup();
    await app.close();
  });

  it("refuses an invitation without CREATE on users", async () => {
    expect((await call("POST", "/app/api/users/invitations", noneToken, { data: { email: `${P}-nope@example.com` } })).statusCode).toBe(403);
  });

  it("invites with a role the caller may assign - the account exists even when the email can't go out", async () => {
    const res = await call("POST", "/app/api/users/invitations", delegateToken, { data: { email: `${P}-new@example.com`, name: "New", roles: [ownRoleId] } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().meta).toMatchObject({ delivered: false, error: { code: "SMTP_NOT_CONFIGURED" } });
    expect(await context.roleAssignments.listRolesForUser(res.json().data.id)).toEqual([ownRoleId]);
  });

  it("refuses a role the caller may not assign, and a copied link - creating nothing", async () => {
    const foreign = await call("POST", "/app/api/users/invitations", delegateToken, { data: { email: `${P}-foreign@example.com`, roles: [foreignRoleId] } });
    expect(foreign.statusCode).toBe(403);
    const administrators = await context.roles.getAdministratorsRoleId();
    const admin = await call("POST", "/app/api/users/invitations", delegateToken, { data: { email: `${P}-escalate@example.com`, roles: [administrators] } });
    expect(admin.statusCode).toBe(403);
    const link = await call("POST", "/app/api/users/invitations", delegateToken, { data: { email: `${P}-link@example.com`, delivery: "link" } });
    expect(link.statusCode).toBe(403);
    const { rows } = await database.query(`SELECT 1 FROM totalbase.users WHERE email IN ($1, $2, $3)`, [`${P}-foreign@example.com`, `${P}-escalate@example.com`, `${P}-link@example.com`]);
    expect(rows).toHaveLength(0);
  });

  it("sends links to a user in scope, never to an administrator", async () => {
    const plain = await call("POST", `/app/api/users/${plainUserId}/reset-password`, delegateToken);
    expect(plain.json().errors?.[0]?.code).toBe("SMTP_NOT_CONFIGURED"); // authorized - only the mail server is missing
    for (const action of ["invite", "reset-password"]) {
      expect((await call("POST", `/app/api/users/${adminUserId}/${action}`, delegateToken)).statusCode).toBe(403);
    }
  });

  it("answers 404 deleting a user that doesn't exist, even under a grant with no row filter", async () => {
    const res = await call("DELETE", "/app/api/users/00000000-0000-4000-8000-000000000000", delegateToken);
    expect([res.statusCode, res.json().errors[0].code]).toEqual([404, "RESOURCE_NOT_FOUND"]);
  });

  it("never lets a delegated user change or delete an administrator's account through the Data API (regression: email then reset)", async () => {
    // An email is never changed through the Data API, by anyone (Security.md §10.2) - and an administrator's
    // account, nothing of it, by a non-administrator (the trigger's own refusal).
    const hijack = await call("PATCH", `/api/totalbase/table/users/${adminUserId}`, delegateToken, { data: { email: `${P}-mine@example.com` } });
    expect(hijack.statusCode).toBe(403);
    const renameAdmin = await call("PATCH", `/api/totalbase/table/users/${adminUserId}`, delegateToken, { data: { name: "Not the admin" } });
    expect(renameAdmin.statusCode).toBe(403);
    expect(renameAdmin.json().errors[0].message).toContain("administrator");
    const remove = await call("DELETE", `/api/totalbase/table/users/${adminUserId}`, delegateToken);
    expect(remove.statusCode).toBe(403);
    const { rows } = await database.query<{ email: string }>(`SELECT email FROM totalbase.users WHERE id = $1`, [adminUserId]);
    expect(rows[0]?.email).toBe(`${P}-admin@example.com`);

    // An ordinary account in scope stays theirs to edit.
    const rename = await call("PATCH", `/api/totalbase/table/users/${plainUserId}`, delegateToken, { data: { name: "Renamed" } });
    expect(rename.statusCode, rename.body).toBe(200);
  });
});
