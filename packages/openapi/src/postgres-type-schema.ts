import type { JsonSchema } from "./openapi-types.js";

/** A sample value per JSON Schema type/format, for `openapi.include_examples`. */
function exampleFor(schema: JsonSchema): unknown {
  switch (schema.format) {
    case "uuid":
      return "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    case "date":
      return "2026-01-31";
    case "date-time":
      return "2026-01-31T12:00:00Z";
    case "time":
      return "12:00:00";
  }
  switch (schema.type) {
    case "integer":
      return 1;
    case "number":
      return 1.5;
    case "boolean":
      return true;
    case "string":
      return "string";
    case "array":
      return schema.items ? [exampleFor(schema.items)] : [];
    default:
      return undefined;
  }
}

/**
 * Best-effort PostgreSQL type name -> JSON Schema mapping. `format_type()`
 * output (e.g. "character varying(255)", "numeric(12,2)") is normalized
 * by stripping any parenthesized modifier before matching. With
 * `includeExamples`, each schema also carries a sample value (JSON Schema
 * `examples`) - none for json/jsonb, which has no honest sample.
 */
export function postgresTypeToSchema(dataType: string, includeExamples = false): JsonSchema {
  const schema = baseSchema(dataType);
  if (!includeExamples) return schema;
  const example = exampleFor(schema);
  return example === undefined ? schema : { ...schema, examples: [example] };
}

function baseSchema(dataType: string): JsonSchema {
  if (dataType.endsWith("[]")) {
    return { type: "array", items: baseSchema(dataType.slice(0, -2)) };
  }

  const base = dataType.replace(/\(.+\)$/, "").trim().toLowerCase();

  switch (base) {
    case "uuid":
      return { type: "string", format: "uuid" };
    case "text":
    case "character varying":
    case "character":
    case "citext":
    case "name":
      return { type: "string" };
    case "smallint":
    case "integer":
      return { type: "integer" };
    case "bigint":
      return { type: "integer", format: "int64" };
    case "numeric":
    case "real":
    case "double precision":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date" };
    case "timestamp without time zone":
    case "timestamp with time zone":
      return { type: "string", format: "date-time" };
    case "time without time zone":
    case "time with time zone":
      return { type: "string", format: "time" };
    case "json":
    case "jsonb":
      // Structurally unconstrained - honest best-effort rather than a fake shape.
      return {};
    case "inet":
    case "cidr":
    case "macaddr":
      return { type: "string" };
    default:
      // Unmapped PostgreSQL type (enum, range, custom domain, ...):
      // fall back to string rather than silently guessing wrong.
      return { type: "string" };
  }
}

/**
 * OpenAPI 3.1 nullability: adds `"null"` to the schema's `type` (3.0's
 * `nullable: true` is not part of 3.1 and tooling ignores it). A schema
 * with no `type` (json/jsonb) already accepts null and is returned as-is.
 */
export function withNull(schema: JsonSchema): JsonSchema {
  if (schema.type === undefined) return schema;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.includes("null") ? schema : { ...schema, type: [...types, "null"] };
}
