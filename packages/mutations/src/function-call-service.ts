import { getFunctionDetail, type FunctionDetail } from "@totalbase/pg-catalog";
import type { DatabaseTransactionContext } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { enqueueOutboxEvent } from "@totalbase/outbox";
import { compileFunctionCall } from "@totalbase/query-engine";
import { resolveFunctionCandidates, type ResolvedApiResource } from "@totalbase/resources";
import { redactSecretKeys } from "@totalbase/shared";
import { writeTransactionContext, type DataPrincipal, type MutationsContext } from "./context.js";
import { dispatchOutboxEventsEagerly } from "./mutation-service.js";

/**
 * FUNCTION EXECUTE (Data_API.md §7): the overload a call's
 * argument names select, the EXECUTE grant, and the call itself - one
 * transaction naming the acting user, with its audit row and outbox event,
 * then the eager dispatch. Shared by the Data API route, the asynchronous
 * executor (a queued call runs exactly as a direct one) and a workflow's
 * Execute function step; what differs between them - who calls, where the
 * call came from, what the audit row may record - comes in as arguments.
 */

/** The function a call names: what the route or the workflow step resolved it to. */
export type FunctionCallResource = Pick<ResolvedApiResource, "id" | "schema" | "name">;

/** Where a call came from, for its audit rows - the request, the asynchronous execution or the workflow step that runs it. */
export interface FunctionCallAudit {
  requestId: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
  source: string;
  /**
   * What the EXECUTED row records as the call's arguments. The Data API
   * passes them sanitized (credentials redacted, long strings truncated);
   * absent, the arguments as given.
   */
  payload?: unknown;
  /** Extra correlation on every row (a workflow's run and step). */
  metadata?: Record<string, unknown> | undefined;
}

/**
 * A call's argument names match one overload's parameter list when every
 * given name is a real parameter (PostgreSQL would reject an unknown
 * name) and every parameter without a DEFAULT is present.
 */
function matchesArgs(detail: FunctionDetail, argNames: string[]): boolean {
  const paramNames = new Set(detail.parameters.map((p) => p.name));
  for (const name of argNames) {
    if (!paramNames.has(name)) return false;
  }
  const givenNames = new Set(argNames);
  for (const parameter of detail.parameters) {
    if (!parameter.hasDefault && !givenNames.has(parameter.name)) return false;
  }
  return true;
}

/**
 * Resolves overloads by argument-name match, allowing DEFAULT parameters
 * to be omitted (Data_API.md §7: "Overloads supported. Ambiguity:
 * AMBIGUOUS_FUNCTION").
 */
async function resolveOverload(
  context: Pick<MutationsContext, "database">,
  candidates: ResolvedApiResource[],
  argNames: string[],
): Promise<{ resource: ResolvedApiResource; detail: FunctionDetail }> {
  const matches: { resource: ResolvedApiResource; detail: FunctionDetail }[] = [];

  for (const candidate of candidates) {
    const detail = await getFunctionDetail(context.database, candidate.postgresOid);
    if (matchesArgs(detail, argNames)) {
      matches.push({ resource: candidate, detail });
    }
  }

  if (matches.length === 0) {
    throw new TotalBaseError("FUNCTION_SIGNATURE_NOT_FOUND", "No matching function signature for the given arguments.");
  }
  if (matches.length > 1) {
    throw new TotalBaseError("AMBIGUOUS_FUNCTION", "More than one function signature matches the given arguments.");
  }
  return matches[0]!;
}

/** The function a call names and the overload its argument names select (Data_API.md §7). */
export async function resolveFunctionCall(
  context: Pick<MutationsContext, "database">,
  schema: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ resource: ResolvedApiResource; detail: FunctionDetail }> {
  const candidates = await resolveFunctionCandidates(context, schema, name);
  if (candidates.length === 0) {
    throw new TotalBaseError("RESOURCE_NOT_FOUND", `Resource not found: ${schema}.${name}`);
  }
  return resolveOverload(context, candidates, Object.keys(args));
}

