import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncResourceDescriptions } from "./pg-sync.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));
const TABLE = "pg_sync_descriptions_test";

// Push (Foundations.md §11.8): a description with no COMMENT ON becomes the table's comment - a string constant
// inlined into DDL, so a quote in it must stay text (AGENTS.md §23: SQL injection).
describe("syncResourceDescriptions (integration)", () => {
  let database: Database;
  let resourceId: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await database.query(`CREATE TABLE public.${TABLE} (id integer)`);
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, description)
       VALUES ('public.${TABLE}'::regclass::oid, 'public', $1, 'TABLE', 'ACTIVE', $2)
       RETURNING id`,
      [TABLE, "Bob's orders'; DROP TABLE public.pg_sync_descriptions_test; --"],
    );
    resourceId = rows[0]!.id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await database.close();
  });

  it("writes the description as the table's comment, quotes and all, and runs nothing in it", async () => {
    const result = await syncResourceDescriptions(database);
    expect(result.filledFromDescription).toBeGreaterThanOrEqual(1);
    const { rows } = await database.query<{ comment: string | null }>(
      `SELECT obj_description('public.${TABLE}'::regclass, 'pg_class') AS comment`,
    );
    expect(rows[0]!.comment).toBe("Bob's orders'; DROP TABLE public.pg_sync_descriptions_test; --");
  });
});
