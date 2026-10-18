import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp } from "./test-support.js";

const P = "default-grants-test";
const PASSWORD = "a-strong-enough-password";
const CUSTOM_COLUMN = "default_grants_test_department";

/**
 * POST /admin/api/roles/{id}/totalbase-defaults (Specification_Security.md
 * §10.5): what an ordinary App user gets on TotalBase's own tables - and
 * that each "own" grant really stops at the user's own rows and columns.
 */
describe("Default permissions on TotalBase's own tables", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let adminToken: string;
  const users: Record<"alice" | "bob", { id: string; token: string }> = {} as never;

  const as = (token: string, method: string, url: string, payload?: Record<string, unknown>) =>
    app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${token}` }, ...(payload && { payload }) });
  const folder = (token: string, name: string) => as(token, "POST", "/api/totalbase/table/folders", { data: { name } });

  async function cleanup(): Promise<void> {
    await database.query(`DELETE FROM totalbase.folders WHERE name LIKE '${P}%'`);
    await database.query(`DELETE FROM totalbase.users WHERE email LIKE '${P}%'`);
    await database.query(`DELETE FROM totalbase.permissions WHERE role IN (SELECT id FROM totalbase.roles WHERE name LIKE '${P}%')`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE '${P}%'`);
    await database.query(`ALTER TABLE totalbase.users DROP COLUMN IF EXISTS ${CUSTOM_COLUMN}`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await cleanup();
    // A column the developer added: the default never lets a user change it on their own account.
    await database.query(`ALTER TABLE totalbase.users ADD COLUMN ${CUSTOM_COLUMN} text`);
    roleId = (await context.roles.create(`${P}-users`, { appAccess: true })).id;
    for (const name of ["alice", "bob"] as const) {
      const email = `${P}-${name}@example.com`;
      const user = await context.auth.users.create({ email, name, passwordHash: await hashPassword(PASSWORD), emailVerified: true });
      await context.roleAssignments.assignRoleToUser(user.id, roleId);
      users[name] = { id: user.id, token: (await context.auth.login({ email, password: PASSWORD })).token };
    }
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("applies the same grants twice without change, and 404s an unknown role", async () => {
    const first = await as(adminToken, "POST", `/admin/api/roles/${roleId}/totalbase-defaults`);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data.missing).toEqual([]);
    const count = async () => Number((await database.query(`SELECT count(*) FROM totalbase.permissions WHERE role = $1`, [roleId])).rows[0]!.count);
    const granted = await count();
    expect(granted).toBe(first.json().data.applied.length);
    const second = await as(adminToken, "POST", `/admin/api/roles/${roleId}/totalbase-defaults`);
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toMatchObject({ applied: [], kept: first.json().data.applied });
    expect(await count()).toBe(granted);
    expect((await as(adminToken, "POST", "/admin/api/roles/00000000-0000-4000-8000-000000000000/totalbase-defaults")).statusCode).toBe(404);
  });

  it("lets a user change their own name, never a column the developer added nor someone else's account", async () => {
    const { alice, bob } = users;
    const own = await as(alice.token, "PATCH", `/api/totalbase/table/users/${alice.id}`, { data: { name: "Alice R." } });
    expect(own.statusCode, own.body).toBe(200);
    const custom = await as(alice.token, "PATCH", `/api/totalbase/table/users/${alice.id}`, { data: { [CUSTOM_COLUMN]: "Finance" } });
    expect(custom.statusCode).toBeGreaterThanOrEqual(400);
    const other = await as(alice.token, "PATCH", `/api/totalbase/table/users/${bob.id}`, { data: { name: "Not Bob" } });
    expect(other.statusCode).toBeGreaterThanOrEqual(400);
    const { rows } = await database.query(`SELECT id, name, ${CUSTOM_COLUMN} AS custom FROM totalbase.users WHERE id = ANY($1) ORDER BY name`, [[alice.id, bob.id]]);
    expect(rows).toEqual([{ id: alice.id, name: "Alice R.", custom: null }, { id: bob.id, name: "bob", custom: null }]);
  });

  it("lets everyone see every folder, and change or delete only their own", async () => {
    const { alice, bob } = users;
    const bobs = await folder(bob.token, `${P}-bob`);
    expect(bobs.statusCode, bobs.body).toBe(201);
    const bobsId = bobs.json().data.id;
    const seen = await as(alice.token, "GET", `/api/totalbase/table/folders?where[id][_eq]=${bobsId}`);
    expect(seen.json().data).toHaveLength(1);
    expect((await as(alice.token, "PATCH", `/api/totalbase/table/folders/${bobsId}`, { data: { name: `${P}-taken` } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await as(alice.token, "DELETE", `/api/totalbase/table/folders/${bobsId}`)).statusCode).toBeGreaterThanOrEqual(400);

    const alices = (await folder(alice.token, `${P}-alice`)).json().data.id;
    expect((await as(alice.token, "PATCH", `/api/totalbase/table/folders/${alices}`, { data: { name: `${P}-alice-2` } })).statusCode).toBe(200);
    expect((await as(alice.token, "DELETE", `/api/totalbase/table/folders/${alices}`)).statusCode).toBeLessThan(300);
    const { rows } = await database.query(`SELECT name FROM totalbase.folders WHERE name LIKE '${P}%'`);
    expect(rows).toEqual([{ name: `${P}-bob` }]);
  });

  it("lets a user sign out one of their own sessions, not someone else's", async () => {
    const { alice, bob } = users;
    await context.auth.login({ email: `${P}-alice@example.com`, password: PASSWORD });
    const sessions = async (user: string) =>
      (await database.query<{ id: string; revoked_at: Date | null }>(`SELECT id, revoked_at FROM totalbase.sessions WHERE "user" = $1 ORDER BY created_at`, [user])).rows;
    const [, second] = await sessions(alice.id);
    const revoked = await as(alice.token, "PATCH", `/api/totalbase/table/sessions/${second!.id}`, { data: { revoked_at: new Date().toISOString() } });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((await sessions(alice.id)).map((s) => s.revoked_at !== null)).toEqual([false, true]);

    const [bobs] = await sessions(bob.id);
    expect((await as(alice.token, "PATCH", `/api/totalbase/table/sessions/${bobs!.id}`, { data: { revoked_at: new Date().toISOString() } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await sessions(bob.id))[0]!.revoked_at).toBeNull();
  });

  it("lets a user read their own activity - its table's name, never another user's entries nor the payload", async () => {
    const { alice, bob } = users;
    const folders = (await database.query<{ id: string }>(`SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'folders' AND status = 'ACTIVE'`)).rows[0]!.id;
    const entry = async (principal: string) =>
      (await database.query<{ id: string }>(
        `INSERT INTO totalbase.logs (request_id, principal_type, principal, resource, action, status, source, payload, changes, metadata, started_at)
         VALUES (gen_random_uuid(), 'USER', $1, $2, 'UPDATE', 'EXECUTED', 'app', '{"name":"secret"}', '{"before":{"salary":1}}', '{"pk":"x"}', now()) RETURNING id`,
        [principal, folders],
      )).rows[0]!.id;
    const ids = [await entry(alice.id), await entry(bob.id)];
    try {
      const own = await as(alice.token, "GET", `/api/totalbase/table/logs?where[id][_in]=${ids.join(",")}`);
      expect(own.statusCode, own.body).toBe(200);
      expect(own.json().data.map((row: { id: string }) => row.id)).toEqual([ids[0]]);
      for (const hidden of ["payload", "changes", "metadata", "where_clause", "sql_text"]) expect(own.json().data[0]).not.toHaveProperty(hidden);

      const named = await as(alice.token, "GET", `/api/totalbase/table/logs?where[id][_eq]=${ids[0]}&fields=id,resource.schema,resource.name`);
      expect(named.statusCode, named.body).toBe(200);
      expect(named.json().data).toEqual([{ id: ids[0], "resource.schema": "totalbase", "resource.name": "folders" }]);
      expect((await as(alice.token, "GET", `/api/totalbase/table/logs?fields=id,payload`)).statusCode).toBe(403);
      // The registry itself stays unreadable - only the path from one's own entries.
      expect((await as(alice.token, "GET", `/api/totalbase/table/resources`)).statusCode).toBe(403);
    } finally {
      await database.query(`DELETE FROM totalbase.logs WHERE id = ANY($1)`, [ids]);
    }
  });

  it("keeps a grant the role already had - a default never narrows the author's own", async () => {
    const role = (await context.roles.create(`${P}-broad`, { appAccess: true })).id;
    try {
      const users = (await database.query<{ id: string }>(`SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'users' AND status = 'ACTIVE'`)).rows[0]!.id;
      // READ on every user, set before the defaults.
      await context.permissions.set(role, users, "READ", { effect: "ALLOW", where: null, fields: [{ field: "id", effect: "ALLOW" }, { field: "name", effect: "ALLOW" }] });
      const applied = await as(adminToken, "POST", `/admin/api/roles/${role}/totalbase-defaults`);
      expect(applied.statusCode, applied.body).toBe(200);
      expect(applied.json().data.kept).toEqual([{ table: "users", action: "READ" }]);
      expect(applied.json().data.applied).toContainEqual({ table: "users", action: "UPDATE" });
      const read = (await database.query<{ where_clause: unknown }>(`SELECT where_clause FROM totalbase.permissions WHERE role = $1 AND resource = $2 AND action = 'READ'`, [role, users])).rows[0]!;
      expect(read.where_clause).toBeNull();
    } finally {
      await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [role]);
    }
  });
});
