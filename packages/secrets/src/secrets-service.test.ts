import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SecretsService } from "./secrets-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));
const MASTER_KEY = "wBY8Qg4p0oel0wNzEGJjT0lLzQHghHGntGcoO36cbEU=";

describe("@totalbase/secrets (integration)", () => {
  let database: Database;
  let secrets: SecretsService;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    secrets = new SecretsService(database, MASTER_KEY);
  });

  afterEach(async () => {
    await database.query(`DELETE FROM totalbase.secrets WHERE key LIKE 'pkg-test-%'`);
  });

  afterAll(async () => {
    await database.close();
  });

  it("creates a secret and decrypts it back internally", async () => {
    await secrets.set("pkg-test-afip-token", "s3cr3t-value");
    expect(await secrets.decrypt("pkg-test-afip-token")).toBe("s3cr3t-value");
  });

  it("list() and exists() never return the value", async () => {
    await secrets.set("pkg-test-smtp-password", "hunter2");
    const list = await secrets.list();
    const entry = list.find((s) => s.key === "pkg-test-smtp-password");
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain("hunter2");
    expect(await secrets.exists("pkg-test-smtp-password")).toBe(true);
    expect(await secrets.exists("pkg-test-does-not-exist")).toBe(false);
  });

  it("replaces an existing secret's value on set() (write-only, replaceable)", async () => {
    await secrets.set("pkg-test-rotate", "old-value");
    await secrets.set("pkg-test-rotate", "new-value");
    expect(await secrets.decrypt("pkg-test-rotate")).toBe("new-value");
    const list = await secrets.list();
    expect(list.filter((s) => s.key === "pkg-test-rotate")).toHaveLength(1);
  });

  it("deletes a secret", async () => {
    await secrets.set("pkg-test-delete-me", "value");
    await secrets.delete("pkg-test-delete-me");
    await expect(secrets.decrypt("pkg-test-delete-me")).rejects.toMatchObject({ code: "SECRET_NOT_FOUND" });
  });

  it("rejects an invalid key", async () => {
    await expect(secrets.set("Not A Valid Key!", "value")).rejects.toMatchObject({ code: "INVALID_SECRET_KEY" });
  });

  it("accepts dotted and hyphenated keys (mail.password, afip-bearer-token)", async () => {
    await secrets.set("pkg-test.mail.password", "smtp-pass");
    await secrets.set("pkg-test-afip-bearer-token", "bearer-value");
    expect(await secrets.decrypt("pkg-test.mail.password")).toBe("smtp-pass");
    expect(await secrets.decrypt("pkg-test-afip-bearer-token")).toBe("bearer-value");
  });
});
