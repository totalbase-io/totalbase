import { TotalBaseError } from "@totalbase/errors";
import type { DatabaseTransactionContext, Queryable } from "@totalbase/database";
import { EXECUTION_CANCELLED, ExecutionExecutorError, type ExecutionRecord } from "@totalbase/executions";
import { executeTransaction, type TransactionRequest } from "@totalbase/mutations";
import type { AppContext } from "./context.js";
import { resolveStoredPrincipal, type DataPrincipal } from "./data-principal.js";
import type { RecordedResponse } from "@totalbase/idempotency";
import { executeFunctionCall, resolveFunctionCall } from "@totalbase/mutations";
import { sanitizeForAudit } from "./access-audit.js";

/**
 * Asynchronous calls (Data_API.md §10.4): a function call or
 * a transaction sent with `Prefer: respond-async` is checked at once
 * (resource, EXECUTE or the TRANSACTIONS capability), queued as an
 * execution and answered 202 with its id; the executions worker runs it
 * the way the route would have, as the caller resolved again at that
 * moment; the caller polls GET /api/executions/{id}.
 */
export const FUNCTION_CALL_EXECUTION_TYPE = "FUNCTION_CALL";
export const TRANSACTION_EXECUTION_TYPE = "TRANSACTION";

interface FunctionCallRequest {
  schema: string;
  function: string;
  args: Record<string, unknown>;
}

/** RFC 7240's `Prefer: respond-async` - the only opt-in, per request. */
export function wantsAsync(headers: Record<string, unknown>): boolean {
  const prefer = headers["prefer"];
  const values = Array.isArray(prefer) ? prefer : [prefer];
  return values.some((value) => typeof value === "string" && value.split(",").some((token) => token.trim().toLowerCase() === "respond-async"));
}

/** Queues one checked call and answers 202 - the same body GET /api/executions/{id} returns. */
export async function queueAsyncCall(
  context: AppContext,
  dataPrincipal: DataPrincipal,
  type: string,
  resource: string | undefined,
  request: unknown,
): Promise<RecordedResponse> {
  if (!(await context.settings.get("async_executions.enabled"))) {
    throw new TotalBaseError("ASYNC_EXECUTIONS_DISABLED", "Asynchronous calls run in the background executions worker, which is off.");
  }
  const { type: principalType, id } = dataPrincipal.principal;
  if ((principalType !== "USER" && principalType !== "API_KEY") || !id) {
    throw new TotalBaseError("AUTHENTICATION_REQUIRED", "Only a user or a token can queue a call.");
  }
  const execution = await context.executions.create({ type, resource, principalType, principal: id, request });
  return { status: 202, body: { data: { id: execution.id, status: execution.status, result: null, error: null } } };
}

type QueuedExecution = Pick<ExecutionRecord, "id" | "type" | "resource" | "request" | "principal" | "principalType">;

/** The types a caller can stop while they run (§10.5): one PostgreSQL transaction each, rolled back whole. */
export const CANCELLABLE_WHILE_RUNNING = new Set([FUNCTION_CALL_EXECUTION_TYPE, TRANSACTION_EXECUTION_TYPE]);

/** How a running call's backend is found in pg_stat_activity. */
export function executionApplicationName(executionId: string): string {
  return `totalbase-execution:${executionId}`;
}

