import { createHmac, randomUUID } from "node:crypto";
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
    await database.query(`DELETE FROM totalbase.secrets WHERE key LIKE '${PREFIX}%'`);
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

  // Security regression (Workflows.md §6.5): an AUTHENTICATED webhook also took the session cookie, which a browser
  // sends by itself - a link or an image on another site invoked a GET webhook as whoever opened it (CSRF).
  it("authenticates an AUTHENTICATED webhook by its Authorization header only, never a cookie", async () => {
    const getId = await publishedWorkflow(`${PREFIX}-auth-get`, { method: "GET", access: "AUTHENTICATED", response_mode: "ASYNC" });
    await context.workflowPermissions.grant(roleId, getId);
    for (const cookie of [`tb_session=${caller.plainKey}`, `__Host-tb_session=${caller.plainKey}`]) {
      const res = await hit("GET", `${PREFIX}-auth-get`, { headers: { cookie } });
      expect([res.statusCode, res.json().errors?.[0]?.code], cookie).toEqual([401, "AUTHENTICATION_REQUIRED"]);
    }
    expect((await hit("GET", `${PREFIX}-auth-get`, { token: caller.plainKey })).statusCode).toBe(202);
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
  // Allowed addresses (Workflows.md §6.5): from anywhere else the webhook answers as one that doesn't exist.
  it("accepts a webhook with allowed addresses only from them - an address, a range, an IPv4 client on a dual-stack socket", async () => {
    const id = await publishedWorkflow(`${PREFIX}-ips`, { method: "POST", access: "PUBLIC", response_mode: "SYNC", execute_as: systemUserId, allowed_ips: ["10.88.0.0/24", "203.0.113.7"] });
    const runs = async () => (await database.query<{ count: number }>(`SELECT count(*)::int AS count FROM totalbase.workflows_runs WHERE workflow = $1`, [id])).rows[0]!.count;

    expect((await hit("POST", `${PREFIX}-ips`, { payload: {}, ip: "10.88.0.5" })).statusCode).toBe(200);
    expect((await hit("POST", `${PREFIX}-ips`, { payload: {}, ip: "203.0.113.7" })).statusCode).toBe(200);
    expect((await hit("POST", `${PREFIX}-ips`, { payload: {}, ip: "::ffff:203.0.113.7" })).statusCode).toBe(200);
    expect(await runs()).toBe(3);

    for (const ip of ["10.88.1.5", "203.0.113.8", "2001:db8::1"]) {
      const refused = await hit("POST", `${PREFIX}-ips`, { payload: {}, ip });
      expect([refused.statusCode, refused.json().errors[0].code], ip).toEqual([404, "WORKFLOW_NOT_FOUND"]);
    }
    expect(await runs()).toBe(3);
  });

  it("checks an AUTHENTICATED webhook's allowed addresses before its caller's credential", async () => {
    const id = await publishedWorkflow(`${PREFIX}-auth-ips`, { method: "POST", access: "AUTHENTICATED", response_mode: "ASYNC", allowed_ips: ["203.0.113.7"] });
    await context.workflowPermissions.grant(roleId, id);
    expect((await hit("POST", `${PREFIX}-auth-ips`, { payload: {}, token: caller.plainKey, ip: "203.0.113.7" })).statusCode).toBe(202);
    const refused = await hit("POST", `${PREFIX}-auth-ips`, { payload: {}, token: caller.plainKey, ip: "203.0.113.8" });
    expect([refused.statusCode, refused.json().errors[0].code]).toEqual([404, "WORKFLOW_NOT_FOUND"]);
  });

  it("refuses to publish a webhook whose allowed addresses PostgreSQL can't read", async () => {
    await expect(publishedWorkflow(`${PREFIX}-ips-bad`, { method: "POST", access: "PUBLIC", execute_as: systemUserId, allowed_ips: ["10.0.0.0/8", "not-an-address"] })).rejects.toThrow(/allowed addresses are invalid/);
    await expect(publishedWorkflow(`${PREFIX}-ips-bad-2`, { method: "POST", access: "PUBLIC", execute_as: systemUserId, allowed_ips: "10.0.0.1" })).rejects.toThrow(/list of IP addresses/);
  });

  it("asks a PUBLIC webhook with a secret for it - as a token, or as an HMAC of the raw body (security regression, SEC-33)", async () => {
    await context.secrets.set(`${PREFIX}-hook-secret`, "hook-s3cr3t", "WORKFLOWS");
    await publishedWorkflow(`${PREFIX}-token`, { method: "POST", access: "PUBLIC", response_mode: "SYNC", execute_as: systemUserId, secret: `${PREFIX}-hook-secret` });
    const runs = async () => Number((await database.query<{ n: string }>(
      `SELECT count(*) AS n FROM totalbase.workflows_runs r JOIN totalbase.workflows w ON w.id = r.workflow WHERE w.slug LIKE '${PREFIX}-token%' OR w.slug LIKE '${PREFIX}-hmac%'`,
    )).rows[0]!.n);
    for (const headers of [{}, { "x-webhook-token": "wrong" }, { "x-webhook-token": "hook-s3cr3" }]) {
      const refused = await hit("POST", `${PREFIX}-token`, { payload: { name: "Ada" }, headers });
      expect([refused.statusCode, refused.json().errors[0].code], JSON.stringify(headers)).toEqual([401, "AUTHENTICATION_REQUIRED"]);
    }
    expect(await runs()).toBe(0);
    const ok = await hit("POST", `${PREFIX}-token`, { payload: { name: "Ada" }, headers: { "x-webhook-token": "hook-s3cr3t" } });
    expect(ok.statusCode, ok.body).toBe(200);

    await publishedWorkflow(`${PREFIX}-hmac`, { method: "POST", access: "PUBLIC", response_mode: "SYNC", execute_as: systemUserId, secret: `${PREFIX}-hook-secret`, secret_mode: "HMAC_SHA256", secret_header: "X-Hub-Signature-256" });
    const payload = { name: "Grace" };
    const signature = createHmac("sha256", "hook-s3cr3t").update(JSON.stringify(payload)).digest("hex");
    const forged = await hit("POST", `${PREFIX}-hmac`, { payload: { name: "Mallory" }, headers: { "x-hub-signature-256": `sha256=${signature}` } });
    expect(forged.statusCode).toBe(401);
    const signed = await hit("POST", `${PREFIX}-hmac`, { payload, headers: { "x-hub-signature-256": `sha256=${signature}` } });
    expect([signed.statusCode, signed.json().data?.result?.data?.name], signed.body).toEqual([200, "Grace"]);
    expect(await runs()).toBe(2);
  });

  // Security regression (round 7): the proof header reached the run's input, and with a header name history redaction
  // doesn't know (X-Shared-Key), the plaintext secret was stored in every DETAILED run's history.
  it("keeps a webhook's proof out of the run - its input and its history - whatever the header is called", async () => {
    await context.secrets.set(`${PREFIX}-shared`, "shared-s3cr3t-value", "WORKFLOWS");
    const id = await publishedWorkflow(`${PREFIX}-shared`, { method: "POST", access: "PUBLIC", response_mode: "SYNC", execute_as: systemUserId, secret: `${PREFIX}-shared`, secret_header: "X-Shared-Key" });
    await database.query(`UPDATE totalbase.workflows SET history_level = 'DETAILED' WHERE id = $1`, [id]);
    const res = await hit("POST", `${PREFIX}-shared`, { payload: { name: "Ada" }, headers: { "x-shared-key": "shared-s3cr3t-value" } });
    expect(res.statusCode, res.body).toBe(200);
    const stored = await database.query(`SELECT s.* FROM totalbase.workflows_steps s JOIN totalbase.workflows_runs r ON r.id = s.run WHERE r.workflow = $1`, [id]);
    expect(stored.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored.rows)).not.toContain("shared-s3cr3t-value");
  });

  it("refuses an HMAC secret on a GET webhook - with no body, its signature is one fixed value", async () => {
    await context.secrets.set(`${PREFIX}-get-secret`, "x", "WORKFLOWS");
    await expect(publishedWorkflow(`${PREFIX}-get-hmac`, { method: "GET", access: "PUBLIC", execute_as: systemUserId, secret: `${PREFIX}-get-secret`, secret_mode: "HMAC_SHA256" })).rejects.toThrow(/GET webhook has none/);
  });

  it("refuses to publish a webhook secret that isn't a workflow's, or on an authenticated webhook", async () => {
    await context.secrets.set(`${PREFIX}-smtp-secret`, "smtp", "SMTP");
    await expect(publishedWorkflow(`${PREFIX}-secret-bad`, { method: "POST", access: "PUBLIC", execute_as: systemUserId, secret: `${PREFIX}-smtp-secret` })).rejects.toThrow(/no workflow secret/);
    await context.secrets.set(`${PREFIX}-hook-secret-2`, "x", "WORKFLOWS");
    await expect(publishedWorkflow(`${PREFIX}-secret-bad-2`, { method: "POST", access: "AUTHENTICATED", secret: `${PREFIX}-hook-secret-2` })).rejects.toThrow(/secret is for a public webhook/);
    await expect(publishedWorkflow(`${PREFIX}-secret-bad-3`, { method: "POST", access: "PUBLIC", execute_as: systemUserId, secret: `${PREFIX}-hook-secret-2`, secret_mode: "MD5" })).rejects.toThrow(/TOKEN or HMAC_SHA256/);
  });

  it("caps the runs one webhook has going at once (security regression, SEC-33)", async () => {
    await context.settings.set("workflows.webhook_max_concurrent_runs", 1);
    try {
      await publishedWorkflow(
        `${PREFIX}-busy`,
        { method: "POST", access: "PUBLIC", response_mode: "ASYNC", execute_as: systemUserId },
        { type: "totalbase.execute-sql", configuration: { statement: "SELECT pg_sleep(1.5)", executeAs: systemUserId } },
      );
      expect((await hit("POST", `${PREFIX}-busy`, { payload: {} })).statusCode).toBe(202);
      const refused = await hit("POST", `${PREFIX}-busy`, { payload: {} });
      expect([refused.statusCode, refused.json().errors[0].code]).toEqual([429, "WORKFLOW_CONCURRENCY_LIMIT"]);
      // Another workflow has its own count.
      expect((await hit("POST", `${PREFIX}-public`, { payload: { name: "Ada" } })).statusCode).toBe(200);
      // Once the run ends, the webhook takes calls again.
      await expect.poll(async () => (await hit("POST", `${PREFIX}-busy`, { payload: {} })).statusCode, { timeout: 10_000, interval: 500 }).toBe(202);
      await expect.poll(async () => Number((await database.query<{ n: string }>(
        `SELECT count(*) AS n FROM totalbase.workflows_runs r JOIN totalbase.workflows w ON w.id = r.workflow WHERE w.slug = '${PREFIX}-busy' AND r.status = 'RUNNING'`,
      )).rows[0]!.n), { timeout: 10_000 }).toBe(0);
    } finally {
      await context.settings.reset("workflows.webhook_max_concurrent_runs");
    }
  }, 30_000);

  // A token's allowed addresses (Security.md §3.5) on the routes that resolve their caller without the request's headers.
  it("refuses a token with allowed addresses from anywhere else - webhook, run result and Data API alike", async () => {
    const restricted = await context.usersApis.create({ userId: caller.userId, name: `${PREFIX}-restricted`, plane: "API", allowedIps: ["203.0.113.50"] });
    const from = (ip: string, url: string, method: "GET" | "POST" = "GET") =>
      app.inject({ method, url, remoteAddress: ip, headers: { authorization: `Bearer ${restricted.plainKey}`, ...(method === "POST" && { "content-type": "application/json" }) }, ...(method === "POST" && { payload: "{}" }) });

    for (const [url, method] of [[`/api/workflows/${PREFIX}-auth/webhook`, "POST"], [`/api/workflows/runs/${randomUUID()}/result`, "GET"], ["/api/totalbase/table/roles", "GET"], ["/api/openapi.json", "GET"]] as const) {
      const refused = await from("198.51.100.1", url, method);
      expect([refused.statusCode, refused.json().errors[0].code], url).toEqual([403, "TOKEN_IP_NOT_ALLOWED"]);
      const allowed = await from("203.0.113.50", url, method);
      expect(allowed.body, url).not.toContain("TOKEN_IP_NOT_ALLOWED");
      expect(allowed.statusCode, url).not.toBe(401);
    }
    await context.usersApis.delete(restricted.userApi.id);
  });
});
