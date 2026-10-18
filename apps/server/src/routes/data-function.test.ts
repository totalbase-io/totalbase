import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { createTestApiToken, setupTestApp } from "../test-support.js";

const PREFIX = "data-function-test";

/**
 * POST /api/:schema/function/:resource - FUNCTION EXECUTE (Specification_Data_API.md §7).
 * AGENTS.md section 23's mandatory coverage for functions:
 * the EXECUTE permission (DENY > ALLOW > UNDEFINED), PostgreSQL's own
 * RAISE EXCEPTION surfacing with the whole call rolled back, the audit
 * row and the outbox event committed in the call's own transaction,
 * overload resolution, parameterized arguments and hidden functions.
 */
describe("POST /api/:schema/function/:resource", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  const resourceIds: Record<string, string> = {};
  let allowRoleId: string;
  let denyRoleId: string;
  let allowed: { plainKey: string; userId: string };
  let denied: { plainKey: string; userId: string };
  let noGrant: { plainKey: string; userId: string; tokenId: string };

  const call = (name: string, args: Record<string, unknown>, token?: string) =>
    app.inject({
      method: "POST",
      url: `/api/public/function/${name}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: { data: args },
    });

  async function registerFunction(signature: string, name: string, exposed = true): Promise<string> {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regprocedure($1)::oid, 'public', $2, 'FUNCTION', 'ACTIVE', $3)
       RETURNING id`,
      [signature, name, exposed ? ["POST"] : []],
    );
    return rows[0]!.id;
  }

  async function cleanup(): Promise<void> {
    await database.query(`DELETE FROM totalbase.users WHERE email LIKE '${PREFIX}%'`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE '${PREFIX}%'`);
    await database.query(`DELETE FROM totalbase.resources WHERE "schema" = 'public' AND name LIKE 'dft\\_%'`);
    await database.query(`DROP FUNCTION IF EXISTS public.dft_add(int, int), public.dft_log(text), public.dft_over(int), public.dft_over(int, int), public.dft_hidden(), public.dft_actor()`);
    await database.query(`DROP TABLE IF EXISTS public.dft_log_entries`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await cleanup();

    await database.query(`CREATE TABLE public.dft_log_entries (id serial PRIMARY KEY, message text NOT NULL)`);
    await database.query(`CREATE FUNCTION public.dft_add(a int, b int) RETURNS int LANGUAGE sql AS 'SELECT a + b'`);
    // Writes, then refuses 'boom' - the write must not survive the refusal.
    await database.query(`
      CREATE FUNCTION public.dft_log(message text) RETURNS int LANGUAGE plpgsql AS $$
      DECLARE new_id int;
      BEGIN
        INSERT INTO public.dft_log_entries (message) VALUES (message) RETURNING id INTO new_id;
        IF message = 'boom' THEN RAISE EXCEPTION 'The message may not be boom'; END IF;
        RETURN new_id;
      END $$`);
    await database.query(`CREATE FUNCTION public.dft_over(a int) RETURNS int LANGUAGE sql AS 'SELECT a'`);
    await database.query(`CREATE FUNCTION public.dft_over(a int, b int DEFAULT 0) RETURNS int LANGUAGE sql AS 'SELECT a + b'`);
    await database.query(`CREATE FUNCTION public.dft_hidden() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
    await database.query(`CREATE FUNCTION public.dft_actor() RETURNS text LANGUAGE sql AS $$SELECT current_setting('totalbase.actor_user_id', true)$$`);

    resourceIds.add = await registerFunction("public.dft_add(int, int)", "dft_add");
    resourceIds.log = await registerFunction("public.dft_log(text)", "dft_log");
    resourceIds.over1 = await registerFunction("public.dft_over(int)", "dft_over");
    resourceIds.over2 = await registerFunction("public.dft_over(int, int)", "dft_over");
    resourceIds.hidden = await registerFunction("public.dft_hidden()", "dft_hidden", false);
    resourceIds.actor = await registerFunction("public.dft_actor()", "dft_actor");

    allowRoleId = (await context.roles.create(`${PREFIX}-allow`, { apiAccess: true })).id;
    denyRoleId = (await context.roles.create(`${PREFIX}-deny`, { apiAccess: true })).id;
    const noGrantRoleId = (await context.roles.create(`${PREFIX}-none`, { apiAccess: true })).id;
    for (const id of Object.values(resourceIds)) {
      await context.permissions.set(allowRoleId, id, "EXECUTE", { effect: "ALLOW" });
    }
    await context.permissions.set(denyRoleId, resourceIds.add!, "EXECUTE", { effect: "DENY" });

    allowed = await createTestApiToken(context, { name: `${PREFIX}-allowed`, roleId: allowRoleId, email: `${PREFIX}-allowed@example.com` });
    denied = await createTestApiToken(context, { name: `${PREFIX}-denied`, roleId: allowRoleId, email: `${PREFIX}-denied@example.com` });
    await context.roleAssignments.assignRoleToUser(denied.userId, denyRoleId);
    noGrant = await createTestApiToken(context, { name: `${PREFIX}-none`, roleId: noGrantRoleId, email: `${PREFIX}-none@example.com` });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("requires a bearer token", async () => {
    expect((await call("dft_add", { a: 1, b: 2 })).statusCode).toBe(401);
  });

  it("returns a scalar function's result", async () => {
    const res = await call("dft_add", { a: 2, b: 3 }, allowed.plainKey);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toBe(5);
  });

  it("runs with totalbase.actor_user_id set to the acting user, like a table write", async () => {
    const res = await call("dft_actor", {}, allowed.plainKey);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toBe(allowed.userId);
  });

  it("denies a role without EXECUTE (UNDEFINED = denied) and audits the refusal", async () => {
    const res = await call("dft_add", { a: 1, b: 1 }, noGrant.plainKey);
    expect(res.statusCode).toBe(403);
    expect(res.json().errors[0].code).toBe("FUNCTION_EXECUTION_DENIED");
    // An API token's entries are recorded under the token (principal API_KEY), not its owner.
    const { rows } = await database.query(
      `SELECT 1 FROM totalbase.logs
       WHERE resource = $1 AND action = 'EXECUTE' AND status = 'DENIED' AND principal_type = 'API_KEY' AND principal = $2`,
      [resourceIds.add, noGrant.tokenId],
    );
    expect(rows).toHaveLength(1);
  });

  it("lets a DENY from any role win over another role's ALLOW", async () => {
    const res = await call("dft_add", { a: 1, b: 1 }, denied.plainKey);
    expect(res.statusCode).toBe(403);
    expect(res.json().errors[0].code).toBe("FUNCTION_EXECUTION_DENIED");
  });

  it("commits the function's writes, its audit row and its outbox event together", async () => {
    const res = await call("dft_log", { message: "hello" }, allowed.plainKey);
    expect(res.statusCode, res.body).toBe(200);
    const newId = res.json().data as number;
    expect((await database.query(`SELECT message FROM public.dft_log_entries WHERE id = $1`, [newId])).rows[0]).toEqual({ message: "hello" });

    const { rows: audit } = await database.query<{ request_id: string; payload: unknown }>(
      `SELECT request_id, payload FROM totalbase.logs WHERE resource = $1 AND action = 'EXECUTE' AND status = 'EXECUTED' ORDER BY created_at DESC LIMIT 1`,
      [resourceIds.log],
    );
    expect(audit[0]!.payload).toEqual({ message: "hello" });
    const { rows: outbox } = await database.query<{ payload: { data: unknown; result: unknown } }>(
      `SELECT payload FROM totalbase.outbox WHERE request_id = $1 AND resource = $2 AND event = 'EXECUTE'`,
      [audit[0]!.request_id, resourceIds.log],
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.payload).toEqual({ data: { message: "hello" }, result: newId });
  });

  it("surfaces RAISE EXCEPTION and rolls the whole call back - no write, no outbox event", async () => {
    const outboxBefore = (await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM totalbase.outbox WHERE resource = $1`, [resourceIds.log],
    )).rows[0]!.count;

    const res = await call("dft_log", { message: "boom" }, allowed.plainKey);
    expect(res.statusCode).toBe(422);
    expect(res.json().errors[0]).toMatchObject({ code: "RAISE_EXCEPTION", message: expect.stringContaining("may not be boom") });

    expect((await database.query(`SELECT 1 FROM public.dft_log_entries WHERE message = 'boom'`)).rows).toHaveLength(0);
    const outboxAfter = (await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM totalbase.outbox WHERE resource = $1`, [resourceIds.log],
    )).rows[0]!.count;
    expect(outboxAfter).toBe(outboxBefore);
    const { rows: failed } = await database.query(
      `SELECT 1 FROM totalbase.logs WHERE resource = $1 AND action = 'EXECUTE' AND status = 'FAILED'`,
      [resourceIds.log],
    );
    expect(failed.length).toBeGreaterThan(0);
  });

  it("passes argument values as parameters - SQL in a value is just text", async () => {
    const payload = "x'); DROP TABLE public.dft_log_entries; --";
    const res = await call("dft_log", { message: payload }, allowed.plainKey);
    expect(res.statusCode, res.body).toBe(200);
    const { rows } = await database.query(`SELECT message FROM public.dft_log_entries WHERE id = $1`, [res.json().data]);
    expect(rows[0]).toEqual({ message: payload });
  });

  it("resolves overloads by argument names, and refuses what is ambiguous or matches nothing", async () => {
    const two = await call("dft_over", { a: 2, b: 5 }, allowed.plainKey);
    expect(two.statusCode, two.body).toBe(200);
    expect(two.json().data).toBe(7);

    // `b` has a DEFAULT, so { a } fits both signatures.
    const ambiguous = await call("dft_over", { a: 2 }, allowed.plainKey);
    expect(ambiguous.json().errors[0].code).toBe("AMBIGUOUS_FUNCTION");

    const unknownArg = await call("dft_add", { a: 1, c: 2 }, allowed.plainKey);
    expect(unknownArg.statusCode).toBe(404);
    expect(unknownArg.json().errors[0].code).toBe("FUNCTION_SIGNATURE_NOT_FOUND");
  });

  it("treats a function that isn't exposed as missing, even with EXECUTE granted", async () => {
    const res = await call("dft_hidden", {}, allowed.plainKey);
    expect(res.statusCode).toBe(404);
    expect(res.json().errors[0].code).toBe("RESOURCE_NOT_FOUND");
  });
});