/** EXECUTE on the resolved overload, or FUNCTION_EXECUTION_DENIED - recorded in the audit log either way it's refused. */
export async function authorizeFunctionCall(
  context: Pick<MutationsContext, "database" | "audit" | "effectivePermissions">,
  dataPrincipal: DataPrincipal,
  resource: FunctionCallResource,
  audit: FunctionCallAudit,
  startedAt: Date,
): Promise<void> {
  const permission = await context.effectivePermissions.resolve(dataPrincipal.roleIds, resource.id, "EXECUTE");
  if (permission.action === "ALLOW") return;
  try {
    await context.audit.record(context.database, {
      requestId: audit.requestId,
      principal: dataPrincipal.principal,
      resourceId: resource.id,
      action: "EXECUTE",
      status: "DENIED",
      source: audit.source,
      ip: audit.ip,
      userAgent: audit.userAgent,
      metadata: audit.metadata,
      startedAt,
      finishedAt: new Date(),
    });
  } catch {
    // best-effort; never mask the original error
  }
  throw new TotalBaseError("FUNCTION_EXECUTION_DENIED", "EXECUTE is not authorized for this function.");
}

/**
 * Runs an authorized function call: one transaction naming the acting
 * user, with its audit row and outbox event, then the eager dispatch.
 */
export async function executeFunctionCall(
  context: MutationsContext,
  dataPrincipal: DataPrincipal,
  resource: FunctionCallResource,
  detail: FunctionDetail,
  args: Record<string, unknown>,
  audit: FunctionCallAudit,
  startedAt: Date,
  cancellation?: Pick<DatabaseTransactionContext, "applicationName" | "beforeCommit">,
): Promise<unknown> {
  await authorizeFunctionCall(context, dataPrincipal, resource, audit, startedAt);
  const compiled = compileFunctionCall(resource.schema, resource.name, detail, args);

  try {
    // A function may write: its transaction names the acting user
    // (totalbase.actor_user_id), exactly like a table write's.
    const transactionResult = await context.database.transaction(async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(compiled.sql, compiled.params);
      const result = compiled.scalar ? (rows[0]?.["result"] ?? null) : rows;

      // resources_audit_fields only defines CREATE/UPDATE/DELETE
      // (Security.md §11.4); EXECUTE has no field-level restriction, so args/result are
      // recorded in full via payload rather than a filtered "changes" set.
      await context.audit.record(client, {
        requestId: audit.requestId,
        principal: dataPrincipal.principal,
        resourceId: resource.id,
        action: "EXECUTE",
        status: "EXECUTED",
        source: audit.source,
        ip: audit.ip,
        userAgent: audit.userAgent,
        payload: audit.payload !== undefined ? audit.payload : args,
        metadata: audit.metadata,
        startedAt,
        finishedAt: new Date(),
      });
      const outboxEventId = await enqueueOutboxEvent(client, {
        requestId: audit.requestId,
        resource: resource.id,
        event: "EXECUTE",
        // A password argument never reaches a webhook.
        payload: { data: redactSecretKeys(args), result },
        source: audit.source,
      });

      return { data: result, outboxEventId };
    }, { ...(await writeTransactionContext(context, dataPrincipal)), ...cancellation });
    // Eager dispatch (Data_API.md §13.3) - fire-and-forget, outside
    // the transaction, never awaited on the response path.
    dispatchOutboxEventsEagerly(context, [transactionResult.outboxEventId]);
    return transactionResult.data;
  } catch (error) {
    try {
      await context.audit.record(context.database, {
        requestId: audit.requestId,
        principal: dataPrincipal.principal,
        resourceId: resource.id,
        action: "EXECUTE",
        status: "FAILED",
        source: audit.source,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: audit.metadata,
        error:
          error instanceof TotalBaseError
            ? { code: error.code, sqlstate: error.sqlstate, message: error.message, detail: error.detail, hint: error.hint }
            : { message: error instanceof Error ? error.message : String(error) },
        startedAt,
        finishedAt: new Date(),
      });
    } catch {
      // best-effort; never mask the original error
    }
    throw error;
  }
}
