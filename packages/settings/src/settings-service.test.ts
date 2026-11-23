import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SettingsService } from "./settings-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));

// Every key these tests write or reset. The database is shared with local
// development, so whatever was stored for them is put back afterwards
// instead of being left deleted.
const TOUCHED_KEYS = [
  "security.cors_origins",
  "security.trusted_proxies",
  "files.storage_local_path",
  "backups.local_path",
  "auth.password_min_length",
  "audit.retention_days",
  "api.max_limit",
  "smtp.port",
  "files.transforms.presets_json",
  "files.storage_provider",
  "s3.enabled",
  "s3.endpoint",
  "s3.bucket",
  "s3.prefix",
];

describe("SettingsService (integration)", () => {
  let database: Database;
  let settings: SettingsService;
  let saved: Array<{ key: string; value: unknown }> = [];

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    settings = new SettingsService(database);
    saved = (
      await database.query<{ key: string; value: unknown }>(
        `SELECT key, value FROM totalbase.settings WHERE key = ANY($1)`,
        [TOUCHED_KEYS],
      )
    ).rows;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.settings WHERE key = ANY($1)`, [TOUCHED_KEYS]);
    for (const { key, value } of saved) {
      await database.query(`INSERT INTO totalbase.settings (key, value) VALUES ($1, $2::jsonb)`, [key, JSON.stringify(value)]);
    }
    await database.close();
  });

  it("returns the registry default when no override exists", async () => {
    await database.query(`DELETE FROM totalbase.settings WHERE key = 'auth.password_min_length'`);
    const value = await settings.get("auth.password_min_length");
    expect(value).toBe(12);
  });

  it("returns the stored override once set", async () => {
    await settings.set("auth.password_min_length", 16);
    const value = await settings.get("auth.password_min_length");
    expect(value).toBe(16);
  });

  it("upserts on repeated writes", async () => {
    await settings.set("auth.password_min_length", 8);
    await settings.set("auth.password_min_length", 20);
    const value = await settings.get("auth.password_min_length");
    expect(value).toBe(20);
  });

  it("getAll returns every registered key", async () => {
    const all = await settings.getAll();
    expect(all["api.default_limit"]).toBe(50);
    expect(all["audit.enabled"]).toBe(true);
  });

  it("getGroup returns only that group's keys", async () => {
    const group = await settings.getGroup("audit");
    expect(Object.keys(group).every((k) => k.startsWith("audit."))).toBe(true);
    expect(group["audit.enabled"]).toBe(true);
  });

  it("setGroup accepts bare or fully-dotted keys and rejects unknown ones", async () => {
    await settings.setGroup("audit", { retention_days: 90 });
    expect(await settings.get("audit.retention_days")).toBe(90);

    await settings.setGroup("audit", { "audit.retention_days": 30 });
    expect(await settings.get("audit.retention_days")).toBe(30);

    await expect(settings.setGroup("audit", { not_a_real_key: 1 })).rejects.toMatchObject({
      code: "INVALID_SETTING",
    });

    await database.query(`DELETE FROM totalbase.settings WHERE key = 'audit.retention_days'`);
  });

  it("caches reads in-process and only re-queries after a write", async () => {
    await database.query(`DELETE FROM totalbase.settings WHERE key = 'auth.password_min_length'`);
    const querySpy = vi.spyOn(database, "query");
    const settings = new SettingsService(database); // fresh instance: no warm entries from earlier tests

    await settings.get("auth.password_min_length"); // cold: hits the database
    const callsAfterFirstGet = querySpy.mock.calls.length;
    expect(callsAfterFirstGet).toBeGreaterThan(0);

    await settings.get("auth.password_min_length"); // warm: served from cache
    expect(querySpy.mock.calls.length).toBe(callsAfterFirstGet);

    await settings.set("auth.password_min_length", 18); // invalidates the cached entry
    const value = await settings.get("auth.password_min_length"); // re-reads from the database
    expect(value).toBe(18);
    expect(querySpy.mock.calls.length).toBeGreaterThan(callsAfterFirstGet + 1); // set() + get()'s re-read

    querySpy.mockRestore();
    await database.query(`DELETE FROM totalbase.settings WHERE key = 'auth.password_min_length'`);
  });

  it("rejects a value of the wrong type for its key, and stores nothing", async () => {
    await settings.reset("auth.password_min_length");
    await expect(settings.set("auth.password_min_length", "20" as never)).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await expect(settings.setGroup("auth", { registration_enabled: "yes" })).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await expect(settings.setGroup("security", { cors_origins: "https://a.example.com" })).rejects.toMatchObject({
      code: "INVALID_SETTING",
    });
    await expect(settings.set("auth.password_min_length", Number.NaN)).rejects.toMatchObject({ code: "INVALID_SETTING" });
    expect(await settings.get("auth.password_min_length")).toBe(12);
  });

  it("takes embed origins exactly - scheme, host and port, no path, never a wildcard", async () => {
    await settings.set("dashboards.embed_allowed_origins", ["https://app.example.com", "http://localhost:5173"]);
    for (const bad of ["*", "https://app.example.com/", "https://app.example.com/page", "app.example.com", "javascript:alert(1)"]) {
      await expect(settings.set("dashboards.embed_allowed_origins", [bad])).rejects.toMatchObject({ code: "INVALID_SETTING" });
    }
    await settings.reset("dashboards.embed_allowed_origins");
  });

  it("rejects numbers outside their bounds - negatives, fractions, a zero page size, a port out of range", async () => {
    await expect(settings.set("audit.retention_days", -1)).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await expect(settings.set("audit.retention_days", 1.5)).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await expect(settings.set("api.max_limit", 0)).rejects.toMatchObject({ code: "INVALID_SETTING" });
    // SEC-98: a page larger than a filter list may hold (10,000) - the keys the server lists of a page (GraphQL's
    // one-to-many reads, realtime's changed rows) would no longer fit one.
    await expect(settings.set("api.max_limit", 10_001)).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await expect(settings.set("smtp.port", 70_000)).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await expect(settings.set("auth.password_min_length", 500)).rejects.toMatchObject({
      message: "auth.password_min_length: Expected a whole number from 8 to 128.",
    });
    expect(await settings.isOverridden("api.max_limit")).toBe(false);
  });

  it("accepts only a well-formed S3 connection, and Files in S3 only while it is enabled - which then stays on", async () => {
    await expect(settings.set("files.storage_provider", "gcs")).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await expect(settings.set("s3.endpoint", "s3.amazonaws.com")).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await expect(settings.set("s3.endpoint", "https://key:secret@s3.amazonaws.com")).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await expect(settings.set("s3.bucket", "My_Bucket")).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await expect(settings.set("s3.prefix", "../other")).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await expect(settings.set("s3.prefix", "/root")).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await settings.set("s3.endpoint", "http://minio:9000");
    await settings.set("s3.bucket", "totalbase-files");
    await settings.set("s3.prefix", "production/");

    await expect(settings.set("files.storage_provider", "s3")).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await settings.set("s3.enabled", true);
    await settings.set("files.storage_provider", "s3");
    expect(await settings.get("files.storage_provider")).toBe("s3");
    await expect(settings.set("s3.enabled", false)).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await expect(settings.reset("s3.enabled")).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await settings.reset("files.storage_provider");
    await settings.set("s3.enabled", false);
    for (const key of ["s3.endpoint", "s3.bucket", "s3.prefix"] as const) await settings.reset(key);
  });

  it("accepts only a JSON object for files.transforms.presets_json", async () => {
    await expect(settings.set("files.transforms.presets_json", "{not json")).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await expect(settings.set("files.transforms.presets_json", "[]")).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await settings.set("files.transforms.presets_json", '{"thumb":{"width":150}}');
    await settings.reset("files.transforms.presets_json");
    expect(await settings.get("files.transforms.presets_json")).toBe("{}");
  });

  it("setGroup is all or nothing - one bad value writes none of the patch", async () => {
    await settings.reset("audit.retention_days");
    await expect(settings.setGroup("audit", { retention_days: 10, enabled: "yes" })).rejects.toMatchObject({
      code: "INVALID_SETTING",
    });
    expect(await settings.get("audit.retention_days")).toBe(365);
    expect(await settings.isOverridden("audit.retention_days")).toBe(false);
  });

  it("saving a key's default value drops its override instead of storing a copy", async () => {
    await settings.set("audit.retention_days", 90);
    expect(await settings.isOverridden("audit.retention_days")).toBe(true);
    await settings.setGroup("audit", { retention_days: 365 });
    expect(await settings.isOverridden("audit.retention_days")).toBe(false);
    expect(await settings.get("audit.retention_days")).toBe(365);
  });
  // Security regression (Administration.md §10.2, §12.3): a storage path had no bounds - set to the data directory (or
  // `/`, `/etc`), a backup's files.tar carried the master key and any server file to whoever downloaded it.
  it("confines the storage paths to directories of their own inside the data directory", async () => {
    const confined = new SettingsService(database, { dataDir: "/var/lib/totalbase" });
    for (const path of ["/var/lib/totalbase", "/var/lib/totalbase/", "/", "/etc", "/var/lib/totalbase/../../etc", "/var/lib/totalbase-other/files"]) {
      await expect(confined.set("files.storage_local_path", path), path).rejects.toMatchObject({ code: "INVALID_SETTING" });
    }
    await expect(confined.set("backups.local_path", "/var/lib/totalbase/files/backups")).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await confined.set("files.storage_local_path", "/var/lib/totalbase/uploads");
    await confined.set("backups.local_path", "/var/lib/totalbase/archives");
    expect(await confined.get("files.storage_local_path")).toBe("/var/lib/totalbase/uploads");
    await confined.reset("files.storage_local_path");
    await confined.reset("backups.local_path");
  });
  // An instance with its own TOTALBASE_DATA_DIR kept its files in /var/lib/totalbase/files, outside it - and its backups,
  // whose default path the confinement then refused (Administration.md §10.2).
  it("defaults the storage paths to the data directory's, stored as no override", async () => {
    const own = new SettingsService(database, { dataDir: "/srv/tb/" });
    expect(await own.get("files.storage_local_path")).toBe("/srv/tb/files");
    expect(await own.confinedStoragePath("backups.local_path")).toBe("/srv/tb/backups");
    await own.set("files.storage_local_path", "/srv/tb/files");
    expect(await own.isOverridden("files.storage_local_path")).toBe(false);
    await own.setGroup("files", { storage_local_path: "/srv/tb/uploads" });
    expect(await own.isOverridden("files.storage_local_path")).toBe(true);
    await own.reset("files.storage_local_path");
    expect(await own.get("files.storage_local_path")).toBe("/srv/tb/files");
    expect(await new SettingsService(database).get("files.storage_local_path")).toBe("/var/lib/totalbase/files");
  });
  // Security regression (Administration.md §7.2, §12.3): the confinement ran in set() only - the settings page's
  // group write (setGroup) stored `/` as the files path, and an override already stored was never checked again.
  it("confines the storage paths in a group write too, and checks a stored one again when it is used", async () => {
    const confined = new SettingsService(database, { dataDir: "/var/lib/totalbase" });
    await expect(confined.setGroup("files", { storage_local_path: "/" })).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await expect(confined.setGroup("backups", { local_path: "/var/lib/totalbase" })).rejects.toMatchObject({ code: "INVALID_SETTING" });
    expect(await confined.isOverridden("files.storage_local_path")).toBe(false);
    await database.query(`INSERT INTO totalbase.settings (key, value) VALUES ('files.storage_local_path', '"/etc"')`);
    confined.forget();
    try {
      await expect(confined.confinedStoragePath("files.storage_local_path")).rejects.toMatchObject({ code: "INVALID_SETTING" });
    } finally {
      await confined.reset("files.storage_local_path");
    }
    await confined.setGroup("files", { storage_local_path: "/var/lib/totalbase/uploads" });
    expect(await confined.confinedStoragePath("files.storage_local_path")).toBe("/var/lib/totalbase/uploads");
    await confined.reset("files.storage_local_path");
  });
  // Security regression (Administration.md §7.8): the CORS origins and trusted proxies took any text - `null` (what a
  // sandboxed page or a file sends) or `*` got credentialed CORS answers.
  it("takes only real origins for CORS and only addresses or ranges as trusted proxies", async () => {
    for (const bad of [["null"], ["*"], ["https://app.example.com/path"], ["app.example.com"], ["file://x"]]) {
      await expect(settings.set("security.cors_origins", bad), JSON.stringify(bad)).rejects.toMatchObject({ code: "INVALID_SETTING" });
    }
    await settings.set("security.cors_origins", ["https://app.example.com", "http://localhost:3000"]);
    for (const bad of [["*"], ["proxy.internal"], ["10.0.0.0/99"]]) {
      await expect(settings.set("security.trusted_proxies", bad), JSON.stringify(bad)).rejects.toMatchObject({ code: "INVALID_SETTING" });
    }
    await settings.set("security.trusted_proxies", ["10.0.0.1", "10.0.0.0/8", "::1"]);
    await settings.reset("security.cors_origins");
    await settings.reset("security.trusted_proxies");
  });
});
