import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { WORKFLOWS_SYSTEM_USER_EMAIL } from "@totalbase/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { createTestApiToken, setupTestApp } from "../test-support.js";
import { validateExecutionReadiness } from "@totalbase/workflows";

const PREFIX = "webhook-test";

/**
 * GET|POST /api/workflows/{slug}/webhook - a workflow's WEBHOOK trigger
 * (Workflows.md §13.2). PUBLIC runs as the
 * configured account, ignores presented credentials and is rate limited
 * per IP; AUTHENTICATED needs the INVOKE grant; anything unavailable
 * (unknown, disabled, wrong method) answers the same way.
 */
describe("Workflow webhooks", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let systemUserId: string;
  let publicWorkflowId: string;
  let authWorkflowId: string;
  let roleId: string;
  let caller: { plainKey: string; userId: string; tokenId: string };

  let ipCounter = 0;
  const nextIp = () => `10.77.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`;
  const hit = (method: "GET" | "POST", slug: string, options: { payload?: unknown; token?: string; ip?: string; headers?: Record<string, string> } = {}) =>
    app.inject({
      method,
      url: `/api/workflows/${slug}/webhook?source=test`,
      remoteAddress: options.ip ?? nextIp(),
      headers: {
        ...options.headers,
        ...(options.token && { authorization: `Bearer ${options.token}` }),
        ...(options.payload !== undefined && { "content-type": "application/json" }),
      },
      ...(options.payload !== undefined && { payload: JSON.stringify(options.payload) }),
    });

  /** Start -> (an optional middle step) -> Finish, whose result echoes the webhook's own input (query and body), proving it reached the workflow. */
  function webhookDefinition(start: Record<string, unknown>, middle?: { type: string; configuration: Record<string, unknown> }): Record<string, unknown> {
    const startId = randomUUID();
    const middleId = randomUUID();
    const finishId = randomUUID();
    return {
      operations: [
        { id: startId, type: "totalbase.start", configuration_version: 1, label: "Start", key: "start", configuration: { trigger: "WEBHOOK", ...start } },
        ...(middle ? [{ id: middleId, type: middle.type, configuration_version: 1, label: "Middle", key: "middle", configuration: middle.configuration }] : []),
        {
          id: finishId, type: "totalbase.finish-result", configuration_version: 1, label: "Done", key: "finish",
          configuration: { result: { ok: true, name: "{{start.data.body.name}}", source: "{{start.data.query.source}}" } },
        },
      ],
      connections: middle
        ? [{ source: startId, target: middleId, output: "next" }, { source: middleId, target: finishId, output: "next" }]
        : [{ source: startId, target: finishId, output: "next" }],
    };
  }

  async function publishedWorkflow(slug: string, start: Record<string, unknown>, middle?: { type: string; configuration: Record<string, unknown> }): Promise<string> {
    const workflows = context.workflowsAdmin;
    const id = (await workflows.create({ name: slug, slug })).id;
    await workflows.saveDraft(id, (await workflows.get(id)).revision, webhookDefinition(start, middle));
    await workflows.publish(id, (await workflows.get(id)).revision, (definition) => validateExecutionReadiness(definition, context));
    await workflows.update(id, { revision: (await workflows.get(id)).revision, enabled: true });
    return id;
  }

  async function cleanup(): Promise<void> {
    await database.query(`DELETE FROM totalbase.workflows WHERE slug LIKE '${PREFIX}%'`);
    await database.query(`DELETE FROM totalbase.users WHERE email LIKE '${PREFIX}%'`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE '${PREFIX}%'`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await cleanup();
    systemUserId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email = $1`, [WORKFLOWS_SYSTEM_USER_EMAIL])).rows[0]!.id;

    publicWorkflowId = await publishedWorkflow(`${PREFIX}-public`, { method: "POST", access: "PUBLIC", response_mode: "SYNC", execute_as: systemUserId });
    authWorkflowId = await publishedWorkflow(`${PREFIX}-auth`, { method: "POST", access: "AUTHENTICATED", response_mode: "ASYNC" });
    await publishedWorkflow(`${PREFIX}-disabled`, { method: "POST", access: "PUBLIC", response_mode: "SYNC", execute_as: systemUserId });
    const disabled = (await database.query<{ id: string }>(`SELECT id FROM totalbase.workflows WHERE slug = $1`, [`${PREFIX}-disabled`])).rows[0]!.id;
    await context.workflowsAdmin.update(disabled, { revision: (await context.workflowsAdmin.get(disabled)).revision, enabled: false });

    roleId = (await context.roles.create(`${PREFIX}-caller`, { apiAccess: true })).id;
    caller = await createTestApiToken(context, { name: `${PREFIX}-caller`, roleId, email: `${PREFIX}-caller@example.com` });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it("runs a PUBLIC SYNC webhook as its configured account and answers with the outcome", async () => {
    const res = await hit("POST", `${PREFIX}-public`, { payload: { name: "Ada" } });
    expect(res.statusCode, res.body).toBe(200);
    const run = res.json().data;
    expect(run.status).toBe("SUCCEEDED");
    // The request reaches the workflow as the Start step's data; the Finish step decides what comes back.
    expect(run.result).toEqual({ data: { ok: true, name: "Ada", source: "test" } });
    expect(run.error).toBeNull();
    const { rows } = await database.query<{ initiator: unknown; executor: { id?: string } }>(
      `SELECT initiator, executor FROM totalbase.workflows_runs WHERE id = $1`, [run.id],
    );
    expect(rows[0]!.initiator).toEqual({ type: "WEBHOOK", public: true });
    expect(JSON.stringify(rows[0]!.executor)).toContain(systemUserId);
  });

  // Regression: the SYNC response used to be { run, steps } - every step's
  // live input and result, the Start step's request headers included - to
  // any caller, PUBLIC ones too.
  it("answers a SYNC webhook with the run's outcome only - never its steps or the request's headers", async () => {
    const res = await hit("POST", `${PREFIX}-public`, {
      payload: { name: "Ada" },
      headers: { "x-api-key": "webhook-secret-header-value", cookie: "session=webhook-secret-cookie" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(Object.keys(body)).toEqual(["data"]);
    expect(Object.keys(body.data).sort()).toEqual(["error", "id", "result", "status"]);
    expect(res.body).not.toContain("webhook-secret-header-value");
    expect(res.body).not.toContain("webhook-secret-cookie");
    expect(res.body).not.toContain("steps");
  });

  it("answers a SYNC timeout with WORKFLOW_SYNC_TIMEOUT and the run id in meta, and the run keeps going", async () => {
    const slowId = await publishedWorkflow(
      `${PREFIX}-slow`,
      { method: "POST", access: "PUBLIC", response_mode: "SYNC", wait_seconds: 1, timeout_action: "CONTINUE", execute_as: systemUserId },
      { type: "totalbase.execute-sql", configuration: { statement: "SELECT pg_sleep(2)", executeAs: systemUserId } },
    );
    const res = await hit("POST", `${PREFIX}-slow`, { payload: {} });
    expect(res.statusCode, res.body).toBe(504);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["errors", "meta"]);
    expect(body.errors[0].code).toBe("WORKFLOW_SYNC_TIMEOUT");
    const runId = body.meta.run as string;
    const { rows } = await database.query<{ workflow: string }>(`SELECT workflow FROM totalbase.workflows_runs WHERE id = $1`, [runId]);
    expect(rows[0]!.workflow).toBe(slowId);
    // CONTINUE: the run finishes on its own (waited for, so cleanup doesn't race it).
    await expect.poll(async () => (await database.query<{ status: string }>(
      `SELECT status FROM totalbase.workflows_runs WHERE id = $1`, [runId],
    )).rows[0]!.status, { timeout: 10_000 }).toBe("SUCCEEDED");
  });

  it("ignores credentials presented to a PUBLIC webhook - even a bogus token", async () => {
    const res = await hit("POST", `${PREFIX}-public`, { payload: {}, token: "not-a-real-token" });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("answers an unknown, disabled or wrong-method webhook the same way", async () => {
    for (const res of [
      await hit("POST", `${PREFIX}-nope`, { payload: {} }),
      await hit("POST", `${PREFIX}-disabled`, { payload: {} }),
      await hit("GET", `${PREFIX}-public`),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json().errors[0].code).toBe("WORKFLOW_NOT_FOUND");
    }
  });

  it("refuses a body that isn't a JSON object or array", async () => {
    const res = await hit("POST", `${PREFIX}-public`, { payload: "just a string" });
    expect(res.json().errors[0].code).toBe("WORKFLOW_WEBHOOK_INVALID_PAYLOAD");
  });

  it("requires a token and the INVOKE grant for an AUTHENTICATED webhook", async () => {
    expect((await hit("POST", `${PREFIX}-auth`, { payload: {} })).statusCode).toBe(401);

    const denied = await hit("POST", `${PREFIX}-auth`, { payload: {}, token: caller.plainKey });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().errors[0].code).toBe("ACTION_DENIED");

    await context.workflowPermissions.grant(roleId, authWorkflowId);
    const accepted = await hit("POST", `${PREFIX}-auth`, { payload: {}, token: caller.plainKey });
    expect(accepted.statusCode, accepted.body).toBe(202);
    const runId = accepted.json().data.run as string;
    const { rows } = await database.query<{ initiator: { type: string; id: string } }>(
      `SELECT initiator FROM totalbase.workflows_runs WHERE id = $1`, [runId],
    );
    expect(rows[0]!.initiator).toEqual({ type: "API_KEY", id: caller.tokenId });

    await context.workflowPermissions.setRoles(authWorkflowId, []);
    expect((await hit("POST", `${PREFIX}-auth`, { payload: {}, token: caller.plainKey })).statusCode).toBe(403);
  });

  it("limits PUBLIC admissions to 60 per IP per minute", async () => {
    const ip = "10.99.0.1";
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await hit("POST", `${PREFIX}-public`, { payload: {}, ip })).statusCode);
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    // Another IP is unaffected.
    expect((await hit("POST", `${PREFIX}-public`, { payload: {} })).statusCode).toBe(200);
    // 62 admissions one after another, each a run: past the default 5 s under the full suite's load.
  }, 20_000);

  it("never runs the workflow for a refused admission", async () => {
    const before = (await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM totalbase.workflows_runs WHERE workflow = $1`, [publicWorkflowId],
    )).rows[0]!.count;
    await hit("GET", `${PREFIX}-public`);
    await hit("POST", `${PREFIX}-public`, { payload: "just a string" });
    const after = (await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM totalbase.workflows_runs WHERE workflow = $1`, [publicWorkflowId],
    )).rows[0]!.count;
    expect(after).toBe(before);
  });
});
