import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp, waitFor } from "./test-support.js";

const PREFIX = "async-calls-test";

/**
 * Asynchronous calls (Specification_Data_API.md §10.4): `Prefer:
 * respond-async` on a function call or a transaction is checked at once,
 * queued, answered 202, run by the executions worker as the caller
 * resolved again, and polled at /api/executions/{id} by that caller only.
 */
describe("Asynchronous function calls and transactions", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let noGrantRoleId: string;
  let itemsId: string;
  const functionIds: string[] = [];
  let caller: { plainKey: string; userId: string; tokenId: string };
  let other: { plainKey: string; userId: string; tokenId: string };

  const post = (url: string, payload: unknown, token: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}`, prefer: "respond-async", ...headers }, payload: payload as Record<string, unknown> });
  const poll = (id: string, token: string) =>
    app.inject({ method: "GET", url: `/api/executions/${id}`, headers: { authorization: `Bearer ${token}` } });

  async function registerFunction(signature: string, name: string): Promise<string> {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regprocedure($1)::oid, 'public', $2, 'FUNCTION', 'ACTIVE', ARRAY['POST'])
       RETURNING id`,
      [signature, name],
    );
    functionIds.push(rows[0]!.id);
    return rows[0]!.id;
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`DROP FUNCTION IF EXISTS public.dac_add(int, int), public.dac_fail(), public.dac_slow(text)`);
    await database.query(`DROP TABLE IF EXISTS public.dac_items`);
    await database.query(`CREATE TABLE public.dac_items (id serial PRIMARY KEY, label text NOT NULL)`);
    await database.query(`CREATE FUNCTION public.dac_add(a int, b int) RETURNS int LANGUAGE sql AS 'SELECT a + b'`);
    await database.query(`CREATE FUNCTION public.dac_fail() RETURNS int LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Not today'; END $$`);
    // Writes, then sleeps - a cancel while it sleeps must leave no row behind.
    await database.query(`CREATE FUNCTION public.dac_slow(label text) RETURNS int LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO public.dac_items (label) VALUES (label); PERFORM pg_sleep(10); RETURN 1; END $$`);
    const addId = await registerFunction("public.dac_add(int, int)", "dac_add");
    const slowId = await registerFunction("public.dac_slow(text)", "dac_slow");
    const failId = await registerFunction("public.dac_fail()", "dac_fail");
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES ('public.dac_items'::regclass::oid, 'public', 'dac_items', 'TABLE', 'ACTIVE', ARRAY['GET','POST'])
       RETURNING id`,
    );
    itemsId = rows[0]!.id;

    roleId = (await context.roles.create(`${PREFIX}-role`, { apiAccess: true })).id;
    noGrantRoleId = (await context.roles.create(`${PREFIX}-none`, { apiAccess: true })).id;
    await context.permissions.set(roleId, addId, "EXECUTE", { effect: "ALLOW" });
    await context.permissions.set(roleId, failId, "EXECUTE", { effect: "ALLOW" });
    await context.permissions.set(roleId, slowId, "EXECUTE", { effect: "ALLOW" });
    const fields = [{ field: "id", effect: "ALLOW" as const }, { field: "label", effect: "ALLOW" as const }];
    await context.permissions.set(roleId, itemsId, "CREATE", { effect: "ALLOW", fields });
    await context.permissions.set(roleId, itemsId, "READ", { effect: "ALLOW", fields });
    await context.capabilityPermissions.setGrant(roleId, "TRANSACTIONS", "ALLOW");
    await context.settings.set("transactions.enabled", true);

    caller = await createTestApiToken(context, { name: `${PREFIX}-caller`, roleId, email: `${PREFIX}-caller@example.com` });
    other = await createTestApiToken(context, { name: `${PREFIX}-other`, roleId: noGrantRoleId, email: `${PREFIX}-other@example.com` });
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.executions WHERE principal = ANY($1)`, [[caller.tokenId, other.tokenId]]);
    await database.query(`DELETE FROM totalbase.users WHERE id = ANY($1)`, [[caller.userId, other.userId]]);
    await database.query(`DELETE FROM totalbase.roles_capabilities WHERE role = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = ANY($1)`, [[roleId, noGrantRoleId]]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1)`, [[...functionIds, itemsId]]);
    await context.settings.reset("transactions.enabled");
    await database.query(`DROP FUNCTION IF EXISTS public.dac_add(int, int), public.dac_fail(), public.dac_slow(text)`);
    await database.query(`DROP TABLE IF EXISTS public.dac_items`);
    await app.close();
    await database.close();
  });

  it("queues a function call, runs it in the worker and shows its result to the caller only", async () => {
    const queued = await post("/api/public/function/dac_add", { data: { a: 2, b: 3 } }, caller.plainKey);
    expect(queued.statusCode).toBe(202);
    const { id, status, result } = queued.json().data;
    expect(status).toBe("PENDING");
    expect(result).toBeNull();

    expect((await poll(id, other.plainKey)).statusCode).toBe(404);
    await context.executionsWorker.processBatch(10);
    const done = await poll(id, caller.plainKey);
    expect(done.json().data).toMatchObject({ status: "COMPLETED", result: 5, error: null });

    // Audited under the execution's id, like a direct call under its request's.
    const { rows } = await database.query(`SELECT status FROM totalbase.logs WHERE request_id = $1 AND action = 'EXECUTE'`, [id]);
    expect(rows).toEqual([{ status: "EXECUTED" }]);
  });

  it("refuses at once what can never run: no EXECUTE, nothing queued", async () => {
    const res = await post("/api/public/function/dac_add", { data: { a: 1, b: 1 } }, other.plainKey);
    expect(res.statusCode).toBe(403);
    expect(res.json().errors[0].code).toBe("FUNCTION_EXECUTION_DENIED");
    const { rows } = await database.query(`SELECT 1 FROM totalbase.executions WHERE principal = $1`, [other.tokenId]);
    expect(rows).toHaveLength(0);
  });

  it("a PostgreSQL error becomes the execution's error, not retried", async () => {
    const queued = await post("/api/public/function/dac_fail", { data: {} }, caller.plainKey);
    await context.executionsWorker.processBatch(10);
    const failed = (await poll(queued.json().data.id, caller.plainKey)).json().data;
    expect(failed.status).toBe("FAILED");
    expect(failed.error.message).toContain("Not today");
  });

  it("an Idempotency-Key retry replays the same 202 - the same execution", async () => {
    const key = `${PREFIX}-${Date.now()}`;
    const first = await post("/api/public/function/dac_add", { data: { a: 4, b: 4 } }, caller.plainKey, { "idempotency-key": key });
    const again = await post("/api/public/function/dac_add", { data: { a: 4, b: 4 } }, caller.plainKey, { "idempotency-key": key });
    expect(again.statusCode).toBe(202);
    expect(again.json().data.id).toBe(first.json().data.id);
    await context.executionsWorker.processBatch(10);
  });

  it("runs as the caller resolved again: a role lost after queueing fails the call", async () => {
    const queued = await post("/api/public/function/dac_add", { data: { a: 1, b: 2 } }, caller.plainKey);
    await context.permissions.set(roleId, functionIds[0]!, "EXECUTE", { effect: "DENY" });
    try {
      await context.executionsWorker.processBatch(10);
    } finally {
      await context.permissions.set(roleId, functionIds[0]!, "EXECUTE", { effect: "ALLOW" });
    }
    const failed = (await poll(queued.json().data.id, caller.plainKey)).json().data;
    expect(failed).toMatchObject({ status: "FAILED", error: { code: "FUNCTION_EXECUTION_DENIED" } });
  });

  it("queues a transaction and returns each operation's row as its result", async () => {
    const queued = await post("/api/transactions", {
      operations: [
        { key: "first", operation: "insert", schema: "public", table: "dac_items", data: { label: "one" } },
        { key: "second", operation: "insert", schema: "public", table: "dac_items", data: { label: "two" } },
      ],
    }, caller.plainKey);
    expect(queued.statusCode).toBe(202);
    await context.executionsWorker.processBatch(10);
    const done = (await poll(queued.json().data.id, caller.plainKey)).json().data;
    expect(done.error).toBeNull();
    expect(done.status).toBe("COMPLETED");
    expect(done.result.first.label).toBe("one");
    expect(done.result.second.label).toBe("two");
  });

  it("refuses a transaction at once without the TRANSACTIONS capability", async () => {
    const res = await post("/api/transactions", {
      operations: [{ key: "x", operation: "insert", schema: "public", table: "dac_items", data: { label: "x" } }],
    }, other.plainKey);
    expect(res.statusCode).toBe(403);
    expect(res.json().errors[0].code).toBe("TRANSACTION_EXECUTION_DENIED");
  });

  describe("cancellation (Specification_Data_API.md §10.5)", () => {
    const cancel = (id: string, token: string) =>
      app.inject({ method: "POST", url: `/api/executions/${id}/cancel`, headers: { authorization: `Bearer ${token}` } });
    const labelCount = async (label: string) =>
      Number((await database.query<{ n: string }>(`SELECT count(*) AS n FROM public.dac_items WHERE label = $1`, [label])).rows[0]!.n);

    it("a queued call never starts: CANCELLED at once, nothing written", async () => {
      const queued = await post("/api/public/function/dac_slow", { data: { label: "never" } }, caller.plainKey);
      const id = queued.json().data.id;
      expect((await cancel(id, other.plainKey)).statusCode).toBe(404);
      const res = await cancel(id, caller.plainKey);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ status: "CANCELLED", result: null, error: { code: "CANCELLED" } });
      await context.executionsWorker.processBatch(10);
      expect((await poll(id, caller.plainKey)).json().data.status).toBe("CANCELLED");
      expect(await labelCount("never")).toBe(0);
    });

    it("a running call is stopped and rolled back whole", async () => {
      const queued = await post("/api/public/function/dac_slow", { data: { label: "stopped" } }, caller.plainKey);
      const id = queued.json().data.id;
      const batch = context.executionsWorker.processBatch(10);
      // Wait until its statement is running under the execution's name.
      await waitFor(async () => (await database.query(`SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND state = 'active'`, [`totalbase-execution:${id}`])).rows.length > 0, { intervalMs: 50 });
      const res = await cancel(id, caller.plainKey);
      expect(res.statusCode).toBe(200);
      await batch;
      expect((await poll(id, caller.plainKey)).json().data).toMatchObject({ status: "CANCELLED", error: { code: "CANCELLED" } });
      expect(await labelCount("stopped")).toBe(0);
    });

    it("a finished execution cannot be cancelled", async () => {
      const queued = await post("/api/public/function/dac_add", { data: { a: 1, b: 1 } }, caller.plainKey);
      await context.executionsWorker.processBatch(10);
      const res = await cancel(queued.json().data.id, caller.plainKey);
      expect(res.statusCode).toBe(409);
      expect(res.json().errors[0].code).toBe("EXECUTION_NOT_CANCELLABLE");
    });
  });
});
