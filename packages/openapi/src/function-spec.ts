import type { FunctionDetail } from "@totalbase/pg-catalog";
import type { JsonSchema, PathItem } from "./openapi-types.js";
import { errorResponses, idempotencyKeyHeader, operationId, PREFER_RESPOND_ASYNC_HEADER, QUEUED_EXECUTION_RESPONSE, WRITE_ERROR_STATUSES } from "./common-components.js";
import { postgresTypeToSchema } from "./postgres-type-schema.js";

/** An administrator's classification of a FUNCTION resource (Data_API.md §7). */
export type FunctionClass = "UNCLASSIFIED" | "QUERY" | "ACTION";

const FUNCTION_CLASS_DESCRIPTION: Record<FunctionClass, string> = {
  UNCLASSIFIED: "Not classified: treat it as one that may change data.",
  QUERY: "Classified QUERY: it only reads - safe to call, and to retry.",
  ACTION: "Classified ACTION: it changes data.",
};

export interface FunctionSpecInput {
  schema: string;
  name: string;
  detail: FunctionDetail;
  /** The resource's `function_class` - documented, never enforced (PostgreSQL decides what the function does). */
  functionClass: FunctionClass;
  /** openapi.include_examples: a sample value on every argument schema. */
  includeExamples?: boolean | undefined;
  /** The resource requires an Idempotency-Key (Data_API.md §9.1). */
  requireIdempotencyKey?: boolean | undefined;
}

export interface FunctionSpecOutput {
  path: string;
  pathItem: PathItem;
}

/**
 * Builds the OpenAPI path for one FUNCTION resource's EXECUTE endpoint
 * (Data_API.md §14.1's "Generated from: catalog"). Each PostgreSQL
 * overload is a distinct TotalBase resource (Foundations.md §11.7) and gets its
 * own operation description via the `summary`, since OpenAPI 3.1 has no
 * native concept of the same path resolving to different bodies by
 * argument-name-set.
 */
export function buildFunctionSpec(input: FunctionSpecInput): FunctionSpecOutput {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const parameter of input.detail.parameters) {
    properties[parameter.name] = postgresTypeToSchema(parameter.dataType, input.includeExamples);
    if (!parameter.hasDefault) required.push(parameter.name);
  }

  const argsSchema: JsonSchema = { type: "object", properties, ...(required.length > 0 ? { required } : {}) };

  // Result column/scalar types aren't introspected (V1 scope, see
  // @totalbase/pg-catalog's function-detail.ts) - the response shape is
  // therefore intentionally left open rather than guessed.
  const resultSchema: JsonSchema = input.detail.returnsRows
    ? { type: "array", items: { type: "object", additionalProperties: true } }
    : {};

  return {
    path: `/api/${input.schema}/function/${input.name}`,
    pathItem: {
      post: {
        operationId: operationId("execute", input.schema, input.name),
        summary: `Execute ${input.name}`,
        description: FUNCTION_CLASS_DESCRIPTION[input.functionClass],
        "x-totalbase-function-class": input.functionClass,
        tags: [input.schema],
        parameters: [idempotencyKeyHeader(input.requireIdempotencyKey === true), PREFER_RESPOND_ASYNC_HEADER],
        requestBody: {
          required: input.detail.parameters.some((p) => !p.hasDefault),
          content: { "application/json": { schema: { type: "object", properties: { data: argsSchema } } } },
        },
        responses: {
          // A function can write and RAISE like any other PostgreSQL code.
          ...errorResponses([...WRITE_ERROR_STATUSES, "413"]),
          "200": {
            description: "OK",
            content: { "application/json": { schema: { type: "object", properties: { data: resultSchema } } } },
          },
          "202": QUEUED_EXECUTION_RESPONSE,
        },
      },
    },
  };
}
