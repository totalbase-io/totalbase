import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EffectivePermissionService } from "./effective-permission-service.js";
import { PermissionsService } from "./permissions-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));

describe("EffectivePermissionService.resolveBulk (integration)", () => {
  let database: Database;
  let permissions: PermissionsService;
  let effectivePermissions: EffectivePermissionService;
  let roleAId: string;
  let roleBId: string;
  let resourceOneId: string;
  let resourceTwoId: string;
  let resourceOrderedId: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    permissions = new PermissionsService(database);
    effectivePermissions = new EffectivePermissionService(database);

    const { rows: roleRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.roles (name) VALUES ('bulk-test-role-a'), ('bulk-test-role-b') RETURNING id`,
    );
    roleAId = roleRows[0]!.id;
    roleBId = roleRows[1]!.id;

    const { rows: resourceRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES (900201, 'public', 'bulk_test_resource_one', 'TABLE', 'ACTIVE'),
              (900202, 'public', 'bulk_test_resource_two', 'TABLE', 'ACTIVE')
       RETURNING id`,
    );
    resourceOneId = resourceRows[0]!.id;
    resourceTwoId = resourceRows[1]!.id;

    // A real table (unlike resourceOne/Two's fake oids) so fields can be
    // sorted by actual pg_attribute.attnum - declared out of alphabetical
    // order on purpose to tell the two apart.
    await database.query(`DROP TABLE IF EXISTS public.bulk_test_column_order`);
    await database.query(`
      CREATE TABLE public.bulk_test_column_order (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        zebra text,
        apple text,
        middle text
      )
    `);
    const { rows: orderedResourceRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES (to_regclass('public.bulk_test_column_order')::oid, 'public', 'bulk_test_column_order', 'TABLE', 'ACTIVE')
       RETURNING id`,
    );
    resourceOrderedId = orderedResourceRows[0]!.id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.roles WHERE id = ANY($1)`, [[roleAId, roleBId]]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1)`, [[resourceOneId, resourceTwoId, resourceOrderedId]]);
    await database.query(`DROP TABLE IF EXISTS public.bulk_test_column_order`);
    await database.close();
  });

  it("returns UNDEFINED with no contributing roles for a resource with no grants", async () => {
    const result = await effectivePermissions.resolveBulk([roleAId], [resourceOneId]);
    const entry = result.get(resourceOneId)!;
    expect(entry.READ).toEqual({ decision: "UNDEFINED", roles: [], ceiling: [], fields: undefined });
    expect(entry.CREATE.decision).toBe("UNDEFINED");
  });

  it("reports ALLOW and which role granted it", async () => {
    await permissions.set(roleAId, resourceOneId, "READ", { effect: "ALLOW" });

    const result = await effectivePermissions.resolveBulk([roleAId], [resourceOneId]);
    expect(result.get(resourceOneId)!.READ).toEqual({ decision: "ALLOW", roles: [roleAId], ceiling: [], fields: [] });
  });

  it("DENY from one role wins over ALLOW from another, and both roles are reported", async () => {
    await permissions.set(roleAId, resourceOneId, "UPDATE", { effect: "ALLOW" });
    await permissions.set(roleBId, resourceOneId, "UPDATE", { effect: "DENY" });

    const result = await effectivePermissions.resolveBulk([roleAId, roleBId], [resourceOneId]);
    const entry = result.get(resourceOneId)!.UPDATE;
    expect(entry.decision).toBe("DENY");
    expect(new Set(entry.roles)).toEqual(new Set([roleAId, roleBId]));
  });

  it("aggregates independently across multiple resources in one call", async () => {
    await permissions.set(roleAId, resourceTwoId, "EXECUTE", { effect: "ALLOW" });

    const result = await effectivePermissions.resolveBulk([roleAId, roleBId], [resourceOneId, resourceTwoId]);
    expect(result.get(resourceOneId)!.READ.decision).toBe("ALLOW");
    expect(result.get(resourceTwoId)!.EXECUTE).toEqual({ decision: "ALLOW", roles: [roleAId], ceiling: [], fields: [] });
    expect(result.get(resourceTwoId)!.READ.decision).toBe("UNDEFINED");
  });

  it("returns UNDEFINED everywhere when given no roles, without querying", async () => {
    const result = await effectivePermissions.resolveBulk([], [resourceOneId, resourceTwoId]);
    expect(result.get(resourceOneId)!.READ.decision).toBe("UNDEFINED");
    expect(result.get(resourceTwoId)!.EXECUTE.decision).toBe("UNDEFINED");
  });

  it("matches per-resource resolve() output for the same (roles, resource, action)", async () => {
    const bulk = await effectivePermissions.resolveBulk([roleAId], [resourceOneId]);
    const single = await effectivePermissions.resolve([roleAId], resourceOneId, "READ");
    expect(bulk.get(resourceOneId)!.READ.decision).toBe(single.action);
  });

  it("reports the effectively granted fields (informational) alongside an ALLOW decision", async () => {
    await permissions.set(roleAId, resourceOneId, "CREATE", {
      effect: "ALLOW",
      fields: [{ field: "name", effect: "ALLOW" }, { field: "email", effect: "ALLOW" }],
    });

    const result = await effectivePermissions.resolveBulk([roleAId], [resourceOneId]);
    const entry = result.get(resourceOneId)!.CREATE;
    expect(entry.decision).toBe("ALLOW");
    expect(entry.fields).toEqual(["email", "name"]);
  });

  it("omits fields for a non-ALLOW decision", async () => {
    const result = await effectivePermissions.resolveBulk([roleAId], [resourceOneId]);
    expect(result.get(resourceOneId)!.DELETE.fields).toBeUndefined();
  });

  it("excludes a field DENYed by one role even though the action itself is ALLOWed by another", async () => {
    await permissions.set(roleAId, resourceOneId, "UPDATE", {
      effect: "ALLOW",
      fields: [{ field: "name", effect: "ALLOW" }, { field: "salary", effect: "ALLOW" }],
    });
    await permissions.set(roleBId, resourceOneId, "UPDATE", {
      effect: "ALLOW",
      fields: [{ field: "salary", effect: "DENY" }],
    });

    const result = await effectivePermissions.resolveBulk([roleAId, roleBId], [resourceOneId]);
    const entry = result.get(resourceOneId)!.UPDATE;
    expect(entry.decision).toBe("ALLOW");
    expect(entry.fields).toEqual(["name"]);
  });

  it("orders fields by physical column order (pg_attribute.attnum), not alphabetically", async () => {
    await permissions.set(roleAId, resourceOrderedId, "READ", {
      effect: "ALLOW",
      // Granted out of both alphabetical and declaration order on purpose.
      fields: [{ field: "middle", effect: "ALLOW" }, { field: "apple", effect: "ALLOW" }, { field: "zebra", effect: "ALLOW" }],
    });

    const result = await effectivePermissions.resolveBulk([roleAId], [resourceOrderedId]);
    // Table was declared id, zebra, apple, middle - id wasn't granted.
    expect(result.get(resourceOrderedId)!.READ.fields).toEqual(["zebra", "apple", "middle"]);
  });

  it("reports the row filters of an ALLOW limited to some rows, per role - none once any grant is unfiltered", async () => {
    const own = { owner: { _eq: "$USER.id" } };
    const open = { status: { _eq: "OPEN" } };
    await permissions.set(roleAId, resourceTwoId, "DELETE", { effect: "ALLOW", where: own });
    let result = await effectivePermissions.resolveBulk([roleAId], [resourceTwoId]);
    expect(result.get(resourceTwoId)!.DELETE.rowFilters).toEqual([{ role: roleAId, where: own }]);

    // Two filtered grants: both reported (OR-combined by the Data API).
    await permissions.set(roleBId, resourceTwoId, "DELETE", { effect: "ALLOW", where: open });
    result = await effectivePermissions.resolveBulk([roleAId, roleBId], [resourceTwoId]);
    expect(new Set(result.get(resourceTwoId)!.DELETE.rowFilters!.map((f) => f.role))).toEqual(new Set([roleAId, roleBId]));

    // One unfiltered grant makes the OR unrestricted - every row.
    await permissions.set(roleBId, resourceTwoId, "DELETE", { effect: "ALLOW", where: null });
    result = await effectivePermissions.resolveBulk([roleAId, roleBId], [resourceTwoId]);
    expect(result.get(resourceTwoId)!.DELETE.rowFilters).toBeUndefined();
  });

  it("reports the payload checks of an ALLOW, with the role each comes from", async () => {
    const rule = { price: { _gte: 0 } };
    await permissions.set(roleAId, resourceTwoId, "CREATE", { effect: "ALLOW", payloadChecks: [{ rule, label: "No negative prices" }] });
    const result = await effectivePermissions.resolveBulk([roleAId], [resourceTwoId]);
    expect(result.get(resourceTwoId)!.CREATE.payloadChecks).toEqual([{ role: roleAId, label: "No negative prices", rule }]);
    expect(result.get(resourceTwoId)!.CREATE.rowFilters).toBeUndefined();
  });

  it("falls back to alphabetical order for a resource with no real backing table (e.g. a stale/fake oid)", async () => {
    await permissions.set(roleAId, resourceOneId, "CREATE", {
      effect: "ALLOW",
      fields: [{ field: "zeta", effect: "ALLOW" }, { field: "alpha", effect: "ALLOW" }],
    });

    const result = await effectivePermissions.resolveBulk([roleAId], [resourceOneId]);
    expect(result.get(resourceOneId)!.CREATE.fields).toEqual(["alpha", "zeta"]);
  });
});

describe("EffectivePermissionService admin-access bypass", () => {
  let database: Database;
  let effectivePermissions: EffectivePermissionService;
  let adminRoleId: string;
  let plainRoleId: string;
  let resourceId: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    effectivePermissions = new EffectivePermissionService(database);

    // Not named "Administrators" - the bypass keys off admin_access
    //, not that one hardcoded name. admin_access
    // requires reserved (CHECK).
    const { rows: roleRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.roles (name, admin_access, app_access, reserved)
       VALUES ('is-admin-test-role', true, true, true), ('is-admin-test-plain-role', false, true, false) RETURNING id`,
    );
    adminRoleId = roleRows[0]!.id;
    plainRoleId = roleRows[1]!.id;

    const { rows: resourceRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES (900301, 'public', 'is_admin_test_resource', 'TABLE', 'ACTIVE')
       RETURNING id`,
    );
    resourceId = resourceRows[0]!.id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.roles WHERE id IN ($1, $2)`, [adminRoleId, plainRoleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await database.close();
  });

  it("grants full access to a differently-named ADMIN role, with no totalbase.permissions row at all", async () => {
    const result = await effectivePermissions.resolve([adminRoleId], resourceId, "DELETE");
    expect(result.action).toBe("ALLOW");
    expect(result.fieldDecision("anything")).toBe("ALLOW");
  });

  it("does not bypass for a role without admin access", async () => {
    const result = await effectivePermissions.resolve([plainRoleId], resourceId, "READ");
    expect(result.action).toBe("UNDEFINED");
  });
});

