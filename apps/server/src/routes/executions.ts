import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ExecutionRecord } from "@totalbase/executions";
import { TotalBaseError } from "@totalbase/errors";
import type { AppContext } from "../context.js";
import { dataEnvelope } from "@totalbase/openapi";
import { extractBearerToken } from "../auth-guards.js";
import { resolveDataPrincipal } from "../data-principal.js";
import { cancelExecution } from "../async-calls.js";

/**
 * Execution status and cancel endpoints (Specification_Data_API.md §10.3, §10.5).
 * Only the principal that created an execution may query it - no
 * unrestricted list endpoint (Specification_Data_API.md §10.3); administrators get broader
 * visibility through the Admin UI/API instead, not this route.
 */
const EXECUTION_SCHEMA = dataEnvelope({
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    status: {
      type: "string",
      enum: ["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"],
      description: "`COMPLETED` carries `result`, `FAILED` and `CANCELLED` carry `error`; both are null otherwise.",
    },
    result: {},
    error: {},
  },
});

/** One shape whatever the status (Specification_Data_API.md §2.5). */
function executionBody(execution: ExecutionRecord) {
  return {
    data: {
      id: execution.id,
      status: execution.status,
      result: execution.status === "COMPLETED" ? execution.result ?? null : null,
      error: execution.status === "FAILED" || execution.status === "CANCELLED" ? execution.error ?? null : null,
    },
  };
}

/** The execution, if this caller started it - anyone else gets the same 404 as a missing one. */
async function ownExecution(context: AppContext, request: FastifyRequest<{ Params: { id: string } }>): Promise<ExecutionRecord> {
  const token = extractBearerToken(request);
  const dataPrincipal = await resolveDataPrincipal(context, token, undefined, request);
  const execution = await context.executions.get(request.params.id);
  const { type, id } = dataPrincipal.principal;
  if (!execution || (type !== "USER" && type !== "API_KEY") || id === null || !context.executions.belongsTo(execution, type, id)) {
    // Ownership must not be observable by an unauthorized caller.
    throw new TotalBaseError("EXECUTION_NOT_FOUND", `Execution not found: ${request.params.id}`);
  }
  return execution;
}

export function registerExecutionRoutes(app: FastifyInstance, context: AppContext): void {
  app.get<{ Params: { id: string } }>("/api/executions/:id", {
    config: {
      openapi: {
        summary: "Status of an asynchronous execution you started",
        description: "Only the principal that started the execution can see it; anyone else gets 404.",
        tags: ["executions"],
        access: "principal",
        pathParameters: { id: { schema: { type: "string", format: "uuid" } } },
        response: { status: "200", schema: EXECUTION_SCHEMA },
      },
    },
  }, async (request) => executionBody(await ownExecution(context, request)));

  app.post<{ Params: { id: string } }>("/api/executions/:id/cancel", {
    config: {
      openapi: {
        summary: "Cancel an asynchronous execution you started",
        description:
          "A queued execution never starts (CANCELLED at once). A running function call or transaction is stopped and " +
          "rolled back whole - CANCELLED, or COMPLETED if it committed first: poll its status. Anything else running, " +
          "or already finished, is 409 EXECUTION_NOT_CANCELLABLE.",
        tags: ["executions"],
        access: "principal",
        pathParameters: { id: { schema: { type: "string", format: "uuid" } } },
        response: { status: "200", schema: EXECUTION_SCHEMA },
      },
    },
  }, async (request) => executionBody(await cancelExecution(context, await ownExecution(context, request))));
}
