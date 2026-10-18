import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EffectivePermissionService } from "./effective-permission-service.js";
import { PermissionsService } from "./permissions-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));

describe("PermissionsService (integration)", () => {
  let database: Database;
  let permissions: PermissionsService;
  let effectivePermissions: EffectivePermissionService;
  let roleId: string;
  let resourceId: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    permissions = new PermissionsService(database);
    effectivePermissions = new EffectivePermissionService(database);

    const { rows: roleRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.roles (name) VALUES ('permissions-pkg-test-role') RETURNING id`,
    );
    roleId = roleRows[0]!.id;

    const { rows: resourceRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES (900101, 'public', 'permissions_pkg_test_resource', 'TABLE', 'ACTIVE')
       RETURNING id`,
    );
    resourceId = resourceRows[0]!.id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await database.close();
  });

  it("upserts a permission with a row filter and field grants, and it takes effect immediately", async () => {
    const permission = await permissions.set(roleId, resourceId, "READ", {
      effect: "ALLOW",
      where: { field: "active", operator: "_eq", value: true },
      fields: [{ field: "name", effect: "ALLOW" }],
    });
    expect(permission.effect).toBe("ALLOW");
    expect(permission.fields).toEqual([{ field: "name", effect: "ALLOW" }]);

    const effective = await effectivePermissions.resolve([roleId], resourceId, "READ");
    expect(effective.action).toBe("ALLOW");
    expect(effective.fieldDecision("name")).toBe("ALLOW");
    expect(effective.fieldDecision("secret")).toBe("UNDEFINED");
    expect(effective.rowFilterSources).toEqual([
      { effect: "ALLOW", whereClause: { field: "active", operator: "_eq", value: true } },
    ]);
  });

  it("upserting the same (role, resource, action) again replaces the grant rather than duplicating it", async () => {
    await permissions.set(roleId, resourceId, "READ", { effect: "ALLOW", fields: [{ field: "name", effect: "ALLOW" }] });
    await permissions.set(roleId, resourceId, "READ", { effect: "ALLOW", fields: [{ field: "price", effect: "ALLOW" }] });

    const permission = await permissions.get(roleId, resourceId, "READ");
    expect(permission?.fields).toEqual([{ field: "price", effect: "ALLOW" }]);
  });

  it("deletes a permission, reverting the effective decision to UNDEFINED", async () => {
    await permissions.set(roleId, resourceId, "DELETE", { effect: "ALLOW" });
    expect((await effectivePermissions.resolve([roleId], resourceId, "DELETE")).action).toBe("ALLOW");

    await permissions.delete(roleId, resourceId, "DELETE");
    expect(await permissions.get(roleId, resourceId, "DELETE")).toBeNull();
    expect((await effectivePermissions.resolve([roleId], resourceId, "DELETE")).action).toBe("UNDEFINED");
  });

  it("lists every permission granted to a role", async () => {
    await permissions.set(roleId, resourceId, "READ", { effect: "ALLOW" });
    await permissions.set(roleId, resourceId, "CREATE", { effect: "DENY" });
    const list = await permissions.listForRole(roleId);
    const actions = list.map((p) => p.action).sort();
    expect(actions).toContain("READ");
    expect(actions).toContain("CREATE");
  });
});
