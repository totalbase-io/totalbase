import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { setupTestApp } from "./test-support.js";

const P = "user-variable-protected-test";
const PASSWORD = "a-strong-enough-password";

/**
 * Regression: the Data API's read routes kept their own $USER resolver,
 * which read any column of the caller's users row - so a filter
 * like `where[name][_lt]=$USER.password_hash` compared a readable column
 * against the caller's password hash, leaking it one comparison at a time.
 * Protected columns are never readable (AGENTS.md section 10), not even as
 * a filter value.
 */
describe("$USER.* never resolves a protected column", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let token: string;
  let rolesResource: string;
  let previousExposure: string[];

  async function cleanup(): Promise<void> {
    await database.query(`DELETE FROM totalbase.users WHERE email LIKE '${P}%'`);
    await database.query(`DELETE FROM totalbase.permissions WHERE role IN (SELECT id FROM totalbase.roles WHERE name LIKE '${P}%')`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE '${P}%'`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await cleanup();
    const { rows } = await database.query<{ id: string; exposed_methods: string[] }>(
      `SELECT id, exposed_methods FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'roles'`,
    );
    rolesResource = rows[0]!.id;
    previousExposure = rows[0]!.exposed_methods;
    await database.query(`UPDATE totalbase.resources SET exposed_methods = '{GET}' WHERE id = $1`, [rolesResource]);
    const role = (await context.roles.create(`${P}-readers`, { appAccess: true })).id;
    await context.permissions.set(role, rolesResource, "READ", { effect: "ALLOW", fields: [{ field: "id", effect: "ALLOW" }, { field: "name", effect: "ALLOW" }] });
    const user = await context.auth.users.create({ email: `${P}-reader@example.com`, name: "Reader", passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    await context.roleAssignments.assignRoleToUser(user.id, role);
    token = (await context.auth.login({ email: `${P}-reader@example.com`, password: PASSWORD })).token;
  });

  afterAll(async () => {
    await database.query(`UPDATE totalbase.resources SET exposed_methods = $2 WHERE id = $1`, [rolesResource, previousExposure]);
    await cleanup();
    await app.close();
  });

  const read = (where: string) =>
    app.inject({
      method: "GET",
      url: `/api/totalbase/table/roles?fields=id&limit=1&${where}`,
      headers: { authorization: `Bearer ${token}` },
    });

  it("resolves an ordinary column of the caller's row", async () => {
    const response = await read(`where[name][_neq]=${encodeURIComponent("$USER.email")}`);
    expect(response.statusCode, response.body).toBe(200);
  });

  it("refuses password_hash, as if the column didn't exist", async () => {
    const response = await read(`where[name][_lt]=${encodeURIComponent("$USER.password_hash")}`);
    expect(response.statusCode).toBe(400);
    expect(response.json().errors[0]).toMatchObject({ code: "INVALID_QUERY", message: "Unknown $USER field: password_hash" });
  });
});
