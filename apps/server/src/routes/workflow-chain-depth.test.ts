import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { dispatchDataEvent, invokeSubWorkflow, resolveDataPrincipalForConfiguredUser, validateExecutionReadiness } from "@totalbase/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

const PREFIX = "wf-chain-test";
const TABLE = "wf_chain_test_items";

/**
 * Configurable chain depth (Workflows.md §6.3.4, §5.23,
 * §15.1): `workflows.max_chain_depth` bounds how many workflows one causal
 * chain holds - data events started by a workflow's write and Execute
 * workflow alike - and a loop is refused at any depth.
 */
describe("workflows.max_chain_depth", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminId: string;
  let tableResourceId: string;
  const workflowIds: string[] = [];
  const eventIds: string[] = [];

  async function publishedWorkflow(start: Record<string, unknown>): Promise<string> {
    const slug = `${PREFIX}-${randomUUID().slice(0, 8)}`;
    const workflows = context.workflowsAdmin;
    const id = (await workflows.create({ name: slug, slug })).id;
    workflowIds.push(id);
    const startOp = { id: randomUUID(), type: "totalbase.start", key: "start", label: "start", configuration_version: 1, configuration: start };
    const done = { id: randomUUID(), type: "totalbase.finish-result", key: "done", label: "done", configuration_version: 1, configuration: { result: "ok" } };
    await workflows.saveDraft(id, (await workflows.get(id)).revision, {
      operations: [startOp, done],
      connections: [{ source: startOp.id, target: done.id, output: "next" }],
    });
    await workflows.publish(id, (await workflows.get(id)).revision, (d) => validateExecutionReadiness(d, context));
    await workflows.update(id, { revision: (await workflows.get(id)).revision, enabled: true });
    return id;
  }

  /** An outbox event written by a workflow step whose run carried `ancestry` - the event itself says so (no audit row needed). */
  async function workflowSourcedEvent(ancestry: string[]): Promise<string> {
    const id = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.outbox (request_id, resource, event, payload, source, workflow_ancestry)
       VALUES ($1, $2, 'CREATE', $3::jsonb, 'workflow', $4::uuid[]) RETURNING id`,
      [randomUUID(), tableResourceId, JSON.stringify([{ id: randomUUID(), name: "x" }]), ancestry],
    )).rows[0]!.id;
    eventIds.push(id);
    return id;
  }

  const runsOf = async (workflowId: string) => (await context.workflowRuns.listRuns(workflowId, { pageSize: 100 })).runs;
  const others = (count: number) => Array.from({ length: count }, () => randomUUID());

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    adminId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email = $1`, [loadServerEnv().adminEmail!])).rows[0]!.id;
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await database.query(`CREATE TABLE public.${TABLE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL)`);
    tableResourceId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', ARRAY['GET', 'POST']) RETURNING id`,
      [`public.${TABLE}`, TABLE],
    )).rows[0]!.id;
    await context.settings.set("workflows.max_chain_depth", 3);
  });

  afterAll(async () => {
    await context.settings.reset("workflows.max_chain_depth");
    for (const id of workflowIds) await database.query(`DELETE FROM totalbase.workflows WHERE id = $1`, [id]);
    for (const id of eventIds) await database.query(`DELETE FROM totalbase.outbox WHERE id = $1`, [id]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [tableResourceId]);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await app.close();
  });

  it("defaults to 8 and accepts 1-32 only", async () => {
    const { SETTINGS_DEFAULTS, settingBounds } = await import("@totalbase/settings");
    expect(SETTINGS_DEFAULTS["workflows.max_chain_depth"]).toBe(8);
    expect(settingBounds("workflows.max_chain_depth")).toEqual({ min: 1, max: 32 });
    await expect(context.settings.set("workflows.max_chain_depth", 0)).rejects.toThrow();
    await expect(context.settings.set("workflows.max_chain_depth", 33)).rejects.toThrow();
    expect(await context.settings.get("workflows.max_chain_depth")).toBe(3);
  });

  it("a data event admits a workflow while the chain stays within the depth and suppresses it beyond", async () => {
    const workflow = await publishedWorkflow({ trigger: "DATA_EVENT", resource: tableResourceId, events: ["CREATE"], execute_as: adminId });

    // Ancestry of 2 + this workflow = 3 workflows: admitted.
    await dispatchDataEvent(context, await workflowSourcedEvent(others(2)));
    let runs = await runsOf(workflow);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("SUCCEEDED");

    // Ancestry of 3 + this workflow = 4: suppressed as a visible FAILED run.
    await dispatchDataEvent(context, await workflowSourcedEvent(others(3)));
    runs = await runsOf(workflow);
    expect(runs).toHaveLength(2);
    const suppressed = runs.find((run) => run.status === "FAILED")!;
    expect(suppressed.error).toMatchObject({ code: "WORKFLOW_LIMIT_EXCEEDED" });
    expect((suppressed.error as { message: string }).message).toContain("3");
  });

  it("a data event loop is refused even within the depth", async () => {
    const workflow = await publishedWorkflow({ trigger: "DATA_EVENT", resource: tableResourceId, events: ["CREATE"], execute_as: adminId });
    await dispatchDataEvent(context, await workflowSourcedEvent([workflow]));
    const runs = await runsOf(workflow);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("FAILED");
    expect(runs[0]!.error).toMatchObject({ code: "WORKFLOW_INVALID_DESIGN" });
  });

  it("Execute workflow follows the same depth and loop rules", async () => {
    const target = await publishedWorkflow({ trigger: "MANUAL" });
    const caller = randomUUID();
    const callerPrincipal = await resolveDataPrincipalForConfiguredUser(context, adminId);
    const call = (ancestry: string[]) => invokeSubWorkflow(context, { callerPrincipal, callerWorkflowId: caller, ancestry, targetWorkflowId: target, input: null });

    // Caller's ancestry (1) + caller + target = 3: allowed.
    const outcome = await call(others(1));
    expect(outcome.run.status).toBe("SUCCEEDED");
    // Ancestry 2 + caller + target = 4: refused before the call.
    await expect(call(others(2))).rejects.toMatchObject({ code: "WORKFLOW_LIMIT_EXCEEDED" });
    // A -> B -> A: a loop, whatever the depth.
    await expect(call([target])).rejects.toMatchObject({ code: "WORKFLOW_INVALID_DESIGN" });
    await context.settings.set("workflows.max_chain_depth", 32);
    await expect(call([target])).rejects.toMatchObject({ code: "WORKFLOW_INVALID_DESIGN" });
    await context.settings.set("workflows.max_chain_depth", 3);
  });
});
