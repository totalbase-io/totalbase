import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthProvidersService, type AuthProviderConfig } from "./auth-providers-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));

function config(overrides: Partial<AuthProviderConfig> = {}): AuthProviderConfig {
  return {
    client_id: "test-client-id",
    client_secret_key: "auth-pkg-test-secret",
    allowed_redirect_urls: ["https://app.example.com/callback"],
    ...overrides,
  };
}

describe("AuthProvidersService (integration)", () => {
  let database: Database;
  let providers: AuthProvidersService;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    providers = new AuthProvidersService(database);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.providers WHERE name LIKE 'auth-pkg-test-%'`);
    await database.close();
  });

  it("creates and resolves a GOOGLE provider by its fixed slug", async () => {
    const created = await providers.create({ type: "GOOGLE", name: "auth-pkg-test-google", configuration: config() });
    expect(created.enabled).toBe(true);
    expect(providers.slugFor(created)).toBe("google");

    const resolved = await providers.findBySlugOrThrow("google");
    expect(resolved.id).toBe(created.id);

    await providers.delete(created.id);
  });

  it("rejects a second GOOGLE provider - the route segment has nowhere else to point", async () => {
    const first = await providers.create({ type: "GOOGLE", name: "auth-pkg-test-google-1", configuration: config() });
    await expect(
      providers.create({ type: "GOOGLE", name: "auth-pkg-test-google-2", configuration: config() }),
    ).rejects.toThrow(TotalBaseError);
    await providers.delete(first.id);
  });

  it("resolves an OIDC provider by a slugified name, and allows several distinct ones", async () => {
    const a = await providers.create({
      type: "OIDC",
      name: "auth-pkg-test-My Company",
      configuration: config({ issuer: "https://issuer.example.com" }),
    });
    const b = await providers.create({
      type: "OIDC",
      name: "auth-pkg-test-Another Co",
      configuration: config({ issuer: "https://issuer2.example.com" }),
    });

    const slugA = providers.slugFor(a);
    const slugB = providers.slugFor(b);
    expect(slugA).not.toBe(slugB);

    const resolvedA = await providers.findBySlugOrThrow(slugA);
    expect(resolvedA.id).toBe(a.id);

    await providers.delete(a.id);
    await providers.delete(b.id);
  });

  it("throws AUTH_PROVIDER_NOT_FOUND for an unknown slug", async () => {
    await expect(providers.findBySlugOrThrow("nonexistent-slug")).rejects.toThrow(TotalBaseError);
  });

  it("update() can toggle enabled and replace configuration without touching name", async () => {
    const created = await providers.create({ type: "GITHUB", name: "auth-pkg-test-github", configuration: config() });
    const updated = await providers.update(created.id, { enabled: false });
    expect(updated.enabled).toBe(false);
    expect(updated.name).toBe(created.name);

    const reconfigured = await providers.update(created.id, {
      configuration: config({ allowed_redirect_urls: ["https://app.example.com/*"] }),
    });
    expect(reconfigured.configuration.allowed_redirect_urls).toEqual(["https://app.example.com/*"]);

    await providers.delete(created.id);
  });
});
