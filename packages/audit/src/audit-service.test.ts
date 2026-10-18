import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { SettingsService } from "@totalbase/settings";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditExclusionsService, buildUpdateChanges, withoutExcludedFields } from "./audit-exclusions-service.js";
import { AuditService } from "./audit-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));

describe("AuditService / AuditExclusionsService (integration)", () => {
  let database: Database;
  let settings: SettingsService;
  let audit: AuditService;
  let exclusions: AuditExclusionsService;
  let resourceId: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    settings = new SettingsService(database);
    audit = new AuditService(settings);
    exclusions = new AuditExclusionsService(database);

    await database.query(`DROP TABLE IF EXISTS public.audit_pkg_test_resource`);
    await database.query(`CREATE TABLE public.audit_pkg_test_resource (id uuid PRIMARY KEY, name text, price numeric, secret text)`);
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES (to_regclass('public.audit_pkg_test_resource')::oid, 'public', 'audit_pkg_test_resource', 'TABLE', 'ACTIVE')
       RETURNING id`,
    );
    resourceId = rows[0]!.id;
  });

  afterAll(async () => {
    await database.query(
      `DELETE FROM totalbase.logs WHERE request_id IN (
         '11111111-1111-1111-1111-111111111111',
         '22222222-2222-2222-2222-222222222222',
         '33333333-3333-3333-3333-333333333333'
       )`,
    );
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await database.query(`DROP TABLE IF EXISTS public.audit_pkg_test_resource`);
    await database.close();
  });

  it("writes and reads back an EXECUTED audit log entry", async () => {
    const startedAt = new Date();
    await audit.record(database, {
      requestId: "11111111-1111-1111-1111-111111111111",
      principal: { type: "USER", id: null },
      resourceId,
      action: "CREATE",
      status: "EXECUTED",
      source: "api",
      changes: { name: { old: null, new: "hello" } },
      startedAt,
      finishedAt: new Date(),
    });

    const { rows } = await database.query(
      `SELECT * FROM totalbase.logs WHERE request_id = $1`,
      ["11111111-1111-1111-1111-111111111111"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["status"]).toBe("EXECUTED");
    expect(rows[0]?.["action"]).toBe("CREATE");
  });

  it("skips writing when audit.enabled is false", async () => {
    await settings.set("audit.enabled", false);
    try {
      await audit.record(database, {
        requestId: "22222222-2222-2222-2222-222222222222",
        principal: { type: "SYSTEM", id: null },
        resourceId,
        action: "DELETE",
        status: "EXECUTED",
        source: "api",
        startedAt: new Date(),
        finishedAt: new Date(),
      });
      const { rows } = await database.query(
        `SELECT * FROM totalbase.logs WHERE request_id = $1`,
        ["22222222-2222-2222-2222-222222222222"],
      );
      expect(rows).toHaveLength(0);
    } finally {
      await settings.set("audit.enabled", true);
    }
  });

  it("omits sql_text when audit.store_sql is false", async () => {
    await settings.set("audit.store_sql", false);
    try {
      await audit.record(database, {
        requestId: "33333333-3333-3333-3333-333333333333",
        principal: { type: "SYSTEM", id: null },
        resourceId,
        action: "READ",
        status: "EXECUTED",
        source: "api",
        sqlText: "SELECT 1",
        startedAt: new Date(),
        finishedAt: new Date(),
      });
      const { rows } = await database.query<{ sql_text: string | null }>(
        `SELECT sql_text FROM totalbase.logs WHERE request_id = $1`,
        ["33333333-3333-3333-3333-333333333333"],
      );
      expect(rows[0]?.sql_text).toBeNull();
    } finally {
      await settings.set("audit.store_sql", true);
    }
  });

  it("excludes columns by name, keeps them through a rename, and replaces the list whole", async () => {
    await exclusions.set(resourceId, ["secret", "price", "price"]);
    expect(await exclusions.list(resourceId)).toEqual(["price", "secret"]);
    // Stored by attnum: a renamed column stays excluded, under its new name.
    await database.query(`ALTER TABLE public.audit_pkg_test_resource RENAME COLUMN secret TO hidden`);
    try {
      expect(await exclusions.excludedFields(resourceId)).toEqual(new Set(["price", "hidden"]));
    } finally {
      await database.query(`ALTER TABLE public.audit_pkg_test_resource RENAME COLUMN hidden TO secret`);
    }
    await exclusions.set(resourceId, []);
    expect(await exclusions.list(resourceId)).toEqual([]);
  });

  it("refuses a name that isn't a column, leaving the list as it was", async () => {
    await exclusions.set(resourceId, ["secret"]);
    await expect(exclusions.set(resourceId, ["name", "nope"])).rejects.toMatchObject({ code: "INVALID_QUERY" });
    expect(await exclusions.list(resourceId)).toEqual(["secret"]);
    await exclusions.set(resourceId, []);
  });

  it("buildUpdateChanges records every changed column but the excluded ones", () => {
    const changes = buildUpdateChanges(
      { name: "old", price: 10, secret: "a", note: "same" },
      { name: "new", price: 12, secret: "b", note: "same" },
      new Set(["price"]),
    );
    expect(changes).toEqual({ name: { old: "old", new: "new" }, secret: { old: "a", new: "b" } });
    // Without the old row (no primary key, PostgreSQL 15-17) or with nothing changed: none.
    expect(buildUpdateChanges(undefined, { name: "x" }, new Set())).toBeUndefined();
    expect(buildUpdateChanges({ name: "x" }, { name: "x" }, new Set())).toBeUndefined();
  });

  it("withoutExcludedFields drops the excluded columns from a row", () => {
    expect(withoutExcludedFields({ id: 1, secret: "s", name: "n" }, new Set(["secret"]))).toEqual({ id: 1, name: "n" });
    expect(withoutExcludedFields(undefined, new Set(["secret"]))).toBeUndefined();
  });
});
