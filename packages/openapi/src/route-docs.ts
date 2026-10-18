import { errorResponses, operationId, WRITE_ERROR_STATUSES, type ErrorStatus } from "./common-components.js";
import type { JsonSchema, OperationObject, ParameterObject, PathItem } from "./openapi-types.js";

/** Who is asking for the document - the same principal the Data API would resolve from the token. */
export interface OpenApiViewer {
  roleIds: string[];
  /** Session-only routes (`access: "session"`) don't exist for an API key. */
  principalType: "USER" | "API_KEY";
}

/**
 * - `public`: no credentials (login, password reset, ...) - `security: []`;
 * - `session`: a user session token only (requireUser - an API key is rejected);
 * - `principal`: any Data API bearer token, session or API key.
 */
export type RouteAccess = "public" | "session" | "principal";

/**
 * OpenAPI documentation for one fixed (non-catalog) route, declared next to
 * the route itself as Fastify `config.openapi` - so the document can't drift
 * from what's mounted, and no second endpoint-definition system exists
 * (AGENTS.md section 18). Documentation only: unlike a Fastify `schema`, it
 * never validates requests or reshapes responses.
 */
export interface RouteDoc {
  summary: string;
  description?: string;
  tags: string[];
  access: RouteAccess;
  /** Query and header parameters; path parameters come from the URL itself. */
  parameters?: ParameterObject[];
  /** Path parameter descriptions/schemas, by name - undeclared ones default to a plain string. */
  pathParameters?: Record<string, { description?: string; schema?: JsonSchema }>;
  requestBody?: { schema: JsonSchema; contentType?: string; required?: boolean };
  response: { status: "200" | "201" | "202" | "204" | "302"; description?: string; schema?: JsonSchema; contentType?: string };
  /** Error statuses beyond the base set; writes get 409/422/413 automatically. */
  errors?: ErrorStatus[];
  /** Component schemas this route's `$ref`s point at (merged into the document). */
  schemas?: Record<string, JsonSchema>;
  /** Extra, permission-based visibility (e.g. a grant the route checks) - reuses the same services the route itself does. */
  visible?: (viewer: OpenApiViewer) => boolean | Promise<boolean>;
}

export interface DocumentedRoute {
  method: string;
  url: string;
  doc: RouteDoc;
}

const ROUTE_PARAM = /:([A-Za-z0-9_]+)/g;
const WRITE_METHODS = new Set(["post", "patch", "put", "delete"]);

/** `{ data: <schema> }` - the envelope every JSON route answers with. */
export function dataEnvelope(schema: JsonSchema): JsonSchema {
  return { type: "object", required: ["data"], properties: { data: schema } };
}

/** Whether `viewer` gets this route in its document at all. */
export async function isRouteVisible(doc: RouteDoc, viewer: OpenApiViewer): Promise<boolean> {
  if (doc.access === "session" && viewer.principalType !== "USER") return false;
  return doc.visible ? await doc.visible(viewer) : true;
}

/** One route -> its OpenAPI path and operation. */
export function buildRouteOperation(route: DocumentedRoute): { path: string; method: keyof PathItem; operation: OperationObject } {
  const method = route.method.toLowerCase() as keyof PathItem;
  const { doc } = route;
  const path = route.url.replace(ROUTE_PARAM, "{$1}");
  const parameters: ParameterObject[] = [
    ...[...route.url.matchAll(ROUTE_PARAM)].map(([, name]) => ({
      name: name!,
      in: "path" as const,
      required: true,
      schema: doc.pathParameters?.[name!]?.schema ?? { type: "string" },
      ...(doc.pathParameters?.[name!]?.description ? { description: doc.pathParameters[name!]!.description } : {}),
    })),
    ...(doc.parameters ?? []),
  ];

  const { status, schema, contentType = "application/json", description } = doc.response;
  const success = {
    description: description ?? (status === "201" ? "Created" : status === "202" ? "Accepted" : status === "204" ? "No Content" : status === "302" ? "Redirect" : "OK"),
    ...(schema ? { content: { [contentType]: { schema } } } : {}),
  };
  const writeErrors: ErrorStatus[] = WRITE_METHODS.has(method) ? [...WRITE_ERROR_STATUSES, ...(doc.requestBody ? ["413" as const] : [])] : [];

  const operation: OperationObject = {
    // "/api/tokens/:id" -> post_tokens_id; "/admin/api/users/:id" -> get_users_id (each document has one prefix).
    operationId: operationId(method, ...route.url.replace(/^\/(admin\/)?api\//, "").replace(/:/g, "").split("/")),
    summary: doc.summary,
    ...(doc.description ? { description: doc.description } : {}),
    tags: doc.tags,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(doc.requestBody
      ? { requestBody: { required: doc.requestBody.required ?? true, content: { [doc.requestBody.contentType ?? "application/json"]: { schema: doc.requestBody.schema } } } }
      : {}),
    responses: { ...errorResponses([...writeErrors, ...(doc.errors ?? [])]), [status]: success },
    ...(doc.access === "public" ? { security: [] } : {}),
  };
  return { path, method, operation };
}

/** Adds every route `viewer` may see to `paths`/`schemas`. */
export async function addDocumentedRoutes(
  routes: DocumentedRoute[],
  viewer: OpenApiViewer,
  paths: Record<string, PathItem>,
  schemas: Record<string, JsonSchema>,
): Promise<void> {
  for (const route of routes) {
    if (!(await isRouteVisible(route.doc, viewer))) continue;
    const { path, method, operation } = buildRouteOperation(route);
    (paths[path] ??= {})[method] = operation;
    Object.assign(schemas, route.doc.schemas);
  }
}
