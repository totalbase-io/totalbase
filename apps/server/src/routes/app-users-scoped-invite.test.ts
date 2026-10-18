import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcileCatalog } from "../catalog-refresh.js";
import type { AppContext } from "../context.js";
import { setupTestApp } from "../test-support.js";

const P = "app-users-scoped";
const COLUMN = "app_users_scoped_branch";
const PASSWORD = "a-strong-enough-password";

/**
 * A delegated invitation scoped by a column the project added to the users table
 * (Specification_Security.md §9.3, Docs_Writing_Findings #8): a CREATE grant whose row filter is
 * `branch = $USER.branch` refused every invitation while the account was created with email and
 * name only. `extra` sets those columns in the same transaction, before the filter is checked.
 */
describe("delegated invitation scoped by a project column", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let token: string;
  const userIds: string[] = [];
  let roleId: string;

  const invite = (data: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/app/api/users/invitations", headers: { authorization: `Bearer ${token}` }, payload: { data } });
  const branchOf = async (id: string) =>
    (await database.query<{ branch: string | null }>(`SELECT ${COLUMN} AS branch FROM totalbase.users WHERE id = $1`, [id])).rows[0]?.branch;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`ALTER TABLE totalbase.users ADD COLUMN IF NOT EXISTS ${COLUMN} text`);
    await reconcileCatalog(context);
    await context.settings.set("smtp.host", "");

    const users = (await database.query<{ id: string }>(`SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'users'`)).rows[0]!.id;
    roleId = (await context.roles.create(`${P}-branch-managers`, { appAccess: true })).id;
    await context.permissions.set(roleId, users, "CREATE", {
      effect: "ALLOW",
      fields: ["email", "name", COLUMN].map((field) => ({ field, effect: "ALLOW" as const })),
      where: { [COLUMN]: { _eq: `$USER.${COLUMN}` } },
    });

    const manager = await context.auth.users.create({ email: `${P}-manager@example.com`, name: "Manager", passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    userIds.push(manager.id);
    await database.query(`UPDATE totalbase.users SET ${COLUMN} = 'NORTH' WHERE id = $1`, [manager.id]);
    await context.roleAssignments.assignRoleToUser(manager.id, roleId);
    token = (await context.auth.login({ email: `${P}-manager@example.com`, password: PASSWORD })).token;
  });

  afterAll(async () => {
    const { rows } = await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email LIKE '${P}-%@example.com'`);
    for (const id of new Set([...userIds, ...rows.map((r) => r.id)])) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    await database.query(`DELETE FROM totalbase.permissions WHERE role = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`ALTER TABLE totalbase.users DROP COLUMN IF EXISTS ${COLUMN}`);
    await context.settings.reset("smtp.host");
    await app.close();
  });

  it("lists the project columns the caller may set when inviting", async () => {
    const res = await app.inject({ method: "GET", url: "/app/api/users/invitation-columns", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual([expect.objectContaining({ name: COLUMN, dataType: "text", nullable: true, relation: null, values: null })]);
  });

  it("invites into the inviter's own branch - the column set before the row filter is checked", async () => {
    const res = await invite({ email: `${P}-north@example.com`, name: "North", extra: { [COLUMN]: "NORTH" } });
    expect(res.statusCode, res.body).toBe(201);
    expect(await branchOf(res.json().data.id)).toBe("NORTH");
  });

  it("refuses another branch, or none, creating nothing", async () => {
    for (const extra of [{ [COLUMN]: "SOUTH" }, {}]) {
      const res = await invite({ email: `${P}-other@example.com`, name: "Other", extra });
      expect(res.statusCode, res.body).toBe(403);
    }
    expect((await database.query(`SELECT 1 FROM totalbase.users WHERE email = '${P}-other@example.com'`)).rows).toHaveLength(0);
  });

  it("sets only project columns the grant allows", async () => {
    const own = await invite({ email: `${P}-own@example.com`, name: "Own", extra: { owner: true } });
    expect(own.statusCode).toBe(403);
    const unknown = await invite({ email: `${P}-unknown@example.com`, name: "Unknown", extra: { [COLUMN]: "NORTH", no_such_column: 1 } });
    expect(unknown.statusCode).toBe(403);
  });
});
