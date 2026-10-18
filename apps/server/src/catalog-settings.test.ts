import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { getCatalogFingerprint } from "@totalbase/pg-catalog";
import { syncCatalogIfChanged } from "./catalog-refresh.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp } from "./test-support.js";

const TABLE = "catalog_settings_test_t";
const KEYS = ["catalog.auto_refresh_after_ddl", "catalog.track_comments"] as const;

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
});
