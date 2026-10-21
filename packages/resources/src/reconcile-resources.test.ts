import { fileURLToPath } from "node:url";
import { buildCatalogSnapshot, type CatalogObject } from "@totalbase/pg-catalog";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcileResources } from "./reconcile-resources.js";
import { relationDetailCache } from "@totalbase/pg-catalog";

// Integration tests change tables with raw SQL (ALTER/RENAME/DROP COLUMN); in the product every schema change
// goes through a reconcile that clears the relation-detail cache, so here it is simply off.
relationDetailCache.enabled = false;

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));
const TABLE = "resources_pkg_test_scratch";
const TABLE_RENAMED = "resources_pkg_test_scratch_renamed";

async function snapshotFor(database: Database, name: string): Promise<CatalogObject[]> {
  const all = await buildCatalogSnapshot(database);
  return all.filter((object) => object.name === name && object.schema === "public");
}

async function resourceRow(database: Database, oid: number) {
  const { rows } = await database.query<{
    id: string;
    name: string;
    status: string;
    exposed_methods: string[];
  }>(`SELECT id, name, status, exposed_methods FROM totalbase.resources WHERE postgres_oid = $1`, [oid]);
  return rows[0];
}

describe("reconcileResources (integration)", () => {
  let database: Database;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
  });

  afterAll(async () => {
    await database.query(`DROP TABLE IF EXISTS public."${TABLE}"`);
    await database.query(`DROP TABLE IF EXISTS public."${TABLE_RENAMED}"`);
    await database.query(
      `DELETE FROM totalbase.resources WHERE name IN ($1, $2)`,
      [TABLE, TABLE_RENAMED],
    );
    await database.close();
  });

  it("discovers a new table as ACTIVE and hidden by default", async () => {
    await database.query(`CREATE TABLE public."${TABLE}" (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`);

    const [object] = await snapshotFor(database, TABLE);
    expect(object).toBeDefined();

    const catalog = await buildCatalogSnapshot(database);
    const result = await reconcileResources(database, catalog);
    expect(result.discovered).toBeGreaterThanOrEqual(1);

    const row = await resourceRow(database, object!.oid);
    expect(row?.status).toBe("ACTIVE");
    expect(row?.exposed_methods).toEqual([]);
  });

  it("preserves resource identity across a rename (same OID)", async () => {
    const before = await snapshotFor(database, TABLE);
    const oid = before[0]!.oid;
    const beforeRow = await resourceRow(database, oid);

    await database.query(`ALTER TABLE public."${TABLE}" RENAME TO "${TABLE_RENAMED}"`);

    const catalog = await buildCatalogSnapshot(database);
    await reconcileResources(database, catalog);

    const afterRow = await resourceRow(database, oid);
    expect(afterRow?.id).toBe(beforeRow?.id);
    expect(afterRow?.name).toBe(TABLE_RENAMED);
    expect(afterRow?.status).toBe("ACTIVE");
  });

  it("marks a dropped table's resource as MISSING, then purges it outright", async () => {
    const [object] = await snapshotFor(database, TABLE_RENAMED);
    const oid = object!.oid;

    await database.query(`DROP TABLE public."${TABLE_RENAMED}"`);

    const catalog = await buildCatalogSnapshot(database);
    const result = await reconcileResources(database, catalog);
    expect(result.missing).toBeGreaterThanOrEqual(1);
    expect(result.purged).toBeGreaterThanOrEqual(1);

    const row = await resourceRow(database, oid);
    expect(row).toBeUndefined();
  });

  it("treats drop+create with the same name as a new, independently hidden resource", async () => {
    await database.query(`CREATE TABLE public."${TABLE}" (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`);

    const [object] = await snapshotFor(database, TABLE);
    const catalog = await buildCatalogSnapshot(database);
    const result = await reconcileResources(database, catalog);
    expect(result.discovered).toBeGreaterThanOrEqual(1);

    const row = await resourceRow(database, object!.oid);
    expect(row?.status).toBe("ACTIVE");
    expect(row?.exposed_methods).toEqual([]);

    // The original (renamed, then dropped) resource row was already purged
    // by the previous test's own sync - nothing named TABLE_RENAMED remains.
    const { rows: goneRows } = await database.query<{ status: string }>(
      `SELECT status FROM totalbase.resources WHERE name = $1`,
      [TABLE_RENAMED],
    );
    expect(goneRows).toHaveLength(0);
  });

  it("leaves a MISSING resource alone when a DataView still references it as source_resource", async () => {
    // TABLE already exists (and is ACTIVE) from the previous test - no need
    // to recreate it, just resync in case anything upstream changed.
    let catalog = await buildCatalogSnapshot(database);
    await reconcileResources(database, catalog);
    const [object] = await snapshotFor(database, TABLE);
    const oid = object!.oid;
    const row = await resourceRow(database, oid);

    const { rows: dvRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.dataviews (name, slug, view_type, source_resource)
       VALUES ('Reconcile test view', 'reconcile-test-view', 'TABLE', $1)
       RETURNING id`,
      [row!.id],
    );

    try {
      await database.query(`DROP TABLE public."${TABLE}"`);
      catalog = await buildCatalogSnapshot(database);
      const result = await reconcileResources(database, catalog);
      expect(result.missing).toBeGreaterThanOrEqual(1);

      const afterRow = await resourceRow(database, oid);
      expect(afterRow?.status).toBe("MISSING");
    } finally {
      await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [dvRows[0]!.id]);
    }
  });

  // A partition is a storage detail of its parent: registered as a resource of its own it could be exposed and
  // granted apart, its rows read past the parent's grants (security regression).
  it("registers a partitioned table but none of its partitions, and drops a table once attached as one", async () => {
    const parent = "resources_pkg_test_parted";
    try {
      await database.query(`CREATE TABLE public."${parent}" (d date NOT NULL) PARTITION BY RANGE (d)`);
      await database.query(
        `CREATE TABLE public."${parent}_2025" PARTITION OF public."${parent}" FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')`,
      );
      await database.query(`CREATE TABLE public."${parent}_2026" (d date NOT NULL)`);
      await reconcileResources(database, await buildCatalogSnapshot(database));
      const standalone = await snapshotFor(database, `${parent}_2026`);
      expect(standalone).toHaveLength(1);
      expect(await resourceRow(database, standalone[0]!.oid)).toBeDefined();

      await database.query(
        `ALTER TABLE public."${parent}" ATTACH PARTITION public."${parent}_2026" FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')`,
      );
      const catalog = await buildCatalogSnapshot(database);
      await reconcileResources(database, catalog);

      const names = catalog.filter((object) => object.schema === "public").map((object) => object.name);
      expect(names).toContain(parent);
      expect(names).not.toContain(`${parent}_2025`);
      expect(names).not.toContain(`${parent}_2026`);
      const { rows } = await database.query<{ name: string }>(
        `SELECT name FROM totalbase.resources WHERE "schema" = 'public' AND name LIKE $1`,
        [`${parent}%`],
      );
      expect(rows.map((row) => row.name)).toEqual([parent]);
    } finally {
      await database.query(`DROP TABLE IF EXISTS public."${parent}"`);
      await database.query(`DROP TABLE IF EXISTS public."${parent}_2026"`);
      await reconcileResources(database, await buildCatalogSnapshot(database));
    }
  });

  it("doesn't register a trigger function as a FUNCTION resource", async () => {
    const fn = "resources_pkg_test_trigger_fn";
    try {
      await database.query(
        `CREATE FUNCTION public."${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
      );
      expect(await snapshotFor(database, fn)).toEqual([]);
    } finally {
      await database.query(`DROP FUNCTION IF EXISTS public."${fn}"()`);
    }
  });
  it("never keeps one of TotalBase's own functions as a resource, even one registered before", async () => {
    // A function of the totalbase schema registered by an older catalog (it once told TotalBase's objects by a
    // name prefix): the next reconcile takes it out, though the function still exists.
    const { rows } = await database.query<{ oid: number }>(
      `SELECT 'totalbase.is_valid_name(text)'::regprocedure::oid::int AS oid`,
    );
    const oid = rows[0]!.oid;
    await database.query(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES ($1, 'totalbase', 'is_valid_name', 'FUNCTION', 'ACTIVE', '{}')`,
      [oid],
    );
    await reconcileResources(database, await buildCatalogSnapshot(database));
    const row = await resourceRow(database, oid);
    expect(row === undefined || row.status === "MISSING").toBe(true);
    await database.query(`DELETE FROM totalbase.resources WHERE postgres_oid = $1 AND "schema" = 'totalbase'`, [oid]);
  });
});
