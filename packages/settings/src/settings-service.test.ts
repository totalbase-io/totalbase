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
  "auth.password_min_length",
  "audit.retention_days",
  "api.max_limit",
  "smtp.port",
  "files.transforms.presets_json",
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
    await expect(settings.set("smtp.port", 70_000)).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await expect(settings.set("auth.password_min_length", 500)).rejects.toMatchObject({
      message: "auth.password_min_length: Expected a whole number from 8 to 128.",
    });
    expect(await settings.isOverridden("api.max_limit")).toBe(false);
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
});
