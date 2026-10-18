import { sanitizeForAudit } from "../access-audit.js";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { authorizeFunctionCall, executeFunctionCall, resolveFunctionCall, type FunctionCallAudit } from "@totalbase/mutations";
import { extractBearerToken } from "../auth-guards.js";
import { resolveDataPrincipal } from "../data-principal.js";
import { FUNCTION_CALL_EXECUTION_TYPE, queueAsyncCall, wantsAsync } from "../async-calls.js";
import { withIdempotency } from "../idempotency-helper.js";

/**
 * FUNCTION EXECUTE endpoint. See Specification_Data_API.md §7. The HTTP glue
 * only: the request's arguments and principal, the idempotency key, and
 * the async opt-in - overload resolution, the EXECUTE grant and the call's
 * transaction (audit + outbox) are @totalbase/mutations' (function-call-
 * service.ts), shared with the asynchronous executor and workflows.
 *
 * V1 scope: only simple IN-parameter functions are supported (see
 * @totalbase/pg-catalog's function-detail.ts); classification
 * (UNCLASSIFIED/QUERY/ACTION) is metadata for OpenAPI generation
 * (Phase 7) and does not gate execution here. `Prefer: respond-async`
 * queues the call instead (Specification_Data_API.md §10.4): checked
 * now, run by the executions worker, polled at /api/executions/{id}.
 */
export function registerDataFunctionRoutes(app: FastifyInstance, context: AppContext): void {
  app.post<{ Params: { schema: string; resource: string }; Body: { data?: Record<string, unknown> } }>(
    "/api/:schema/function/:resource",
    async (request, reply) => {
      const startedAt = new Date();
      const token = extractBearerToken(request);
      const dataPrincipal = await resolveDataPrincipal(context, token, request.headers["x-totalbase-timezone"], request);

      // The request body is { data: { argument: value } } - every Data API body carries its data in `data` (Specification_Data_API.md §2.4).
      const args = request.body?.data ?? {};
      const audit: FunctionCallAudit = {
        requestId: request.id,
        ip: request.ip,
        userAgent: request.headers["user-agent"],
        source: "api",
        payload: sanitizeForAudit(args), // a password argument never lands in the log (Pre_Beta_Review 1.9)
      };
      const { resource, detail } = await resolveFunctionCall(context, request.params.schema, request.params.resource, args);
      const async = wantsAsync(request.headers);

      // Opt-in per request, or required by the resolved overload's
      // resource (Specification_Data_API.md §9, §9.1). The scope names the
      // function, not the overload: the body (its arguments) is in the
      // request hash anyway. A queued call has a scope of its own, so a
      // retry replays the same 202 (the same execution), never a 200.
      const response = await withIdempotency(
        context,
        request.headers as Record<string, unknown>,
        dataPrincipal,
        `function:${resource.schema}.${resource.name}:${async ? "queue" : "execute"}`,
        "POST",
        request.body,
        async () => {
          if (async) {
            await authorizeFunctionCall(context, dataPrincipal, resource, audit, startedAt);
            return queueAsyncCall(context, dataPrincipal, FUNCTION_CALL_EXECUTION_TYPE, resource.id, {
              schema: resource.schema,
              function: resource.name,
              args,
            });
          }
          const data = await executeFunctionCall(context, dataPrincipal, resource, detail, args, audit, startedAt);
          return { status: 200, body: { data } };
        },
        resource.requireIdempotencyKey,
      );
      reply.code(response.status);
      return response.body;
    },
  );
}
