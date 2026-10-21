import type { FastifyInstance } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import { assertFilterComplexity, assertFilterFeatures, parseFilter, SchemaContext, type FilterNode, type OnConflictSpec } from "@totalbase/query-engine";
import type { AppContext } from "../context.js";
import { extractBearerToken } from "../auth-guards.js";
import { resolveDataPrincipal } from "../data-principal.js";
import { resolveTableResource } from "@totalbase/resources";
import { executeCreate, executeDelete, executeNestedCreate, executeUpdate, hasNestedRelations, rowFilterLimits as loadLimits } from "@totalbase/mutations";
import { loadQueryFeatures } from "../query-features.js";
import { withIdempotency } from "../idempotency-helper.js";

interface MutationBody {
  data?: unknown;
  on_conflict?: OnConflictSpec;
}

function isBulk(query: Record<string, unknown>): boolean {
  return query["bulk"] === "true" || query["bulk"] === true;
}

async function assertBulkSize(context: AppContext, count: number): Promise<void> {
  const max = await context.settings.get("api.bulk_max_items");
  if (count > max) {
    throw new TotalBaseError("INVALID_BULK_PAYLOAD", `Bulk request exceeds api.bulk_max_items (${max}).`);
  }
}

function singlePrimaryKeyField(root: { primaryKey: string[]; table: string }): string {
  if (root.primaryKey.length !== 1) {
    throw new TotalBaseError(
      "INVALID_QUERY",
      `${root.table} does not have a simple primary key; bulk operations require one.`,
    );
  }
  return root.primaryKey[0]!;
}

function pkEqualsFilter(pkField: string, value: unknown): FilterNode {
  return { type: "comparison", path: [pkField], operator: "_eq", value: String(value) };
}

/**
 * TABLE mutation endpoints (CREATE/UPDATE/DELETE). See
 * Data_API.md §5, §5.7.
 *
 * Bulk UPDATE/DELETE convention (not fully specified in the source
 * document - see AGENTS.md section 27): each item in a bulk `data` array
 * must carry the resource's primary key value, used to target that row;
 * for UPDATE, remaining fields in the item become the SET values.
 */
/**
 * If-Match: the version (ETag) the caller read - `"123"`, `W/"123"` or `123`; absent or `*`, no condition
 * (Data_API.md §5.3, T56).
 */
function ifMatchVersion(header: string | string[] | undefined): string | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (!value || value === "*") return undefined;
  const version = value.replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
  if (!/^\d+$/.test(version)) throw new TotalBaseError("INVALID_QUERY", "If-Match must be a version this API answered (meta.version / ETag).");
  return version;
}

