import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database, loadDatabaseConfigFromEnv, postgresClientEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { SettingsService } from "@totalbase/settings";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BackupsService, type BackupEvent } from "./backups-service.js";
import { restoreBackup } from "./restore.js";

/**
 * Built-in backups end to end (Administration.md §12), against real PostgreSQL: a scratch instance backed up,
 * then restored into a new, empty database. pg_dump and pg_restore are PostgreSQL's own - on PATH, or in
 * TOTALBASE_TEST_PG_BIN; without them the suite is skipped.
 */
const PG_BIN = process.env["TOTALBASE_TEST_PG_BIN"];
const HAS_TOOLS = PG_BIN ? existsSync(join(PG_BIN, "pg_dump")) : (process.env["PATH"] ?? "").split(":").some((dir) => existsSync(join(dir, "pg_dump")));
const MIGRATIONS = resolve(import.meta.dirname, "../../../migrations/totalbase");

describe.skipIf(!HAS_TOOLS)("built-in backups (integration)", () => {
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const sourceName = `tb_backup_src_${suffix}`;
  const targetName = `tb_backup_dst_${suffix}`;
  let admin: Database;
  let source: Database;
  let target: Database;
  let root: string;
  let filesDir: string;
  let backupsDir: string;
  let service: BackupsService;
  const events: BackupEvent["event"][] = [];

  const clientEnv = (database: string) => ({ ...postgresClientEnv(), PGDATABASE: database });

  beforeAll(async () => {
    admin = new Database(loadDatabaseConfigFromEnv());
    await admin.query(`CREATE DATABASE ${sourceName}`);
    await admin.query(`CREATE DATABASE ${targetName}`);
    source = new Database({ ...loadDatabaseConfigFromEnv(), database: sourceName, poolMax: 3 });
    target = new Database({ ...loadDatabaseConfigFromEnv(), database: targetName, poolMax: 2 });
    await runMigrations(source, { migrationsDir: MIGRATIONS, totalbaseVersion: "0.0.0-test" });

    root = await mkdtemp(join(tmpdir(), "tb-backups-"));
    filesDir = join(root, "files");
    backupsDir = join(root, "backups");
    await mkdir(join(filesDir, "ab/cd"), { recursive: true });
    await writeFile(join(filesDir, "ab/cd/report.pdf"), "the report");

    await source.query(`CREATE TABLE public.notes (id int PRIMARY KEY, body text NOT NULL)`);
    await source.query(`INSERT INTO public.notes VALUES (1, 'kept'), (2, 'also kept')`);
    await source.query(`INSERT INTO totalbase.settings (key, value) VALUES ('system.master_key_verifier', to_jsonb('the-verifier'::text))`);
    const settings = new SettingsService(source);
    await settings.set("files.storage_local_path", filesDir);
    await settings.set("backups.local_path", backupsDir);
    await settings.set("backups.enabled", true);
    await settings.set("backups.schedule", "* * * * *");
    await settings.set("backups.keep", 1);

    service = new BackupsService({
      database: source,
      settings,
      s3Store: () => Promise.reject(new Error("no S3 in this test")),
      clientEnv: () => clientEnv(sourceName),
      pgBinDir: PG_BIN,
      workDir: join(root, "work"),
      totalbaseVersion: "0.0.0-test",
      workerId: "test",
      onEvent: async (event) => {
        events.push(event.event);
      },
    });
  }, 120_000);

  afterAll(async () => {
    await source?.close();
    await target?.close();
    await admin.query(`DROP DATABASE IF EXISTS ${sourceName} WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${targetName} WITH (FORCE)`);
    await admin.close();
    if (root) await rm(root, { recursive: true, force: true });
    // Dropping two databases waits for PostgreSQL's checkpoint - past vitest's 10 s on a busy server.
  }, 120_000);

  it("queues the schedule's occurrence once, then backs the database and the files up into one archive", async () => {
    const now = new Date();
    const queued = await service.scheduleTick(now);
    expect(queued).toMatchObject({ status: "PENDING", trigger: "SCHEDULED", destination: "LOCAL" });
    // The same minute again, or a Back up now meanwhile: one backup at a time (backups_one_active).
    expect(await service.scheduleTick(now)).toBeNull();

    expect(await service.processNext()).toBe(true);
    const done = await service.get(queued!.id);
    expect(done.error).toBeNull();
    expect(done).toMatchObject({ status: "COMPLETED", manifest: { files: true, masterKeyVerifier: "the-verifier", migration: expect.any(String) } });
    expect(done.sizeBytes).toBeGreaterThan(0);
    expect(await readdir(backupsDir)).toEqual([done.name]);
    expect(events).toEqual(["COMPLETED"]);
  }, 120_000);

  it("keeps backups.keep completed backups: the next one deletes the oldest, its archive with it", async () => {
    const [first] = await service.list();
    await service.scheduleTick(new Date(Date.now() + 60_000));
    await service.processNext();
    const kept = await service.list();
    expect(kept.map((b) => b.status)).toEqual(["COMPLETED"]);
    expect(kept[0]!.id).not.toBe(first!.id);
    expect(await readdir(backupsDir)).toEqual([kept[0]!.name]);
  }, 120_000);

  it("restores into an empty database only, with the backup's master key - the rows, the files and the backup itself", async () => {
    const [backup] = await service.list();
    const archive = join(backupsDir, backup!.name);
    const options = {
      archive,
      database: target,
      clientEnv: clientEnv(targetName),
      pgBinDir: PG_BIN,
      migrationsDir: MIGRATIONS,
      workDir: join(root, "work"),
      log: () => undefined,
    };
    await expect(restoreBackup({ ...options, masterKeyVerifier: "another-key" })).rejects.toThrow(/master key/);
    await expect(restoreBackup({ ...options, database: source, clientEnv: clientEnv(sourceName), masterKeyVerifier: "the-verifier" })).rejects.toThrow(/isn't empty/);
    // The files directory the backup names holds its files: a restore never writes over them.
    await expect(restoreBackup({ ...options, masterKeyVerifier: "the-verifier" })).rejects.toThrow(/files directory/);

    await rm(filesDir, { recursive: true });
    await restoreBackup({ ...options, masterKeyVerifier: "the-verifier" });
    const { rows } = await target.query<{ body: string }>(`SELECT body FROM public.notes ORDER BY id`);
    expect(rows.map((r) => r.body)).toEqual(["kept", "also kept"]);
    expect(await readFile(join(filesDir, "ab/cd/report.pdf"), "utf8")).toBe("the report");
    // Taken while it ran, it is restored as what it became: completed. The history is the dump's - the backup
    // retention deleted after it is listed again, its archive gone.
    const { rows: backups } = await target.query<{ id: string; status: string }>(`SELECT id, status FROM totalbase.backups`);
    expect(backups).toContainEqual({ id: backup!.id, status: "COMPLETED" });
    expect(backups.every((b) => b.status === "COMPLETED")).toBe(true);
  }, 180_000);

  it("deletes a backup and its archive, never one under way", async () => {
    const [backup] = await service.list();
    await service.delete(backup!.id);
    expect(await service.list()).toEqual([]);
    expect(await readdir(backupsDir)).toEqual([]);
  });
});
