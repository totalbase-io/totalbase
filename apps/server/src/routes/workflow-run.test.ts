import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { WORKFLOWS_SYSTEM_USER_EMAIL } from "@totalbase/shared";
import { validateExecutionReadiness } from "@totalbase/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { createTestApiToken, setupTestApp } from "../test-support.js";

const PREFIX = "wf-run-test";

/**
 * POST /api/workflows/{slug}/run (Workflows.md §13.1) and the
 * file operations it can reach (§5.17-§5.20). Two security regressions:
 *
 * - the response is the run's outcome only, `{ id, status, result, error }`
 *   - it used to be `{ run, steps }`, every step's live input and result,
 *   to any caller holding WORKFLOW_INVOKE;
 * - Read file, Parse CSV / JSON and Create file act as the run's executor
 *   under the Files API's own authorization - they used to call the Files
 *   service directly, so a non-administrator who could invoke a MANUAL
 *   workflow read any file through it.
 */
describe("POST /api/workflows/{slug}/run", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let systemUserId: string;
  let filesResourceId: string;
  let roleId: string;
  let caller: { plainKey: string; userId: string; tokenId: string };
  let ownFileId: string;
  let otherFileId: string;
  let publicFileId: string;
  const workflowIds: string[] = [];
  const createdFileIds: string[] = [];

  const run = (slug: string, data: unknown) =>
    app.inject({
      method: "POST",
      url: `/api/workflows/${slug}/run`,
      headers: { authorization: `Bearer ${caller.plainKey}`, "content-type": "application/json" },
      payload: JSON.stringify({ data }),
    });

  /** Start -> `step` -> Finish(`result`); the step's error output is left unconnected, so a refusal fails the run with its code. */
  async function publishedWorkflow(slug: string, start: Record<string, unknown>, step: { type: string; configuration: Record<string, unknown> }, result: unknown): Promise<string> {
    const startId = randomUUID();
    const stepId = randomUUID();
    const finishId = randomUUID();
    const definition = {
      operations: [
        { id: startId, type: "totalbase.start", configuration_version: 1, label: "Start", key: "start", configuration: start },
        { id: stepId, type: step.type, configuration_version: 1, label: "Step", key: "step", configuration: step.configuration },
        { id: finishId, type: "totalbase.finish-result", configuration_version: 1, label: "Done", key: "finish", configuration: { result } },
      ],
      connections: [
        { source: startId, target: stepId, output: "next" },
        { source: stepId, target: finishId, output: "next" },
      ],
    };
    const workflows = context.workflowsAdmin;
    const id = (await workflows.create({ name: slug, slug })).id;
    await workflows.saveDraft(id, (await workflows.get(id)).revision, definition);
    await workflows.publish(id, (await workflows.get(id)).revision, (definition) => validateExecutionReadiness(definition, context));
    await workflows.update(id, { revision: (await workflows.get(id)).revision, enabled: true });
    await context.workflowPermissions.grant(roleId, id);
    workflowIds.push(id);
    return id;
  }

  const MANUAL = { trigger: "MANUAL" };
  const READ = { type: "totalbase.read-file", configuration: { asset: "{{start.data.asset}}" } };
  const PARSE = { type: "totalbase.parse-file", configuration: { asset: "{{start.data.asset}}", format: "json" } };
  const CREATE = { type: "totalbase.create-file", configuration: { name: `${PREFIX}-created.txt`, content: "created by a workflow", contentType: "text/plain" } };

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    systemUserId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email = $1`, [WORKFLOWS_SYSTEM_USER_EMAIL])).rows[0]!.id;
    filesResourceId = (await database.query<{ id: string }>(
      `SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'files'`,
    )).rows[0]!.id;

    roleId = (await context.roles.create(`${PREFIX}-caller`, { apiAccess: true })).id;
    caller = await createTestApiToken(context, { name: `${PREFIX}-caller`, roleId, email: `${PREFIX}-caller@example.com` });

    const upload = (name: string, visibility: "PRIVATE" | "PUBLIC", actorUserId?: string) =>
      context.filesAdmin.upload({ content: Buffer.from(`{"secret":"${name}-content"}`), filename: `${name}.json`, declaredContentType: "application/json", visibility, actorUserId });
    ownFileId = (await upload(`${PREFIX}-own`, "PRIVATE", caller.userId)).id;
    otherFileId = (await upload(`${PREFIX}-other`, "PRIVATE")).id;
    publicFileId = (await upload(`${PREFIX}-public`, "PUBLIC")).id;

    await publishedWorkflow(`${PREFIX}-read`, MANUAL, READ, { name: "{{step.data.name}}" });
    await publishedWorkflow(`${PREFIX}-parse`, MANUAL, PARSE, "{{step.data}}");
    await publishedWorkflow(`${PREFIX}-create`, MANUAL, CREATE, { asset: "{{step.data.asset}}" });
    // CRON runs as its execute_as - the Workflows system account, an administrator executor -
    // with the schedule object as Start data (§6.4.3), so the file is part of the design.
    await publishedWorkflow(`${PREFIX}-cron-read`, { trigger: "CRON", cron_expression: "0 0 1 1 *", timezone: "UTC", execute_as: systemUserId }, { type: "totalbase.read-file", configuration: { asset: otherFileId } }, { name: "{{step.data.name}}", start: "{{start.data}}" });
  });

  afterAll(async () => {
    for (const id of [ownFileId, otherFileId, publicFileId, ...createdFileIds]) await context.filesAdmin.remove(id).catch(() => undefined);
    await database.query(`DELETE FROM totalbase.workflows WHERE id = ANY($1)`, [workflowIds]);
    await database.query(`DELETE FROM totalbase.permissions WHERE role = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [caller.userId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await app.close();
  });

  describe("MANUAL Start options (Workflows.md §6.2)", () => {
    const JS = { type: "totalbase.execute-javascript", configuration: { code: "return 1" } };

    it("Execute as: runs as the configured user, the caller still recorded as the initiator", async () => {
      await publishedWorkflow(`${PREFIX}-as`, { trigger: "MANUAL", execute_as: systemUserId }, JS, "{{step.data}}");
      const res = await run(`${PREFIX}-as`, {});
      expect(res.statusCode, res.body).toBe(200);
      const stored = await context.workflowRuns.getRun(res.json().data.id);
      expect(stored.executor).toMatchObject({ type: "USER", id: systemUserId });
      expect(stored.initiator).toMatchObject({ type: "API_KEY", id: caller.tokenId });
    });

    it("an input form: a run's input checked against it - required fields, their types", async () => {
      await publishedWorkflow(`${PREFIX}-form`, { trigger: "MANUAL", input_fields: [{ name: "qty", label: "Quantity", type: "number", required: true }, { name: "on", type: "date" }] }, JS, "{{start.data}}");
      const missing = await run(`${PREFIX}-form`, { on: "2026-10-04" });
      expect([missing.statusCode, missing.json().errors[0].code]).toEqual([422, "WORKFLOW_VALIDATION_FAILED"]);
      expect(missing.body).toContain("Quantity is required.");
      const wrongType = await run(`${PREFIX}-form`, { qty: "three", on: "tomorrow" });
      expect(wrongType.json().errors[0].message).toContain("Quantity must be a number.");
      const ok = await run(`${PREFIX}-form`, { qty: 3, on: "2026-10-04" });
      expect(ok.json().data, ok.body).toMatchObject({ status: "SUCCEEDED", result: { data: { qty: 3 } } });
    });

    it("?async=true: 202 at once with the run as admitted, its result polled later", async () => {
      await publishedWorkflow(`${PREFIX}-async`, MANUAL, JS, "{{step.data}}");
      const res = await app.inject({
        method: "POST",
        url: `/api/workflows/${PREFIX}-async/run?async=true`,
        headers: { authorization: `Bearer ${caller.plainKey}`, "content-type": "application/json" },
        payload: JSON.stringify({ data: {} }),
      });
      expect(res.statusCode, res.body).toBe(202);
      const id = res.json().data.id;
      await expect.poll(async () => (await app.inject({ method: "GET", url: `/api/workflows/runs/${id}/result`, headers: { authorization: `Bearer ${caller.plainKey}` } })).json().data?.status).toBe("SUCCEEDED");
    });
  });

  it("answers with the run's outcome only - { id, status, result, error }, never its steps", async () => {
    const res = await run(`${PREFIX}-read`, { asset: publicFileId });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(Object.keys(body)).toEqual(["data"]);
    expect(Object.keys(body.data).sort()).toEqual(["error", "id", "result", "status"]);
    expect(body.data).toMatchObject({ status: "SUCCEEDED", result: { data: { name: `${PREFIX}-public.json` } }, error: null });
    // The Read file step's own result (the content, base64) stays out of the response.
    expect(res.body).not.toContain(Buffer.from(`{"secret":"${PREFIX}-public-content"}`).toString("base64"));
    expect(res.body).not.toContain("steps");
  });

  it("Read file refuses a PRIVATE file the executor may not READ", async () => {
    const res = await run(`${PREFIX}-read`, { asset: otherFileId });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ status: "FAILED", result: null, error: { code: "FILE_ACCESS_DENIED" } });
  });

  it("Read file honors the READ grant's row filter, like the Files API", async () => {
    // A literal id: $USER.* does not resolve for an API token principal (files.test.ts).
    await context.permissions.set(roleId, filesResourceId, "READ", { effect: "ALLOW", where: { created_by: { _eq: caller.userId } } });
    try {
      const own = await run(`${PREFIX}-read`, { asset: ownFileId });
      expect(own.json().data, own.body).toMatchObject({ status: "SUCCEEDED", result: { data: { name: `${PREFIX}-own.json` } } });
      const other = await run(`${PREFIX}-read`, { asset: otherFileId });
      expect(other.json().data).toMatchObject({ status: "FAILED", error: { code: "FILE_ACCESS_DENIED" } });
    } finally {
      await context.permissions.delete(roleId, filesResourceId, "READ");
    }
  });

  it("Parse CSV / JSON refuses a PRIVATE file without READ and parses it with READ", async () => {
    const denied = await run(`${PREFIX}-parse`, { asset: otherFileId });
    expect(denied.json().data).toMatchObject({ status: "FAILED", error: { code: "FILE_ACCESS_DENIED" } });
    expect(denied.body).not.toContain(`${PREFIX}-other-content`);

    await context.permissions.set(roleId, filesResourceId, "READ", { effect: "ALLOW" });
    try {
      const allowed = await run(`${PREFIX}-parse`, { asset: otherFileId });
      expect(allowed.json().data, allowed.body).toMatchObject({ status: "SUCCEEDED", result: { data: { secret: `${PREFIX}-other-content` } } });
    } finally {
      await context.permissions.delete(roleId, filesResourceId, "READ");
    }
  });

  it("Create file needs CREATE on files and stores the file with the executor as creator", async () => {
    const countCreated = async () => (await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM totalbase.files WHERE name = $1`, [`${PREFIX}-created.txt`],
    )).rows[0]!.count;
    const before = await countCreated();
    const denied = await run(`${PREFIX}-create`, {});
    expect(denied.json().data).toMatchObject({ status: "FAILED", error: { code: "FILE_ACCESS_DENIED" } });
    expect(await countCreated()).toBe(before);

    await context.permissions.set(roleId, filesResourceId, "CREATE", { effect: "ALLOW" });
    try {
      const allowed = await run(`${PREFIX}-create`, {});
      expect(allowed.json().data.status, allowed.body).toBe("SUCCEEDED");
      const assetId = allowed.json().data.result.data.asset as string;
      createdFileIds.push(assetId);
      const { rows } = await database.query<{ created_by: string | null }>(`SELECT created_by FROM totalbase.files WHERE id = $1`, [assetId]);
      expect(rows[0]!.created_by).toBe(caller.userId);
    } finally {
      await context.permissions.delete(roleId, filesResourceId, "CREATE");
    }
  });

  it("an administrator executor keeps full access to files", async () => {
    const res = await run(`${PREFIX}-cron-read`, { ignored: true });
    expect(res.json().data, res.body).toMatchObject({ status: "SUCCEEDED", result: { data: { name: `${PREFIX}-other.json`, start: { timezone: "UTC" } } } });
    // On demand, a CRON workflow receives the schedule object, never the caller's data.
    const start = res.json().data.result.data.start;
    expect(Object.keys(start).sort()).toEqual(["scheduled_at", "started_at", "timezone"]);
  });
});
