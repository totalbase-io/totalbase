import type { OpenApiDocument, OpenApiDocumentOptions, ParameterObject, PathItem, ReferenceObject, ResponseObject } from "./openapi-types.js";

const BEARER_SCHEME = "bearerAuth";

/**
 * The one error envelope every TotalBase route answers with (server.ts's
 * error handler + TotalBaseError.toPublicJSON(), Data_API.md §11.1).
 * Generated SQL is never part of it (AGENTS.md section 20).
 */
const ERROR_SCHEMA_NAME = "Error";
const ERROR_SCHEMA = {
  type: "object",
  required: ["errors"],
  properties: {
    errors: {
      type: "array",
      items: {
        type: "object",
        required: ["source", "code", "message"],
        properties: {
          source: { type: "string", enum: ["TOTALBASE", "POSTGRESQL"] },
          code: { type: "string", description: "Stable machine-readable code, e.g. INVALID_FIELD or UNIQUE_VIOLATION." },
          message: { type: "string" },
        },
      },
    },
  },
};

/**
 * Status -> reusable response, following Data_API.md §11.2's status families.
 * Descriptions name representative codes (packages/errors' status map)
 * so a reader can tell what each status means here.
 */
const ERROR_RESPONSES = {
  "400": { name: "BadRequest", description: "Invalid query or input (INVALID_QUERY, INVALID_FIELD, INVALID_OPERATOR, QUERY_COMPLEXITY_LIMIT_EXCEEDED, INVALID_TEXT_REPRESENTATION, ...)." },
  "401": { name: "Unauthorized", description: "Missing or invalid credentials (AUTHENTICATION_REQUIRED, INVALID_TOKEN, SESSION_EXPIRED)." },
  "403": { name: "Forbidden", description: "Authenticated but not authorized (PERMISSION_DENIED, ACTION_DENIED, FIELD_PERMISSION_DENIED)." },
  "404": { name: "NotFound", description: "Resource or row does not exist or is not visible to the caller (RESOURCE_NOT_FOUND, ROW_NOT_FOUND)." },
  "409": { name: "Conflict", description: "PostgreSQL rejected the write as a conflict (UNIQUE_VIOLATION, FOREIGN_KEY_VIOLATION, SERIALIZATION_FAILURE, DEADLOCK_DETECTED)." },
  "413": { name: "PayloadTooLarge", description: "Request body exceeds api.max_body_bytes (REQUEST_BODY_TOO_LARGE)." },
  "422": { name: "UnprocessableEntity", description: "Semantically invalid write (CHECK_VIOLATION, NOT_NULL_VIOLATION, PAYLOAD_CHECK_FAILED, RAISE_EXCEPTION from a trigger or function)." },
  "429": { name: "TooManyRequests", description: "Rate limit exceeded (RATE_LIMIT_EXCEEDED)." },
  "500": { name: "InternalError", description: "Unexpected server error (INTERNAL_ERROR)." },
  "503": { name: "ServiceUnavailable", description: "PostgreSQL cancelled the statement, e.g. statement timeout (QUERY_CANCELED)." },
} as const;

export type ErrorStatus = keyof typeof ERROR_RESPONSES;

/** Statuses any authenticated operation can answer with. */
const BASE_ERROR_STATUSES: ErrorStatus[] = ["400", "401", "403", "404", "429", "500", "503"];

/** Extra statuses for operations that write (or execute arbitrary PostgreSQL logic). */
export const WRITE_ERROR_STATUSES: ErrorStatus[] = ["409", "422"];

/** `$ref`s to the shared error responses: the base set plus `extra`, ordered by status. */
export function errorResponses(extra: ErrorStatus[] = []): Record<string, ReferenceObject> {
  const statuses = [...new Set([...BASE_ERROR_STATUSES, ...extra])].sort();
  return Object.fromEntries(statuses.map((status) => [status, { $ref: `#/components/responses/${ERROR_RESPONSES[status].name}` }]));
}

