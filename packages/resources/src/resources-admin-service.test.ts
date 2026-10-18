import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRelationDetail } from "@totalbase/pg-catalog";
import { ResourcesAdminService } from "./resources-admin-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));

describe("ResourcesAdminService (integration)", () => {
  let database: Database;
  let resourcesAdmin: ResourcesAdminService;
  let tableResourceId: string;
  let functionResourceId: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    resourcesAdmin = new ResourcesAdminService(database);

    const { rows: tableRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES (900201, 'public', 'resources_admin_pkg_test_table', 'TABLE', 'ACTIVE')
       RETURNING id`,
    );
    tableResourceId = tableRows[0]!.id;

    const { rows: fnRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, function_class)
       VALUES (900202, 'public', 'resources_admin_pkg_test_fn', 'FUNCTION', 'ACTIVE', 'UNCLASSIFIED')
       RETURNING id`,
    );
    functionResourceId = fnRows[0]!.id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.resources WHERE id IN ($1, $2)`, [tableResourceId, functionResourceId]);
    await database.close();
  });

  it("lists resources filtered by schema/type", async () => {
    const tables = await resourcesAdmin.list({ schema: "public", type: "TABLE" });
    expect(tables.map((r) => r.id)).toContain(tableResourceId);
    expect(tables.every((r) => r.type === "TABLE")).toBe(true);
  });

  it("gets one resource by id and 404s for an unknown id", async () => {
    const resource = await resourcesAdmin.get(tableResourceId);
    expect(resource.name).toBe("resources_admin_pkg_test_table");
    expect(resource.exposedMethods).toEqual([]);
    await expect(resourcesAdmin.get("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
  });

  it("sets a table's default order, checked against its columns", async () => {
    // Its own real table: on a fresh database the first ACTIVE table can be this suite's OID-only stand-in.
    await database.query(`DROP TABLE IF EXISTS public.resources_admin_pkg_test_sorted`);
    await database.query(`CREATE TABLE public.resources_admin_pkg_test_sorted (id integer, name text)`);
    const { rows } = await database.query<{ id: string; postgres_oid: number }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES ('public.resources_admin_pkg_test_sorted'::regclass::oid, 'public', 'resources_admin_pkg_test_sorted', 'TABLE', 'ACTIVE')
       RETURNING id, postgres_oid`,
    );
    const table = { id: rows[0]!.id, postgresOid: Number(rows[0]!.postgres_oid) };
    try {
      const columns = (await getRelationDetail(database, table.postgresOid)).columns.map((c) => c.name);
      const sort = [{ column: columns[0]!, direction: "desc" as const }];
      expect(await resourcesAdmin.updateDefaultSort(table.id, sort)).toEqual(sort);
      expect((await resourcesAdmin.get(table.id)).defaultSort).toEqual(sort);
      await expect(resourcesAdmin.updateDefaultSort(table.id, [{ column: "nope", direction: "asc" }])).rejects.toMatchObject({ code: "INVALID_QUERY" });
      await expect(resourcesAdmin.updateDefaultSort(table.id, [{ column: columns[0]!, direction: "up" }])).rejects.toMatchObject({ code: "INVALID_QUERY" });
      await expect(resourcesAdmin.updateDefaultSort(table.id, [sort[0]!, sort[0]!])).rejects.toMatchObject({ code: "INVALID_QUERY" });
      expect(await resourcesAdmin.updateDefaultSort(table.id, [])).toEqual([]);
    } finally {
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [table.id]);
      await database.query(`DROP TABLE public.resources_admin_pkg_test_sorted`);
    }
  });

  it("updates exposed_methods and audit_read without touching identity fields", async () => {
    const updated = await resourcesAdmin.update(tableResourceId, { exposedMethods: ["GET", "POST", "PATCH", "DELETE"], auditRead: true });
    expect(updated.exposedMethods.sort()).toEqual(["DELETE", "GET", "PATCH", "POST"]);
    expect(updated.auditRead).toBe(true);
    expect(updated.name).toBe("resources_admin_pkg_test_table");
  });

  it("updates function_class only for FUNCTION resources", async () => {
    const updated = await resourcesAdmin.update(functionResourceId, { functionClass: "ACTION" });
    expect(updated.functionClass).toBe("ACTION");

    await expect(resourcesAdmin.update(tableResourceId, { functionClass: "QUERY" })).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
  });

  it("accepts an explicit exposed_methods subset, including emptying it back out (= hidden)", async () => {
    const restricted = await resourcesAdmin.update(tableResourceId, { exposedMethods: ["GET", "POST"] });
    expect(restricted.exposedMethods.sort()).toEqual(["GET", "POST"]);

    const emptied = await resourcesAdmin.update(tableResourceId, { exposedMethods: [] });
    expect(emptied.exposedMethods).toEqual([]);
  });

  it("rejects exposed_methods that don't apply to the resource's type", async () => {
    await expect(resourcesAdmin.update(functionResourceId, { exposedMethods: ["GET"] })).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
  });

  it("gets and sets a resource's description", async () => {
    const initial = await resourcesAdmin.get(tableResourceId);
    expect(initial.description).toBeNull();

    const described = await resourcesAdmin.update(tableResourceId, { description: "Scratch table for tests" });
    expect(described.description).toBe("Scratch table for tests");

    // A fresh get() reads it back the same way - a plain column, not
    // recomputed from anything.
    expect((await resourcesAdmin.get(tableResourceId)).description).toBe("Scratch table for tests");

    const cleared = await resourcesAdmin.update(tableResourceId, { description: null });
    expect(cleared.description).toBeNull();
  });
});
