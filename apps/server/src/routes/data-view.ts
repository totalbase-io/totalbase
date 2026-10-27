import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { extractBearerToken } from "../auth-guards.js";
import { resolveDataPrincipal } from "../data-principal.js";
import { resolveViewResource } from "@totalbase/resources";
import { readRows } from "../data-read.js";
import { readOrigin } from "../read-audit.js";


/**
 * VIEW read endpoint. VIEW is READ-only in V1 (Foundations.md §11.5); reuses
 * the same read path as TABLE reads (Data_API.md §2.1, data-read.ts).
 */
export function registerDataViewRoutes(app: FastifyInstance, context: AppContext): void {
  app.get<{ Params: { schema: string; resource: string } }>(
    "/api/:schema/view/:resource",
    async (request) => {
      const token = extractBearerToken(request);
      const dataPrincipal = await resolveDataPrincipal(context, token, request.headers["x-totalbase-timezone"], request);
      const resource = await resolveViewResource(context, request.params.schema, request.params.resource);
      return readRows(context, dataPrincipal, resource, request.query as Record<string, unknown>, readOrigin(request));
    },
  );
}
