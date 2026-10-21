import { commonDocumentParts, ensureUniqueOperationIds, errorResponses, operationId, WRITE_ERROR_STATUSES } from "./common-components.js";
import type { JsonSchema, OpenApiDocument, OpenApiDocumentOptions, OperationObject, ParameterObject, PathItem } from "./openapi-types.js";
import { buildRouteOperation, type RouteDoc } from "./route-docs.js";

export interface RouteInfo {
  method: string;
  url: string;
  /** Reachable without a bearer token (e.g. the login route) - declared by the route itself, see apps/server's onRoute hook. */
  public?: boolean;
  /** The route's own `config.openapi`, when it declares one - request/response shapes instead of method + path only. */
  doc?: RouteDoc;
}

const OPENAPI_METHODS = new Set(["get", "post", "patch", "delete", "put"]);

const ROUTE_PARAM = /:([A-Za-z0-9_]+)/g;

/** Fastify's `:param` route syntax -> OpenAPI's `{param}` syntax. */
function toOpenApiPath(fastifyUrl: string): string {
  return fastifyUrl.replace(ROUTE_PARAM, "{$1}");
}

/** OpenAPI requires every `{param}` in a path to be declared as a required path parameter. */
function pathParameters(fastifyUrl: string): ParameterObject[] {
  return [...fastifyUrl.matchAll(ROUTE_PARAM)].map(([, name]) => ({ name: name!, in: "path", required: true, schema: { type: "string" } }));
}

/**
 * Builds the admin Control Plane OpenAPI document directly from Fastify's
 * registered route table (collected via an `onRoute` hook in
 * apps/server), so it can never drift from what's actually mounted
 * (Data_API.md §14.3: "dynamic generation").
 *
 * A route that declares `config.openapi` (a RouteDoc, same as the Data
 * API's fixed routes) gets its request/response shapes; any other route
 * is documented by method + path only, rather than guessed (AGENTS.md
 * section 27).
 */
export function buildAdminOpenApiSpec(routes: RouteInfo[], options: OpenApiDocumentOptions): OpenApiDocument {
  const paths: Record<string, PathItem> = {};
  const schemas: Record<string, JsonSchema> = {};

  for (const route of routes) {
    const method = route.method.toLowerCase();
    if (!OPENAPI_METHODS.has(method)) continue;
    if (route.doc) {
      const built = buildRouteOperation({ method: route.method, url: route.url, doc: route.doc });
      (paths[built.path] ??= {})[built.method] = built.operation;
      Object.assign(schemas, route.doc.schemas);
      continue;
    }
    const path = toOpenApiPath(route.url);
    const pathItem = (paths[path] ??= {});
    const parameters = pathParameters(route.url);
    const operation: OperationObject = {
      // "GET /admin/api/users/:id" -> "get_users_id"
      operationId: operationId(method, ...route.url.replace(/^\/admin\/api\//, "").replace(/:/g, "").split("/")),
      summary: `${route.method} ${route.url}`,
      tags: ["admin"],
      ...(parameters.length > 0 ? { parameters } : {}),
      responses: {
        ...errorResponses(method === "get" ? [] : WRITE_ERROR_STATUSES),
        "200": { description: "OK" },
      },
      ...(route.public ? { security: [] } : {}),
    };
    (pathItem as Record<string, OperationObject>)[method] = operation;
  }

  ensureUniqueOperationIds(paths);
  const common = commonDocumentParts(options);
  return {
    openapi: "3.1.0",
    info: {
      title: "TotalBase Admin API",
      version: "1.0.0",
      description:
        "Control Plane administration endpoints, generated from the live Fastify route table. Never manually edited.",
    },
    servers: common.servers,
    security: common.security,
    paths,
    components: { ...common.components, schemas: { ...common.components.schemas, ...schemas } },
  };
}
