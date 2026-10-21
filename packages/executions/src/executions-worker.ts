import { randomUUID } from "node:crypto";
import type { Database } from "@totalbase/database";
import type { SettingsService } from "@totalbase/settings";
import { EXECUTION_CANCELLED, ExecutionExecutorError, RetryableExecutionExecutorError } from "./executor-error.js";
import type { ExecutionRecord } from "./executions-service.js";

interface ClaimedRow {
  id: string;
  type: string;
  resource: string | null;
  principal_type: "USER" | "API_KEY";
  principal: string;
  request: unknown;
  attempt: number;
}

/** Runs one execution and either returns its result or throws (Execution|RetryableExecution)ExecutorError. */
export type Executor = (
  execution: Pick<ExecutionRecord, "id" | "type" | "resource" | "request" | "principal" | "principalType">,
) => Promise<unknown>;

/**
 * PostgreSQL-based execution queue worker (Data_API.md §10.2).
 * Uses `FOR UPDATE SKIP LOCKED` exactly like
 * @totalbase/webhooks' OutboxConsumer, so multiple worker instances can run
 * concurrently without a broker (Data_API.md §10.2).
 *
 * `executors` is a type -> handler registry so new execution sources
 * (Functions, Transactions - Data_API.md §10) plug in without touching this
 * class; v1 only registers "PROXY" (see
 * apps/server/src/context.ts).
 */
export class ExecutionsWorker {
  constructor(
    private readonly database: Database,
    private readonly settings: SettingsService,
    private readonly executors: Record<string, Executor>,
    private readonly workerId: string = `worker-${randomUUID()}`,
  ) {}

  /**
   * Reclaims executions stuck in `running` past the staleness timeout -
   * crash recovery (Data_API.md §10.2). Measured from
   * locked_at, set when claimed and renewed by ExecutionsService.heartbeat()
   * - an execution that legitimately runs longer than the timeout (a
   * VACUUM of a large table) keeps it fresh and is never run twice.
   */
  async reclaimStale(): Promise<number> {
    const staleMs = await this.settings.get("async_executions.stale_timeout_ms");
    const { rowCount } = await this.database.query(
      `UPDATE totalbase.executions
       SET status = 'PENDING', available_at = now(), locked_at = NULL, locked_by = NULL
       WHERE status = 'RUNNING' AND coalesce(locked_at, started_at) < now() - ($1 || ' milliseconds')::interval`,
      [staleMs],
    );
    return rowCount;
  }

  /**
   * Claims up to `batchSize` pending executions and processes them.
   * Returns how many were processed. Only claims types this worker has a
   * registered executor for - a worker must never grab-and-fail work it
   * cannot actually perform, which also means independently configured
   * worker instances (or, in tests, independent processes against the
   * same database) never fight over each other's execution types.
   */
  async processBatch(batchSize = 10): Promise<number> {
    if (!(await this.settings.get("async_executions.enabled"))) return 0;
    const knownTypes = Object.keys(this.executors);
    if (knownTypes.length === 0) return 0;

    // One claim per execution, run at once - never a batch claimed ahead and run one by one, which left the
    // waiting ones RUNNING without a heartbeat: reclaimStale re-queued them while this worker still ran them (twice).
    // An execution this batch already ran (a retry put back to PENDING with no delay) waits for the next batch.
    const seen: string[] = [];
    while (seen.length < batchSize) {
      const { rows } = await this.database.query<ClaimedRow>(
        `WITH next AS (
           SELECT id FROM totalbase.executions
           WHERE status = 'PENDING' AND available_at <= now() AND type = ANY($1::text[]) AND id <> ALL($3::uuid[])
           ORDER BY created_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE totalbase.executions e
         SET status = 'RUNNING', started_at = now(), locked_at = now(), locked_by = $2
         FROM next WHERE e.id = next.id
         RETURNING e.id, e.type, e.resource, e.principal_type, e.principal, e.request, e.attempt`,
        [knownTypes, this.workerId, seen],
      );
      const row = rows[0];
      if (!row) break;
      seen.push(row.id);
      await this.run(row);
    }
    return seen.length;
  }

  private async run(row: ClaimedRow): Promise<void> {
    const executor = this.executors[row.type];
    if (!executor) {
      await this.database.query(
        `UPDATE totalbase.executions
         SET status = 'FAILED', error = $2, completed_at = now()
         WHERE id = $1 AND locked_by = $3 AND status = 'RUNNING'`,
        [row.id, JSON.stringify({ code: "EXECUTION_TYPE_NOT_SUPPORTED", message: `No executor registered for type: ${row.type}` }), this.workerId],
      );
      return;
    }

    try {
      const result = await executor({
        id: row.id,
        type: row.type,
        resource: row.resource,
        request: row.request,
        principal: row.principal,
        principalType: row.principal_type,
      });
      await this.database.query(
        // Fenced on locked_by (Data_API.md §10.2): a worker that lost its claim to reclaimStale never overwrites the new holder's outcome.
        `UPDATE totalbase.executions SET status = 'COMPLETED', result = $2, completed_at = now() WHERE id = $1 AND locked_by = $3 AND status = 'RUNNING'`,
        [row.id, JSON.stringify(result ?? null), this.workerId],
      );
    } catch (error) {
      await this.handleFailure(row, error);
    }
  }

  private async handleFailure(row: ClaimedRow, error: unknown): Promise<void> {
    const maxRetries = await this.settings.get("async_executions.max_retries");
    const retryDelaySeconds = await this.settings.get("async_executions.retry_delay_seconds");
    const retryable = error instanceof RetryableExecutionExecutorError;
    const errorPayload =
      error instanceof ExecutionExecutorError || error instanceof RetryableExecutionExecutorError
        ? { code: error.code, status: error.status, message: error.message }
        : { code: "EXECUTION_FAILED", message: error instanceof Error ? error.message : String(error) };

    if (retryable && row.attempt < maxRetries) {
      await this.database.query(
        `UPDATE totalbase.executions
         SET status = 'PENDING', attempt = attempt + 1, available_at = now() + ($2 || ' seconds')::interval,
             locked_at = NULL, locked_by = NULL, error = $3
         WHERE id = $1 AND locked_by = $4 AND status = 'RUNNING'`,
        [row.id, retryDelaySeconds, JSON.stringify(errorPayload), this.workerId],
      );
      return;
    }

    // An executor that was stopped (its caller cancelled it, an administrator stopped maintenance) ends CANCELLED.
    const status = error instanceof ExecutionExecutorError && error.code === EXECUTION_CANCELLED ? "CANCELLED" : "FAILED";
    await this.database.query(
      `UPDATE totalbase.executions SET status = $3, error = $2, completed_at = now() WHERE id = $1 AND locked_by = $4 AND status = 'RUNNING'`,
      [row.id, JSON.stringify(errorPayload), status, this.workerId],
    );
  }
}
