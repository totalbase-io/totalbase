import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp } from "./test-support.js";

const P = "delegation-test";
const PASSWORD = "a-strong-enough-password";

/**
 * Delegated administration (Security.md §9 to 6): a
 * non-administrator manages people through the Data API under their own
 * permissions, plus fixed rules no grant can lift - a role's creator is
 * PostgreSQL's to record, only your own roles may be renamed or deleted,
 * only your own or managed roles may be assigned, managers and
 * permissions are administrator-written, log SQL never leaves the Data
 * API, and the rail follows READ on each module's table.
 */
describe("Delegated administration", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let managerToken: string;
  let managerUserId: string;
  let managerRoleId: string;
  let managedRoleId: string;
  let foreignRoleId: string;
  let targetUserId: string;
  const resources: Record<string, string> = {};
  const previousExposure = new Map<string, string[]>();

  const call = (method: string, url: string, payload?: unknown, token = managerToken) =>
    app.inject({
      method: method as "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
    });
  const fields = (...names: string[]) => names.map((field) => ({ field, effect: "ALLOW" as const }));

  async function cleanup(): Promise<void> {
    await database.query(`DELETE FROM totalbase.users WHERE email LIKE '${P}%'`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE '${P}%'`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await cleanup();
    const { rows } = await database.query<{ id: string; name: string; exposed_methods: string[] }>(
      `SELECT id, name, exposed_methods FROM totalbase.resources WHERE "schema" = 'totalbase'
       AND name IN ('roles', 'users_roles', 'roles_managers', 'logs', 'users')`,
    );
    for (const row of rows) {
      resources[row.name] = row.id;
      previousExposure.set(row.id, row.exposed_methods);
    }
    // Whatever earlier suites left: these tests need the default exposure (and managers exposed, to reach the guardrail).
    for (const [name, methods] of [
      ["roles", ["GET", "POST", "PATCH", "DELETE"]],
      ["users_roles", ["GET", "POST", "DELETE"]],
      ["roles_managers", ["GET", "POST", "DELETE"]],
      ["logs", ["GET"]],
    ] as const) {
      await database.query(`UPDATE totalbase.resources SET exposed_methods = $2 WHERE id = $1`, [resources[name], methods]);
    }

    managerRoleId = (await context.roles.create(`${P}-managers`, { appAccess: true })).id;
    managedRoleId = (await context.roles.create(`${P}-sales`, { appAccess: true })).id;
    foreignRoleId = (await context.roles.create(`${P}-finance`, { appAccess: true })).id;
    await database.query(`INSERT INTO totalbase.roles_managers (role, manager) VALUES ($1, $2)`, [managedRoleId, managerRoleId]);

    // Deliberately generous grants: the fixed rules, not these, must hold the line.
    await context.permissions.set(managerRoleId, resources.roles!, "READ", { effect: "ALLOW", fields: fields("id", "name", "created_by") });
    await context.permissions.set(managerRoleId, resources.roles!, "CREATE", { effect: "ALLOW", fields: fields("name", "created_by") });
    await context.permissions.set(managerRoleId, resources.roles!, "UPDATE", { effect: "ALLOW", fields: fields("id", "name", "created_by") });
    await context.permissions.set(managerRoleId, resources.roles!, "DELETE", { effect: "ALLOW" });
    await context.permissions.set(managerRoleId, resources.users_roles!, "READ", { effect: "ALLOW", fields: fields("id", "user", "role") });
    await context.permissions.set(managerRoleId, resources.users_roles!, "CREATE", { effect: "ALLOW", fields: fields("user", "role") });
    await context.permissions.set(managerRoleId, resources.users_roles!, "DELETE", { effect: "ALLOW" });
    await context.permissions.set(managerRoleId, resources.roles_managers!, "CREATE", { effect: "ALLOW", fields: fields("role", "manager") });
    await context.permissions.set(managerRoleId, resources.logs!, "READ", {
      effect: "ALLOW",
      where: { principal: { _eq: "$USER.id" } },
      fields: fields("id", "action", "principal", "sql_text", "sql_params"),
    });

    const manager = await context.auth.users.create({ email: `${P}-manager@example.com`, name: "Manager", passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    managerUserId = manager.id;
    await context.roleAssignments.assignRoleToUser(manager.id, managerRoleId);
    managerToken = (await context.auth.login({ email: `${P}-manager@example.com`, password: PASSWORD })).token;
    targetUserId = (await context.auth.users.create({ email: `${P}-target@example.com`, name: "Target" })).id;
  });

  afterAll(async () => {
    for (const [id, methods] of previousExposure) await database.query(`UPDATE totalbase.resources SET exposed_methods = $2 WHERE id = $1`, [id, methods]);
    await database.query(`DELETE FROM totalbase.permissions WHERE role IN (SELECT id FROM totalbase.roles WHERE name LIKE '${P}%')`);
    await cleanup();
    await app.close();
  });

  it("exposes the delegable tables by default when TotalBase registers them", async () => {
    const { rows } = await database.query<{ name: string; exposed_methods: string[] }>(
      `SELECT name, exposed_methods FROM totalbase.resources WHERE "schema" = 'totalbase' AND name IN ('users', 'templates', 'folders')`,
    );
    for (const row of rows) expect(row.exposed_methods, row.name).toEqual(["GET", "POST", "PATCH", "DELETE"]);
  });

  it("records a role's creator itself - the payload can't set it, the Admin API leaves it null", async () => {
    const created = await call("POST", "/api/totalbase/table/roles", { data: { name: `${P}-created` } });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().data.created_by).toBe(managerUserId);

    const forged = await call("POST", "/api/totalbase/table/roles", { data: { name: `${P}-forged`, created_by: targetUserId } });
    expect(forged.statusCode).toBe(403);

    const viaAdmin = await context.roles.create(`${P}-admin-made`, { appAccess: true });
    const { rows } = await database.query<{ created_by: string | null }>(`SELECT created_by FROM totalbase.roles WHERE id = $1`, [viaAdmin.id]);
    expect(rows[0]!.created_by).toBeNull();
  });

  it("lets a non-administrator rename and delete only the roles they created", async () => {
    const own = (await call("POST", "/api/totalbase/table/roles", { data: { name: `${P}-own` } })).json().data;
    const renamed = await call("PATCH", `/api/totalbase/table/roles/${own.id}`, { data: { name: `${P}-own-renamed` } });
    expect(renamed.statusCode, renamed.body).toBe(200);

    const foreign = await call("PATCH", `/api/totalbase/table/roles/${foreignRoleId}`, { data: { name: `${P}-hijacked` } });
    expect(foreign.statusCode).toBe(403);
    const { rows } = await database.query<{ name: string }>(`SELECT name FROM totalbase.roles WHERE id = $1`, [foreignRoleId]);
    expect(rows[0]!.name).toBe(`${P}-finance`);

    expect((await call("DELETE", `/api/totalbase/table/roles/${foreignRoleId}`)).statusCode).toBe(403);
    expect((await call("DELETE", `/api/totalbase/table/roles/${own.id}`)).statusCode).toBe(200);
  });

  it("assigns only a role you created or one your roles manage - and removes likewise", async () => {
    const own = (await call("POST", "/api/totalbase/table/roles", { data: { name: `${P}-own-assignable` } })).json().data;
    for (const role of [own.id, managedRoleId]) {
      const res = await call("POST", "/api/totalbase/table/users_roles", { data: { user: targetUserId, role } });
      expect(res.statusCode, res.body).toBe(201);
    }
    const foreign = await call("POST", "/api/totalbase/table/users_roles", { data: { user: targetUserId, role: foreignRoleId } });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().errors[0].code).toBe("PERMISSION_DENIED");

    await context.roleAssignments.assignRoleToUser(targetUserId, foreignRoleId);
    const removeForeign = await call("DELETE", `/api/totalbase/table/users_roles?where[role][_eq]=${foreignRoleId}&where[user][_eq]=${targetUserId}`);
    expect(removeForeign.statusCode).toBe(403);
    const removeManaged = await call("DELETE", `/api/totalbase/table/users_roles?where[role][_eq]=${managedRoleId}&where[user][_eq]=${targetUserId}`);
    expect(removeManaged.statusCode, removeManaged.body).toBe(200);
  });

  it("keeps role managers administrator-written", async () => {
    const res = await call("POST", "/api/totalbase/table/roles_managers", { data: { role: foreignRoleId, manager: managerRoleId } });
    expect(res.statusCode).toBe(403);
    const { rows } = await database.query(`SELECT 1 FROM totalbase.roles_managers WHERE role = $1`, [foreignRoleId]);
    expect(rows).toHaveLength(0);
  });

  it("lets an administrator set a role's managers - whose members may then assign it", async () => {
    const env = loadServerEnv();
    const admin = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    const put = await call("PUT", `/admin/api/roles/${foreignRoleId}/managers`, { data: { roleIds: [managerRoleId, foreignRoleId] } }, admin);
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().data).toEqual([managerRoleId]); // a role never manages itself
    const read = await call("GET", `/api/totalbase/table/roles_managers?where[role][_eq]=${foreignRoleId}&fields=manager`, undefined, admin);
    expect(read.json().data).toEqual([{ manager: managerRoleId }]);
    // Not through the portal for a non-administrator.
    expect((await call("PUT", `/admin/api/roles/${foreignRoleId}/managers`, { data: { roleIds: [] } })).statusCode).toBe(403);

    const member = (await context.auth.users.create({ email: `${P}-managed-member@example.com`, name: "Member" })).id;
    const assign = await call("POST", "/api/totalbase/table/users_roles", { data: { user: member, role: foreignRoleId } });
    expect(assign.statusCode, assign.body).toBe(201);

    expect((await call("PUT", `/admin/api/roles/${foreignRoleId}/managers`, { data: { roleIds: [] } }, admin)).json().data).toEqual([]);
    const administrators = await context.roles.getAdministratorsRoleId();
    expect((await call("PUT", `/admin/api/roles/${administrators}/managers`, { data: { roleIds: [managerRoleId] } }, admin)).statusCode).toBe(403);
  });

  it("never lets log SQL out of the Data API, and a row filter keeps a user to their own entries", async () => {
    // A protected column is left out, whatever the grant says - the same as a password hash.
    const withSql = await call("GET", "/api/totalbase/table/logs?fields=id,sql_text,sql_params&limit=50");
    expect(withSql.statusCode).toBeLessThan(500);
    if (withSql.statusCode === 200) {
      for (const row of withSql.json().data as Record<string, unknown>[]) {
        expect(row).not.toHaveProperty("sql_text");
        expect(row).not.toHaveProperty("sql_params");
      }
    }
    expect(withSql.body).not.toContain("SELECT ");
    const own = await call("GET", "/api/totalbase/table/logs?fields=id,principal,action&limit=50");
    expect(own.statusCode, own.body).toBe(200);
    for (const row of own.json().data as Array<{ principal: string }>) expect(row.principal).toBe(managerUserId);
  });

  it("shows in the rail the modules the user's roles may read", async () => {
    const me = await call("GET", "/admin/api/auth/me");
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().data.modules.sort()).toEqual(["logs", "roles"]);
    // Role assignments ride along with Roles, as a companion - never a rail module.
    expect(me.json().data.moduleActions.assignments.sort()).toEqual(["CREATE", "DELETE", "READ"]);
    // ...and the roles the guardrail lets them assign: managed or their own, not another's.
    expect(me.json().data.assignableRoles).toContain(managedRoleId);
    expect(me.json().data.assignableRoles).not.toContain(foreignRoleId);
  });
});
