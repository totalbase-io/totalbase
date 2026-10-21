import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv, type Queryable } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { RoleAssignmentsService, RolesService } from "@totalbase/permissions";
import { SettingsService } from "@totalbase/settings";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsersApisService } from "./users-apis-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));

interface ApiRow {
  id: string;
  user: string;
  name: string;
  description: string | null;
  plane: string;
  key_prefix: string;
  key_hash: string;
  active: boolean;
  expires_at: Date;
  last_used_at: Date | null;
  rotated_at: Date | null;
  revoked_at: Date | null;
  updated_at: Date;
}

/**
 * The `tokens_limited_changes` trigger (
 * Security.md §10.3): a personal access token written on
 * someone's behalf - `totalbase.actor_user_id` set, as every Data API write
 * is - may be renamed, described, deactivated or revoked, never moved to
 * another user or plane, re-keyed, extended or un-revoked; the revocation
 * time is PostgreSQL's clock. Issuing and rotating stay TotalBase's (no actor).
 */
describe("tokens_limited_changes trigger (integration)", () => {
  const suffix = Date.now().toString(36);
  let database: Database;
  let usersApis: UsersApisService;
  let userId: string;
  let otherUserId: string;
  let apiRoleId: string;
  const tokenIds: string[] = [];

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    const roles = new RolesService(database);
    const roleAssignments = new RoleAssignmentsService(database);
    usersApis = new UsersApisService(database, new SettingsService(database), roles, roleAssignments);
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.users (email) VALUES ($1), ($2) RETURNING id`,
      [`apis-trigger-${suffix}@example.com`, `apis-trigger-other-${suffix}@example.com`],
    );
    userId = rows[0]!.id;
    otherUserId = rows[1]!.id;
    // plane=API tokens need a role granting API access.
    apiRoleId = (await roles.create(`apis-trigger-${suffix}`, { apiAccess: true })).id;
    await roleAssignments.assignRoleToUser(userId, apiRoleId);
  });

  afterAll(async () => {
    if (tokenIds.length) await database.query(`DELETE FROM totalbase.tokens WHERE id = ANY($1::uuid[])`, [tokenIds]);
    if (userId) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]);
    if (otherUserId) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [otherUserId]);
    if (apiRoleId) await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [apiRoleId]);
    await database.close();
  });

  async function createToken(): Promise<ApiRow> {
    const { userApi } = await usersApis.create({ userId, name: `trigger ${suffix} ${tokenIds.length}`, plane: "API", ttlDays: 10 });
    tokenIds.push(userApi.id);
    return read(userApi.id);
  }

  async function read(id: string): Promise<ApiRow> {
    const { rows } = await database.query<ApiRow>(
      `SELECT id, "user", name, description, plane, key_prefix, key_hash, active, expires_at, last_used_at, rotated_at, revoked_at, updated_at
       FROM totalbase.tokens WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  }

  /** Runs `fn` as a write made on `actor`'s behalf - the setting is transaction-local, like the Data API's. */
  function asActor<T>(actor: string, fn: (client: Queryable) => Promise<T>): Promise<T> {
    return database.transaction(async (client) => {
      await client.query(`SELECT set_config('totalbase.actor_user_id', $1, true)`, [actor]);
      return fn(client);
    });
  }

  it("lets TotalBase itself (no actor) rotate and extend a token", async () => {
    const token = await createToken();
    await database.query(
      `UPDATE totalbase.tokens SET key_hash = 'rotated', rotated_at = now(), expires_at = now() + interval '100 days', last_used_at = now() WHERE id = $1`,
      [token.id],
    );
    const after = await read(token.id);
    expect(after.key_hash).toBe("rotated");
    expect(after.rotated_at).not.toBeNull();
    expect(after.last_used_at).not.toBeNull();
    expect(after.expires_at.getTime()).toBeGreaterThan(token.expires_at.getTime());
  });

  it("lets an actor rename, describe and deactivate a token - and touches updated_at", async () => {
    const token = await createToken();
    await asActor(userId, (client) =>
      client.query(`UPDATE totalbase.tokens SET name = $2, description = 'described', active = false WHERE id = $1`, [token.id, `renamed ${suffix}`]),
    );
    const after = await read(token.id);
    expect(after.name).toBe(`renamed ${suffix}`);
    expect(after.description).toBe("described");
    expect(after.active).toBe(false);
    expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(token.updated_at.getTime());
    expect(after.revoked_at).toBeNull();
  });

  it("keeps a token's owner, plane, key and expiry when an actor writes it", async () => {
    const token = await createToken();
    await asActor(userId, (client) =>
      client.query(
        `UPDATE totalbase.tokens
         SET "user" = $2, plane = 'ADMIN', key_prefix = 'tb_x', key_hash = 'rewritten', expires_at = now() + interval '365 days', last_used_at = now(), rotated_at = now()
         WHERE id = $1`,
        [token.id, otherUserId],
      ),
    );
    const after = await read(token.id);
    expect(after.user).toBe(userId);
    expect(after.plane).toBe(token.plane);
    expect(after.key_prefix).toBe(token.key_prefix);
    expect(after.key_hash).toBe(token.key_hash);
    expect(after.expires_at.getTime()).toBe(token.expires_at.getTime());
    expect(after.last_used_at).toEqual(token.last_used_at);
    expect(after.rotated_at).toEqual(token.rotated_at);
  });

  it("revokes at PostgreSQL's clock and never un-revokes for an actor", async () => {
    const token = await createToken();
    const before = Date.now();
    await asActor(userId, (client) => client.query(`UPDATE totalbase.tokens SET revoked_at = '2000-01-01T00:00:00Z' WHERE id = $1`, [token.id]));
    const revoked = await read(token.id);
    expect(revoked.revoked_at).not.toBeNull();
    expect(revoked.revoked_at!.getTime()).toBeGreaterThan(before - 60_000);
    await asActor(userId, (client) => client.query(`UPDATE totalbase.tokens SET revoked_at = NULL WHERE id = $1`, [token.id]));
    expect((await read(token.id)).revoked_at?.getTime()).toBe(revoked.revoked_at!.getTime());
  });
});
