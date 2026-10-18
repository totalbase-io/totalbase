import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { TOTALBASE_USER_COLUMNS } from "@totalbase/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { setupTestApp } from "../test-support.js";

const COLUMN = "admin_users_extra_test_branch";

/**
 * users is the project's to extend (AGENTS.md §11): TotalBase knows its own columns, and the
 * Admin API's user list filters by the ones a project added.
 */
describe("A project's own columns on users", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const admin = await context.auth.users.create({ email: "admin-users-extra-admin@example.com", name: "Admin" });
    userIds.push(admin.id);
    await context.roleAssignments.assignRoleToUser(admin.id, await context.roles.getAdministratorsRoleId());
    adminToken = (await context.usersApis.create({ userId: admin.id, name: "admin-users-extra", plane: "ADMIN" })).plainKey;
  });

  afterAll(async () => {
    await database.query(`ALTER TABLE totalbase.users DROP COLUMN IF EXISTS ${COLUMN}`);
    for (const id of userIds) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    await app.close();
  });

  it("knows exactly TotalBase's own columns - a migration adding one adds it to TOTALBASE_USER_COLUMNS", async () => {
    const { rows } = await database.query<{ name: string }>(
      `SELECT attname AS name FROM pg_attribute WHERE attrelid = 'totalbase.users'::regclass AND attnum > 0 AND NOT attisdropped`,
    );
    const own = rows.map((r) => r.name).filter((name) => name !== COLUMN);
    expect([...own].sort()).toEqual([...TOTALBASE_USER_COLUMNS].sort());
  });

  it("filters the user list by a column the project added, and refuses any other", async () => {
    await database.query(`ALTER TABLE totalbase.users ADD COLUMN IF NOT EXISTS ${COLUMN} text`);
    expect(await context.auth.users.projectColumns()).toContain(COLUMN);
    const listed = await app.inject({ method: "GET", url: "/admin/api/users/project-columns", headers: { authorization: `Bearer ${adminToken}` } });
    expect(listed.json().data).toContainEqual({ name: COLUMN });
    const north = await context.auth.users.create({ email: "admin-users-extra-north@example.com", name: "North" });
    const none = await context.auth.users.create({ email: "admin-users-extra-none@example.com", name: "None" });
    userIds.push(north.id, none.id);
    await database.query(`UPDATE totalbase.users SET ${COLUMN} = 'NORTH' WHERE id = $1`, [north.id]);

    const list = (query: string) =>
      app.inject({ method: "GET", url: `/admin/api/users?limit=200&q=admin-users-extra-&${query}`, headers: { authorization: `Bearer ${adminToken}` } });
    const byValue = await list(`extra%5B${COLUMN}%5D=NORTH`);
    expect(byValue.statusCode, byValue.body).toBe(200);
    expect(byValue.json().data.map((u: { id: string }) => u.id)).toEqual([north.id]);
    const empty = (await list(`extra%5B${COLUMN}%5D=`)).json().data.map((u: { id: string }) => u.id);
    expect(empty).toContain(none.id);
    expect(empty).not.toContain(north.id);
    const own = await list("extra%5Bpassword_hash%5D=x");
    expect([own.statusCode, own.json().errors[0].code]).toEqual([400, "INVALID_QUERY"]);
  });
});
