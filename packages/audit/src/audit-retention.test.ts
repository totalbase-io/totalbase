import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purgeAuditLogs } from "./audit-retention.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));

describe("purgeAuditLogs (integration)", () => {
  let database: Database;
  const ids: string[] = [];

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.logs WHERE id = ANY($1::uuid[])`, [ids]);
    await database.close();
  });

  const entry = async (ageDays: number) => {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.logs (request_id, principal_type, action, status, source, started_at, created_at)
       VALUES (gen_random_uuid(), 'SYSTEM', 'AUTH', 'EXECUTED', 'test', now(), now() - make_interval(days => $1))
       RETURNING id`,
      [ageDays],
    );
    ids.push(rows[0]!.id);
    return rows[0]!.id;
  };
  const exists = async (id: string) =>
    (await database.query(`SELECT 1 FROM totalbase.logs WHERE id = $1`, [id])).rows.length === 1;

  it("keeps everything when retention is 0", async () => {
    const ancient = await entry(5000);
    expect(await purgeAuditLogs(database, 0)).toBe(0);
    expect(await exists(ancient)).toBe(true);
  });

  it("deletes entries older than the window and keeps the rest", async () => {
    const old = await entry(400);
    const older = await entry(401);
    const recent = await entry(10);
    expect(await purgeAuditLogs(database, 365)).toBeGreaterThanOrEqual(2);
    expect(await exists(old)).toBe(false);
    expect(await exists(older)).toBe(false);
    expect(await exists(recent)).toBe(true);
  });
});
