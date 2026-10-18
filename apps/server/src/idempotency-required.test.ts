import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

/**
 * Required idempotency key (Specification_Data_API.md §9.1): an
 * administrator marks a TABLE's CREATE or a FUNCTION's EXECUTE as needing an
 * Idempotency-Key. Fixtures are prefixed `idem_req_test` and removed by
 * primary key.
 */
describe("Required idempotency key", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let tableId: string;
  let viewId: string;
  let functionId: string;
  let roleId: string;
  let apiKey: string;
  let apiKeyUserId: string;

  const admin = (method: "GET" | "PATCH", url: string, data?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${adminToken}` }, ...(data === undefined ? {} : { payload: { data } as Record<string, unknown> }) });
  const call = (url: string, data: unknown, idempotencyKey?: string) =>
    app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${apiKey}`, ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
      payload: { data } as Record<string, unknown>,
    });
  const create = (data: unknown, key?: string) => call("/api/public/table/idem_req_test_orders", data, key);
  const charge = (amount: number, key?: string) => call("/api/public/function/idem_req_test_charge", { amount }, key);
  const require = (id: string, value: boolean) => admin("PATCH", `/admin/api/resources/${id}`, { requireIdempotencyKey: value });
  const count = async (table: string) => (await database.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0]!.n;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;

    await database.query(`DROP VIEW IF EXISTS public.idem_req_test_orders_view`);
    await database.query(`DROP FUNCTION IF EXISTS public.idem_req_test_charge(integer)`);
    await database.query(`DROP TABLE IF EXISTS public.idem_req_test_charges, public.idem_req_test_orders`);
    await database.query(`CREATE TABLE public.idem_req_test_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL)`);
    await database.query(`CREATE VIEW public.idem_req_test_orders_view AS SELECT id, name FROM public.idem_req_test_orders`);
    await database.query(`CREATE TABLE public.idem_req_test_charges (id serial PRIMARY KEY, amount integer NOT NULL)`);
    await database.query(`
      CREATE FUNCTION public.idem_req_test_charge(amount integer) RETURNS integer LANGUAGE sql AS $$
        INSERT INTO public.idem_req_test_charges (amount) VALUES (amount) RETURNING id
      $$`);

    const register = async (oidSql: string, name: string, type: string, methods: string) =>
      (await database.query<{ id: string }>(
        `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
         VALUES ((${oidSql})::oid, 'public', $1, $2, 'ACTIVE', $3) RETURNING id`,
        [name, type, methods],
      )).rows[0]!.id;
    tableId = await register(`to_regclass('public.idem_req_test_orders')`, "idem_req_test_orders", "TABLE", "{GET,POST}");
    viewId = await register(`to_regclass('public.idem_req_test_orders_view')`, "idem_req_test_orders_view", "VIEW", "{GET}");
    functionId = await register(`'public.idem_req_test_charge(integer)'::regprocedure`, "idem_req_test_charge", "FUNCTION", "{POST}");

    roleId = (await context.roles.create("idem-req-test-role", { apiAccess: true })).id;
    const fields = [{ field: "id", effect: "ALLOW" as const }, { field: "name", effect: "ALLOW" as const }];
    await context.permissions.set(roleId, tableId, "READ", { effect: "ALLOW", fields });
    await context.permissions.set(roleId, tableId, "CREATE", { effect: "ALLOW", fields: [{ field: "name", effect: "ALLOW" }] });
    await context.permissions.set(roleId, functionId, "EXECUTE", { effect: "ALLOW" });
    const token = await createTestApiToken(context, { name: "idem-req-test", roleId, email: "idem-req-test@example.com" });
    apiKey = token.plainKey;
    apiKeyUserId = token.userId;
  });

  afterEach(async () => {
    await context.settings.reset("idempotency.enabled");
    await database.query(`DELETE FROM totalbase.idempotency_keys WHERE principal = $1`, [apiKeyUserId]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [apiKeyUserId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    for (const id of [tableId, viewId, functionId]) await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [id]);
    await database.query(`DROP VIEW IF EXISTS public.idem_req_test_orders_view`);
    await database.query(`DROP FUNCTION IF EXISTS public.idem_req_test_charge(integer)`);
    await database.query(`DROP TABLE IF EXISTS public.idem_req_test_charges, public.idem_req_test_orders`);
    await app.close();
  });

  it("an administrator marks a table or a function, never a view", async () => {
    const res = await require(tableId, true);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.requireIdempotencyKey).toBe(true);
    const view = await require(viewId, true);
    expect([view.statusCode, view.json().errors[0].code]).toEqual([400, "INVALID_QUERY"]);
    // PostgreSQL holds the rule too, for a write that skips the Admin API.
    await expect(database.query(`UPDATE totalbase.resources SET require_idempotency_key = true WHERE id = $1`, [viewId]))
      .rejects.toMatchObject({ code: "CHECK_VIOLATION" });
    await require(tableId, false);
  });

  it("a marked table refuses a CREATE without the key, before writing anything", async () => {
    await require(tableId, true);
    try {
      const before = await count("idem_req_test_orders");
      const missing = await create({ name: "no key" });
      expect([missing.statusCode, missing.json().errors[0].code]).toEqual([400, "IDEMPOTENCY_KEY_REQUIRED"]);
      const malformed = await create({ name: "bad key" }, "has spaces");
      expect([malformed.statusCode, malformed.json().errors[0].code]).toEqual([400, "INVALID_IDEMPOTENCY_KEY"]);
      expect(await count("idem_req_test_orders")).toBe(before);

      const first = await create({ name: "keyed" }, "order-1");
      expect(first.statusCode, first.body).toBe(201);
      const replay = await create({ name: "keyed" }, "order-1");
      expect(replay.json()).toEqual(first.json());
      expect(await count("idem_req_test_orders")).toBe(before + 1);
    } finally {
      await require(tableId, false);
    }
    // Unmarked again: the key is optional.
    expect((await create({ name: "optional" })).statusCode).toBe(201);
  });

  it("a marked function refuses an EXECUTE without the key, and runs once with one", async () => {
    await require(functionId, true);
    try {
      const before = await count("idem_req_test_charges");
      const missing = await charge(10);
      expect([missing.statusCode, missing.json().errors[0].code]).toEqual([400, "IDEMPOTENCY_KEY_REQUIRED"]);
      expect(await count("idem_req_test_charges")).toBe(before);

      const first = await charge(10, "charge-1");
      expect(first.statusCode, first.body).toBe(200);
      const replay = await charge(10, "charge-1");
      expect(replay.json()).toEqual(first.json());
      const reused = await charge(99, "charge-1");
      expect([reused.statusCode, reused.json().errors[0].code]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
      expect(await count("idem_req_test_charges")).toBe(before + 1);
    } finally {
      await require(functionId, false);
    }
  });

  it("an unmarked function accepts an optional key and replays it", async () => {
    const before = await count("idem_req_test_charges");
    const first = await charge(5, "charge-optional");
    const replay = await charge(5, "charge-optional");
    expect(replay.json()).toEqual(first.json());
    expect(await count("idem_req_test_charges")).toBe(before + 1);
    expect((await charge(5)).statusCode).toBe(200);
    expect(await count("idem_req_test_charges")).toBe(before + 2);
  });

  it("with idempotency.enabled off the header is ignored, and so is the requirement", async () => {
    await require(tableId, true);
    try {
      await context.settings.set("idempotency.enabled", false);
      expect((await create({ name: "disabled" })).statusCode).toBe(201);
    } finally {
      await require(tableId, false);
    }
  });

  it("OpenAPI marks the header required on the marked operations only", async () => {
    await require(tableId, true);
    await require(functionId, true);
    try {
      const spec = (await app.inject({ method: "GET", url: "/api/openapi.json", headers: { authorization: `Bearer ${apiKey}` } })).json();
      const header = (operation: { parameters?: Array<{ name: string; required?: boolean }> }) =>
        operation.parameters?.find((p) => p.name === "Idempotency-Key");
      expect(header(spec.paths["/api/public/table/idem_req_test_orders"].post)?.required).toBe(true);
      expect(header(spec.paths["/api/public/function/idem_req_test_charge"].post)?.required).toBe(true);
    } finally {
      await require(tableId, false);
      await require(functionId, false);
    }
    const spec = (await app.inject({ method: "GET", url: "/api/openapi.json", headers: { authorization: `Bearer ${apiKey}` } })).json();
    const parameters = spec.paths["/api/public/function/idem_req_test_charge"].post.parameters as Array<{ name: string; required?: boolean }>;
    expect(parameters.find((p) => p.name === "Idempotency-Key")?.required).toBe(false);
  });
});
