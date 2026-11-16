import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./runner.js";

const MIGRATIONS_DIR = new URL("../../../migrations/totalbase", import.meta.url).pathname;

/**
 * `users` is extensible (Foundations.md §10.4): a migration that adds a column to it meets the databases where a
 * project added one of that name first. Each case runs the real migrations in a scratch database of its own.
 */
describe("migrations over a users table a project extended (integration)", () => {
  let admin: Database;
  let scratch: Database | undefined;
  let scratchName: string;
  let before22: string;

  beforeAll(async () => {
    admin = new Database(loadDatabaseConfigFromEnv());
    before22 = await mkdtemp(join(tmpdir(), "totalbase-users-extensions-"));
    for (const file of await readdir(MIGRATIONS_DIR)) {
      if (/^\d{6}_/.test(file) && Number(file.slice(0, 6)) < 22) await cp(join(MIGRATIONS_DIR, file), join(before22, file));
    }
  });

  afterAll(async () => {
    await rm(before22, { recursive: true, force: true });
    await admin.close();
  });

  beforeEach(async () => {
    scratchName = `tb_users_ext_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await admin.query(`CREATE DATABASE ${scratchName}`);
    scratch = new Database({ ...loadDatabaseConfigFromEnv(), database: scratchName, poolMax: 2 });
    await runMigrations(scratch, { migrationsDir: before22, totalbaseVersion: "0.0.0-test" });
  });

  afterEach(async () => {
    await scratch?.close();
    scratch = undefined;
    await admin.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`);
  });

  const migrate = () => runMigrations(scratch!, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
  const removedCheck = async () =>
    (await scratch!.query(`SELECT 1 FROM pg_constraint WHERE conrelid = 'totalbase.users'::regclass AND conname = 'users_removed_inactive'`)).rows.length;

  it("000022 takes a removed_at timestamptz the project already added, with its values and its other columns", async () => {
    await scratch!.query(`ALTER TABLE totalbase.users ADD COLUMN removed_at timestamptz`);
    await scratch!.query(`ALTER TABLE totalbase.users ADD COLUMN removed_by uuid REFERENCES totalbase.users(id) ON DELETE SET NULL`);
    await scratch!.query(
      `INSERT INTO totalbase.users (email, name, active, removed_at) VALUES ('gone@example.com', 'Gone', false, '2026-11-01T00:00:00Z')`,
    );

    const result = await migrate();
    expect(result.applied).toContain("000022_users_removed.sql");
    expect(await removedCheck()).toBe(1);
    const { rows } = await scratch!.query<{ removed_at: Date; removed_by: string | null }>(
      `SELECT removed_at, removed_by FROM totalbase.users WHERE email = 'gone@example.com'`,
    );
    expect(rows[0]!.removed_at.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(rows[0]!.removed_by).toBeNull();
  });

  it("000022 stops, naming the column, when the project's removed_at is of another type", async () => {
    await scratch!.query(`ALTER TABLE totalbase.users ADD COLUMN removed_at boolean`);
    await expect(migrate()).rejects.toThrow(/removed_at of type boolean/);
    expect(await removedCheck()).toBe(0);
  });

  it("000022 adds the column where there is none", async () => {
    await migrate();
    expect(await removedCheck()).toBe(1);
  });
});
