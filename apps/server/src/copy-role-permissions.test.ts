import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { adminToken as loginAdmin, setupTestApp } from "./test-support.js";

const P = "copy-permissions";

/** Security.md §5.4: a role's grants copied to another - added or replacing, in one transaction, within the target's ceiling. */
describe("POST /admin/api/roles/:role/permissions/copy", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let adminId: string;
  let roles: string;
  let assignments: string;
  let source: string;
  let target: string;
  let parent: string;

  const copy = (role: string, data: object) =>
    app.inject({ method: "POST", url: `/admin/api/roles/${role}/permissions/copy`, headers: { authorization: `Bearer ${adminToken}` }, payload: { data } });
  const grantsOf = async (role: string) =>
    (await database.query<{ resource: string; action: string; effect: string; where_clause: unknown; granted_by: string | null }>(
      `SELECT resource, action, effect, where_clause, granted_by FROM totalbase.permissions WHERE role = $1 ORDER BY resource, action`,
      [role],
    )).rows;

  async function cleanup(): Promise<void> {
    await database.query(`DELETE FROM totalbase.permissions WHERE role IN (SELECT id FROM totalbase.roles WHERE name LIKE '${P}-%')`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE '${P}-%' AND parent IS NOT NULL`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE '${P}-%'`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await cleanup();
    adminToken = await loginAdmin(context);
    adminId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email = $1`, [process.env.TOTALBASE_ADMIN_EMAIL])).rows[0]!.id;
    const { rows } = await database.query<{ id: string; name: string }>(
      `SELECT id, name FROM totalbase.resources WHERE status = 'ACTIVE' AND "schema" = 'totalbase' AND name IN ('roles', 'users_roles')`,
    );
    roles = rows.find((r) => r.name === "roles")!.id;
    assignments = rows.find((r) => r.name === "users_roles")!.id;
  });

  beforeEach(async () => {
    await cleanup();
    source = (await context.roles.create(`${P}-source`)).id;
    target = (await context.roles.create(`${P}-target`)).id;
    parent = (await context.roles.create(`${P}-parent`)).id;
    await context.permissions.set(source, roles, "READ", { effect: "ALLOW", where: { name: { _eq: "x" } }, fields: [{ field: "name", effect: "ALLOW" }] });
    await context.permissions.set(source, assignments, "READ", { effect: "ALLOW" });
    await context.permissions.set(source, assignments, "DELETE", { effect: "DENY" });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("adds the source's grants whole, keeping the target's own on a clash, recorded as the administrator's", async () => {
    await context.permissions.set(target, assignments, "READ", { effect: "DENY" });
    const response = await copy(target, { from: source });
    expect(response.statusCode).toBe(200);
    const { copied, kept, beyondCeiling } = response.json().data;
    expect(copied).toHaveLength(2);
    expect(kept).toEqual([{ resource: "totalbase.users_roles", action: "READ" }]);
    expect(beyondCeiling).toEqual([]);

    const grants = await grantsOf(target);
    expect(grants).toHaveLength(3);
    expect(grants.find((g) => g.resource === assignments && g.action === "READ")!.effect).toBe("DENY");
    const copiedRead = grants.find((g) => g.resource === roles && g.action === "READ")!;
    expect(copiedRead.where_clause).toEqual({ name: { _eq: "x" } });
    expect(copiedRead.granted_by).toBe(adminId);
  });

  it("replaces the target's grants when asked", async () => {
    await context.permissions.set(target, roles, "UPDATE", { effect: "ALLOW" });
    expect((await copy(target, { from: source, replace: true })).statusCode).toBe(200);
    expect((await grantsOf(target)).map((g) => `${g.resource}:${g.action}`).sort()).toEqual(
      [`${roles}:READ`, `${assignments}:READ`, `${assignments}:DELETE`].sort(),
    );
  });

  it("leaves out what the target's parent can't give - an action, a field - and lists it", async () => {
    await database.query(`UPDATE totalbase.roles SET parent = $2 WHERE id = $1`, [target, parent]);
    // The parent reads roles (without the name column) and nothing on users_roles.
    await context.permissions.set(parent, roles, "READ", { effect: "ALLOW", fields: [{ field: "description", effect: "ALLOW" }] });
    const { copied, beyondCeiling } = (await copy(target, { from: source })).json().data;
    expect(beyondCeiling).toEqual(expect.arrayContaining([
      { resource: "totalbase.roles", action: "READ" },
      { resource: "totalbase.users_roles", action: "READ" },
    ]));
    // A DENY never exceeds a ceiling.
    expect(copied).toEqual([{ resource: "totalbase.users_roles", action: "DELETE" }]);
  });

  it("refuses the role itself, an unknown source, and a role whose access bypasses grants", async () => {
    expect((await copy(target, { from: target })).statusCode).toBe(400);
    expect((await copy(target, { from: "00000000-0000-0000-0000-000000000000" })).statusCode).toBe(400);
    const administrators = await context.roles.getAdministratorsRoleId();
    expect((await copy(target, { from: administrators })).statusCode).toBe(403);
    expect((await copy(administrators, { from: source })).statusCode).toBe(403);
    expect(await grantsOf(target)).toEqual([]);
  });
});