export function registerDataTableMutationRoutes(app: FastifyInstance, context: AppContext): void {
  app.post<{ Params: { schema: string; resource: string }; Body: MutationBody }>(
    "/api/:schema/table/:resource",
    async (request, reply) => {
      const token = extractBearerToken(request);
      const dataPrincipal = await resolveDataPrincipal(context, token, request.headers["x-totalbase-timezone"], request);
      const resource = await resolveTableResource(context, request.params.schema, request.params.resource, "POST");
      const limits = await loadLimits(context);
      const schemaContext = new SchemaContext(context.database);
      const root = await schemaContext.loadRoot(resource.schema, resource.name, resource.postgresOid);

      const bulk = isBulk(request.query as Record<string, unknown>);
      const rawData = request.body?.data;

      const response = await withIdempotency(
        context,
        request.headers as Record<string, unknown>,
        dataPrincipal,
        `table:${resource.schema}.${resource.name}:create`,
        "POST",
        request.body,
        async () => {
          if (bulk) {
            if (!Array.isArray(rawData)) {
              throw new TotalBaseError("INVALID_BULK_PAYLOAD", "bulk=true requires data to be an array.");
            }
            if (rawData.some((item) => hasNestedRelations(item))) {
              throw new TotalBaseError(
                "UNSUPPORTED_NESTED_OPERATION",
                "Nested writes are not supported with bulk=true.",
              );
            }
          } else if (hasNestedRelations(rawData)) {
            if (request.body?.on_conflict !== undefined) {
              throw new TotalBaseError("UNSUPPORTED_NESTED_OPERATION", "on_conflict is not supported with nested writes.");
            }
            const nestedResult = await executeNestedCreate(
              {
                context,
                dataPrincipal,
                limits,
                audit: {
                  requestId: request.id,
                  ip: request.ip,
                  userAgent: request.headers["user-agent"],
                  source: "api",
                },
              },
              schemaContext,
              resource.id,
              root,
              rawData,
            );
            return { status: 201, body: { data: nestedResult } };
          }

          let items: Record<string, unknown>[];
          if (bulk) {
            await assertBulkSize(context, (rawData as unknown[]).length);
            items = rawData as Record<string, unknown>[];
          } else {
            if (typeof rawData !== "object" || rawData === null || Array.isArray(rawData)) {
              throw new TotalBaseError("INVALID_QUERY", "data must be an object.");
            }
            items = [rawData as Record<string, unknown>];
          }

          const results = await executeCreate(
            {
              context,
              dataPrincipal,
              resourceId: resource.id,
              root,
              limits,
              audit: { requestId: request.id, ip: request.ip, userAgent: request.headers["user-agent"], source: "api" },
            },
            items,
            request.body?.on_conflict,
          );

          return { status: 201, body: { data: bulk ? results : results[0] } };
        },
        resource.requireIdempotencyKey,
      );

      reply.code(response.status);
      return response.body;
    },
  );

  app.patch<{ Params: { schema: string; resource: string; pk: string }; Body: MutationBody }>(
    "/api/:schema/table/:resource/:pk",
    async (request, reply) => {
      const token = extractBearerToken(request);
      const dataPrincipal = await resolveDataPrincipal(context, token, request.headers["x-totalbase-timezone"], request);
      const resource = await resolveTableResource(context, request.params.schema, request.params.resource, "PATCH");
      const limits = await loadLimits(context);
      const schemaContext = new SchemaContext(context.database);
      const root = await schemaContext.loadRoot(resource.schema, resource.name, resource.postgresOid);
      const pkField = singlePrimaryKeyField(root);

      if (typeof request.body?.data !== "object" || request.body.data === null) {
        throw new TotalBaseError("INVALID_QUERY", "data must be an object.");
      }
      if (hasNestedRelations(request.body.data)) {
        // Nested UPDATE is deferred to a later version (Roadmap_v3.md §2.1).
        throw new TotalBaseError("UNSUPPORTED_NESTED_OPERATION", "Nested writes are not supported on UPDATE yet.");
      }

      const versions: string[] = [];
      const results = await executeUpdate(
        {
          context,
          dataPrincipal,
          resourceId: resource.id,
          root,
          limits,
          audit: { requestId: request.id, ip: request.ip, userAgent: request.headers["user-agent"], source: "api" },
        },
        [{ data: request.body.data as Record<string, unknown>, where: pkEqualsFilter(pkField, request.params.pk), version: ifMatchVersion(request.headers["if-match"]) }],
        true,
        versions,
      );
      // The row's new version - what the next If-Match sends back (Data_API.md §5.3).
      if (versions[0]) reply.header("etag", `"${versions[0]}"`);
      return { data: results[0], ...(versions[0] && { meta: { version: versions[0] } }) };
    },
  );

  app.patch<{ Params: { schema: string; resource: string }; Body: MutationBody }>(
    "/api/:schema/table/:resource",
    async (request) => {
      const token = extractBearerToken(request);
      const dataPrincipal = await resolveDataPrincipal(context, token, request.headers["x-totalbase-timezone"], request);
      const resource = await resolveTableResource(context, request.params.schema, request.params.resource, "PATCH");
      const limits = await loadLimits(context);
      const schemaContext = new SchemaContext(context.database);
      const root = await schemaContext.loadRoot(resource.schema, resource.name, resource.postgresOid);

      const query = request.query as Record<string, unknown>;
      const bulk = isBulk(query);
      const requireWhere = await context.settings.get("api.require_where_for_update");

      if (bulk) {
        if (!Array.isArray(request.body?.data)) {
          throw new TotalBaseError("INVALID_BULK_PAYLOAD", "bulk=true requires data to be an array.");
        }
        if (request.body.data.some((item) => hasNestedRelations(item))) {
          throw new TotalBaseError("UNSUPPORTED_NESTED_OPERATION", "Nested writes are not supported on UPDATE yet.");
        }
        await assertBulkSize(context, request.body.data.length);
        const pkField = singlePrimaryKeyField(root);
        const operations = (request.body.data as Record<string, unknown>[]).map((item) => {
          const { [pkField]: pkValue, ...rest } = item;
          if (pkValue === undefined) {
            throw new TotalBaseError("INVALID_BULK_PAYLOAD", `Each bulk item requires "${pkField}".`);
          }
          return { data: rest, where: pkEqualsFilter(pkField, pkValue) };
        });
        const results = await executeUpdate(
          {
          context,
          dataPrincipal,
          resourceId: resource.id,
          root,
          limits,
          audit: { requestId: request.id, ip: request.ip, userAgent: request.headers["user-agent"], source: "api" },
        },
          operations,
          true,
        );
        return { data: results };
      }

      const whereRaw = query["where"];
      if (whereRaw === undefined && requireWhere) {
        throw new TotalBaseError(
          "INVALID_QUERY",
          "where is required for collection UPDATE (api.require_where_for_update).",
        );
      }
      const where = whereRaw !== undefined ? parseFilter(whereRaw, limits, 0) : undefined;
      assertFilterComplexity(where, await context.settings.get("api.max_query_nodes"));
      assertFilterFeatures(where, await loadQueryFeatures(context));

      if (typeof request.body?.data !== "object" || request.body.data === null) {
        throw new TotalBaseError("INVALID_QUERY", "data must be an object.");
      }
      if (hasNestedRelations(request.body.data)) {
        throw new TotalBaseError("UNSUPPORTED_NESTED_OPERATION", "Nested writes are not supported on UPDATE yet.");
      }

      const results = await executeUpdate(
        {
          context,
          dataPrincipal,
          resourceId: resource.id,
          root,
          limits,
          audit: { requestId: request.id, ip: request.ip, userAgent: request.headers["user-agent"], source: "api" },
        },
        [{ data: request.body.data as Record<string, unknown>, where }],
        false,
      );
      return { data: results };
    },
  );

  app.delete<{ Params: { schema: string; resource: string; pk: string } }>(
    "/api/:schema/table/:resource/:pk",
    async (request) => {
      const token = extractBearerToken(request);
      const dataPrincipal = await resolveDataPrincipal(context, token, request.headers["x-totalbase-timezone"], request);
      const resource = await resolveTableResource(context, request.params.schema, request.params.resource, "DELETE");
      const limits = await loadLimits(context);
      const schemaContext = new SchemaContext(context.database);
      const root = await schemaContext.loadRoot(resource.schema, resource.name, resource.postgresOid);
      const pkField = singlePrimaryKeyField(root);

      const results = await executeDelete(
        {
          context,
          dataPrincipal,
          resourceId: resource.id,
          root,
          limits,
          audit: { requestId: request.id, ip: request.ip, userAgent: request.headers["user-agent"], source: "api" },
        },
        [{ where: pkEqualsFilter(pkField, request.params.pk), version: ifMatchVersion(request.headers["if-match"]) }],
        true,
      );
      return { data: results[0] };
    },
  );

  app.delete<{ Params: { schema: string; resource: string }; Body: MutationBody }>(
    "/api/:schema/table/:resource",
    async (request) => {
      const token = extractBearerToken(request);
      const dataPrincipal = await resolveDataPrincipal(context, token, request.headers["x-totalbase-timezone"], request);
      const resource = await resolveTableResource(context, request.params.schema, request.params.resource, "DELETE");
      const limits = await loadLimits(context);
      const schemaContext = new SchemaContext(context.database);
      const root = await schemaContext.loadRoot(resource.schema, resource.name, resource.postgresOid);

      const query = request.query as Record<string, unknown>;
      const bulk = isBulk(query);
      const requireWhere = await context.settings.get("api.require_where_for_delete");

      if (bulk) {
        if (!Array.isArray(request.body?.data)) {
          throw new TotalBaseError("INVALID_BULK_PAYLOAD", "bulk=true requires data to be an array.");
        }
        await assertBulkSize(context, request.body.data.length);
        const pkField = singlePrimaryKeyField(root);
        const operations = (request.body.data as Record<string, unknown>[]).map((item) => {
          const pkValue = item[pkField];
          if (pkValue === undefined) {
            throw new TotalBaseError("INVALID_BULK_PAYLOAD", `Each bulk item requires "${pkField}".`);
          }
          return { where: pkEqualsFilter(pkField, pkValue) };
        });
        const results = await executeDelete(
          {
          context,
          dataPrincipal,
          resourceId: resource.id,
          root,
          limits,
          audit: { requestId: request.id, ip: request.ip, userAgent: request.headers["user-agent"], source: "api" },
        },
          operations,
          true,
        );
        return { data: results };
      }

      const whereRaw = query["where"];
      if (whereRaw === undefined && requireWhere) {
        throw new TotalBaseError(
          "INVALID_QUERY",
          "where is required for collection DELETE (api.require_where_for_delete).",
        );
      }
      const where = whereRaw !== undefined ? parseFilter(whereRaw, limits, 0) : undefined;
      assertFilterComplexity(where, await context.settings.get("api.max_query_nodes"));
      assertFilterFeatures(where, await loadQueryFeatures(context));

      const results = await executeDelete(
        {
          context,
          dataPrincipal,
          resourceId: resource.id,
          root,
          limits,
          audit: { requestId: request.id, ip: request.ip, userAgent: request.headers["user-agent"], source: "api" },
        },
        [{ where }],
        false,
      );
      return { data: results };
    },
  );
}
