import type { FastifyInstance } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import type { OnConflictSpec } from "@totalbase/query-engine";
import type { AppContext } from "../context.js";
import { extractBearerToken } from "../auth-guards.js";
import { resolveDataPrincipal } from "../data-principal.js";
import { resolveTableResource } from "@totalbase/resources";
import { createRows, deleteRowByKey, deleteRows, updateRowByKey, updateRows, writeOrigin } from "../data-write.js";
import { withIdempotency } from "../idempotency-helper.js";

interface MutationBody {
  data?: unknown;
  on_conflict?: OnConflictSpec;
}

function isBulk(query: Record<string, unknown>): boolean {
  return query["bulk"] === "true" || query["bulk"] === true;
}

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

/**
 * TABLE mutation endpoints (CREATE/UPDATE/DELETE). See Data_API.md §5, §5.7;
 * the write itself is data-write.ts - here only HTTP's part: the principal,
 * the resource, the Idempotency-Key, If-Match and the ETag.
 */
export function registerDataTableMutationRoutes(app: FastifyInstance, context: AppContext): void {
  app.post<{ Params: { schema: string; resource: string }; Body: MutationBody }>(
    "/api/:schema/table/:resource",
    async (request, reply) => {
      const token = extractBearerToken(request);
      const dataPrincipal = await resolveDataPrincipal(context, token, request.headers["x-totalbase-timezone"], request);
      const resource = await resolveTableResource(context, request.params.schema, request.params.resource, "POST");

      const response = await withIdempotency(
        context,
        request.headers as Record<string, unknown>,
        dataPrincipal,
        `table:${resource.schema}.${resource.name}:create`,
        "POST",
        request.body,
        async () => {
          const data = await createRows(
            context,
            dataPrincipal,
            resource,
            { data: request.body?.data, bulk: isBulk(request.query as Record<string, unknown>), onConflict: request.body?.on_conflict },
            writeOrigin(request),
          );
          return { status: 201, body: { data } };
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
      const { row, version } = await updateRowByKey(
        context,
        dataPrincipal,
        resource,
        request.params.pk,
        request.body?.data,
        ifMatchVersion(request.headers["if-match"]),
        writeOrigin(request),
      );
      // The row's new version - what the next If-Match sends back (Data_API.md §5.3).
      if (version) reply.header("etag", `"${version}"`);
      return { data: row, ...(version && { meta: { version } }) };
    },
  );

  app.patch<{ Params: { schema: string; resource: string }; Body: MutationBody }>(
    "/api/:schema/table/:resource",
    async (request) => {
      const token = extractBearerToken(request);
      const dataPrincipal = await resolveDataPrincipal(context, token, request.headers["x-totalbase-timezone"], request);
      const resource = await resolveTableResource(context, request.params.schema, request.params.resource, "PATCH");
      const query = request.query as Record<string, unknown>;
      const data = await updateRows(
        context,
        dataPrincipal,
        resource,
        { data: request.body?.data, bulk: isBulk(query), where: query["where"] },
        writeOrigin(request),
      );
      return { data };
    },
  );

  app.delete<{ Params: { schema: string; resource: string; pk: string } }>(
    "/api/:schema/table/:resource/:pk",
    async (request) => {
      const token = extractBearerToken(request);
      const dataPrincipal = await resolveDataPrincipal(context, token, request.headers["x-totalbase-timezone"], request);
      const resource = await resolveTableResource(context, request.params.schema, request.params.resource, "DELETE");
      const data = await deleteRowByKey(
        context,
        dataPrincipal,
        resource,
        request.params.pk,
        ifMatchVersion(request.headers["if-match"]),
        writeOrigin(request),
      );
      return { data };
    },
  );

  app.delete<{ Params: { schema: string; resource: string }; Body: MutationBody }>(
    "/api/:schema/table/:resource",
    async (request) => {
      const token = extractBearerToken(request);
      const dataPrincipal = await resolveDataPrincipal(context, token, request.headers["x-totalbase-timezone"], request);
      const resource = await resolveTableResource(context, request.params.schema, request.params.resource, "DELETE");
      const query = request.query as Record<string, unknown>;
      const data = await deleteRows(
        context,
        dataPrincipal,
        resource,
        { data: request.body?.data, bulk: isBulk(query), where: query["where"] },
        writeOrigin(request),
      );
      return { data };
    },
  );
}
