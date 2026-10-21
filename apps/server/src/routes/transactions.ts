import type { FastifyInstance } from "fastify";
import { dataEnvelope, IDEMPOTENCY_KEY_HEADER, PREFER_RESPOND_ASYNC_HEADER } from "@totalbase/openapi";
import type { AppContext } from "../context.js";
import { extractBearerToken } from "../auth-guards.js";
import { resolveDataPrincipal } from "../data-principal.js";
import { withIdempotency } from "../idempotency-helper.js";
import { checkTransactionRequest, executeTransaction, type TransactionRequest } from "@totalbase/mutations";
import { queueAsyncCall, TRANSACTION_EXECUTION_TYPE, wantsAsync } from "../async-calls.js";

/**
 * Transactions (Data_API.md §8): combines
 * independent CREATE/UPDATE/DELETE operations, possibly across different
 * resources, into one atomic PostgreSQL transaction. Not exposed through
 * the schema/resource convention (Data_API.md §8).
 */
export function registerTransactionRoutes(app: FastifyInstance, context: AppContext): void {
  app.post<{ Body: TransactionRequest }>("/api/transactions", {
    config: {
      openapi: {
        summary: "Run several writes in one atomic transaction",
        description:
          "Operations run in order; any failure rolls back all of them. A later operation may reference an earlier " +
          "one's result as `$<key>.<field>` (only fields the caller can READ). Each operation is authorized like the " +
          "matching table route. `Prefer: respond-async` queues it instead: 202 with an execution to poll at GET /api/executions/{id}.",
        tags: ["transactions"],
        access: "principal",
        parameters: [IDEMPOTENCY_KEY_HEADER, PREFER_RESPOND_ASYNC_HEADER],
        requestBody: {
          schema: {
            type: "object",
            required: ["operations"],
            properties: {
              operations: {
                type: "array",
                minItems: 1,
                description: "At most transactions.max_operations.",
                items: {
                  type: "object",
                  required: ["key", "operation", "schema", "table"],
                  properties: {
                    key: { type: "string", description: "Unique within the request; names this operation's result." },
                    operation: { type: "string", enum: ["insert", "update", "delete"] },
                    schema: { type: "string" },
                    table: { type: "string" },
                    id: { description: "Primary key value (update/delete)." },
                    data: { type: "object", additionalProperties: true, description: "Row values (insert/update)." },
                  },
                },
              },
            },
          },
        },
        response: {
          status: "200",
          schema: dataEnvelope({ type: "object", additionalProperties: { type: "object", additionalProperties: true }, description: "Each operation's resulting row, by key." }),
        },
        // Only for principals holding the transactions grant, while the feature is on.
        visible: async (viewer) =>
          (await context.settings.get("transactions.enabled")) && (await context.capabilityPermissions.resolve(viewer.roleIds, "TRANSACTIONS")) === "ALLOW",
      },
    },
  }, async (request, reply) => {
    const token = extractBearerToken(request);
    const dataPrincipal = await resolveDataPrincipal(context, token, request.headers["x-totalbase-timezone"], request);
    const [maxFilterDepth, maxRelationDepth] = await Promise.all([
      context.settings.get("api.max_filter_depth"),
      context.settings.get("api.max_relation_depth"),
    ]);
    const limits = { maxFilterDepth, maxRelationDepth };
    // `Prefer: respond-async` (Data_API.md §10.4): checked now, run by the executions worker.
    const async = wantsAsync(request.headers);

    const response = await withIdempotency(
      context,
      request.headers as Record<string, unknown>,
      dataPrincipal,
      async ? "transactions:queue" : "transactions:execute",
      "POST",
      request.body,
      async () => {
        if (async) {
          await checkTransactionRequest({ context, dataPrincipal }, request.body);
          return queueAsyncCall(context, dataPrincipal, TRANSACTION_EXECUTION_TYPE, undefined, { operations: request.body.operations });
        }
        const results = await executeTransaction(
          {
            context,
            dataPrincipal,
            limits,
            audit: { requestId: request.id, ip: request.ip, userAgent: request.headers["user-agent"], source: "api" },
          },
          request.body,
        );
        return { status: 200, body: { data: results } };
      },
    );

    reply.code(response.status);
    return response.body;
  });
}
