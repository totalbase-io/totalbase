import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { WORKFLOWS_ROLE_NAME, WORKFLOWS_SYSTEM_USER_EMAIL } from "@totalbase/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));

/**
 * The DB-level lockdown of the seeded Workflows system account (migrations
 * 000075 and 000085): nobody but the system user may hold the Workflows role,
 * and the system user is never deleted - PostgreSQL refuses either, whatever
 * code path asks (a service, a script, SQL typed by hand).
 */
describe("Workflows system account protection triggers (integration)", () => {
  const suffix = Date.now().toString(36);
  let database: Database;
  let workflowsRoleId: string;
  let systemUserId: string;
  let userId: string;
  let plainRoleId: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    workflowsRoleId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.roles WHERE name = $1`, [WORKFLOWS_ROLE_NAME])).rows[0]!.id;
    systemUserId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email = $1`, [WORKFLOWS_SYSTEM_USER_EMAIL])).rows[0]!.id;
    userId = (await database.query<{ id: string }>(`INSERT INTO totalbase.users (email) VALUES ($1) RETURNING id`, [`workflows-protect-${suffix}@example.com`])).rows[0]!.id;
    plainRoleId = (await database.query<{ id: string }>(`INSERT INTO totalbase.roles (name) VALUES ($1) RETURNING id`, [`workflows-protect-${suffix}`])).rows[0]!.id;
  });

  afterAll(async () => {
    if (userId) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]); // cascades its assignments
    if (plainRoleId) await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [plainRoleId]);
    await database.close();
  });

  it("refuses the Workflows role on any user but the system account, and keeps the system account's own", async () => {
    await expect(
      database.query(`INSERT INTO totalbase.users_roles ("user", role) VALUES ($1, $2)`, [userId, workflowsRoleId]),
    ).rejects.toThrow(/reserved for TotalBase's own system account/);
    const { rows } = await database.query<{ user: string }>(`SELECT "user" FROM totalbase.users_roles WHERE role = $1`, [workflowsRoleId]);
    expect(rows.map((row) => row.user)).toEqual([systemUserId]);
  });

  it("refuses re-pointing the system account's assignment at another user", async () => {
    await expect(
      database.query(`UPDATE totalbase.users_roles SET "user" = $1 WHERE role = $2 AND "user" = $3`, [userId, workflowsRoleId, systemUserId]),
    ).rejects.toThrow(/reserved for TotalBase's own system account/);
  });

  it("lets any other role be assigned as usual", async () => {
    const { rowCount } = await database.query(`INSERT INTO totalbase.users_roles ("user", role) VALUES ($1, $2)`, [userId, plainRoleId]);
    expect(rowCount).toBe(1);
    await database.query(`DELETE FROM totalbase.users_roles WHERE "user" = $1 AND role = $2`, [userId, plainRoleId]);
  });

  it("refuses deleting the Workflows system user, whatever the statement matches", async () => {
    await expect(database.query(`DELETE FROM totalbase.users WHERE id = $1`, [systemUserId])).rejects.toThrow(/Workflows system user cannot be deleted/);
    // A wider DELETE that reaches it is refused as a whole - the plain user it also matched stays too.
    await expect(database.query(`DELETE FROM totalbase.users WHERE id = ANY($1::uuid[])`, [[systemUserId, userId]])).rejects.toThrow(/Workflows system user cannot be deleted/);
    const { rows } = await database.query(`SELECT id FROM totalbase.users WHERE id = ANY($1::uuid[])`, [[systemUserId, userId]]);
    expect(rows).toHaveLength(2);
  });
});
