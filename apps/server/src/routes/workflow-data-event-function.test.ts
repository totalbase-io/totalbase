import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { dispatchDataEvent, validateExecutionReadiness } from "@totalbase/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { createTestApiToken, setupTestApp, uniqueSuffix } from "../test-support.js";

const RUN = uniqueSuffix();
const FN = `wf_fn_check_${RUN}`;
const VIEW = `wf_fn_view_${RUN}`;

/**
 * A DATA_EVENT Start on a function (Workflows.md §6.3.1, §6.3.3): each call through the Data API starts one run
 * with `{ arguments, result }`, for an executor that may EXECUTE it now; a workflow's own Execute function step
 * starts none; a Start with a table's options on a function is refused on save.
 */
describe("DATA_EVENT Start on a function's calls", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminId: string;
  let adminToken: string;
  let functionId: string;
  let roleId: string;
  let caller: { plainKey: string; userId: string };
  let outsider: { userId: string };
  const workflowIds: string[] = [];

  async function workflow(start: Record<string, unknown>, steps: { type: string; configuration: Record<string, unknown> }[] = []): Promise<string> {
    const slug = `wf-fn-${randomUUID().slice(0, 8)}`;
    const workflows = context.workflowsAdmin;
    const id = (await workflows.create({ name: slug, slug, historyLevel: "DETAILED" })).id;
    workflowIds.push(id);
    const startOp = { id: randomUUID(), type: "totalbase.start", key: "start", label: "start", configuration_version: 1, configuration: start };
    const ops = steps.map((step, index) => ({ id: randomUUID(), key: `step_${index}`, label: `step ${index}`, configuration_version: 1, ...step }));
    const done = { id: randomUUID(), type: "totalbase.finish-result", key: "done", label: "done", configuration_version: 1, configuration: { result: "{{start.data}}" } };
    const chain = [startOp, ...ops, done];
    await workflows.saveDraft(id, (await workflows.get(id)).revision, {
      operations: chain,
      connections: chain.slice(1).map((op, index) => ({ source: chain[index]!.id, target: op.id, output: "next" })),
    });
    await workflows.publish(id, (await workflows.get(id)).revision, (d) => validateExecutionReadiness(d, context));
    await workflows.update(id, { revision: (await workflows.get(id)).revision, enabled: true });
    return id;
  }

  const onCalls = (executeAs: string) => workflow({ trigger: "DATA_EVENT", resource: functionId, events: ["EXECUTE"], execute_as: executeAs });
  const resultsOf = async (workflowId: string) => (await context.workflowRuns.listRuns(workflowId, { pageSize: 100 })).runs.map((run) => (run.result as { data?: unknown } | null)?.data);

  /** Every pending event of the function dispatched - the eager dispatch races the test, the claim makes it once. */
  async function settle(): Promise<void> {
    const { rows } = await database.query<{ id: string }>(`SELECT id FROM totalbase.outbox WHERE resource = $1 ORDER BY created_at`, [functionId]);
    for (const { id } of rows) await dispatchDataEvent(context, id);
    for (let i = 0; i < 50; i++) {
      const { rows: busy } = await database.query(`SELECT 1 FROM totalbase.outbox WHERE resource = $1 AND status IN ('PENDING', 'PROCESSING')`, [functionId]);
      if (busy.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const call = (dni: string) => app.inject({
    method: "POST",
    url: `/api/public/function/${FN}`,
    headers: { authorization: `Bearer ${caller.plainKey}` },
    payload: { data: { dni } },
  });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    adminId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email = $1`, [loadServerEnv().adminEmail!])).rows[0]!.id;
    adminToken = (await context.auth.login({ email: loadServerEnv().adminEmail!, password: loadServerEnv().adminPassword! })).token;
    await database.query(`CREATE FUNCTION public.${FN}(dni text) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('allowed', dni <> '0')$$`);
    await database.query(`CREATE VIEW public.${VIEW} AS SELECT 1 AS one`);
    functionId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regprocedure($1)::oid, 'public', $2, 'FUNCTION', 'ACTIVE', ARRAY['POST']) RETURNING id`,
      [`public.${FN}(text)`, FN],
    )).rows[0]!.id;
    roleId = (await context.roles.create(`wf-fn-role-${RUN}`, { apiAccess: true })).id;
    await context.permissions.set(roleId, functionId, "EXECUTE", { effect: "ALLOW" });
    caller = await createTestApiToken(context, { name: `wf-fn-${RUN}`, roleId, email: `wf-fn-caller-${RUN}@example.com` });
    // Active, but with no role that may EXECUTE the function.
    outsider = { userId: (await context.auth.users.create({ email: `wf-fn-outsider-${RUN}@example.com` })).id };
  });

  afterAll(async () => {
    for (const id of workflowIds) await database.query(`DELETE FROM totalbase.workflows WHERE id = $1`, [id]);
    await database.query(`DELETE FROM totalbase.outbox WHERE resource = $1`, [functionId]);
    await database.query(`DELETE FROM totalbase.logs WHERE resource = $1`, [functionId]);
    await database.query(`DELETE FROM totalbase.users WHERE id = ANY($1::uuid[])`, [[caller.userId, outsider.userId]]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [functionId]);
    await database.query(`DROP FUNCTION IF EXISTS public.${FN}(text)`);
    await database.query(`DROP VIEW IF EXISTS public.${VIEW}`);
    await app.close();
  });

  it("starts one run per call with its arguments and result - only for an executor that may EXECUTE it", async () => {
    const admitted = await onCalls(adminId);
    const refused = await onCalls(outsider.userId);
    expect((await call("0")).statusCode).toBe(200);
    expect((await call("30111222")).statusCode).toBe(200);
    await settle();
    expect(await resultsOf(admitted)).toEqual(expect.arrayContaining([
      { arguments: { dni: "0" }, result: { allowed: false } },
      { arguments: { dni: "30111222" }, result: { allowed: true } },
    ]));
    expect(await resultsOf(admitted)).toHaveLength(2);
    expect(await resultsOf(refused)).toEqual([]);
  });

  it("starts nothing for a workflow's own Execute function step - no loop through a function", async () => {
    const listener = await onCalls(adminId);
    const caller = await workflow({ trigger: "MANUAL" }, [{ type: "totalbase.execute-function", configuration: { function: functionId, arguments: { dni: "1" } } }]);
    const slug = (await context.workflowsAdmin.get(caller)).slug;
    const res = await app.inject({ method: "POST", url: `/api/workflows/${slug}/run`, headers: { authorization: `Bearer ${adminToken}` }, payload: { data: {} } });
    expect(res.json().data, res.body).toMatchObject({ status: "SUCCEEDED" });
    await settle();
    expect(await resultsOf(listener)).toEqual([]);
  });

  it("refuses on save a function's Start with a table's events or options, and a view's (M27)", async () => {
    const base = { trigger: "DATA_EVENT", resource: functionId, execute_as: adminId };
    await expect(workflow({ ...base, events: ["CREATE"] })).rejects.toMatchObject({ code: "WORKFLOW_INVALID_DESIGN", message: expect.stringContaining("a function's event is EXECUTE") });
    await expect(workflow({ ...base, events: ["EXECUTE"], filter: { dni: { _eq: "0" } } })).rejects.toMatchObject({ code: "WORKFLOW_INVALID_DESIGN", message: expect.stringContaining("with no filter") });
    await expect(workflow({ ...base, events: ["EXECUTE"], for_each: "STATEMENT" })).rejects.toMatchObject({ code: "WORKFLOW_INVALID_DESIGN", message: expect.stringContaining("with no for_each") });
    const view = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'VIEW', 'ACTIVE', ARRAY['GET']) RETURNING id`,
      [`public.${VIEW}`, VIEW],
    )).rows[0]!.id;
    try {
      await expect(workflow({ ...base, resource: view, events: ["CREATE"] })).rejects.toMatchObject({ code: "WORKFLOW_INVALID_DESIGN", message: expect.stringContaining(`public.${VIEW} is a VIEW`) });
    } finally {
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [view]);
    }
  });
});
