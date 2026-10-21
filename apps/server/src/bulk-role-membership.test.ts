import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp } from "./test-support.js";

const PREFIX = "bulk-membership";
const ASSIGNMENTS = "/api/totalbase/table/users_roles";

/**
 * Bulk role membership (Security.md §9.4) through the Data
 * API, as the admin's Users list and a role's Members tab send it: a bulk
 * create skipping who already holds the role, a delete by `where` - each one
 * transaction with an audit row per assignment.
 */
describe("bulk role membership", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let adminToken: string;
  const roleIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    ({ app, context } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    for (const name of ["a", "b"]) roleIds.push((await context.roles.create(`${PREFIX}-${name}`, { appAccess: true })).id);
    for (const n of [1, 2, 3]) {
      const { rows } = await context.database.query<{ id: string }>(`INSERT INTO totalbase.users (email) VALUES ($1) RETURNING id`, [`${PREFIX}-${n}@example.com`]);
      userIds.push(rows[0]!.id);
    }
  });

  afterAll(async () => {
    await context.database.query(`DELETE FROM totalbase.users WHERE id = ANY($1)`, [userIds]);
    await context.database.query(`DELETE FROM totalbase.roles WHERE id = ANY($1)`, [roleIds]);
    await app.close();
  });

  const call = (method: "POST" | "DELETE", url: string, payload?: Record<string, unknown>) =>
    app.inject(payload ? { method, url, headers: { authorization: `Bearer ${adminToken}` }, payload } : { method, url, headers: { authorization: `Bearer ${adminToken}` } });
  const membersOf = async (roleId: string) =>
    (await context.database.query<{ user: string }>(`SELECT "user" FROM totalbase.users_roles WHERE role = $1 ORDER BY "user"`, [roleId])).rows.map((r) => r.user).sort();

  it("adds several users at once, skipping one who already holds the role", async () => {
    const [roleA] = roleIds;
    await context.database.query(`INSERT INTO totalbase.users_roles (role, "user") VALUES ($1, $2)`, [roleA, userIds[0]]);
    const res = await call("POST", `${ASSIGNMENTS}?bulk=true`, {
      data: userIds.map((user) => ({ role: roleA, user })),
      on_conflict: { target: ["user", "role"], action: "NOTHING" },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(await membersOf(roleA!)).toEqual([...userIds].sort());
  });

  it("removes several users by where, leaving the rest", async () => {
    const [roleA] = roleIds;
    const res = await call("DELETE", `${ASSIGNMENTS}?where[role][_eq]=${roleA}&where[user][_in]=${userIds[0]},${userIds[1]}`);
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(await membersOf(roleA!)).toEqual([userIds[2]]);
  });

  it("moves: into the new role first, then out of the old one", async () => {
    const [roleA, roleB] = roleIds;
    await call("POST", `${ASSIGNMENTS}?bulk=true`, { data: [{ role: roleB, user: userIds[2] }], on_conflict: { target: ["user", "role"], action: "NOTHING" } });
    await call("DELETE", `${ASSIGNMENTS}?where[role][_eq]=${roleA}&where[user][_in]=${userIds[2]}`);
    expect(await membersOf(roleA!)).toEqual([]);
    expect(await membersOf(roleB!)).toEqual([userIds[2]]);
  });

  it("audits each assignment written", async () => {
    const { rows } = await context.database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM totalbase.logs l
         JOIN totalbase.resources r ON r.id = l.resource
        WHERE r.name = 'users_roles' AND l.action = 'CREATE' AND l.payload->>'role' = $1`,
      [roleIds[0]],
    );
    expect(rows[0]!.n).toBeGreaterThanOrEqual(2);
  });
});