/** Security.md §6.11, §9.5: a role's parent is its ceiling - resolved live, per role, before roles combine. */
describe("EffectivePermissionService - the role ceiling (integration)", () => {
  let database: Database;
  let permissions: PermissionsService;
  let effectivePermissions: EffectivePermissionService;
  let siteId: string;
  let operatorId: string;
  let otherId: string;
  let resourceId: string;
  const allow = (...names: string[]) => names.map((field) => ({ field, effect: "ALLOW" as const }));
  const SITE = { site: { _eq: "$USER.site" } };
  const NIGHT = { night: { _eq: true } };

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    permissions = new PermissionsService(database);
    effectivePermissions = new EffectivePermissionService(database);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE 'ceiling-test-%' AND parent IS NOT NULL`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE 'ceiling-test-%'`);
    siteId = (await database.query<{ id: string }>(`INSERT INTO totalbase.roles (name) VALUES ('ceiling-test-site') RETURNING id`)).rows[0]!.id;
    operatorId = (await database.query<{ id: string }>(`INSERT INTO totalbase.roles (name, parent) VALUES ('ceiling-test-operator', $1) RETURNING id`, [siteId])).rows[0]!.id;
    otherId = (await database.query<{ id: string }>(`INSERT INTO totalbase.roles (name) VALUES ('ceiling-test-other') RETURNING id`)).rows[0]!.id;
    await database.query(`DELETE FROM totalbase.resources WHERE postgres_oid = 900301`);
    resourceId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status) VALUES (900301, 'public', 'ceiling_test_controls', 'TABLE', 'ACTIVE') RETURNING id`,
    )).rows[0]!.id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [operatorId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id IN ($1, $2)`, [siteId, otherId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await database.close();
  });

  it("bounds a child by its parent: the action, the fields, the row filter (AND) and the payload checks", async () => {
    await permissions.set(siteId, resourceId, "READ", { effect: "ALLOW", where: SITE, fields: allow("id", "site", "name"), payloadChecks: [{ rule: { name: { _nnull: true } }, label: "site rule" }] });
    await permissions.set(operatorId, resourceId, "READ", { effect: "ALLOW", where: NIGHT, fields: allow("id", "name", "notes"), payloadChecks: [{ rule: { id: { _nnull: true } }, label: "own rule" }] });
    const read = await effectivePermissions.resolve([operatorId], resourceId, "READ");
    expect(read.action).toBe("ALLOW");
    expect(read.fieldDecision("name")).toBe("ALLOW");
    expect(read.fieldDecision("notes")).toBe("UNDEFINED"); // the parent doesn't allow it
    expect(read.rowFilterSources).toEqual([{ effect: "ALLOW", whereClause: { _and: [NIGHT, SITE] } }]);
    expect(read.payloadCheckSources!.map((c) => c.label).sort()).toEqual(["own rule", "site rule"]);

    const bulk = (await effectivePermissions.resolveBulk([operatorId], [resourceId])).get(resourceId)!.READ;
    expect(bulk).toMatchObject({ decision: "ALLOW", roles: [operatorId], ceiling: [siteId], fields: ["id", "name"] });
    expect(bulk.rowFilters).toEqual([{ role: operatorId, where: { _and: [NIGHT, SITE] } }]);
  });

  it("allows nothing the parent doesn't: an action it lacks, then one revoked - live", async () => {
    await permissions.set(operatorId, resourceId, "UPDATE", { effect: "ALLOW", fields: allow("name") });
    expect((await effectivePermissions.resolve([operatorId], resourceId, "UPDATE")).action).toBe("UNDEFINED");
    await permissions.set(siteId, resourceId, "UPDATE", { effect: "ALLOW", fields: allow("name") });
    expect((await effectivePermissions.resolve([operatorId], resourceId, "UPDATE")).action).toBe("ALLOW");
    await permissions.delete(siteId, resourceId, "UPDATE");
    expect((await effectivePermissions.resolve([operatorId], resourceId, "UPDATE")).action).toBe("UNDEFINED");
  });

  it("an inactive parent grants its children nothing", async () => {
    await database.query(`UPDATE totalbase.roles SET active = false WHERE id = $1`, [siteId]);
    try {
      expect((await effectivePermissions.resolve([operatorId], resourceId, "READ")).action).toBe("UNDEFINED");
    } finally {
      await database.query(`UPDATE totalbase.roles SET active = true WHERE id = $1`, [siteId]);
    }
  });

  it("a parent's DENY bounds its branch only - another role of the caller still allows", async () => {
    await permissions.set(otherId, resourceId, "DELETE", { effect: "ALLOW" });
    await permissions.set(operatorId, resourceId, "DELETE", { effect: "ALLOW" });
    await permissions.set(siteId, resourceId, "DELETE", { effect: "DENY" });
    expect((await effectivePermissions.resolve([operatorId], resourceId, "DELETE")).action).toBe("UNDEFINED");
    const both = await effectivePermissions.resolve([operatorId, otherId], resourceId, "DELETE");
    expect(both.action).toBe("ALLOW");
    expect(both.rowFilterSources).toEqual([{ effect: "ALLOW", whereClause: null }]);
  });

  it("keeps the tree's shape: no cycle, at most four levels, no administrative role in it", async () => {
    const insert = (name: string, parent: string) =>
      database.query<{ id: string }>(`INSERT INTO totalbase.roles (name, parent) VALUES ($1, $2) RETURNING id`, [name, parent]);
    await expect(database.query(`UPDATE totalbase.roles SET parent = $1 WHERE id = $2`, [operatorId, siteId])).rejects.toThrow(/its own descendants/);
    const third = (await insert("ceiling-test-third", operatorId)).rows[0]!.id;
    const fourth = (await insert("ceiling-test-fourth", third)).rows[0]!.id;
    try {
      await expect(insert("ceiling-test-fifth", fourth)).rejects.toThrow(/four levels/);
      await expect(database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [third])).rejects.toThrow();
    } finally {
      await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [fourth]);
      await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [third]);
    }
    const administrators = (await database.query<{ id: string }>(`SELECT id FROM totalbase.roles WHERE reserved AND admin_access ORDER BY name LIMIT 1`)).rows[0]!.id;
    await expect(insert("ceiling-test-under-admins", administrators)).rejects.toThrow(/no roles under it/);
  });
});
