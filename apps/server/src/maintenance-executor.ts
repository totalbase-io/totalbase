import { resolveMaintenanceTarget } from "@totalbase/pg-catalog";
import { TotalBaseError } from "@totalbase/errors";
import { ExecutionExecutorError, MAINTENANCE_CANCELLED, type ExecutionRecord, type MaintenanceRequest } from "@totalbase/executions";
import { buildMaintenanceSql } from "@totalbase/schema";
import type { AppContext } from "./context.js";

/** A long VACUUM outlasts async_executions.stale_timeout_ms; renewing the lock keeps it from being run twice. */
const HEARTBEAT_MS = 30_000;

/**
 * Runs one queued maintenance action (Administration.md §6) in
 * the dedicated maintenance worker - one at a time, outside any
 * transaction, as VACUUM and REINDEX CONCURRENTLY require, and outside the
 * admin's HTTP request, since they can take minutes. The target is
 * resolved by OID again and the privilege re-checked right before running:
 * the table may have been dropped or changed owner since it was queued,
 * and PostgreSQL would answer a VACUUM it may not run with a WARNING, not
 * an error. Never retried - any failure ends the execution.
 */
export async function runMaintenanceExecution(
  context: AppContext,
  execution: Pick<ExecutionRecord, "id" | "request" | "principal">,
): Promise<{ sql: string; durationMs: number }> {
  const request = execution.request as MaintenanceRequest;

  // A batch stopped between this item being claimed and starting: don't.
  if (request.batchId && (await context.maintenance.isBatchStopped(request.batchId))) {
    throw new ExecutionExecutorError(MAINTENANCE_CANCELLED, "Stopped by an administrator.");
  }

  const target = await resolveMaintenanceTarget(context.database, request.tableOid, request.indexOid);
  if (!target) throw new ExecutionExecutorError("RESOURCE_NOT_FOUND", `${request.label} no longer exists.`, 404);
  if (!target.canMaintain) {
    throw new ExecutionExecutorError("PERMISSION_DENIED", `${target.schema}.${target.table} belongs to ${target.owner}; TotalBase's role can't maintain it.`, 403);
  }

  const sql = buildMaintenanceSql(request.operation, target);
  const startedAt = new Date();
  const heartbeat = setInterval(() => {
    context.executions.heartbeat(execution.id).catch(() => undefined);
  }, HEARTBEAT_MS);
  try {
    await context.database.query(sql);
    await recordAudit(context, execution, sql, startedAt, undefined);
    return { sql, durationMs: Date.now() - startedAt.getTime() };
  } catch (error) {
    // "Stop" cancels a running VACUUM/ANALYZE with pg_cancel_backend().
    const cancelled = error instanceof TotalBaseError && error.code === "QUERY_CANCELED";
    const message = cancelled ? "Stopped by an administrator." : error instanceof Error ? error.message : String(error);
    await recordAudit(context, execution, sql, startedAt, message);
    throw new ExecutionExecutorError(cancelled ? MAINTENANCE_CANCELLED : "MAINTENANCE_FAILED", message);
  } finally {
    clearInterval(heartbeat);
  }
}

async function recordAudit(
  context: AppContext,
  execution: Pick<ExecutionRecord, "id" | "principal" | "request">,
  sql: string,
  startedAt: Date,
  failure: string | undefined,
): Promise<void> {
  const request = execution.request as MaintenanceRequest;
  try {
    await context.audit.record(context.database, {
      requestId: execution.id,
      principal: { type: "ADMIN", id: execution.principal },
      action: "MAINTENANCE",
      status: failure ? "FAILED" : "EXECUTED",
      source: "admin",
      sqlText: sql,
      metadata: { execution: execution.id, ...(request.batchId ? { batch: request.batchId } : {}) },
      ...(failure ? { error: { message: failure } } : {}),
      startedAt,
      finishedAt: new Date(),
    });
  } catch {
    // best-effort; never mask the maintenance outcome
  }
}