async function cancelRequested(client: Queryable, executionId: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM totalbase.executions WHERE id = $1 AND cancel_requested_at IS NOT NULL`,
    [executionId],
  );
  return rows.length > 0;
}

/**
 * A running call's cancellation hooks: its backend is named so a cancel
 * interrupts the statement it runs (pg_cancel_backend), and right before
 * COMMIT it checks whether a cancel came while it was between statements -
 * either way the transaction rolls back whole. A cancel after COMMIT is too
 * late: the call stays COMPLETED.
 */
function cancellationHooks(executionId: string): Pick<DatabaseTransactionContext, "applicationName" | "beforeCommit"> {
  return {
    applicationName: executionApplicationName(executionId),
    beforeCommit: async (client) => {
      if (await cancelRequested(client, executionId)) throw new TotalBaseError("QUERY_CANCELED", "Cancelled by its caller.");
    },
  };
}

/**
 * A refusal or a failure becomes the execution's error, never retried: a
 * call that wrote nothing may have run a side effect. A statement cancelled
 * because its caller asked ends CANCELLED - a statement_timeout cancels
 * with the same SQLSTATE, so only a recorded request counts.
 */
async function asExecutorFailure<T>(context: AppContext, executionId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof TotalBaseError) {
      if (error.code === "QUERY_CANCELED" && (await cancelRequested(context.database, executionId))) {
        throw new ExecutionExecutorError(EXECUTION_CANCELLED, "Cancelled by its caller.");
      }
      throw new ExecutionExecutorError(error.code, error.message, error.httpStatus);
    }
    throw error;
  }
}

async function runFunctionCall(context: AppContext, execution: QueuedExecution): Promise<unknown> {
  return asExecutorFailure(context, execution.id, async () => {
    const startedAt = new Date();
    const request = execution.request as FunctionCallRequest;
    const dataPrincipal = await resolveStoredPrincipal(context, execution.principalType, execution.principal);
    const { resource, detail } = await resolveFunctionCall(context, request.schema, request.function, request.args);
    // The name now selects another function (dropped and created again): not the one that was checked.
    if (execution.resource && resource.id !== execution.resource) {
      throw new TotalBaseError("RESOURCE_NOT_FOUND", `The function queued as ${request.schema}.${request.function} no longer exists.`);
    }
    const audit = { requestId: execution.id, source: "api", payload: sanitizeForAudit(request.args) };
    return executeFunctionCall(context, dataPrincipal, resource, detail, request.args, audit, startedAt, cancellationHooks(execution.id));
  });
}

async function runTransaction(context: AppContext, execution: QueuedExecution): Promise<unknown> {
  return asExecutorFailure(context, execution.id, async () => {
    const dataPrincipal = await resolveStoredPrincipal(context, execution.principalType, execution.principal);
    const [maxFilterDepth, maxRelationDepth] = await Promise.all([
      context.settings.get("api.max_filter_depth"),
      context.settings.get("api.max_relation_depth"),
    ]);
    return executeTransaction(
      {
        context,
        dataPrincipal,
        limits: { maxFilterDepth, maxRelationDepth },
        audit: { requestId: execution.id, source: "api" },
        transactionContext: cancellationHooks(execution.id),
      },
      execution.request as TransactionRequest,
    );
  });
}

/** Plugs both call types into the executions worker (context.ts). */
export function registerAsyncCallExecutors(context: AppContext): void {
  context.executionExecutors[FUNCTION_CALL_EXECUTION_TYPE] = (execution) => runFunctionCall(context, execution);
  context.executionExecutors[TRANSACTION_EXECUTION_TYPE] = (execution) => runTransaction(context, execution);
}

/**
 * POST /api/executions/{id}/cancel (§10.5), for its owner: a queued
 * execution never starts (CANCELLED at once); a running function call or
 * transaction is asked to stop - its statement interrupted, its COMMIT
 * refused - and ends CANCELLED, or COMPLETED if it committed first; any
 * other running type cannot be stopped from here (maintenance has its
 * own Stop). Returns the execution as it stands.
 */
export async function cancelExecution(context: AppContext, execution: ExecutionRecord): Promise<ExecutionRecord> {
  const { rowCount } = await context.database.query(
    `UPDATE totalbase.executions
        SET status = 'CANCELLED', cancel_requested_at = now(), completed_at = now(),
            error = jsonb_build_object('code', $2::text, 'message', 'Cancelled by its caller.')
      WHERE id = $1 AND status = 'PENDING'`,
    [execution.id, EXECUTION_CANCELLED],
  );
  if (rowCount === 0) {
    // Claimed meanwhile, or never pending: what it is now decides.
    const current = (await context.executions.get(execution.id))!;
    if (current.status !== "RUNNING") {
      throw new TotalBaseError("EXECUTION_NOT_CANCELLABLE", `This execution is already ${current.status.toLowerCase()}.`);
    }
    if (!CANCELLABLE_WHILE_RUNNING.has(current.type)) {
      throw new TotalBaseError("EXECUTION_NOT_CANCELLABLE", "This execution is running and cannot be stopped from here.");
    }
    await context.database.query(
      `UPDATE totalbase.executions SET cancel_requested_at = coalesce(cancel_requested_at, now()) WHERE id = $1`,
      [execution.id],
    );
    await context.database.query(
      `SELECT pg_cancel_backend(pid) FROM pg_catalog.pg_stat_activity WHERE application_name = $1 AND datname = current_database()`,
      [executionApplicationName(execution.id)],
    );
  }
  return (await context.executions.get(execution.id))!;
}
