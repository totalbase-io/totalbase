import type { FastifyInstance } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import { buildGraphQLSchema, executeGraphQL, operationTypeOf, type GraphQLDataExecutor, type GraphQLLimits, type GraphQLResourceRef, type GraphQLSchema } from "@totalbase/graphql";
import { executeFunctionCall, resolveFunctionCall } from "@totalbase/mutations";
import { resolveTableResource, resolveViewResource } from "@totalbase/resources";
import { sanitizeForAudit } from "../access-audit.js";
import type { AppContext } from "../context.js";
import { extractBearerToken } from "../auth-guards.js";
import { resolveDataPrincipal, type DataPrincipal } from "../data-principal.js";
import { readRows } from "../data-read.js";
import { createRows, deleteRowByKey, deleteRows, updateRowByKey, updateRows } from "../data-write.js";
import { withIdempotency } from "../idempotency-helper.js";
import { readOrigin, type ReadOrigin } from "../read-audit.js";
import type { RealtimeHub } from "../realtime.js";
import { registerGraphQLWebSocket } from "./graphql-ws.js";
import { dataApiFieldGuard } from "./openapi.js";

/**
 * Each root field as the REST call it stands for (Data_API.md §17.4-§17.6): the resource resolved as
 * its route resolves it (status, exposed verb), then data-read.ts, data-write.ts or the function call with this
 * request's principal and origin - the same permissions, limits, audit rows and errors.
 */
export function executorFor(
  context: AppContext,
  dataPrincipal: DataPrincipal,
  origin: () => ReadOrigin,
  options: { idempotencyKey: boolean },
): GraphQLDataExecutor {
  const writeOrigin = () => ({ ...origin(), source: "api" });
  // A resource that requires an Idempotency-Key (Data_API.md §9.1) refuses a create or a call without one, as
  // its REST route does - while idempotency.enabled is on.
  const assertKey = async (resource: { requireIdempotencyKey: boolean }) => {
    if (resource.requireIdempotencyKey && !options.idempotencyKey && (await context.settings.get("idempotency.enabled"))) {
      throw new TotalBaseError("IDEMPOTENCY_KEY_REQUIRED", "This operation requires an Idempotency-Key header.");
    }
  };
  const resolve = (ref: GraphQLResourceRef, method: "GET" | "POST" | "PATCH" | "DELETE") =>
    ref.type === "VIEW" ? resolveViewResource(context, ref.schema, ref.name) : resolveTableResource(context, ref.schema, ref.name, method);
  return {
    readRows: async (ref, rawQuery, readOptions) => readRows(context, dataPrincipal, await resolve(ref, "GET"), rawQuery, origin(), readOptions),
    createRows: async (ref, input) => {
      const resource = await resolve(ref, "POST");
      await assertKey(resource);
      return createRows(context, dataPrincipal, resource, input, writeOrigin());
    },
    updateRowByKey: async (ref, pk, data, version) => updateRowByKey(context, dataPrincipal, await resolve(ref, "PATCH"), pk, data, version, writeOrigin()),
    updateRows: async (ref, input) =>
      updateRows(context, dataPrincipal, await resolve(ref, "PATCH"), { ...input, bulk: false }, writeOrigin()),
    deleteRowByKey: async (ref, pk, version) => deleteRowByKey(context, dataPrincipal, await resolve(ref, "DELETE"), pk, version, writeOrigin()),
    deleteRows: async (ref, input) =>
      deleteRows(context, dataPrincipal, await resolve(ref, "DELETE"), { ...input, data: undefined, bulk: false }, writeOrigin()),
    // As POST /api/{schema}/function/{name} runs it (routes/data-function.ts), synchronously.
    callFunction: async (schema, name, args) => {
      const startedAt = new Date();
      const { resource, detail } = await resolveFunctionCall(context, schema, name, args);
      await assertKey(resource);
      return executeFunctionCall(context, dataPrincipal, resource, detail, args, { ...writeOrigin(), payload: sanitizeForAudit(args) }, startedAt);
    },
  };
}