/**
 * The parts every generated document shares: where the API lives
 * (`servers`), how to authenticate (a bearer token - a session token or
 * an API key, both sent as `Authorization: Bearer`, auth-guards.ts'
 * extractBearerToken), and the error envelope/responses above.
 */
export function commonDocumentParts(options: OpenApiDocumentOptions): Required<Pick<OpenApiDocument, "servers" | "security">> & {
  components: Required<Pick<NonNullable<OpenApiDocument["components"]>, "schemas" | "responses" | "securitySchemes">>;
} {
  const errorSchemaRef = { $ref: `#/components/schemas/${ERROR_SCHEMA_NAME}` };
  const responses: Record<string, ResponseObject> = {};
  for (const { name, description } of Object.values(ERROR_RESPONSES)) {
    responses[name] = { description, content: { "application/json": { schema: errorSchemaRef } } };
  }

  return {
    servers: [{ url: options.publicUrl.replace(/\/+$/, "") }],
    security: [{ [BEARER_SCHEME]: [] }],
    components: {
      schemas: { [ERROR_SCHEMA_NAME]: ERROR_SCHEMA },
      responses,
      securitySchemes: {
        [BEARER_SCHEME]: {
          type: "http",
          scheme: "bearer",
          description: "A session token (from POST /api/auth/login) or an API key, sent as `Authorization: Bearer <token>`.",
        },
      },
    },
  };
}

/**
 * A stable `operationId` (SDK generators name client methods after it):
 * the parts joined with `_`, anything outside [A-Za-z0-9_] replaced -
 * PostgreSQL identifiers may contain spaces, dots or quotes.
 */
export function operationId(...parts: string[]): string {
  return parts.join("_").replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * OpenAPI requires `operationId` to be unique per document; sanitizing can
 * collide (`a.b` and `a_b` both become `a_b`), so later duplicates get a
 * numeric suffix. Mutates `paths` in place.
 */
export function ensureUniqueOperationIds(paths: Record<string, PathItem>): void {
  const seen = new Set<string>();
  for (const pathItem of Object.values(paths)) {
    for (const operation of Object.values(pathItem)) {
      if (!operation?.operationId) continue;
      let id = operation.operationId as string;
      for (let n = 2; seen.has(id); n++) id = `${operation.operationId as string}_${n}`;
      operation.operationId = id;
      seen.add(id);
    }
  }
}

/** Optional replay protection on writes that support it (apps/server idempotency-helper.ts). */
export const IDEMPOTENCY_KEY_HEADER: ParameterObject = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,255}$" },
  description: "Retrying with the same key replays the first response instead of repeating the write.",
};

/** Queues the call instead of running it (Data_API.md §10.4) - 202 with an execution to poll. */
export const PREFER_RESPOND_ASYNC_HEADER: ParameterObject = {
  name: "Prefer",
  in: "header",
  required: false,
  schema: { type: "string", enum: ["respond-async"] },
  description: "`respond-async` queues the call: 202 with an execution id, polled at GET /api/executions/{id}, whose `result` is what this call would have returned.",
};

/** The 202 a queued call answers (Data_API.md §10.4). */
export const QUEUED_EXECUTION_RESPONSE: ResponseObject = {
  description: "Queued (`Prefer: respond-async`) - poll GET /api/executions/{id}.",
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          data: {
            type: "object",
            properties: { id: { type: "string", format: "uuid" }, status: { type: "string", enum: ["PENDING"] }, result: {}, error: {} },
          },
        },
      },
    },
  },
};

/** The same header on an operation whose resource requires it (Data_API.md §9.1). */
export function idempotencyKeyHeader(required: boolean): ParameterObject {
  return required
    ? {
        ...IDEMPOTENCY_KEY_HEADER,
        required: true,
        description: `${IDEMPOTENCY_KEY_HEADER.description} Required here: without it the request is 400 IDEMPOTENCY_KEY_REQUIRED.`,
      }
    : IDEMPOTENCY_KEY_HEADER;
}
