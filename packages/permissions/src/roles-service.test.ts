import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RoleAssignmentsService } from "./role-assignments-service.js";
import { RolesService } from "./roles-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));

describe("RolesService + RoleAssignmentsService (integration)", () => {
  let database: Database;
  let roles: RolesService;
  let assignments: RoleAssignmentsService;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    roles = new RolesService(database);
    assignments = new RoleAssignmentsService(database);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.users WHERE email LIKE 'roles-pkg-test-%'`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE 'roles-pkg-test-%'`);
    await database.close();
  });

  it("creates, updates and deletes a role", async () => {
    const role = await roles.create("roles-pkg-test-editor");
    expect(role.active).toBe(true);

    await roles.update(role.id, { name: "roles-pkg-test-editor-renamed", active: false });
    const updated = await roles.findById(role.id);
    expect(updated?.name).toBe("roles-pkg-test-editor-renamed");
    expect(updated?.active).toBe(false);

    await roles.delete(role.id);
    expect(await roles.findById(role.id)).toBeNull();
  });

  it("assigns and removes roles for a user, replacing the full set", async () => {
    const roleA = await roles.create("roles-pkg-test-a");
    const roleB = await roles.create("roles-pkg-test-b");
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.users (email) VALUES ('roles-pkg-test-user@example.com') RETURNING id`,
    );
    const userId = rows[0]!.id;

    await assignments.assignRoleToUser(userId, roleA.id);
    expect(await assignments.listRolesForUser(userId)).toEqual([roleA.id]);

    // Assigning the same role twice is a no-op (ON CONFLICT DO NOTHING).
    await assignments.assignRoleToUser(userId, roleA.id);
    expect(await assignments.listRolesForUser(userId)).toEqual([roleA.id]);

    await assignments.setRolesForUser(userId, [roleB.id]);
    expect(await assignments.listRolesForUser(userId)).toEqual([roleB.id]);

    await database.query(`DELETE FROM totalbase.users_roles WHERE "user" = $1 AND role = $2`, [userId, roleB.id]);
    expect(await assignments.listRolesForUser(userId)).toEqual([]);
  });
});