/**
 * The caller's schema and the request limits (Data_API.md §17.3): built per principal type and role
 * set from what they may do, cached with the OpenAPI documents and their invalidation (Data_API.md §14.2) -
 * and with what shapes it: the default schema, whether realtime is on.
 */
export async function graphqlSchemaFor(context: AppContext, dataPrincipal: DataPrincipal): Promise<{ schema: GraphQLSchema; limits: GraphQLLimits }> {
  const { roleIds } = dataPrincipal;
  const principalType = dataPrincipal.principal.type === "API_KEY" ? "API_KEY" : "USER";
  const [maxCalls, maxDepth, maxRelationDepth, defaultSchema, maxLimit, subscriptions] = await Promise.all([
    context.settings.get("graphql.max_calls"),
    context.settings.get("graphql.max_depth"),
    context.settings.get("api.max_relation_depth"),
    context.settings.get("graphql.default_schema"),
    context.settings.get("api.max_limit"),
    context.settings.get("realtime.enabled"),
  ]);
  const key = `graphql:${defaultSchema}:${subscriptions}:${principalType}:${[...roleIds].sort().join(",")}`;
  const schema = await context.openApiCache.get(key, async () =>
    buildGraphQLSchema(context.database, context.effectivePermissions, roleIds, {
      guardFieldDecision: await dataApiFieldGuard(context, roleIds),
      maxRelationDepth,
      defaultSchema,
      maxLimit,
      subscriptions,
    }),
  );
  return { schema, limits: { maxCalls, maxDepth } };
}

/**
 * The GraphQL API (Data_API.md §17): POST /api/graphql with a Data API bearer
 * token, GraphQL-over-HTTP's own body and response. The schema is the caller's - built per principal type and
 * role set from what they may do, cached with the OpenAPI documents and their invalidation (Data_API.md §14.2).
 */
export function registerGraphQLRoutes(app: FastifyInstance, context: AppContext, hub: RealtimeHub): void {
  registerGraphQLWebSocket(app, context, hub);
  app.post(
    "/api/graphql",
    {
      config: {
        openapi: {
          summary: "Run a GraphQL request",
          description:
            "GraphQL-over-HTTP: `{ query, variables, operationName }` in, `{ data, errors }` out. The schema lists what your " +
            "roles allow; each root field runs as the REST call it stands for, with the same permissions, limits and audit.",
          tags: ["graphql"],
          access: "principal",
          requestBody: {
            schema: {
              type: "object",
              required: ["query"],
              properties: {
                query: { type: "string" },
                variables: { type: "object", additionalProperties: true },
                operationName: { type: "string" },
              },
            },
          },
          response: {
            status: "200",
            schema: {
              type: "object",
              properties: { data: { type: ["object", "null"], additionalProperties: true }, errors: { type: "array", items: { type: "object" } } },
            },
          },
          visible: async () => context.settings.get("graphql.enabled"),
        },
      },
    },
    async (request, reply) => {
      if ((await context.settings.get("graphql.enabled")) !== true) {
        throw new TotalBaseError("RESOURCE_NOT_FOUND", "GraphQL is off on this instance - an administrator turns it on in Settings > GraphQL.");
      }
      const dataPrincipal = await resolveDataPrincipal(context, extractBearerToken(request), request.headers["x-totalbase-timezone"], request);
      const { schema, limits } = await graphqlSchemaFor(context, dataPrincipal);
      // A mutation takes an Idempotency-Key as a REST write does (Data_API.md §9): the whole response is
      // recorded - every root field's result and error - and a retry with the same document and variables
      // replays it, running nothing.
      const hasKey = typeof request.headers["idempotency-key"] === "string" && request.headers["idempotency-key"] !== "";
      const isMutation = operationTypeOf(request.body) === "mutation";
      const run = () => executeGraphQL(
        schema,
        request.body,
        { executor: executorFor(context, dataPrincipal, () => readOrigin(request), { idempotencyKey: hasKey && isMutation }) },
        limits,
        (error) => request.log.error(error),
      );
      const response = isMutation
        ? await withIdempotency(context, request.headers as Record<string, unknown>, dataPrincipal, "graphql:mutation", "POST", request.body, run)
        : await run();
      reply.code(response.status);
      return response.body;
    },
  );
}
