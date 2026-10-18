import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { SettingsService } from "@totalbase/settings";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ExecutionsService } from "./executions-service.js";
import { ExecutionsWorker, type Executor } from "./executions-worker.js";
import { ExecutionExecutorError, RetryableExecutionExecutorError } from "./executor-error.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));

describe("@totalbase/executions (integration)", () => {
  let database: Database;
  let settings: SettingsService;
  let executions: ExecutionsService;
  let principal: string;
  /** Every execution this file created - deleted by id in afterAll. */
  const createdIds: string[] = [];
  const create: ExecutionsService["create"] = async (input) => {
    const row = await executions.create(input);
    createdIds.push(row.id);
    return row;
  };

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    settings = new SettingsService(database);
    executions = new ExecutionsService(database);
  });

  beforeEach(async () => {
    principal = randomUUID();
    await settings.set("async_executions.max_retries", 3);
    await settings.set("async_executions.retry_delay_seconds", 30);
    await settings.set("async_executions.stale_timeout_ms", 120_000);
  });

  afterAll(async () => {
    // Only this file's own rows, by primary key - totalbase.executions is a
    // shared table and other suites may have rows in flight against the same database.
    await database.query(`DELETE FROM totalbase.executions WHERE id = ANY($1)`, [createdIds]);
    await database.close();
  });

  it("creates a pending execution and exposes it via get()", async () => {
    // A distinct, unregistered type: this row is deliberately never
    // processed by any worker in this file, so it must not be reachable
    // by "TEST"'s executor in a later test's processBatch() call.
    const created = await create({
      type: "TEST_CREATE_ONLY",
      principalType: "USER",
      principal,
      request: { foo: "bar" },
    });
    expect(created.status).toBe("PENDING");
    const fetched = await executions.get(created.id);
    expect(fetched?.request).toEqual({ foo: "bar" });
  });

  it("processes a pending execution to completed", async () => {
    const created = await create({ type: "TEST", principalType: "USER", principal });
    const executor: Executor = async () => ({ ok: true });
    const worker = new ExecutionsWorker(database, settings, { TEST: executor });

    const processed = await worker.processBatch(10);
    expect(processed).toBe(1);

    const after = await executions.get(created.id);
    expect(after?.status).toBe("COMPLETED");
    expect(after?.result).toEqual({ ok: true });
    expect(after?.completedAt).not.toBeNull();
  });

  it("marks a non-retryable failure as failed without retrying", async () => {
    const created = await create({ type: "TEST", principalType: "USER", principal });
    const executor: Executor = async () => {
      throw new ExecutionExecutorError("UPSTREAM_REJECTED", "bad request", 400);
    };
    const worker = new ExecutionsWorker(database, settings, { TEST: executor });

    await worker.processBatch(10);
    const after = await executions.get(created.id);
    expect(after?.status).toBe("FAILED");
    expect(after?.error).toEqual({ code: "UPSTREAM_REJECTED", status: 400, message: "bad request" });
  });

  it("retries a retryable failure up to max_retries, then fails", async () => {
    await settings.set("async_executions.max_retries", 1);
    await settings.set("async_executions.retry_delay_seconds", 0);
    const created = await create({ type: "TEST", principalType: "USER", principal });
    let calls = 0;
    const executor: Executor = async () => {
      calls++;
      throw new RetryableExecutionExecutorError("UPSTREAM_TIMEOUT", "timed out", 504);
    };
    const worker = new ExecutionsWorker(database, settings, { TEST: executor });

    await worker.processBatch(10); // attempt 0 -> retry -> pending, attempt 1
    let after = await executions.get(created.id);
    expect(after?.status).toBe("PENDING");
    expect(after?.attempt).toBe(1);

    await worker.processBatch(10); // attempt 1 == max_retries -> failed
    after = await executions.get(created.id);
    expect(after?.status).toBe("FAILED");
    expect(calls).toBe(2);
  });

  it("never claims a type it has no registered executor for, even if other types are pending", async () => {
    const created = await create({ type: "UNKNOWN_TYPE", principalType: "USER", principal });
    const executor: Executor = async () => ({ ok: true });
    // This worker only knows "TEST" - "UNKNOWN_TYPE" must be left alone
    // for a different worker (with the right executor) to pick up later,
    // rather than being claimed and failed by a worker that can't run it.
    const worker = new ExecutionsWorker(database, settings, { TEST: executor });
    const processed = await worker.processBatch(10);
    expect(processed).toBe(0);
    const after = await executions.get(created.id);
    expect(after?.status).toBe("PENDING");
  });

  it("does not double-process the same execution when two workers race (SKIP LOCKED)", async () => {
    const created = await create({ type: "TEST", principalType: "USER", principal });
    let calls = 0;
    const executor: Executor = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { calls };
    };
    const workerA = new ExecutionsWorker(database, settings, { TEST: executor }, "worker-a");
    const workerB = new ExecutionsWorker(database, settings, { TEST: executor }, "worker-b");

    await Promise.all([workerA.processBatch(10), workerB.processBatch(10)]);
    expect(calls).toBe(1);
    const after = await executions.get(created.id);
    expect(after?.status).toBe("COMPLETED");
  });

  it("reclaimStale() resets a stuck running execution back to pending", async () => {
    const created = await create({ type: "TEST", principalType: "USER", principal });
    await database.query(
      `UPDATE totalbase.executions SET status = 'RUNNING', started_at = now() - interval '1 hour' WHERE id = $1`,
      [created.id],
    );
    await settings.set("async_executions.stale_timeout_ms", 1_000);
    const worker = new ExecutionsWorker(database, settings, {});
    const reclaimed = await worker.reclaimStale();
    expect(reclaimed).toBe(1);
    const after = await executions.get(created.id);
    expect(after?.status).toBe("PENDING");
  });

  it("does nothing when async_executions.enabled is false", async () => {
    await create({ type: "TEST", principalType: "USER", principal });
    await settings.setGroup("async_executions", { enabled: false });
    try {
      const executor: Executor = async () => ({ ok: true });
      const worker = new ExecutionsWorker(database, settings, { TEST: executor });
      const processed = await worker.processBatch(10);
      expect(processed).toBe(0);
    } finally {
      await settings.setGroup("async_executions", { enabled: true });
    }
  });
});
