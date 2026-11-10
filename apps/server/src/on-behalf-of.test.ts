import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp, uniqueSuffix, waitFor } from "./test-support.js";

const ITEMS = "obo_test_items";
const TENANT = "obo_test_tenant";
const HEADER = "x-totalbase-on-behalf-of";

/**
 * On-behalf-of requests (Security.md §10.3): a service token names the user it acts for; the request runs as the
 * caller, never as the named user; the user is recorded in the audit entry, the outbox event and the
 * transaction's `totalbase.on_behalf_of_user_id`. Who may: the ACT_ON_BEHALF capability, for users the caller
 * can read through its own grants on users.
 */
describe("X-TotalBase-On-Behalf-Of", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let serviceRole: string;
  let serviceToken: string;
  let serviceUserId: string;
  let itemsId: string;
  let usersId: string;
  let sameTenantUser: string;
  let otherTenantUser: string;
  const tenants = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
  const userIds: string[] = [];

  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, headers: { authorization: `Bearer ${serviceToken}`, ...headers }, payload: payload as Record<string, unknown> });
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${serviceToken}`, ...headers } });
  const allow = (fields: string[]) => fields.map((field) => ({ field, effect: "ALLOW" as const }));

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`ALTER TABLE totalbase.users ADD COLUMN IF NOT EXISTS ${TENANT} uuid`);
    await database.query(`DROP TABLE IF EXISTS public.${ITEMS}`);
    await database.query(`CREATE TABLE public.${ITEMS} (id serial PRIMARY KEY, name text NOT NULL, initiated_by uuid)`);
    // The documented pattern: a trigger stamps initiated_by from the transaction's setting.
    await database.query(`CREATE OR REPLACE FUNCTION public.obo_test_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.initiated_by := NULLIF(current_setting('totalbase.on_behalf_of_user_id', true), '')::uuid; RETURN NEW; END $$`);
    await database.query(`CREATE TRIGGER obo_test_stamp BEFORE INSERT ON public.${ITEMS} FOR EACH ROW EXECUTE FUNCTION public.obo_test_stamp()`);
    itemsId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', $3) RETURNING id`,
      [`public.${ITEMS}`, ITEMS, ["GET", "POST", "PATCH"]],
    )).rows[0]!.id;
    usersId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'users'`)).rows[0]!.id;

    serviceRole = (await context.roles.create(`obo-service-${uniqueSuffix()}`, { apiAccess: true })).id;
    await context.permissions.set(serviceRole, itemsId, "CREATE", { effect: "ALLOW", fields: allow(["name"]) });
    await context.permissions.set(serviceRole, itemsId, "READ", { effect: "ALLOW", fields: allow(["id", "name", "initiated_by"]) });
    // The service reads the users of its own tenant only.
    await context.permissions.set(serviceRole, usersId, "READ", { effect: "ALLOW", fields: allow(["id", "email"]), where: { [TENANT]: { _eq: `$USER.${TENANT}` } } });
    ({ plainKey: serviceToken, userId: serviceUserId } = await createTestApiToken(context, { name: "obo-service", roleId: serviceRole, email: `obo-service-${uniqueSuffix()}@example.com` }));
    userIds.push(serviceUserId);
    await database.query(`UPDATE totalbase.users SET ${TENANT} = $1 WHERE id = $2`, [tenants[0], serviceUserId]);
    sameTenantUser = (await context.auth.users.create({ email: `obo-same-${uniqueSuffix()}@example.com`, name: "Ana" })).id;
    otherTenantUser = (await context.auth.users.create({ email: `obo-other-${uniqueSuffix()}@example.com`, name: "Bob" })).id;
    userIds.push(sameTenantUser, otherTenantUser);
    await database.query(`UPDATE totalbase.users SET ${TENANT} = $1 WHERE id = $2`, [tenants[0], sameTenantUser]);
    await database.query(`UPDATE totalbase.users SET ${TENANT} = $1 WHERE id = $2`, [tenants[1], otherTenantUser]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.logs WHERE resource = $1`, [itemsId]);
    await database.query(`DELETE FROM totalbase.outbox WHERE resource = $1`, [itemsId]);
    for (const id of userIds) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [serviceRole]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [itemsId]);
    await database.query(`DROP TABLE IF EXISTS public.${ITEMS}`);
    await database.query(`DROP FUNCTION IF EXISTS public.obo_test_stamp()`);
    await database.query(`ALTER TABLE totalbase.users DROP COLUMN IF EXISTS ${TENANT}`);
    await app.close();
  });

  it("needs the ACT_ON_BEHALF capability, a well-formed id, and a user the caller can read", async () => {
    const without = await post(`/api/public/table/${ITEMS}`, { data: { name: "no capability" } }, { [HEADER]: sameTenantUser });
    expect(without.statusCode).toBe(403);
    expect(without.json().errors[0].code).toBe("ON_BEHALF_OF_DENIED");

    await context.capabilityPermissions.setGrant(serviceRole, "ACT_ON_BEHALF", "ALLOW");
    const malformed = await post(`/api/public/table/${ITEMS}`, { data: { name: "x" } }, { [HEADER]: "not-a-uuid" });
    expect(malformed.statusCode).toBe(400);
    const other = await post(`/api/public/table/${ITEMS}`, { data: { name: "other tenant" } }, { [HEADER]: otherTenantUser });
    expect(other.statusCode).toBe(403);
    expect(other.json().errors[0].code).toBe("ON_BEHALF_OF_DENIED");
    const unknown = await post(`/api/public/table/${ITEMS}`, { data: { name: "unknown" } }, { [HEADER]: "00000000-0000-4000-8000-000000000000" });
    expect(unknown.statusCode).toBe(403);
    expect((await database.query(`SELECT 1 FROM public.${ITEMS}`)).rowCount).toBe(0);
  });

  it("records the named user in the audit entry, the outbox event and the transaction's setting - the request stays the caller's", async () => {
    const res = await post(`/api/public/table/${ITEMS}`, { data: { name: "for Ana" } }, { [HEADER]: sameTenantUser });
    expect(res.statusCode, res.body).toBe(201);
    // The trigger read totalbase.on_behalf_of_user_id.
    expect(res.json().data.initiated_by).toBe(sameTenantUser);
    const audit = await waitFor(async () => (await database.query<{ principal_type: string; actor: string; on_behalf_of: string }>(
      `SELECT principal_type, actor, on_behalf_of FROM totalbase.logs WHERE resource = $1 AND action = 'CREATE' AND status = 'EXECUTED'`, [itemsId])).rows[0]);
    expect(audit).toMatchObject({ principal_type: "API_KEY", actor: serviceUserId, on_behalf_of: sameTenantUser });
    const { rows: outbox } = await database.query<{ on_behalf_of: string }>(`SELECT on_behalf_of FROM totalbase.outbox WHERE resource = $1`, [itemsId]);
    expect(outbox[0]?.on_behalf_of).toBe(sameTenantUser);

    // Without the header: nobody named.
    const plain = await post(`/api/public/table/${ITEMS}`, { data: { name: "plain" } });
    expect(plain.json().data.initiated_by).toBeNull();

    // The named user lends no permission: a column the service may not write is still refused, a read is the service's.
    const denied = await app.inject({ method: "PATCH", url: `/api/public/table/${ITEMS}/${res.json().data.id}`, headers: { authorization: `Bearer ${serviceToken}`, [HEADER]: sameTenantUser }, payload: { data: { name: "renamed" } } });
    expect(denied.statusCode, denied.body).toBe(403);
    const deniedAudit = await waitFor(async () => (await database.query<{ on_behalf_of: string }>(
      `SELECT on_behalf_of FROM totalbase.logs WHERE resource = $1 AND status = 'DENIED'`, [itemsId])).rows[0]);
    expect(deniedAudit.on_behalf_of).toBe(sameTenantUser);
    const read = await get(`/api/public/table/${ITEMS}?order_by=id`, { [HEADER]: sameTenantUser });
    expect(read.statusCode).toBe(200);
    expect(read.json().data.map((r: { name: string }) => r.name)).toEqual(["for Ana", "plain"]);
  });

  it("an administrator may name anyone; the capability is administrator-written", async () => {
    const adminToken = await (await import("./test-support.js")).adminToken(context);
    const res = await app.inject({ method: "GET", url: `/api/public/table/${ITEMS}`, headers: { authorization: `Bearer ${adminToken}`, [HEADER]: otherTenantUser } });
    expect(res.statusCode, res.body).toBe(200);
    const write = await post("/api/totalbase/table/roles_capabilities", { data: { role: serviceRole, capability: "ACT_ON_BEHALF", effect: "ALLOW" } });
    expect([403, 409]).toContain(write.statusCode);
  });
});
