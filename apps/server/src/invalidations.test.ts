import type { FastifyInstance } from "fastify";
import { Database, loadDatabaseConfigFromEnv, type Subscription } from "@totalbase/database";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { applyInvalidation, catalogChanged, INVALIDATIONS_CHANNEL, listenForInvalidations } from "./invalidations.js";
import { adminToken, setupTestApp, uniqueSuffix, waitFor } from "./test-support.js";

/**
 * Several server processes per instance (Foundations.md §4.6): two contexts, each with its own pool and
 * its own LISTEN on the same database - what one changes, the other drops from memory.
 */
describe("Invalidation signal between processes (integration)", () => {
  let app: FastifyInstance;
  let first: AppContext;
  let database: Database;
  let otherDatabase: Database;
  let second: AppContext;
  const subscriptions: Subscription[] = [];
  const KEY = "security.rate_limit_per_minute";
  let original: number;

  beforeAll(async () => {
    ({ app, context: first, database } = await setupTestApp());
    const env = loadServerEnv();
    otherDatabase = new Database(loadDatabaseConfigFromEnv());
    second = buildContext(otherDatabase, pino({ level: "silent" }), env.masterKey!, env.publicUrl!, env.nodeEnv);
    subscriptions.push(await listenForInvalidations(first), await listenForInvalidations(second));
    original = await first.settings.get(KEY);
  });

  afterAll(async () => {
    await first.settings.set(KEY, original);
    for (const subscription of subscriptions) await subscription.close();
    await app.close();
    await database.close();
    await otherDatabase.close();
  });

  it("a setting one process saves is read anew by the other", async () => {
    expect(await second.settings.get(KEY)).toBe(original); // cached in the second process
    await first.settings.set(KEY, original + 7);
    await waitFor(async () => (await second.settings.get(KEY)) === original + 7);
  });

  it("a setting changed outside the settings service - the SQL Console - reaches every process", async () => {
    await first.settings.get(KEY);
    await second.settings.get(KEY);
    await database.query(`UPDATE totalbase.settings SET value = to_jsonb($2::int) WHERE key = $1`, [KEY, original + 11]);
    await waitFor(async () => (await first.settings.get(KEY)) === original + 11 && (await second.settings.get(KEY)) === original + 11);
  });

  it("a rolled-back write tells no one", async () => {
    await first.settings.set(KEY, original + 1);
    await waitFor(async () => (await second.settings.get(KEY)) === original + 1);
    await database
      .transaction(async (client) => {
        await first.settings.set(KEY, original + 2, client);
        throw new Error("abort");
      })
      .catch(() => undefined);
    expect(await second.settings.get(KEY)).toBe(original + 1);
  });

  it("a catalog change drops the other process's cached OpenAPI documents", async () => {
    let builds = 0;
    const build = async () => ({ build: ++builds });
    await second.openApiCache.get("probe", build);
    await second.openApiCache.get("probe", build);
    expect(builds).toBe(1);
    await catalogChanged(first);
    await waitFor(async () => (await second.openApiCache.get("probe", build)).build === 2);
  });

  it("Cancel on a run executing elsewhere is signaled, not refused", async () => {
    const received: string[] = [];
    const probe = await database.listen(INVALIDATIONS_CHANNEL, { onNotification: (payload) => received.push(payload), onReconnect: () => undefined });
    const suffix = uniqueSuffix();
    const workflow = (await first.workflowsAdmin.create({ name: `cancel ${suffix}`, slug: `cancel-elsewhere-${suffix}` })).id;
    // RUNNING within its deadline, and not in this process: another one is executing it.
    const run = await first.workflowRuns.createRun({
      workflow, version: null, trigger: "MANUAL", mode: "TEST", initiator: {}, executor: {}, historyEnabled: true, historyLevel: "SUMMARY", expiresAt: new Date(Date.now() + 60_000),
    });
    try {
      await database.query(`UPDATE totalbase.workflows_runs SET status = 'RUNNING', started_at = now() WHERE id = $1`, [run.id]);
      const token = await adminToken(first);
      const cancel = await app.inject({ method: "POST", url: `/admin/api/workflows/runs/${run.id}/cancel`, headers: { authorization: `Bearer ${token}` } });
      expect(cancel.statusCode, cancel.body).toBe(202);
      await waitFor(() => received.some((payload) => JSON.parse(payload).topic === "RUN_CANCEL" && JSON.parse(payload).run === run.id));

      // Past its deadline the process that ran it is gone: 409, nothing to signal.
      await database.query(`UPDATE totalbase.workflows_runs SET expires_at = now() - interval '1 second' WHERE id = $1`, [run.id]);
      const late = await app.inject({ method: "POST", url: `/admin/api/workflows/runs/${run.id}/cancel`, headers: { authorization: `Bearer ${token}` } });
      expect([late.statusCode, late.json().errors[0].code]).toEqual([409, "WORKFLOW_RUN_NOT_CANCELLABLE"]);
    } finally {
      await probe.close();
      await first.workflowsAdmin.remove(workflow);
    }
  });

  it("the first administrator's setup spends the code in every process", () => {
    const code = second.setup.code;
    second.setup.code = "PENDING";
    applyInvalidation(second, JSON.stringify({ topic: "SETUP" }));
    expect(second.setup.code).toBeNull();
    second.setup.code = code;
  });
});
