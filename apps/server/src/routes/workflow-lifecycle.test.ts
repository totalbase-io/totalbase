import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { WORKFLOWS_SYSTEM_USER_EMAIL } from "@totalbase/shared";
import { runCronTick, runWorkflow, validateExecutionReadiness } from "@totalbase/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp, waitFor } from "../test-support.js";

const PREFIX = "wf-lifecycle-test";
const TABLE = "wf_lifecycle_test_items";

type Op = { id: string; type: string; key: string; label: string; configuration_version: 1; configuration: Record<string, unknown> };
const step = (key: string, type: string, configuration: Record<string, unknown> = {}): Op =>
  ({ id: randomUUID(), type, key, label: key, configuration_version: 1, configuration });
/** A chain Start -> ops[0] -> ops[1] ... over `next`, plus any extra connections. */
function chain(start: Record<string, unknown>, ops: Op[], extra: { from: Op; to: Op; output: string }[] = []) {
  const startOp = step("start", "totalbase.start", start);
  const connections = [startOp, ...ops].slice(0, -1).map((source, i) => ({ source: source.id, target: ([startOp, ...ops][i + 1] as Op).id, output: "next" }));
  return {
    operations: [startOp, ...ops, ...extra.map((e) => e.to).filter((to) => !ops.includes(to))],
    connections: [...connections, ...extra.map((e) => ({ source: e.from.id, target: e.to.id, output: e.output }))],
  };
}

/**
 * Workflow engine and lifecycle (Workflows.md §6.4, §7, §8,
 * §10.2, §14): the editor's Run of a CRON workflow, CRON schedule data and
 * overlap, the run deadline, cancellation from Logs, error details in an
 * error branch, audit correlation, graph validation and a no-op publish.
 */
