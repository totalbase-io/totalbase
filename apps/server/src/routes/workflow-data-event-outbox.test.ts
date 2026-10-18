import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { dispatchDataEvent, validateExecutionReadiness, type WorkflowRunsService } from "@totalbase/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { requeueFailedOutbox } from "../retention.js";
import { setupTestApp } from "../test-support.js";

const PREFIX = "wf-outbox-test";
const TABLE = "wf_outbox_test_items";

/**
 * Outbox delivery guarantees for DATA_EVENT admission
 * (Specification_Data_API.md §13.3, Specification_Workflows.md §6.3.5):
 * a retried event admits each workflow run once, a PROCESSING event whose
 * lease expired is retried, and dispatchers racing over one event never
 * process it twice.
 */
describe("Outbox delivery: idempotent DATA_EVENT admission and the processing lease", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminId: string;
  let tableResourceId: string;
  const workflowIds: string[] = [];
  const eventIds: string[] = [];

  async function dataEventWorkflow(event: "CREATE" | "UPDATE" | "DELETE"): Promise<string> {
    const slug = `${PREFIX}-${randomUUID().slice(0, 8)}`;
    const workflows = context.workflowsAdmin;
    const id = (await workflows.create({ name: slug, slug, historyLevel: "DETAILED" })).id;
    workflowIds.push(id);
    const start = { id: randomUUID(), type: "totalbase.start", key: "start", label: "start", configuration_version: 1,
      configuration: { trigger: "DATA_EVENT", resource: tableResourceId, events: [event], execute_as: adminId } };
    const done = { id: randomUUID(), type: "totalbase.finish-result", key: "done", label: "done", configuration_version: 1,
      configuration: { result: "{{start.data}}" } };
    await workflows.saveDraft(id, (await workflows.get(id)).revision, {
      operations: [start, done],
      connections: [{ source: start.id, target: done.id, output: "next" }],
    });
    await workflows.publish(id, (await workflows.get(id)).revision, (d) => validateExecutionReadiness(d, context));
    await workflows.update(id, { revision: (await workflows.get(id)).revision, enabled: true });
    return id;
  }

  async function enqueue(event: string, payload: unknown, extra = "", params: unknown[] = []): Promise<string> {
    const id = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.outbox (request_id, resource, event, payload${extra ? ", status, attempts, locked_at, locked_until" : ""})
       VALUES (gen_random_uuid(), $1, $2, $3::jsonb${extra ? `, ${extra}` : ""}) RETURNING id`,
      [tableResourceId, event, JSON.stringify(payload), ...params],
    )).rows[0]!.id;
    eventIds.push(id);
    return id;
  }
  const eventRow = async (id: string) =>
    (await database.query<{ status: string; attempts: number; locked_until: Date | null }>(
      `SELECT status, attempts, locked_until FROM totalbase.outbox WHERE id = $1`, [id],
    )).rows[0]!;
  const runsOf = async (workflowId: string) => (await context.workflowRuns.listRuns(workflowId, { pageSize: 100 })).runs;
  const admissionsOf = async (eventId: string) =>
    (await database.query<{ workflow: string; item: number | null }>(
      `SELECT workflow, item FROM totalbase.outbox_admissions WHERE event = $1 ORDER BY workflow, item`, [eventId],
    )).rows;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    adminId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email = $1`, [env.adminEmail])).rows[0]!.id;

    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await database.query(`CREATE TABLE public.${TABLE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL)`);
    tableResourceId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', ARRAY['GET', 'POST'])
       RETURNING id`,
      [`public.${TABLE}`, TABLE],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    for (const id of workflowIds) await database.query(`DELETE FROM totalbase.workflows WHERE id = $1`, [id]);
    for (const id of eventIds) await database.query(`DELETE FROM totalbase.outbox WHERE id = $1`, [id]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [tableResourceId]);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await app.close();
  });

  it("a retry after a partial failure admits each workflow run once", async () => {
    const first = await dataEventWorkflow("CREATE");
    const second = await dataEventWorkflow("CREATE");
    const event = await enqueue("CREATE", [{ id: randomUUID(), name: "a" }, { id: randomUUID(), name: "b" }]);

    // The first attempt fails partway: the second workflow's second record
    // can't be admitted (a lost connection, a crash) - after the first
    // workflow's two runs and the second's first one already exist.
    const flaky = Object.create(context.workflowRuns) as WorkflowRunsService;
    flaky.createRunForOutboxEvent = async (input, claim) => {
      if (input.workflow === second && claim.item === 1) throw new Error("simulated failure mid-dispatch");
      return context.workflowRuns.createRunForOutboxEvent(input, claim);
    };
    await dispatchDataEvent({ ...context, workflowRuns: flaky } as AppContext, event);
    expect(await eventRow(event)).toMatchObject({ status: "FAILED", attempts: 1, locked_until: null });
    expect((await runsOf(second)).length).toBe(1);
    const admittedBeforeRetry = (await admissionsOf(event)).length; // 1, or 3 when the first workflow went first
    expect([1, 3]).toContain(admittedBeforeRetry);

    // Its backoff elapses; the retry dispatches the whole event again.
    await database.query(`UPDATE totalbase.outbox SET locked_at = now() - interval '1 hour' WHERE id = $1`, [event]);
    expect(await requeueFailedOutbox(context)).toContain(event);
    await dispatchDataEvent(context, event);

    expect(await eventRow(event)).toMatchObject({ status: "PROCESSED", attempts: 2 });
    const firstRuns = await runsOf(first);
    const secondRuns = await runsOf(second);
    // Nothing the failed attempt admitted was admitted again.
    expect(firstRuns).toHaveLength(2);
    expect(secondRuns).toHaveLength(2);
    expect(secondRuns.every((run) => run.status === "SUCCEEDED")).toBe(true);
    expect((await admissionsOf(event)).filter((a) => a.workflow === second).map((a) => a.item)).toEqual([0, 1]);
    expect(await admissionsOf(event)).toHaveLength(4);

    // Claims go with their event.
    await database.query(`DELETE FROM totalbase.outbox WHERE id = $1`, [event]);
    expect(await admissionsOf(event)).toHaveLength(0);
  });

  it("a PROCESSING event whose lease expired is retried; one still leased is left alone", async () => {
    const workflow = await dataEventWorkflow("UPDATE");
    const records = [{ id: randomUUID(), name: "a" }, { id: randomUUID(), name: "b" }];
    // A process claimed this event 30 minutes ago, admitted the first
    // record's run, and stopped: its lease ran out.
    const abandoned = await enqueue("UPDATE", records, `'PROCESSING', 1, now() - interval '30 minutes', now() - interval '1 minute'`);
    const definition = (await context.workflowsAdmin.listEnabledPublished()).find((c) => c.workflow.id === workflow)!;
    const crashedRun = await context.workflowRuns.createRunForOutboxEvent({
      workflow, version: definition.workflow.publishedVersion, trigger: "DATA_EVENT", mode: "PRODUCTION",
      initiator: { type: "DATA_EVENT" }, executor: { type: "USER", id: adminId },
      historyEnabled: true, historyLevel: "DETAILED", expiresAt: new Date(Date.now() + 60_000),
    }, { event: abandoned, item: 0 });
    expect(crashedRun).not.toBeNull();
    const leased = await enqueue("UPDATE", records, `'PROCESSING', 1, now(), now() + interval '10 minutes'`);

    expect(await requeueFailedOutbox(context)).toContain(abandoned);
    expect(await eventRow(abandoned)).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(await eventRow(leased)).toMatchObject({ status: "PROCESSING", attempts: 1 });

    await dispatchDataEvent(context, abandoned);
    expect(await eventRow(abandoned)).toMatchObject({ status: "PROCESSED", attempts: 2, locked_until: null });
    // The crashed attempt's run plus the second record's - never the first one again.
    expect(await runsOf(workflow)).toHaveLength(2);
    expect((await admissionsOf(abandoned)).map((a) => a.item)).toEqual([0, 1]);

    // A dispatcher never takes an event another one still holds.
    await dispatchDataEvent(context, leased);
    expect(await eventRow(leased)).toMatchObject({ status: "PROCESSING", attempts: 1 });
    await database.query(`DELETE FROM totalbase.outbox WHERE id = $1`, [leased]);
  });

  it("an expired lease that used the last attempt stays FAILED", async () => {
    const maxAttempts = await context.settings.get("outbox.max_attempts");
    const event = await enqueue("UPDATE", [], `'PROCESSING', $4, now() - interval '30 minutes', now() - interval '1 minute'`, [maxAttempts]);
    await requeueFailedOutbox(context);
    expect(await eventRow(event)).toMatchObject({ status: "FAILED", attempts: maxAttempts });
  });

  it("dispatchers racing over one event process it once", async () => {
    const workflow = await dataEventWorkflow("DELETE");
    const event = await enqueue("DELETE", [{ id: randomUUID(), name: "a" }, { id: randomUUID(), name: "b" }, { id: randomUUID(), name: "c" }]);

    // The eager dispatch and two fallback pollers all pick it up at once.
    await Promise.all([1, 2, 3, 4].map(() => dispatchDataEvent(context, event)));

    expect(await eventRow(event)).toMatchObject({ status: "PROCESSED", attempts: 1 });
    expect(await runsOf(workflow)).toHaveLength(3);

    // Even past the event claim, PostgreSQL admits a (event, workflow, item) once.
    const definition = (await context.workflowsAdmin.listEnabledPublished()).find((c) => c.workflow.id === workflow)!;
    const input = {
      workflow, version: definition.workflow.publishedVersion, trigger: "DATA_EVENT" as const, mode: "PRODUCTION" as const,
      initiator: { type: "DATA_EVENT" }, executor: { type: "USER", id: adminId },
      historyEnabled: true, historyLevel: "DETAILED" as const, expiresAt: new Date(Date.now() + 60_000),
    };
    const raced = await Promise.all([1, 2, 3].map(() => context.workflowRuns.createRunForOutboxEvent(input, { event, item: 7 })));
    expect(raced.filter((run) => run !== null)).toHaveLength(1);
    const suppressions = await Promise.all([1, 2].map(() => context.workflowRuns.createRunForOutboxEvent(input, { event, item: null })));
    expect(suppressions.filter((run) => run !== null)).toHaveLength(1);
    // Close the runs this check opened by hand.
    await database.query(`UPDATE totalbase.workflows_runs SET status = 'FAILED', finished_at = now() WHERE workflow = $1 AND status = 'RUNNING'`, [workflow]);
  });
});
