import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { buildCatalogSnapshot, getCatalogFingerprint } from "@totalbase/pg-catalog";
import { catalogScope, reconcileCatalog, syncCatalogIfChanged } from "./catalog-refresh.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp } from "./test-support.js";

const TABLE = "catalog_settings_test_t";
const KEYS = ["catalog.auto_refresh_after_ddl", "catalog.track_comments", "catalog.excluded_schemas"] as const;

describe("catalog.* settings", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  const saved = new Map<string, { overridden: boolean; value: unknown }>();

  const post = (url: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url, payload, headers: { authorization: `Bearer ${adminToken}` } });
  const resourceRow = async () =>
    (await database.query<{ id: string; description: string | null }>(
      `SELECT id, description FROM totalbase.resources WHERE "schema" = 'public' AND name = $1 AND status = 'ACTIVE'`,
      [TABLE],
    )).rows[0];

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    for (const key of KEYS) saved.set(key, { overridden: await context.settings.isOverridden(key), value: await context.settings.get(key) });
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
  });

  afterAll(async () => {
    // Shared with local development: leave these as they were.
    for (const key of KEYS) {
      const entry = saved.get(key)!;
      if (entry.overridden) await context.settings.set(key, entry.value as never);
      else await context.settings.reset(key);
    }
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await post("/admin/api/catalog/refresh");
    await database.query(`DELETE FROM totalbase.resources WHERE "schema" = 'public' AND name = $1`, [TABLE]);
    await app.close();
    await database.close();
  });

  it("reconciles after a SQL Console run only with catalog.auto_refresh_after_ddl", async () => {
    await context.settings.set("catalog.auto_refresh_after_ddl", false);
    expect((await post("/admin/api/sql/execute", { data: { sql: `CREATE TABLE public.${TABLE} (id int PRIMARY KEY)` } })).statusCode).toBe(200);
    expect(await resourceRow()).toBeUndefined();

    await context.settings.set("catalog.auto_refresh_after_ddl", true);
    expect((await post("/admin/api/sql/execute", { data: { sql: "SELECT 1" } })).statusCode).toBe(200);
    expect(await resourceRow()).toBeDefined();
  });

  it("catalog.watch_interval_seconds' check syncs only when DDL changed the catalog", async () => {
    const WATCHED = `${TABLE}_watched`;
    await database.query(`DROP TABLE IF EXISTS public.${WATCHED}`);
    let fingerprint = await getCatalogFingerprint(database);
    try {
      // Nothing changed: no sync. Neither do statistics (ANALYZE).
      await database.query(`ANALYZE public.${TABLE}`);
      expect((await syncCatalogIfChanged(context, fingerprint)).result).toBeNull();

      // DDL from outside TotalBase: synced, then quiet again.
      await database.query(`CREATE TABLE public.${WATCHED} (id int PRIMARY KEY)`);
      const changed = await syncCatalogIfChanged(context, fingerprint);
      expect(changed.result!.discovered).toBeGreaterThanOrEqual(1);
      fingerprint = changed.fingerprint;
      expect((await syncCatalogIfChanged(context, fingerprint)).result).toBeNull();

      // A new column is a change too.
      await database.query(`ALTER TABLE public.${WATCHED} ADD COLUMN label text`);
      const added = await syncCatalogIfChanged(context, fingerprint);
      expect(added.result).not.toBeNull();
      expect(added.fingerprint).not.toBe(fingerprint);
    } finally {
      const { rows } = await database.query<{ id: string }>(
        `SELECT id FROM totalbase.resources WHERE "schema" = 'public' AND name = $1`,
        [WATCHED],
      );
      await database.query(`DROP TABLE IF EXISTS public.${WATCHED}`);
      for (const { id } of rows) await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [id]);
    }
  });

  it("syncs COMMENT ON into an empty description only with catalog.track_comments", async () => {
    await database.query(`COMMENT ON TABLE public.${TABLE} IS 'From PostgreSQL'`);

    await context.settings.set("catalog.track_comments", false);
    const off = await post("/admin/api/catalog/refresh");
    expect(off.json().data.descriptions).toBeNull();
    expect((await resourceRow())!.description).toBeNull();

    await context.settings.set("catalog.track_comments", true);
    const on = await post("/admin/api/catalog/refresh");
    expect(on.json().data.descriptions.filledFromComment).toBeGreaterThanOrEqual(1);
    expect((await resourceRow())!.description).toBe("From PostgreSQL");
  });

  // Foundations.md §11.2, §12.3, §12.4: a table by inheritance (a TimescaleDB chunk) is no resource and no catalog
  // change; an excluded schema is left out whole, and a resource registered there before leaves on the next sync.
  it("leaves a table inheriting from another out of the catalog and the change fingerprint", async () => {
    const PARENT = `${TABLE}_hyper`;
    await database.query(`DROP TABLE IF EXISTS public.${PARENT} CASCADE`);
    try {
      await database.query(`CREATE TABLE public.${PARENT} (at timestamptz NOT NULL, value int)`);
      await reconcileCatalog(context);
      const fingerprint = (await syncCatalogIfChanged(context, "")).fingerprint;
      // The first child rewrites the parent's pg_class row once (relhassubclass): one sync, which registers nothing.
      await database.query(`CREATE TABLE public.${PARENT}_chunk_1 (id int PRIMARY KEY, CHECK (at >= '2026-01-01')) INHERITS (public.${PARENT})`);
      const first = await syncCatalogIfChanged(context, fingerprint);
      expect(first.result?.discovered ?? 0).toBe(0);
      // Every chunk after it - with its primary key, its index, its check and its row type - is no change at all.
      await database.query(`CREATE TABLE public.${PARENT}_chunk_2 (id int PRIMARY KEY, CHECK (at >= '2026-02-01')) INHERITS (public.${PARENT})`);
      await database.query(`CREATE INDEX ON public.${PARENT}_chunk_2 (at)`);
      expect((await syncCatalogIfChanged(context, first.fingerprint)).result).toBeNull();
      const names = (await buildCatalogSnapshot(database, await catalogScope(context))).filter((o) => o.schema === "public").map((o) => o.name);
      expect(names).toContain(PARENT);
      expect(names).not.toContain(`${PARENT}_chunk_1`);
      expect(names).not.toContain(`${PARENT}_chunk_2`);
    } finally {
      await database.query(`DROP TABLE IF EXISTS public.${PARENT} CASCADE`);
      await reconcileCatalog(context);
    }
  });

  it("catalog.excluded_schemas leaves a schema out: its tables are no resources, its DDL no change, and a resource registered there before leaves", async () => {
    const SCHEMA = "catalog_settings_test_excluded";
    await database.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    try {
      await database.query(`CREATE SCHEMA ${SCHEMA}`);
      await database.query(`CREATE TABLE ${SCHEMA}.things (id int PRIMARY KEY)`);
      await context.settings.reset("catalog.excluded_schemas");
      await reconcileCatalog(context);
      const registered = async () => (await database.query(`SELECT 1 FROM totalbase.resources WHERE "schema" = $1 AND name = 'things'`, [SCHEMA])).rowCount;
      expect(await registered()).toBe(1);

      await context.settings.set("catalog.excluded_schemas", [SCHEMA]);
      const synced = await reconcileCatalog(context);
      expect(synced.missing).toBeGreaterThanOrEqual(1);
      expect(await registered()).toBe(0);
      const schemas = (await app.inject({ method: "GET", url: "/admin/api/catalog/schemas", headers: { authorization: `Bearer ${adminToken}` } })).json().data as { schema: string }[];
      expect(schemas.map((s) => s.schema)).not.toContain(SCHEMA);

      const fingerprint = (await syncCatalogIfChanged(context, "")).fingerprint;
      await database.query(`CREATE TABLE ${SCHEMA}.more (id int PRIMARY KEY, label text)`);
      expect((await syncCatalogIfChanged(context, fingerprint)).result).toBeNull();
    } finally {
      await context.settings.reset("catalog.excluded_schemas");
      await database.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await reconcileCatalog(context);
    }
  });
});
