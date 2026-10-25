import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

/**
 * The transactions capability (totalbase.roles_capabilities) through the
 * Data API - Security.md §5.2, §10.1, §10.2: fixed exposure,
 * read under ordinary permissions, written by administrators only (what the
 * role editor's "Can run transactions" switch does), and POST
 * /api/transactions follows the row the moment it changes.
 *
 * Also the generated OpenAPI's account columns (§10.2 item 9): a
 * non-administrator's document never offers the administrator-written
 * users columns in a write body; an administrator's keeps them.
 */
describe("Transactions capability through the Data API", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let capabilitiesId: string;
  let usersId: string;
  let itemsId: string;
  let runnerRole: string;
  let delegateRole: string;
  let runnerKey: string;
  let delegateKey: string;
  const userIds: string[] = [];

  const CAPABILITIES = "/api/totalbase/table/roles_capabilities";
  const ITEMS = "capabilities_test_items";

  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const transaction = (key: string) =>
    app.inject({
      method: "POST",
      url: "/api/transactions",
      headers: as(key),
      payload: { operations: [{ key: "a", operation: "insert", schema: "public", table: ITEMS, data: { name: "via transaction" } }] },
    });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    await context.settings.set("transactions.enabled", true);

    const resourceId = async (schema: string, name: string) =>
      (await database.query<{ id: string }>(`SELECT id FROM totalbase.resources WHERE "schema" = $1 AND name = $2`, [schema, name])).rows[0]!.id;
    capabilitiesId = await resourceId("totalbase", "roles_capabilities");
    usersId = await resourceId("totalbase", "users");

    await database.query(`DROP TABLE IF EXISTS public.${ITEMS} CASCADE`);
    await database.query(`CREATE TABLE public.${ITEMS} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL)`);
    itemsId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', '{GET,POST}') RETURNING id`,
      [`public.${ITEMS}`, ITEMS],
    )).rows[0]!.id;

    runnerRole = (await context.roles.create("capabilities-test-runner", { apiAccess: true })).id;
    await context.permissions.set(runnerRole, itemsId, "READ", { effect: "ALLOW", fields: [{ field: "id", effect: "ALLOW" }, { field: "name", effect: "ALLOW" }] });
    await context.permissions.set(runnerRole, itemsId, "CREATE", { effect: "ALLOW", fields: [{ field: "name", effect: "ALLOW" }] });

    // A delegate holding an over-permissive grant on the capability table and
    // on users' account columns - the guardrail, not the grant, decides.
    delegateRole = (await context.roles.create("capabilities-test-delegate", { apiAccess: true })).id;
    const capabilityFields = ["role", "capability", "effect"].map((field) => ({ field, effect: "ALLOW" as const }));
    for (const action of ["READ", "CREATE", "UPDATE", "DELETE"] as const) {
      await context.permissions.set(delegateRole, capabilitiesId, action, { effect: "ALLOW", ...(action !== "DELETE" && { fields: capabilityFields }) });
    }
    const accountFields = ["name", "email", "email_verified_at", "can_login", "locked_until", "failed_login_count", "last_login_at", "owner"]
      .map((field) => ({ field, effect: "ALLOW" as const }));
    await context.permissions.set(delegateRole, usersId, "CREATE", { effect: "ALLOW", fields: accountFields });
    await context.permissions.set(delegateRole, usersId, "UPDATE", { effect: "ALLOW", fields: accountFields });

    for (const [name, role] of [["runner", runnerRole], ["delegate", delegateRole]] as const) {
      const token = await createTestApiToken(context, { name: `capabilities-test-${name}`, roleId: role, email: `capabilities-test-${name}@example.com` });
      userIds.push(token.userId);
      if (name === "runner") runnerKey = token.plainKey;
      else delegateKey = token.plainKey;
    }
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.roles_capabilities WHERE role = ANY($1)`, [[runnerRole, delegateRole]]);
    await database.query(`DELETE FROM totalbase.logs WHERE resource = $1`, [itemsId]);
    await database.query(`DELETE FROM totalbase.outbox WHERE resource = $1`, [itemsId]);
    for (const id of userIds) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    for (const id of [runnerRole, delegateRole]) await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [id]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [itemsId]);
    await database.query(`DROP TABLE IF EXISTS public.${ITEMS} CASCADE`);
    await app.close();
    await database.close();
  });

  it("is exposed with a fixed GET, POST, PATCH, DELETE", async () => {
    const { rows } = await database.query<{ exposed_methods: string[] }>(`SELECT exposed_methods FROM totalbase.resources WHERE id = $1`, [capabilitiesId]);
    expect([...rows[0]!.exposed_methods].sort()).toEqual(["DELETE", "GET", "PATCH", "POST"]);
  });

  it("an administrator grants, turns into DENY and removes it, and transactions follow each change", async () => {
    expect((await transaction(runnerKey)).statusCode).toBe(403);

    const granted = await app.inject({ method: "POST", url: CAPABILITIES, headers: as(adminToken), payload: { data: { role: runnerRole, capability: "TRANSACTIONS", effect: "ALLOW" } } });
    expect(granted.statusCode, granted.body).toBe(201);
    // Addressed by its own id (uuid primary key), not by the role.
    const capabilityId = granted.json().data.id as string;
    expect(capabilityId).toMatch(/^[0-9a-f-]{36}$/);
    expect(capabilityId).not.toBe(runnerRole);
    expect((await transaction(runnerKey)).statusCode).toBe(200);

    const denied = await app.inject({ method: "PATCH", url: `${CAPABILITIES}/${capabilityId}`, headers: as(adminToken), payload: { data: { effect: "DENY" } } });
    expect(denied.statusCode, denied.body).toBe(200);
    const refused = await transaction(runnerKey);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().errors[0].code).toBe("TRANSACTION_EXECUTION_DENIED");

    await app.inject({ method: "PATCH", url: `${CAPABILITIES}/${capabilityId}`, headers: as(adminToken), payload: { data: { effect: "ALLOW" } } });
    const removed = await app.inject({ method: "DELETE", url: `${CAPABILITIES}/${capabilityId}`, headers: as(adminToken) });
    expect(removed.statusCode, removed.body).toBeLessThan(300);
    expect((await transaction(runnerKey)).statusCode).toBe(403);
  });

  it("a non-administrator can't write it, whatever their grants say - but reads it under them", async () => {
    const create = await app.inject({ method: "POST", url: CAPABILITIES, headers: as(delegateKey), payload: { data: { role: delegateRole, effect: "ALLOW" } } });
    expect(create.statusCode).toBe(403);
    expect(create.json().errors[0].code).toBe("PERMISSION_DENIED");
    const { rows } = await database.query(`SELECT 1 FROM totalbase.roles_capabilities WHERE role = $1`, [delegateRole]);
    expect(rows).toEqual([]);

    await context.capabilityPermissions.setGrant(runnerRole, "TRANSACTIONS", "ALLOW");
    const { rows: [granted] } = await database.query<{ id: string }>(`SELECT id FROM totalbase.roles_capabilities WHERE role = $1`, [runnerRole]);
    const update = await app.inject({ method: "PATCH", url: `${CAPABILITIES}/${granted!.id}`, headers: as(delegateKey), payload: { data: { effect: "DENY" } } });
    expect(update.statusCode).toBe(403);
    const remove = await app.inject({ method: "DELETE", url: `${CAPABILITIES}/${granted!.id}`, headers: as(delegateKey) });
    expect(remove.statusCode).toBe(403);
    expect(await context.capabilityPermissions.resolve([runnerRole], "TRANSACTIONS")).toBe("ALLOW");

    const read = await app.inject({ method: "GET", url: `${CAPABILITIES}?where[role][_eq]=${runnerRole}`, headers: as(delegateKey) });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().data).toEqual([{ role: runnerRole, capability: "TRANSACTIONS", effect: "ALLOW" }]);
    await context.capabilityPermissions.clearGrant(runnerRole, "TRANSACTIONS");
  });

  describe("OpenAPI write bodies on users", () => {
    const ADMIN_WRITTEN = ["email", "email_verified_at", "can_login", "locked_until", "failed_login_count", "last_login_at"];
    const writeBodies = (spec: { components: { schemas: Record<string, { properties?: Record<string, unknown> }> } }) => ({
      create: Object.keys(spec.components.schemas["totalbase_users_create"]?.properties ?? {}),
      update: Object.keys(spec.components.schemas["totalbase_users_update"]?.properties ?? {}),
    });

    it("omits the administrator-written account columns and owner for a non-administrator, even when granted", async () => {
      const res = await app.inject({ method: "GET", url: "/api/openapi.json", headers: as(delegateKey) });
      expect(res.statusCode).toBe(200);
      const { create, update } = writeBodies(res.json());
      expect(create).toEqual(["name"]);
      expect(update).toEqual(["name"]);
    });

    it("keeps them for an administrator, never owner", async () => {
      const { rows } = await database.query<{ id: string }>(`SELECT id FROM totalbase.roles WHERE reserved AND name = 'Administrators'`);
      const res = await app.inject({ method: "GET", url: `/admin/api/openapi/data?role=${rows[0]!.id}`, headers: as(adminToken) });
      expect(res.statusCode).toBe(200);
      const { create, update } = writeBodies(res.json());
      for (const column of ADMIN_WRITTEN) {
        expect(create).toContain(column);
        // An account's email is set on create only - its route changes it (Security.md §10.2).
        if (column === "email") expect(update).not.toContain(column);
        else expect(update).toContain(column);
      }
      expect(create).not.toContain("owner");
      expect(update).not.toContain("owner");
      expect(create).not.toContain("password_hash");
    });
  });
});
