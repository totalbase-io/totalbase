import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcileCatalog } from "./catalog-refresh.js";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp } from "./test-support.js";

const P = "role-hierarchy";
const SITE = "role_hierarchy_site";
const TABLE = "role_hierarchy_controls";
const PASSWORD = "a-strong-enough-password";

/**
 * Security.md §9.5, §9.6, §6.11 - the driving case: one node per site. A site's manager (MANAGE_ROLES) creates a
 * role under theirs, grants it within the ceiling and assigns it; the grant is the same rule for whoever holds it
 * (`site = $USER.site`), and a cut on the manager's role reaches it on the next request.
 */
describe("role hierarchy - delegated grants within the ceiling", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let managerRole: string;
  let foreignRole: string;
  let operatorRole: string;
  let controls: string;
  let managerToken: string;
  let managerId: string;
  let adminToken: string;
  const tables: Record<string, string> = {};
  const fields = (...names: string[]) => names.map((field) => ({ field, effect: "ALLOW" as const }));

  const call = (method: string, url: string, token: string, payload?: object) => {
    const headers = { authorization: `Bearer ${token}` };
    return payload === undefined
      ? app.inject({ method: method as "GET", url, headers })
      : app.inject({ method: method as "GET", url, headers, payload });
  };
  const grantUrl = (role: string, action: string) => `/app/api/roles/${role}/resources/${controls}/permissions/${action}`;

  async function person(name: string, site: string, role?: string): Promise<{ id: string; token: string }> {
    const user = await context.auth.users.create({ email: `${P}-${name}@example.com`, name, passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    await database.query(`UPDATE totalbase.users SET ${SITE} = $2 WHERE id = $1`, [user.id, site]);
    if (role) await context.roleAssignments.assignRoleToUser(user.id, role);
    return { id: user.id, token: (await context.auth.login({ email: `${P}-${name}@example.com`, password: PASSWORD })).token };
  }

  async function cleanup(): Promise<void> {
    await database.query(`DELETE FROM totalbase.users WHERE email LIKE '${P}-%'`);
    await database.query(`DELETE FROM totalbase.permissions WHERE role IN (SELECT id FROM totalbase.roles WHERE name LIKE '${P}-%')`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE '${P}-%' AND parent IS NOT NULL`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE '${P}-%'`);
    await database.query(`DELETE FROM totalbase.dashboards WHERE name LIKE '${P}-%'`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await cleanup();
    await database.query(`ALTER TABLE totalbase.users ADD COLUMN IF NOT EXISTS ${SITE} text`);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await database.query(`CREATE TABLE public.${TABLE} (id serial PRIMARY KEY, site text NOT NULL, kind text NOT NULL, notes text)`);
    await database.query(`INSERT INTO public.${TABLE} (site, kind, notes) VALUES ('A', 'night', 'a1'), ('A', 'day', 'a2'), ('B', 'night', 'b1'), ('B', 'day', 'b2')`);
    await reconcileCatalog(context);
    const { rows } = await database.query<{ id: string; name: string; schema: string }>(
      `SELECT id, name, "schema" FROM totalbase.resources WHERE status = 'ACTIVE' AND (("schema" = 'public' AND name = $1) OR ("schema" = 'totalbase' AND name IN ('roles', 'users_roles')))`,
      [TABLE],
    );
    for (const row of rows) tables[row.name] = row.id;
    controls = tables[TABLE]!;
    await database.query(`UPDATE totalbase.resources SET exposed_methods = ARRAY['GET','POST','PATCH','DELETE'] WHERE id = $1`, [controls]);

    // "Site A managers": a root an administrator configured - MANAGE_ROLES, its site's controls, and enough of
    // roles and users_roles to create and assign the roles under it.
    managerRole = (await context.roles.create(`${P}-site-a-managers`, { appAccess: true })).id;
    foreignRole = (await context.roles.create(`${P}-governing-body`, { appAccess: true })).id;
    await database.query(`INSERT INTO totalbase.roles_capabilities (role, capability, effect) VALUES ($1, 'MANAGE_ROLES', 'ALLOW')`, [managerRole]);
    await context.permissions.set(managerRole, controls, "READ", { effect: "ALLOW", where: { site: { _eq: `$USER.${SITE}` } }, fields: fields("id", "site", "kind") });
    await context.permissions.set(managerRole, tables.roles!, "READ", { effect: "ALLOW", fields: fields("id", "name", "parent") });
    await context.permissions.set(managerRole, tables.roles!, "CREATE", { effect: "ALLOW", fields: fields("name", "parent") });
    await context.permissions.set(managerRole, tables.roles!, "UPDATE", { effect: "ALLOW", fields: fields("id", "name", "parent") });
    await context.permissions.set(managerRole, tables.users_roles!, "READ", { effect: "ALLOW", fields: fields("id", "user", "role") });
    await context.permissions.set(managerRole, tables.users_roles!, "CREATE", { effect: "ALLOW", fields: fields("user", "role") });
    const manager = await person("manager-a", "A", managerRole);
    managerToken = manager.token;
    managerId = manager.id;
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
  });

  afterAll(async () => {
    await cleanup();
    await database.query(`DROP TABLE IF EXISTS public.${TABLE}`);
    await database.query(`ALTER TABLE totalbase.users DROP COLUMN IF EXISTS ${SITE}`);
    await reconcileCatalog(context);
    await app.close();
  });

  it("creates a role only under the roles it manages", async () => {
    const created = await call("POST", "/api/totalbase/table/roles", managerToken, { data: { name: `${P}-night-operator-a`, parent: managerRole } });
    expect(created.statusCode, created.body).toBe(201);
    operatorRole = created.json().data.id as string;
    const elsewhere = await call("POST", "/api/totalbase/table/roles", managerToken, { data: { name: `${P}-elsewhere`, parent: foreignRole } });
    expect(elsewhere.statusCode).toBe(403);
    // Its own role is not below itself: it can't rename or re-parent it.
    expect((await call("PATCH", `/api/totalbase/table/roles/${managerRole}`, managerToken, { data: { name: `${P}-renamed` } })).statusCode).toBe(403);
    expect((await call("PATCH", `/api/totalbase/table/roles/${operatorRole}`, managerToken, { data: { name: `${P}-night-operator-a2` } })).statusCode).toBe(200);
  });

  // Security regression: ownership was judged on the row the UPDATE returned - once `parent` pointed into the
  // manager's tree, the role "was" theirs. It is judged on where the role stood before the write.
  it("never pulls a foreign role into its subtree - by key, by upsert, in a transaction", async () => {
    const parentOf = async (id: string) => (await database.query<{ parent: string | null }>(`SELECT parent FROM totalbase.roles WHERE id = $1`, [id])).rows[0]!.parent;
    await database.query(`INSERT INTO totalbase.roles_capabilities (role, capability, effect) VALUES ($1, 'TRANSACTIONS', 'ALLOW') ON CONFLICT DO NOTHING`, [managerRole]);
    for (const parent of [managerRole, operatorRole]) {
      const moved = await call("PATCH", `/api/totalbase/table/roles/${foreignRole}`, managerToken, { data: { parent } });
      expect([moved.statusCode, moved.json().errors?.[0]?.code], moved.body).toEqual([403, "PERMISSION_DENIED"]);
    }
    const upsert = await call("POST", "/api/totalbase/table/roles", managerToken, {
      data: { name: `${P}-governing-body`, parent: managerRole },
      on_conflict: { target: ["name"], action: "UPDATE", data: { parent: managerRole } },
    });
    expect(upsert.statusCode, upsert.body).toBe(403);
    const transaction = await call("POST", "/api/transactions", managerToken, {
      operations: [{ key: "move", operation: "update", schema: "totalbase", table: "roles", id: foreignRole, data: { parent: managerRole } }],
    });
    expect(transaction.statusCode, transaction.body).toBe(403);
    expect(await parentOf(foreignRole)).toBeNull();
    // A role already below its own still moves within its tree.
    expect((await call("PATCH", `/api/totalbase/table/roles/${operatorRole}`, managerToken, { data: { parent: managerRole } })).statusCode).toBe(200);
  });

  it("never changes a role it holds, even one it created (Security.md §9.4)", async () => {
    const created = await call("POST", "/api/totalbase/table/roles", managerToken, { data: { name: `${P}-held-by-creator`, parent: managerRole } });
    expect(created.statusCode, created.body).toBe(201);
    const held = created.json().data.id as string;
    await context.roleAssignments.assignRoleToUser(managerId, held);
    const renamed = await call("PATCH", `/api/totalbase/table/roles/${held}`, managerToken, { data: { name: `${P}-held-renamed` } });
    expect(renamed.statusCode, renamed.body).toBe(403);
    await database.query(`DELETE FROM totalbase.users_roles WHERE "user" = $1 AND role = $2`, [managerId, held]);
  });

  it("grants within the ceiling - ALLOW only, never an action or field the parent lacks - and records who granted", async () => {
    const ok = await call("PUT", grantUrl(operatorRole, "READ"), managerToken, { data: { effect: "ALLOW", where: { kind: { _eq: "night" } }, fields: fields("id", "site", "kind") } });
    expect(ok.statusCode, ok.body).toBe(200);
    const { rows } = await database.query<{ email: string }>(
      `SELECT u.email FROM totalbase.permissions p JOIN totalbase.users u ON u.id = p.granted_by WHERE p.role = $1 AND p.resource = $2`,
      [operatorRole, controls],
    );
    expect(rows[0]?.email).toBe(`${P}-manager-a@example.com`);

    const field = await call("PUT", grantUrl(operatorRole, "READ"), managerToken, { data: { effect: "ALLOW", fields: fields("id", "notes") } });
    expect(field.statusCode).toBe(403);
    expect(field.json().errors[0]).toMatchObject({ code: "PERMISSION_EXCEEDS_CEILING", meta: { fields: ["notes"] } });
    const action = await call("PUT", grantUrl(operatorRole, "UPDATE"), managerToken, { data: { effect: "ALLOW", fields: fields("kind") } });
    expect(action.json().errors[0].code).toBe("PERMISSION_EXCEEDS_CEILING");
    const deny = await call("PUT", grantUrl(operatorRole, "DELETE"), managerToken, { data: { effect: "DENY" } });
    expect([deny.statusCode, deny.json().errors[0].code]).toEqual([403, "PERMISSION_DENIED"]);
    // Security regression: a grant's filter decides which rows its holder sees, so one on a column the parent can't
    // read told that column's values through the rows that appeared - in a row filter, a payload check or a $ROW.
    for (const grant of [
      { effect: "ALLOW", where: { notes: { _like: "a%" } }, fields: fields("id") },
      { effect: "ALLOW", where: { kind: { _eq: "$ROW.notes" } }, fields: fields("id") },
      { effect: "ALLOW", where: { _or: [{ site: { _eq: "A" } }, { "site.secret": { _eq: "x" } }] }, fields: fields("id") },
    ]) {
      const filtered = await call("PUT", grantUrl(operatorRole, "READ"), managerToken, { data: grant });
      expect([filtered.statusCode, filtered.json().errors?.[0]?.code], JSON.stringify(grant)).toEqual([403, "PERMISSION_EXCEEDS_CEILING"]);
    }
    const checked = await call("PUT", grantUrl(operatorRole, "READ"), managerToken, { data: { effect: "ALLOW", fields: fields("id"), payloadChecks: [{ rule: { notes: { _nnull: true } } }] } });
    expect(checked.json().errors?.[0]).toMatchObject({ code: "PERMISSION_EXCEEDS_CEILING", meta: { fields: ["notes"] } });
    // Security regression (DELEG-01): a manager's `deny_fields` was dropped, the columns left allowed - refused by name.
    for (const [url, data] of [[grantUrl(operatorRole, "READ"), { effect: "ALLOW", fields: fields("id"), deny_fields: ["kind"] }], [`/app/api/resources/${controls}/permissions/READ`, { effect: "ALLOW", roleIds: [operatorRole], deny_fields: ["kind"] }]] as const) {
      const unknown = await call("PUT", url, managerToken, { data });
      expect([unknown.statusCode, unknown.json().errors?.[0]?.message]).toEqual([400, expect.stringMatching(/^Unknown key in the grant: deny_fields/)]);
    }
    // Security regression (Data_API.md §3.12): a delegated filter isn't an administrator's - with query.allow_regex off
    // it still put a regex on every row its holders read.
    await context.settings.set("query.allow_regex", false);
    try {
      const regex = await call("PUT", grantUrl(operatorRole, "READ"), managerToken, { data: { effect: "ALLOW", where: { kind: { _regex: "^(a+)+$" } }, fields: fields("id", "kind") } });
      expect([regex.statusCode, regex.json().errors?.[0]?.code]).toEqual([400, "QUERY_FEATURE_DISABLED"]);
    } finally {
      await context.settings.reset("query.allow_regex");
    }
    // Security regression: an administrator's DENY on a managed role - removed or replaced by the manager, it handed
    // back access the administrator took away.
    await context.permissions.set(operatorRole, controls, "DELETE", { effect: "DENY" });
    expect([(await call("DELETE", grantUrl(operatorRole, "DELETE"), managerToken)).statusCode]).toEqual([403]);
    const replaced = await call("PUT", grantUrl(operatorRole, "DELETE"), managerToken, { data: { effect: "ALLOW" } });
    expect(replaced.statusCode).toBe(403);
    const many = await call("PUT", `/app/api/resources/${controls}/permissions/DELETE`, managerToken, { data: { effect: "ALLOW", roleIds: [operatorRole] } });
    expect(many.statusCode).toBe(403);
    expect((await context.permissions.get(operatorRole, controls, "DELETE"))?.effect).toBe("DENY");
    await context.permissions.delete(operatorRole, controls, "DELETE");
    // The grant above, filtered on a field the parent reads, still stands.
    expect((await database.query(`SELECT where_clause FROM totalbase.permissions WHERE role = $1 AND resource = $2 AND action = 'READ'`, [operatorRole, controls])).rows[0]).toEqual({ where_clause: { kind: { _eq: "night" } } });
    // The editor's choices: what the parent may do.
    const ceiling = (await call("GET", `/app/api/roles/${operatorRole}/ceiling`, managerToken)).json().data;
    expect(ceiling.find((c: { resource: { id: string } }) => c.resource.id === controls)?.actions).toEqual({ READ: { fields: ["id", "site", "kind"] } });
    // Its own role, or one outside its scope: not there.
    expect((await call("PUT", grantUrl(managerRole, "READ"), managerToken, { data: { effect: "ALLOW" } })).statusCode).toBe(404);
    expect((await call("PUT", grantUrl(foreignRole, "READ"), managerToken, { data: { effect: "ALLOW" } })).statusCode).toBe(404);
  });

  it("the same rule for whoever holds it: each operator sees their own site's night rows, and a cut above reaches them", async () => {
    const operatorA = await person("operator-a", "A");
    const assign = await call("POST", "/api/totalbase/table/users_roles", managerToken, { data: { user: operatorA.id, role: operatorRole } });
    expect(assign.statusCode, assign.body).toBe(201);
    const operatorB = await person("operator-b", "B", operatorRole);
    const read = async (token: string) => {
      const res = await call("GET", `/api/public/table/${TABLE}?fields=site,kind&order_by=site`, token);
      return res.statusCode === 200 ? res.json().data : res.statusCode;
    };
    expect(await read(operatorA.token)).toEqual([{ site: "A", kind: "night" }]);
    expect(await read(operatorB.token)).toEqual([{ site: "B", kind: "night" }]);

    await context.permissions.delete(managerRole, controls, "READ");
    try {
      expect(await read(operatorA.token)).toBe(403);
    } finally {
      await context.permissions.set(managerRole, controls, "READ", { effect: "ALLOW", where: { site: { _eq: `$USER.${SITE}` } }, fields: fields("id", "site", "kind") });
    }
  });

  it("opens a dashboard to a role it manages only once an administrator marked it delegable", async () => {
    const created = await call("POST", "/admin/api/dashboards", adminToken, { data: { name: `${P}-site-board` } });
    expect(created.statusCode, created.body).toBe(201);
    const board = created.json().data.id as string;
    const foreign = (await call("POST", "/admin/api/dashboards", adminToken, { data: { name: `${P}-other-board` } })).json().data.id as string;
    await call("PUT", `/admin/api/dashboards/${board}/roles`, adminToken, { data: { roleIds: [managerRole] } });
    const share = () => call("PUT", `/app/api/roles/${operatorRole}/objects/dashboards/${board}`, managerToken);

    expect([(await share()).statusCode, (await share()).json().errors[0].code]).toEqual([403, "PERMISSION_DENIED"]);
    await call("PATCH", `/admin/api/dashboards/${board}`, adminToken, { data: { delegable: true } });
    expect((await share()).statusCode).toBe(204);
    const objects = (await call("GET", `/app/api/roles/${operatorRole}/objects`, managerToken)).json().data;
    expect(objects.dashboards).toEqual([{ id: board, name: `${P}-site-board`, granted: true }]);
    // One it can't open itself: as if it didn't exist.
    expect((await call("PUT", `/app/api/roles/${operatorRole}/objects/dashboards/${foreign}`, managerToken)).statusCode).toBe(404);
    expect((await call("DELETE", `/app/api/roles/${operatorRole}/objects/dashboards/${board}`, managerToken)).statusCode).toBe(204);
  });

  it("duplicates a role it manages - grants kept, members not - and grants several roles at once, each within its ceiling", async () => {
    const copy = await call("POST", `/app/api/roles/${operatorRole}/duplicate`, managerToken, { data: { name: `${P}-night-operator-copy` } });
    expect(copy.statusCode, copy.body).toBe(201);
    const copyId = copy.json().data.id as string;
    expect(copy.json().data.parent).toBe(managerRole);
    const { rows } = await database.query<{ action: string; granted_by: string | null }>(`SELECT action, granted_by FROM totalbase.permissions WHERE role = $1`, [copyId]);
    expect(rows).toEqual([{ action: "READ", granted_by: managerId }]);
    expect((await database.query(`SELECT 1 FROM totalbase.users_roles WHERE role = $1`, [copyId])).rows).toHaveLength(0);

    const both = (roleIds: string[], kindFields: string[]) =>
      call("PUT", `/app/api/resources/${controls}/permissions/READ`, managerToken, { data: { roleIds, effect: "ALLOW", fields: fields(...kindFields) } });
    expect((await both([operatorRole, copyId], ["id", "kind"])).json().data).toHaveLength(2);
    // One role outside its scope, or a field past the ceiling: nothing is written.
    expect((await both([copyId, foreignRole], ["id"])).statusCode).toBe(404);
    expect((await both([operatorRole, copyId], ["id", "notes"])).json().errors[0].code).toBe("PERMISSION_EXCEEDS_CEILING");
    const fieldsOf = async (role: string) => (await database.query<{ f: unknown }>(`SELECT field_overrides AS f FROM totalbase.permissions WHERE role = $1`, [role])).rows[0]!.f;
    expect(await fieldsOf(copyId)).toEqual(fields("id", "kind"));
  });

  it("records who acted on each log entry - the user, or a token's owner - for a grant to follow", async () => {
    await call("GET", `/api/public/table/${TABLE}`, managerToken);
    const { rows } = await database.query<{ actor: string | null }>(
      `SELECT actor FROM totalbase.logs WHERE principal = $1 ORDER BY created_at DESC LIMIT 1`,
      [managerId],
    );
    expect(rows[0]?.actor).toBe(managerId);
  });
});
