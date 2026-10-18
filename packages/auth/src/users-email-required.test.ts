import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OAuthService } from "./oauth-service.js";
import type { OAuthIdentity } from "./oauth-identity.js";
import { UsersService } from "./users-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));

describe("every user has an email (integration)", () => {
  let database: Database;
  let users: UsersService;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    users = new UsersService(database);
  });

  afterAll(async () => {
    await database.close();
  });

  it("UsersService refuses a user without one", async () => {
    for (const email of [undefined, null, "", "   "]) {
      await expect(users.create({ email: email as string, name: "No email" }), String(email)).rejects.toMatchObject({
        code: "INVALID_QUERY",
        message: "Email is required.",
      });
    }
  });

  it("PostgreSQL itself refuses one - whoever writes (Data API, SQL Console, a script)", async () => {
    await expect(database.query(`INSERT INTO totalbase.users (name) VALUES ('no email')`)).rejects.toMatchObject({
      code: "NOT_NULL_VIOLATION",
    });
    await expect(database.query(`INSERT INTO totalbase.users (email, name) VALUES ('  ', 'blank')`)).rejects.toMatchObject({
      code: "CHECK_VIOLATION",
    });
  });

  it("an OAuth first sign-in without an email creates no account", async () => {
    const oauth = new OAuthService(database, null as never, null as never, null as never, null as never, "", async () => "");
    const identity: OAuthIdentity = { subject: `no-email-${Date.now()}`, email: null, emailVerified: false, username: "ghost", avatarUrl: null };
    const provider = { id: "00000000-0000-4000-8000-000000000000" };
    const before = (await database.query<{ n: string }>(`SELECT count(*) AS n FROM totalbase.users`)).rows[0]!.n;
    await expect((oauth as unknown as { resolveUser: (p: unknown, i: OAuthIdentity) => Promise<unknown> }).resolveUser(provider, identity))
      .rejects.toMatchObject({ code: "OAUTH_EMAIL_REQUIRED" });
    expect((await database.query<{ n: string }>(`SELECT count(*) AS n FROM totalbase.users`)).rows[0]!.n).toBe(before);
  });
});
