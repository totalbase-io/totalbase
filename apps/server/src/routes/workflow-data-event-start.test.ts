import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { dispatchDataEvent, validateExecutionReadiness } from "@totalbase/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

const PREFIX = "wf-start-test";
const TABLE = "wf_start_test_orders";

/**
 * A DATA_EVENT Start's own matching and granularity (Specification_Workflows.md
 * §6.3.1, §6.3.3): For each row or For each statement - the rows of one write,
 * one run - and its filter, changed fields and filter on the row before.
 */
describe("DATA_EVENT Start: For each row / statement, filters", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminId: string;
  let tableResourceId: string;
  const workflowIds: string[] = [];
  const requestIds: string[] = [];

  async function workflow(event: "CREATE" | "UPDATE", start: Record<string, unknown>): Promise<string> {
    const slug = `${PREFIX}-${randomUUID().slice(0, 8)}`;
    const workflows = context.workflowsAdmin;
    const id = (await workflows.create({ name: slug, slug, historyLevel: "DETAILED" })).id;
    workflowIds.push(id);
    const startOp = { id: randomUUID(), type: "totalbase.start", key: "start", label: "start", configuration_version: 1,
      configuration: { trigger: "DATA_EVENT", resource: tableResourceId, events: [event], execute_as: adminId, ...start } };
    const done = { id: randomUUID(), type: "totalbase.finish-result", key: "done", label: "done", configuration_version: 1, configuration: { result: "{{start.data}}" } };
    await workflows.saveDraft(id, (await workflows.get(id)).revision, { operations: [startOp, done], connections: [{ source: startOp.id, target: done.id, output: "next" }] });
    await workflows.publish(id, (await workflows.get(id)).revision, (d) => validateExecutionReadiness(d, context));
    await workflows.update(id, { revision: (await workflows.get(id)).revision, enabled: true });
    return id;
  }

  /** One write: an outbox event per row, sharing its request id - as the Data API writes them. */
  async function write(event: "CREATE" | "UPDATE", rows: Array<{ row: Record<string, unknown>; old?: Record<string, unknown>; changed?: string[] }>): Promise<string[]> {
    const requestId = randomUUID();
    requestIds.push(requestId);
    const ids: string[] = [];
    for (const { row, old, changed } of rows) {
      ids.push((await database.query<{ id: string }>(
        `INSERT INTO totalbase.outbox (request_id, resource, event, payload, old_payload, changed_columns)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::text[]) RETURNING id`,
        [requestId, tableResourceId, event, JSON.stringify(row), old ? JSON.stringify(old) : null, changed ?? null],
      )).rows[0]!.id);
    }
    return ids;
  }
  const dispatchAll = async (ids: string[]) => {
    for (const id of ids) await dispatchDataEvent(context, id);
  };
  const resultsOf = async (workflowId: string) => (await context.workflowRuns.listRuns(workflowId, { pageSize: 100 })).runs.map((run) => (run.result as { data?: unknown } | null)?.data);

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    adminId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email = $1`, [loadServerEnv().adminEmail!])).rows[0]!.id;
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await database.query(`CREATE TABLE public.${TABLE} (id integer PRIMARY KEY, status text NOT NULL, total numeric)`);
    tableResourceId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', ARRAY['GET']) RETURNING id`,
      [`public.${TABLE}`, TABLE],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    for (const id of workflowIds) await database.query(`DELETE FROM totalbase.workflows WHERE id = $1`, [id]);
    for (const id of requestIds) await database.query(`DELETE FROM totalbase.outbox WHERE request_id = $1`, [id]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [tableResourceId]);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await app.close();
  });

  it("For each statement: one run with every row of the write - however many events it has", async () => {
    const perWrite = await workflow("CREATE", { for_each: "STATEMENT" });
    const perRow = await workflow("CREATE", { for_each: "ROW" });
    await dispatchAll(await write("CREATE", [{ row: { id: 1, status: "NEW" } }, { row: { id: 2, status: "NEW" } }, { row: { id: 3, status: "NEW" } }]));
    const statementRuns = await resultsOf(perWrite);
    expect(statementRuns).toHaveLength(1);
    expect(statementRuns[0]).toEqual([{ id: 1, status: "NEW" }, { id: 2, status: "NEW" }, { id: 3, status: "NEW" }]);
    expect(await resultsOf(perRow)).toHaveLength(3);
  });

  it("a filter keeps only the rows matching it - in either granularity; none matching, no run", async () => {
    const paidRows = await workflow("CREATE", { filter: { status: { _eq: "PAID" } } });
    const paidWrite = await workflow("CREATE", { for_each: "STATEMENT", filter: { status: { _eq: "PAID" } } });
    await dispatchAll(await write("CREATE", [{ row: { id: 10, status: "PAID" } }, { row: { id: 11, status: "NEW" } }]));
    expect(await resultsOf(paidRows)).toEqual([{ id: 10, status: "PAID" }]);
    expect(await resultsOf(paidWrite)).toEqual([[{ id: 10, status: "PAID" }]]);
    await dispatchAll(await write("CREATE", [{ row: { id: 12, status: "NEW" } }]));
    expect(await resultsOf(paidWrite)).toHaveLength(1);
  });

  it("on an UPDATE: changed fields and a filter on the row before - PENDING -> PAID only", async () => {
    const paidTransition = await workflow("UPDATE", { filter: { status: { _eq: "PAID" } }, old_filter: { status: { _eq: "PENDING" } } });
    const totalChanged = await workflow("UPDATE", { changed_fields: ["total"] });
    await dispatchAll(await write("UPDATE", [
      { row: { id: 20, status: "PAID", total: 5 }, old: { id: 20, status: "PENDING", total: 5 }, changed: ["status"] },
      { row: { id: 21, status: "PAID", total: 9 }, old: { id: 21, status: "PAID", total: 7 }, changed: ["total"] },
    ]));
    expect(await resultsOf(paidTransition)).toEqual([{ id: 20, status: "PAID", total: 5 }]);
    expect(await resultsOf(totalChanged)).toEqual([{ id: 21, status: "PAID", total: 9 }]);
  });

  it("publish refuses a Start filter outside the grammar", async () => {
    await expect(workflow("CREATE", { filter: { status: { _nope: 1 } } })).rejects.toMatchObject({ code: "WORKFLOW_NOT_PUBLISHABLE" });
  });

  it("save refuses a Start that could never run - a function's events, an event that isn't one (M27)", async () => {
    await expect(workflow("CREATE", { events: ["EXECUTE"] })).rejects.toMatchObject({ code: "WORKFLOW_INVALID_DESIGN", message: 'Start (DATA_EVENT): events are CREATE, UPDATE, DELETE - got "EXECUTE".' });
    const fn = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regproc('pg_catalog.now')::oid, 'pg_catalog', 'now_m27', 'FUNCTION', 'ACTIVE', ARRAY['POST']) RETURNING id`,
    )).rows[0]!.id;
    try {
      await expect(workflow("CREATE", { resource: fn })).rejects.toMatchObject({ code: "WORKFLOW_INVALID_DESIGN", message: expect.stringContaining("pg_catalog.now_m27 is a FUNCTION - a data event comes from a TABLE") });
    } finally {
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [fn]);
    }
  });
});
