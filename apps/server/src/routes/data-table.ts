import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { extractBearerToken } from "../auth-guards.js";
import { resolveDataPrincipal } from "../data-principal.js";
import { resolveTableResource } from "@totalbase/resources";
import { readRowByKey, readRows } from "../data-read.js";
import { readOrigin } from "../read-audit.js";

/**
 * TABLE read endpoints. See Data_API.md §2.1; the read itself is data-read.ts.
 */
export function registerDataTableRoutes(app: FastifyInstance, context: AppContext): void {
  app.get<{ Params: { schema: string; resource: string } }>(
    "/api/:schema/table/:resource",
    async (request) => {
      const token = extractBearerToken(request);
      const dataPrincipal = await resolveDataPrincipal(context, token, request.headers["x-totalbase-timezone"], request);
      const resource = await resolveTableResource(context, request.params.schema, request.params.resource, "GET");
      return readRows(context, dataPrincipal, resource, request.query as Record<string, unknown>, readOrigin(request));
    },
  );

  app.get<{ Params: { schema: string; resource: string; pk: string } }>(
    "/api/:schema/table/:resource/:pk",
    async (request, reply) => {
      const token = extractBearerToken(request);
      const dataPrincipal = await resolveDataPrincipal(context, token, request.headers["x-totalbase-timezone"], request);
      const resource = await resolveTableResource(context, request.params.schema, request.params.resource, "GET");
      const { row, version } = await readRowByKey(context, dataPrincipal, resource, request.params.pk, readOrigin(request));
      if (version !== undefined) reply.header("etag", `"${version}"`);
      return { data: row, ...(version !== undefined && { meta: { version } }) };
    },
  );
}
