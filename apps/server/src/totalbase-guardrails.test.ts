import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import type { ResolvedResource } from "@totalbase/query-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { hashPassword } from "@totalbase/auth";
import { loadServerEnv } from "./env.js";
import { createTestApiToken, setupTestApp, uniqueSuffix } from "./test-support.js";

/** Per-run suffix on every name this file creates - no pre-cleaning by name, nothing to collide with. */
const SUFFIX = uniqueSuffix();
import { assertAdminWrittenTable, assertRolesDeleteAllowed, assertGuardedColumnsWriteAllowed, assertUserRoleAssignmentAllowed, protectedFieldDecision } from "@totalbase/mutations";

// Privilege-escalation floor for the Data API's generic mutation engine
// once totalbase.roles/users_roles become exposed resources (see the
// chat that designed this) - unit-level, not through a live resource
// row/permission grant, since neither table is in
// EXPOSABLE_TOTALBASE_TABLES yet.
function resourceFor(schema: string, table: string): ResolvedResource {
  return { oid: 0, schema, table, columns: [], primaryKey: ["id"], relations: [], uniqueConstraints: [] };
}

const ROLES = resourceFor("totalbase", "roles");
const USERS_ROLES = resourceFor("totalbase", "users_roles");
const OTHER_TABLE = resourceFor("totalbase", "roles_archive"); // same schema, another table - must not match
// Regression: the guardrails matched on `public` after the tables moved to the `totalbase` schema
// moved these tables to `totalbase`, so they never fired. A same-named
// table in `public` is someone else's table and must not match either.
const PUBLIC_ROLES = resourceFor("public", "roles");

describe("totalbase-guardrails", () => {
  let app: FastifyInstance;
  let database: Database;
  let adminRoleId: string;
  let reservedRoleId: string;
  let plainRoleId: string;

  beforeAll(async () => {
    ({ app, database } = await setupTestApp());
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.roles (name, admin_access, reserved) VALUES
         ($1, true, true),
         ($2, false, true),
         ($3, false, false)
       RETURNING id`,
      [`guardrail-test-admin-role-${SUFFIX}`, `guardrail-test-reserved-role-${SUFFIX}`, `guardrail-test-plain-role-${SUFFIX}`],
    );
    adminRoleId = rows[0]!.id;
    reservedRoleId = rows[1]!.id;
    plainRoleId = rows[2]!.id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.roles WHERE id IN ($1, $2, $3)`, [adminRoleId, reservedRoleId, plainRoleId]);
    await app.close();
  });

  describe("assertGuardedColumnsWriteAllowed", () => {
    it("rejects a payload that touches any access flag, even an ordinary one", () => {
      expect(() => assertGuardedColumnsWriteAllowed(ROLES, { name: "x", api_access: true })).toThrow(/api_access/);
      expect(() => assertGuardedColumnsWriteAllowed(ROLES, { app_access: false })).toThrow(/app_access/);
      expect(() => assertGuardedColumnsWriteAllowed(ROLES, { admin_access: true })).toThrow(/admin_access/);
    });
    it("rejects a payload that sets reserved, even without changing its value", () => {
      expect(() => assertGuardedColumnsWriteAllowed(ROLES, { reserved: true })).toThrow(/reserved/);
    });
    it("accepts admin_access and reserved stated as their default, false (M19)", () => {
      expect(() => assertGuardedColumnsWriteAllowed(ROLES, { name: "x", admin_access: false, reserved: false })).not.toThrow();
      expect(() => assertGuardedColumnsWriteAllowed(ROLES, { admin_access: null })).toThrow(/admin_access/);
    });
    it("allows a payload that touches neither", () => {
      expect(() => assertGuardedColumnsWriteAllowed(ROLES, { name: "x", description: "y" })).not.toThrow();
    });
    it("ignores a differently-named table in the same schema", () => {
      expect(() => assertGuardedColumnsWriteAllowed(OTHER_TABLE, { admin_access: true })).not.toThrow();
    });
    it("ignores a same-named table in the public schema", () => {
      expect(() => assertGuardedColumnsWriteAllowed(PUBLIC_ROLES, { admin_access: true })).not.toThrow();
    });
  });

  describe("assertRolesDeleteAllowed", () => {
    it("rejects deleting an admin-access row", () => {
      expect(() => assertRolesDeleteAllowed(ROLES, { id: adminRoleId, admin_access: true, reserved: false })).toThrow();
    });
    it("rejects deleting a row with reserved = true", () => {
      expect(() => assertRolesDeleteAllowed(ROLES, { id: reservedRoleId, admin_access: false, reserved: true })).toThrow();
    });
    it("allows deleting an ordinary role", () => {
      expect(() => assertRolesDeleteAllowed(ROLES, { id: plainRoleId, admin_access: false, reserved: false })).not.toThrow();
    });
  });

  describe("assertUserRoleAssignmentAllowed", () => {
    it("rejects assigning a user to an ADMIN role", async () => {
      await expect(assertUserRoleAssignmentAllowed(database, USERS_ROLES, { role: adminRoleId })).rejects.toThrow();
    });
    it("rejects assigning a user to a reserved role", async () => {
      await expect(assertUserRoleAssignmentAllowed(database, USERS_ROLES, { role: reservedRoleId })).rejects.toThrow();
    });
    it("allows assigning a user to an ordinary role", async () => {
      await expect(assertUserRoleAssignmentAllowed(database, USERS_ROLES, { role: plainRoleId })).resolves.toBeUndefined();
    });
    it("is a no-op for a different table", async () => {
      await expect(assertUserRoleAssignmentAllowed(database, ROLES, { role: adminRoleId })).resolves.toBeUndefined();
    });
  });
});