describe("Workflow engine and lifecycle", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let adminId: string;
  let systemUserId: string;
  let tableResourceId: string;
  const workflowIds: string[] = [];

  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as "GET",
      url: `/admin/api${url}`,
      headers: { authorization: `Bearer ${adminToken}` },
      ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
    });

  async function draftWorkflow(definition: Record<string, unknown>): Promise<string> {
    const slug = `${PREFIX}-${randomUUID().slice(0, 8)}`;
    const id = (await context.workflowsAdmin.create({ name: slug, slug, historyLevel: "DETAILED" })).id;
    workflowIds.push(id);
    await context.workflowsAdmin.saveDraft(id, (await context.workflowsAdmin.get(id)).revision, definition);
    return id;
  }
  async function liveWorkflow(definition: Record<string, unknown>): Promise<string> {
    const id = await draftWorkflow(definition);
    const workflows = context.workflowsAdmin;
    await workflows.publish(id, (await workflows.get(id)).revision, (d) => validateExecutionReadiness(d, context));
    await workflows.update(id, { revision: (await workflows.get(id)).revision, enabled: true });
    return id;
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    adminId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email = $1`, [env.adminEmail!])).rows[0]!.id;
    systemUserId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email = $1`, [WORKFLOWS_SYSTEM_USER_EMAIL])).rows[0]!.id;

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
    await database.query(`DELETE FROM totalbase.logs WHERE resource = $1`, [tableResourceId]);
    await database.query(`DELETE FROM totalbase.outbox WHERE resource = $1`, [tableResourceId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [tableResourceId]);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await app.close();
  });

  it("the editor's Run of a CRON workflow runs as its execute_as with the schedule data; MANUAL runs as the caller", async () => {
    const cron = await liveWorkflow(chain(
      { trigger: "CRON", cron_expression: "0 0 1 1 *", timezone: "Europe/Madrid", execute_as: systemUserId },
      [step("done", "totalbase.finish-result", { result: { start: "{{start.data}}" } })],
    ));
    const res = await call("POST", `/workflows/${cron}/run`, { data: { ignored: true } });
    expect(res.statusCode, res.body).toBe(200);
    const run = res.json().data.run;
    expect(run).toMatchObject({ trigger: "CRON", mode: "PRODUCTION", status: "SUCCEEDED", executor: { type: "USER", id: systemUserId }, initiator: { type: "USER", id: adminId } });
    const start = run.result.data.start;
    expect(Object.keys(start).sort()).toEqual(["scheduled_at", "started_at", "timezone"]);
    expect(start.timezone).toBe("Europe/Madrid");
    expect(Number.isNaN(Date.parse(start.scheduled_at))).toBe(false);

    const manual = await liveWorkflow(chain({ trigger: "MANUAL" }, [step("done", "totalbase.finish-result", { result: "{{start.data}}" })]));
    const manualRun = (await call("POST", `/workflows/${manual}/run`, { data: { given: 1 } })).json().data.run;
    expect(manualRun).toMatchObject({ trigger: "MANUAL", executor: { id: adminId }, initiator: { id: adminId }, result: { data: { given: 1 } } });
  });

  it("a scheduled occurrence receives { scheduled_at, started_at, timezone } and is skipped while the previous one still runs", async () => {
    const id = await liveWorkflow(chain(
      { trigger: "CRON", cron_expression: "17-18 3 29 2 *", timezone: "UTC", execute_as: systemUserId },
      [step("pause", "totalbase.wait-resume", { waitSeconds: 1 }), step("done", "totalbase.finish-result", { result: "{{start.data}}" })],
    ));
    const first = await runCronTick(context, { now: new Date("2032-02-29T03:17:05Z") });
    // The tick returns once the run is admitted, not when it ends: it is still waiting.
    const running = await context.workflowRuns.listRuns(id);
    expect(running.runs.map((r) => r.status)).toEqual(["RUNNING"]);

    void await runCronTick(context, { now: new Date("2032-02-29T03:18:01Z") });
    void await runCronTick(context, { now: new Date("2032-02-29T03:18:30Z") }); // same occurrence: already claimed
    await Promise.all(first);

    const { runs } = await context.workflowRuns.listRuns(id);
    const skipped = runs.find((r) => (r.initiator as { scheduledAt: string }).scheduledAt === "2032-02-29T03:18:00.000Z")!;
    const ran = runs.find((r) => (r.initiator as { scheduledAt: string }).scheduledAt === "2032-02-29T03:17:00.000Z")!;
    expect(runs).toHaveLength(2);
    expect(skipped).toMatchObject({ trigger: "CRON", status: "FAILED", error: { code: "WORKFLOW_LIMIT_EXCEEDED" } });
    expect((skipped.error as { message: string }).message).toContain(ran.id);
    expect(ran).toMatchObject({ status: "SUCCEEDED", executor: { id: systemUserId } });
    expect(ran.result).toMatchObject({ data: { scheduled_at: "2032-02-29T03:17:00.000Z", timezone: "UTC" } });
    expect(Number.isNaN(Date.parse((ran.result as { data: { started_at: string } }).data.started_at))).toBe(false);
    // A skipped occurrence is not a failure of the workflow: the streak stays clean.
    expect((await context.workflowsAdmin.get(id)).consecutiveFailures).toBe(0);
  });

  it("stops a run that passes its deadline as INTERRUPTED, and recovery and a finishing run never overwrite each other", async () => {
    const id = await liveWorkflow(chain({ trigger: "MANUAL" }, [
      step("pause", "totalbase.wait-resume", { waitSeconds: 1 }),
      step("done", "totalbase.finish-result", { result: "never" }),
    ]));
    const settings = { get: async (key: string) => (key === "workflows.max_run_duration_ms" ? 1000 : context.settings.get(key as never)) };
    const shortDeadline = new Proxy(context, { get: (target, property) => (property === "settings" ? settings : Reflect.get(target, property)) });
    const { workflow, definition } = await context.workflowsAdmin.getPublished(id);
    const principal = { principal: { type: "USER" as const, id: systemUserId }, roleIds: [], userRow: {}, actorUserId: systemUserId };
    const adminPrincipal = { ...principal, roleIds: (await context.roleAssignments.listEffectiveRolesForUser(systemUserId)) };
    const outcome = await runWorkflow(shortDeadline as AppContext, adminPrincipal, workflow, workflow.publishedVersion, definition, { trigger: "MANUAL", mode: "PRODUCTION" }, null);
    expect(outcome.run).toMatchObject({ status: "INTERRUPTED", error: { code: "WORKFLOW_LIMIT_EXCEEDED" } });
    expect(outcome.steps.map((s) => s.operationType)).toEqual(["totalbase.start", "totalbase.wait-resume"]);
    expect((await context.workflowsAdmin.get(id)).consecutiveFailures).toBe(0);

    // Recovery first: the engine's later finish does not overwrite INTERRUPTED.
    const stale = await context.workflowRuns.createRun({
      workflow: id, version: null, trigger: "MANUAL", mode: "TEST", initiator: {}, executor: {}, historyEnabled: true, historyLevel: "SUMMARY", expiresAt: new Date(Date.now() - 1000),
    });
    await context.workflowRuns.reclaimExpired();
    expect(await context.workflowRuns.finishRun(stale.id, { status: "SUCCEEDED" })).toBe(false);
    expect((await context.workflowRuns.getRun(stale.id)).status).toBe("INTERRUPTED");
    // The engine first: recovery does not touch a finished run.
    const finished = await context.workflowRuns.createRun({
      workflow: id, version: null, trigger: "MANUAL", mode: "TEST", initiator: {}, executor: {}, historyEnabled: true, historyLevel: "SUMMARY", expiresAt: new Date(Date.now() - 1000),
    });
    expect(await context.workflowRuns.finishRun(finished.id, { status: "SUCCEEDED" })).toBe(true);
    await context.workflowRuns.reclaimExpired();
    expect((await context.workflowRuns.getRun(finished.id)).status).toBe("SUCCEEDED");
  });

  it("cancels a running run from Logs; a run that is not running answers 409", async () => {
    const id = await liveWorkflow(chain({ trigger: "MANUAL" }, [
      step("first", "totalbase.wait-resume", { waitSeconds: 0.6 }),
      step("second", "totalbase.wait-resume", { waitSeconds: 0.6 }),
      step("done", "totalbase.finish-result", { result: "never" }),
    ]));
    const pending = call("POST", `/workflows/${id}/run`, { data: null });
    const runId = await waitFor(async () => (await context.workflowRuns.listRuns(id)).runs[0]?.id, { intervalMs: 20 });
    // Cancel while the first wait runs: sent as soon as the run exists, it can land before that step starts,
    // and the run ends after Start alone - right, but not what this test checks.
    await waitFor(async () => (await context.workflowRuns.listSteps(runId)).some((s) => s.operationType === "totalbase.wait-resume" && s.status === "RUNNING"), { intervalMs: 20 });
    const cancel = await call("POST", `/workflows/runs/${runId}/cancel`);
    expect(cancel.statusCode, cancel.body).toBe(202);
    expect(cancel.json().data).toMatchObject({ id: runId, status: "RUNNING" });

    const finished = (await pending).json().data;
    expect(finished.run).toMatchObject({ id: runId, status: "CANCELLED" });
    expect(finished.steps.map((s: { key?: string; operationType: string; status: string }) => [s.operationType, s.status])).toEqual([
      ["totalbase.start", "SUCCEEDED"],
      ["totalbase.wait-resume", "SUCCEEDED"],
    ]);

    const again = await call("POST", `/workflows/runs/${runId}/cancel`);
    expect([again.statusCode, again.json().errors[0].code]).toEqual([409, "WORKFLOW_RUN_NOT_CANCELLABLE"]);
    expect((await call("POST", `/workflows/runs/${randomUUID()}/cancel`)).statusCode).toBe(404);
    // A CANCELLED run does not count toward auto-disable.
    expect((await context.workflowsAdmin.get(id)).consecutiveFailures).toBe(0);
  });

  it("an error branch reads the handled error through {{error...}} and the run records it as handled", async () => {
    const read = step("read", "totalbase.read-records", { resource: randomUUID() });
    const recover = step("recover", "totalbase.finish-result", { result: { code: "{{error.code}}", message: "{{error.message}}" } });
    const id = await draftWorkflow(chain({ trigger: "MANUAL" }, [read], [{ from: read, to: recover, output: "error" }]));
    const res = (await call("POST", `/workflows/${id}/test-run`, { data: null })).json().data;
    expect(res.run).toMatchObject({ status: "SUCCEEDED", hasHandledErrors: true, result: { data: { code: "RESOURCE_NOT_FOUND" } } });
    expect(res.run.result.data.message).toBeTruthy();
    expect(res.steps.find((s: { operationType: string }) => s.operationType === "totalbase.read-records").status).toBe("FAILED");
    expect((await call("GET", `/workflows/runs/${res.run.id}`)).json().data.run.hasHandledErrors).toBe(true);

    // The error's detail travels too: Validate data's failed rules.
    const validate = step("validate", "totalbase.validate-data", { input: "{{start.data}}", rules: [{ filter: { qty: { _gt: "0" } }, message: "Quantity must be positive" }] });
    const report = step("report", "totalbase.finish-result", { result: { code: "{{error.code}}", failed: "{{error.detail}}" } });
    const validated = await draftWorkflow(chain({ trigger: "MANUAL" }, [validate], [{ from: validate, to: report, output: "error" }]));
    const reported = (await call("POST", `/workflows/${validated}/test-run`, { data: { qty: 0 } })).json().data.run;
    expect(reported).toMatchObject({ status: "SUCCEEDED", hasHandledErrors: true, result: { data: { code: "WORKFLOW_VALIDATION_FAILED", failed: [{ rule: 1, message: "Quantity must be positive" }] } } });

    // Only the direct target of the error output sees it.
    const elsewhere = await draftWorkflow(chain({ trigger: "MANUAL" }, [step("done", "totalbase.finish-result", { result: "{{error.code}}" })]));
    const invalid = (await call("POST", `/workflows/${elsewhere}/test-run`, { data: null })).json().data.run;
    expect(invalid).toMatchObject({ status: "FAILED", hasHandledErrors: false, error: { code: "WORKFLOW_INVALID_DESIGN" } });
  });

  it("audit rows written by a step carry the run correlation, and the audit API filters by run", async () => {
    const id = await draftWorkflow(chain({ trigger: "MANUAL" }, [
      step("insert", "totalbase.create-records", { resource: tableResourceId, records: [{ name: "{{start.data.name}}" }] }),
      step("done", "totalbase.finish-result", { result: "{{insert.data}}" }),
    ]));
    const res = (await call("POST", `/workflows/${id}/test-run`, { data: { name: "correlated" } })).json().data;
    expect(res.run.status, JSON.stringify(res.run.error)).toBe("SUCCEEDED");
    const insertStep = res.steps.find((s: { operationType: string }) => s.operationType === "totalbase.create-records");

    const logs = await call("GET", `/audit/logs?workflow_run=${res.run.id}`);
    expect(logs.statusCode, logs.body).toBe(200);
    const entries = logs.json().data;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "CREATE",
      source: "workflow",
      principalId: adminId,
      metadata: { workflow: id, workflowRun: res.run.id, workflowStep: insertStep.id, workflowInitiator: { type: "USER", id: adminId } },
    });
    expect((await call("GET", `/audit/logs?workflow_run=not-a-uuid`)).statusCode).toBe(400);
  });

  it("refuses a draft that breaks the graph rules, naming the operation; publishing an unchanged draft is a no-op", async () => {
    const done = step("done", "totalbase.finish-result", { result: 1 });
    const id = await draftWorkflow(chain({ trigger: "MANUAL" }, [done]));
    const revision = (await call("GET", `/workflows/${id}`)).json().data.revision as string;
    const draft = (await call("GET", `/workflows/${id}/draft`)).json().data.definition;
    const broken = { ...draft, connections: [...draft.connections, { source: done.id, target: draft.operations[0].id, output: "next" }] };
    const refused = await call("PUT", `/workflows/${id}/draft`, { data: { revision, definition: broken } });
    expect([refused.statusCode, refused.json().errors[0].code]).toEqual([400, "WORKFLOW_INVALID_DESIGN"]);
    expect(refused.json().errors[0].message).toContain('"done"');

    const published = await call("POST", `/workflows/${id}/publish`, { data: { revision } });
    expect(published.statusCode, published.body).toBe(200);
    const live = published.json().data;
    expect(live.liveVersion).toBe(1);
    const again = await call("POST", `/workflows/${id}/publish`, { data: { revision: live.revision } });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().data).toMatchObject({ liveVersion: 1, revision: live.revision, hasUnpublishedChanges: false });
  });

  it("refuses a definition over its limits on create, draft save and publish (WORKFLOW_LIMIT_EXCEEDED)", async () => {
    // Create: the Start configuration is an operation's configuration too.
    const slug = `${PREFIX}-${randomUUID().slice(0, 8)}`;
    const tooWide = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`f${i}`, i]));
    const created = await call("POST", "/workflows", { data: { name: slug, slug, startConfiguration: { trigger: "MANUAL", ...tooWide } } });
    expect([created.statusCode, created.json().errors[0].code]).toEqual([422, "WORKFLOW_LIMIT_EXCEEDED"]);
    expect(created.json().errors[0].message).toContain('"start"');
    expect((await database.query(`SELECT 1 FROM totalbase.workflows WHERE slug = $1`, [slug])).rowCount).toBe(0);

    // Draft save: 101 operations, Start included.
    const id = await draftWorkflow(chain({ trigger: "MANUAL" }, [step("done", "totalbase.finish-result", { result: 1 })]));
    const revision = (await call("GET", `/workflows/${id}`)).json().data.revision as string;
    const draft = (await call("GET", `/workflows/${id}/draft`)).json().data.definition;
    const many = { ...draft, operations: [...draft.operations, ...Array.from({ length: 99 }, (_, i) => step(`extra_${i}`, "totalbase.finish-result"))] };
    const refused = await call("PUT", `/workflows/${id}/draft`, { data: { revision, definition: many } });
    expect([refused.statusCode, refused.json().errors[0].code]).toEqual([422, "WORKFLOW_LIMIT_EXCEEDED"]);
    expect(refused.json().errors[0].message).toContain("operations per workflow");
    expect((await call("GET", `/workflows/${id}`)).json().data.revision).toBe(revision);

    // Publish re-checks: a draft stored over a limit (written around the API) is not published.
    const big = { ...draft, operations: draft.operations.map((op: Op) => op.key === "done" ? { ...op, configuration: { result: "x".repeat(70_000) } } : op) };
    await database.query(`UPDATE totalbase.workflows SET definition = $2::jsonb WHERE id = $1`, [id, JSON.stringify(big)]);
    const published = await call("POST", `/workflows/${id}/publish`, { data: { revision } });
    expect([published.statusCode, published.json().errors[0].code]).toEqual([422, "WORKFLOW_LIMIT_EXCEEDED"]);
    expect(published.json().errors[0].message).toContain('Step "done"');
    expect((await call("GET", `/workflows/${id}`)).json().data.liveVersion).toBeNull();
  });
});