/**
 * End-to-end proof the guardrails above actually reach the real Data
 * API request path (not just their own unit tests) - a role holding an
 * ordinary, operator-configured field grant that includes the protected
 * columns (the exact misconfiguration the guardrail exists for) must
 * still be blocked by the server, not just by the Admin UI choosing not
 * to offer them.
 */
describe("Data API integration - totalbase table guardrails", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let callerRoleId: string;
  let apiKeyUserId: string;
  let apiKeyId: string;
  let apiKeyPlain: string;
  let adminRoleId: string;
  let rolesResourceId: string;
  let usersRolesResourceId: string;
  let usersResourceId: string;
  let previousExposure: { id: string; exposed_methods: string[] }[] = [];

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());

    const { rows: resourceRows } = await database.query<{ name: string; id: string }>(
      `SELECT name, id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name IN ('roles', 'users_roles', 'users')`,
    );
    rolesResourceId = resourceRows.find((r) => r.name === "roles")!.id;
    usersRolesResourceId = resourceRows.find((r) => r.name === "users_roles")!.id;
    usersResourceId = resourceRows.find((r) => r.name === "users")!.id;

    // Turn every method on to reach the guardrail at all (the delegable
    // tables start with fewer - assignments have no PATCH); restored in afterAll.
    previousExposure = (await database.query<{ id: string; exposed_methods: string[] }>(
      `SELECT id, exposed_methods FROM totalbase.resources WHERE id = ANY($1)`,
      [[rolesResourceId, usersRolesResourceId, usersResourceId]],
    )).rows;
    await database.query(
      `UPDATE totalbase.resources SET exposed_methods = ARRAY['GET', 'POST', 'PATCH', 'DELETE'] WHERE id = ANY($1)`,
      [[rolesResourceId, usersRolesResourceId, usersResourceId]],
    );

    const { rows: adminRoleRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.roles (name, admin_access, reserved) VALUES ($1, true, true) RETURNING id`,
      [`guardrail-e2e-admin-role-${SUFFIX}`],
    );
    adminRoleId = adminRoleRows[0]!.id;

    const callerRole = await context.roles.create(`guardrail-e2e-caller-role-${SUFFIX}`, { apiAccess: true });
    callerRoleId = callerRole.id;
    // Deliberately over-permissive, mirroring a real operator mistake -
    // the guardrail, not this grant, is what must stop the escalation.
    await context.permissions.set(callerRoleId, rolesResourceId, "CREATE", {
      effect: "ALLOW",
      fields: [
        { field: "name", effect: "ALLOW" },
        { field: "app_access", effect: "ALLOW" },
      ],
    });
    await context.permissions.set(callerRoleId, usersRolesResourceId, "CREATE", {
      effect: "ALLOW",
      fields: [
        { field: "user", effect: "ALLOW" },
        { field: "role", effect: "ALLOW" },
      ],
    });
    await context.permissions.set(callerRoleId, usersResourceId, "READ", {
      effect: "ALLOW",
      fields: [
        { field: "id", effect: "ALLOW" },
        { field: "email", effect: "ALLOW" },
        { field: "password_hash", effect: "ALLOW" },
      ],
    });

    const token = await createTestApiToken(context, {
      name: `guardrail-e2e-key-${SUFFIX}`,
      roleId: callerRoleId,
      email: `guardrail-e2e-key-owner-${SUFFIX}@example.com`,
    });
    apiKeyUserId = token.userId;
    apiKeyId = token.tokenId;
    apiKeyPlain = token.plainKey;
  });

  afterAll(async () => {
    for (const row of previousExposure) {
      await database.query(`UPDATE totalbase.resources SET exposed_methods = $2 WHERE id = $1`, [row.id, row.exposed_methods]);
    }
    await database.query(`DELETE FROM totalbase.tokens WHERE id = $1`, [apiKeyId]);
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [apiKeyUserId]);
    await database.query(`DELETE FROM totalbase.permissions WHERE role = $1`, [callerRoleId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id IN ($1, $2)`, [callerRoleId, adminRoleId]);
    await app.close();
    await database.close();
  });

  it("rejects POST totalbase.roles with an access flag in the body, even though the field is granted", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/totalbase/table/roles",
      headers: { authorization: `Bearer ${apiKeyPlain}` },
      payload: { data: { name: `guardrail-e2e-should-not-exist-${SUFFIX}`, app_access: true } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().errors[0].code).toBe("PERMISSION_DENIED");

    const { rows } = await database.query(
      `SELECT 1 FROM totalbase.roles WHERE name = $1`, [`guardrail-e2e-should-not-exist-${SUFFIX}`],
    );
    expect(rows.length).toBe(0);
  });

  it("rejects POST totalbase.users_roles assigning the caller's own role to an ADMIN role", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/totalbase/table/users_roles",
      headers: { authorization: `Bearer ${apiKeyPlain}` },
      payload: { data: { user: apiKeyUserId, role: adminRoleId } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().errors[0].code).toBe("PERMISSION_DENIED");

    const { rows } = await database.query(
      `SELECT 1 FROM totalbase.users_roles WHERE "user" = $1 AND role = $2`,
      [apiKeyUserId, adminRoleId],
    );
    expect(rows.length).toBe(0);
  });

  it("never returns password_hash from GET totalbase.users, even though the field is granted", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/totalbase/table/users",
      headers: { authorization: `Bearer ${apiKeyPlain}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toHaveProperty("password_hash");
    }
  });

  it("never lists a protected column in the generated OpenAPI document, even though the field is granted", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/openapi.json",
      headers: { authorization: `Bearer ${apiKeyPlain}` },
    });
    expect(res.statusCode).toBe(200);
    const schemas = res.json().components.schemas as Record<string, { properties?: Record<string, unknown> }>;
    // READ grants password_hash - the row schema must still omit it.
    expect(Object.keys(schemas["totalbase_users"]?.properties ?? {})).toEqual(["id", "email"]);
    // CREATE grants app_access - assertGuardedColumnsWriteAllowed rejects it, so the create body must not offer it.
    expect(Object.keys(schemas["totalbase_roles_create"]?.properties ?? {})).toEqual(["name"]);
    expect(res.body).not.toContain("password_hash");
  });
});

describe("protectedFieldDecision - Files storage columns", () => {
  it("denies storage_key/storage_provider on files whatever the grant says, and leaves other columns alone", () => {
    const root = { schema: "totalbase", table: "files" } as ResolvedResource;
    const decision = protectedFieldDecision(root, () => "ALLOW");
    expect(decision("storage_key")).toBe("DENY");
    expect(decision("storage_provider")).toBe("DENY");
    expect(decision("name")).toBe("ALLOW");
  });
});

/**
 * Access tables (Security.md §10.2, guardrails 1 and 5):
 * readable under ordinary permissions, written by administrators only -
 * writing one IS granting access. A role holding an over-permissive grant
 * on one (the misconfiguration this exists for) is still refused.
 */
describe("assertAdminWrittenTable", () => {
  const notAdmin = async () => false;
  const admin = async () => true;

  it("refuses a non-administrator on every access table", async () => {
    for (const table of ["permissions", "dataviews_roles", "dashboards_roles", "menus"]) {
      await expect(assertAdminWrittenTable(notAdmin, ["r"], resourceFor("totalbase", table)), table).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
  });

  it("lets an administrator write, and leaves other tables alone", async () => {
    await expect(assertAdminWrittenTable(admin, ["r"], resourceFor("totalbase", "menus"))).resolves.toBeUndefined();
    await expect(assertAdminWrittenTable(notAdmin, ["r"], resourceFor("totalbase", "roles"))).resolves.toBeUndefined();
    await expect(assertAdminWrittenTable(notAdmin, ["r"], resourceFor("public", "menus"))).resolves.toBeUndefined();
  });
});

describe("Data API integration - access tables are administrator-written", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let callerRoleId: string;
  let tokenUserId: string;
  let tokenPlain: string;
  let accessResourceId: string;
  let dataviewId: string;
  let sourceResourceId: string;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`DROP TABLE IF EXISTS public.guardrail_access_items CASCADE`);

    accessResourceId = (await database.query<{ id: string }>(
      `SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'dataviews_roles'`,
    )).rows[0]!.id;
    await database.query(`UPDATE totalbase.resources SET exposed_methods = ARRAY['GET', 'POST', 'DELETE'] WHERE id = $1`, [accessResourceId]);

    await database.query(`CREATE TABLE public.guardrail_access_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`);
    sourceResourceId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass('public.guardrail_access_items')::oid, 'public', 'guardrail_access_items', 'TABLE', 'ACTIVE', ARRAY['GET']) RETURNING id`,
    )).rows[0]!.id;
    dataviewId = (await context.dataviewsAdmin.create({ name: `Guardrail access ${SUFFIX}`, slug: `guardrail-access-${SUFFIX}`, sourceResourceId, viewType: "TABLE" })).id;

    callerRoleId = (await context.roles.create(`guardrail-access-caller-${SUFFIX}`, { apiAccess: true })).id;
    // Deliberately over-permissive: the guardrail, not this grant, must stop it.
    const fields = ["id", "dataview", "role", "created_at"].map((field) => ({ field, effect: "ALLOW" as const }));
    for (const action of ["READ", "CREATE", "DELETE"] as const) {
      await context.permissions.set(callerRoleId, accessResourceId, action, { effect: "ALLOW", fields });
    }
    const token = await createTestApiToken(context, { name: `guardrail-access-key-${SUFFIX}`, roleId: callerRoleId, email: `guardrail-access-owner-${SUFFIX}@example.com` });
    tokenUserId = token.userId;
    tokenPlain = token.plainKey;
  });

  afterAll(async () => {
    await database.query(`UPDATE totalbase.resources SET exposed_methods = '{}' WHERE id = $1`, [accessResourceId]); // not a delegable table - unexposed by default
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [tokenUserId]);
    await database.query(`DELETE FROM totalbase.permissions WHERE role = $1`, [callerRoleId]);
    await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [dataviewId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [callerRoleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [sourceResourceId]);
    await database.query(`DROP TABLE IF EXISTS public.guardrail_access_items CASCADE`);
    await app.close();
  });

  it("refuses granting yourself a DataView through the Data API, whatever the grant says", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/totalbase/table/dataviews_roles",
      headers: { authorization: `Bearer ${tokenPlain}` },
      payload: { data: { dataview: dataviewId, role: callerRoleId } },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().errors[0].code).toBe("PERMISSION_DENIED");
    expect((await context.dataviewsAdmin.listRoles(dataviewId))).toEqual([]);
  });

  it("still lets the same grant read the table", async () => {
    await context.dataviewsAdmin.setRoles(dataviewId, [callerRoleId]);
    const res = await app.inject({
      method: "GET",
      url: `/api/totalbase/table/dataviews_roles?where[dataview][_eq]=${dataviewId}`,
      headers: { authorization: `Bearer ${tokenPlain}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.map((row: { role: string }) => row.role)).toEqual([callerRoleId]);
  });

  it("refuses removing a grant through the Data API too", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/totalbase/table/dataviews_roles?where[dataview][_eq]=${dataviewId}`,
      headers: { authorization: `Bearer ${tokenPlain}` },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(await context.dataviewsAdmin.listRoles(dataviewId)).toEqual([callerRoleId]);
  });
});


describe("assertGuardedColumnsWriteAllowed - users security columns", () => {
  const USERS = resourceFor("totalbase", "users");
  const ADMIN_ONLY = ["email", "email_verified_at", "can_login", "locked_until", "failed_login_count", "last_login_at"];

  it("refuses each administrator-written column to a non-administrator, by key presence", () => {
    for (const column of ADMIN_ONLY) {
      expect(() => assertGuardedColumnsWriteAllowed(USERS, { [column]: null }, { administrator: false }), column).toThrow(/administrators only/);
      expect(() => assertGuardedColumnsWriteAllowed(USERS, { [column]: null }), column).toThrow(/administrators only/);
    }
  });

  it("lets an administrator write them, but never owner", () => {
    for (const column of ADMIN_ONLY) {
      expect(() => assertGuardedColumnsWriteAllowed(USERS, { [column]: null }, { administrator: true }), column).not.toThrow();
    }
    expect(() => assertGuardedColumnsWriteAllowed(USERS, { owner: false }, { administrator: true })).toThrow(/cannot be set/);
  });

  it("leaves the other columns (and same-named tables elsewhere) to the grants", () => {
    expect(() => assertGuardedColumnsWriteAllowed(USERS, { name: "x", active: false, avatar_url: null, preferences: {}, custom: 1 }, { administrator: false })).not.toThrow();
    expect(() => assertGuardedColumnsWriteAllowed(resourceFor("public", "users"), { locked_until: null }, { administrator: false })).not.toThrow();
  });
});

/**
 * Security.md §10.2 guardrail 9: a delegated user manager
 * with UPDATE/CREATE and field grants on every column of
 * users (the misconfiguration this exists for) still can't
 * write an account's security state or sign-in identity - not on another
 * account, not on their own, not through an upsert's conflict branch.
 * An administrator can; the delegated screens' own writes (name, active)
 * keep working.
 */
describe("Data API integration - users security columns are administrator-written", () => {
  const P = `guardrail-users-columns-${SUFFIX}`;
  const PASSWORD = "a-strong-enough-password";
  const users = "/api/totalbase/table/users";
  const LOCKED_UNTIL = "2999-01-01T00:00:00.000Z";
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let delegateId: string;
  let delegateToken: string;
  let adminToken: string;
  let targetId: string;
  let ownerId: string;

  const call = (method: string, url: string, token: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined && { payload: payload as Record<string, unknown> }) });
  const stateOf = async (id: string) =>
    (await database.query(
      `SELECT email, email_verified_at, can_login, locked_until, failed_login_count, last_login_at, owner, name, active FROM totalbase.users WHERE id = $1`,
      [id],
    )).rows[0];
  // Each column with a value that differs from the target's current one.
  const ATTEMPTS: Record<string, unknown> = {
    email: `${P}-hijacked@example.com`,
    email_verified_at: "2026-01-01T00:00:00.000Z",
    can_login: false,
    locked_until: null,
    failed_login_count: 0,
    last_login_at: "2026-01-01T00:00:00.000Z",
    owner: true,
  };

  async function cleanup(): Promise<void> {
    for (const id of [targetId, delegateId]) if (id) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    if (roleId) await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    ownerId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE owner`)).rows[0]!.id;
    const usersResourceId = (await database.query<{ id: string }>(
      `SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'users'`,
    )).rows[0]!.id;
    await database.query(`UPDATE totalbase.resources SET exposed_methods = '{GET,POST,PATCH,DELETE}' WHERE id = $1`, [usersResourceId]);

    roleId = (await context.roles.create(`${P}-managers`, { appAccess: true })).id;
    // Deliberately over-permissive: every column granted - the guardrail, not this grant, must stop it.
    const fields = ["id", "name", "active", ...Object.keys(ATTEMPTS)].map((field) => ({ field, effect: "ALLOW" as const }));
    for (const action of ["READ", "CREATE", "UPDATE"] as const) {
      await context.permissions.set(roleId, usersResourceId, action, { effect: "ALLOW", fields });
    }
    const delegate = await context.auth.users.create({ email: `${P}-delegate@example.com`, name: "Delegate", passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    await context.roleAssignments.assignRoleToUser(delegate.id, roleId);
    delegateId = delegate.id;
    delegateToken = (await context.auth.login({ email: `${P}-delegate@example.com`, password: PASSWORD })).token;

    targetId = (await context.auth.users.create({ email: `${P}-target@example.com`, name: "Target" })).id;
    // Locked by an administrator after failed sign-ins, address not verified.
    await database.query(
      `UPDATE totalbase.users SET locked_until = $2, failed_login_count = 3, email_verified_at = NULL, last_login_at = NULL WHERE id = $1`,
      [targetId, LOCKED_UNTIL],
    );
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("refuses each column on another account, leaving the row unchanged", async () => {
    const before = await stateOf(targetId);
    for (const [column, value] of Object.entries(ATTEMPTS)) {
      const res = await call("PATCH", `${users}/${targetId}`, delegateToken, { data: { [column]: value } });
      expect([res.statusCode, res.json().errors?.[0]?.code], column).toEqual([403, "PERMISSION_DENIED"]);
    }
    expect(await stateOf(targetId)).toEqual(before);
  });

  it("refuses each column on the delegate's own account", async () => {
    const before = await stateOf(delegateId);
    for (const [column, value] of Object.entries(ATTEMPTS)) {
      const res = await call("PATCH", `${users}/${delegateId}`, delegateToken, { data: { [column]: column === "email" ? `${P}-self@example.com` : value } });
      expect([res.statusCode, res.json().errors?.[0]?.code], column).toEqual([403, "PERMISSION_DENIED"]);
    }
    expect(await stateOf(delegateId)).toEqual(before);
  });

  it("refuses them on a create and in an upsert's conflict branch", async () => {
    const created = await call("POST", users, delegateToken, { data: { email: `${P}-created@example.com`, name: "Created" } });
    expect([created.statusCode, created.json().errors?.[0]?.code]).toEqual([403, "PERMISSION_DENIED"]);
    const verified = await call("POST", users, delegateToken, { data: { name: "Created", email_verified_at: "2026-01-01T00:00:00.000Z" } });
    expect([verified.statusCode, verified.json().errors?.[0]?.code]).toEqual([403, "PERMISSION_DENIED"]);

    const before = await stateOf(targetId);
    const upsert = await call("POST", users, delegateToken, {
      data: { id: targetId, name: "Target" },
      on_conflict: { target: ["id"], action: "UPDATE", data: { locked_until: null, failed_login_count: 0 } },
    });
    // The conflict branch's columns pass the same guardrail as a plain UPDATE's, before any SQL.
    expect([upsert.statusCode, upsert.json().errors?.[0]?.code], upsert.body).toEqual([403, "PERMISSION_DENIED"]);
    expect(await stateOf(targetId)).toEqual(before);
    // Nothing of what the refused writes would have made exists.
    const { rows: leaked } = await database.query(`SELECT id FROM totalbase.users WHERE email = ANY($1)`, [[`${P}-created@example.com`, `${P}-hijacked@example.com`, `${P}-self@example.com`]]);
    expect(leaked).toHaveLength(0);
  });

  it("still lets the delegate rename, deactivate and activate the account - what the delegated screen does", async () => {
    for (const data of [{ name: "Renamed" }, { active: false }, { active: true }]) {
      const res = await call("PATCH", `${users}/${targetId}`, delegateToken, { data });
      expect(res.statusCode, res.body).toBe(200);
    }
    expect(await stateOf(targetId)).toMatchObject({ name: "Renamed", active: true });
  });

  it("lets an administrator unlock, verify and change sign-in ability - but never set owner", async () => {
    const unlock = await call("PATCH", `${users}/${targetId}`, adminToken, { data: { locked_until: null, failed_login_count: 0 } });
    expect(unlock.statusCode, unlock.body).toBe(200);
    const verify = await call("PATCH", `${users}/${targetId}`, adminToken, { data: { email_verified_at: "2026-01-01T00:00:00.000Z", can_login: false } });
    expect(verify.statusCode, verify.body).toBe(200);
    expect(await stateOf(targetId)).toMatchObject({ locked_until: null, failed_login_count: 0, can_login: false });
    expect((await stateOf(targetId))!["email_verified_at"]).not.toBeNull();

    const owner = await call("PATCH", `${users}/${ownerId}`, adminToken, { data: { owner: false } });
    expect([owner.statusCode, owner.json().errors?.[0]?.code]).toEqual([403, "PERMISSION_DENIED"]);
    expect((await stateOf(ownerId))!["owner"]).toBe(true);
  });
});
