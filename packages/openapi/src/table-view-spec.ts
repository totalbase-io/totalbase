import type { ColumnDefinition } from "@totalbase/pg-catalog";
import type { PermissionDecision, ResourceAction } from "@totalbase/permissions";
import { COMPARISON_OPERATORS, LOGICAL_OPERATORS } from "@totalbase/query-engine";
import type { ResolvedResource } from "@totalbase/query-engine";
import type { JsonSchema, OperationObject, ParameterObject, PathItem } from "./openapi-types.js";
import { errorResponses, idempotencyKeyHeader, operationId, WRITE_ERROR_STATUSES } from "./common-components.js";
import { postgresTypeToSchema, withNull } from "./postgres-type-schema.js";

type FieldDecision = (field: string) => PermissionDecision;

export interface TableViewSpecInput {
  schema: string;
  name: string;
  type: "TABLE" | "VIEW";
  resource: ResolvedResource;
  allowedActions: ReadonlySet<ResourceAction>;
  /** Field decisions of each allowed action's own grant - a write body is only what that action's grant ALLOWs (mutation-compiler.ts requireFieldAllowed), never READ's. */
  fieldDecisions: Partial<Record<ResourceAction, FieldDecision>>;
  /** Password columns (column type `password`): writable (hashed on the way in) but never returned (apps/server password-fields.ts). */
  passwordColumns: ReadonlySet<string>;
  /** openapi.include_examples: a sample value on every column schema. */
  includeExamples?: boolean | undefined;
  /** The resource requires an Idempotency-Key on CREATE (Data_API.md §9.1). */
  requireIdempotencyKey?: boolean | undefined;
}

export interface TableViewSpecOutput {
  paths: Record<string, PathItem>;
  schemas: Record<string, JsonSchema>;
}

const RELATIONS_EXTENSION = "x-totalbase-relations";
const FIELDS_EXTENSION = "x-totalbase-fields";
const OPERATORS_EXTENSION = "x-totalbase-operators";

function columnSchema(column: ColumnDefinition, includeExamples = false): JsonSchema {
  const schema = postgresTypeToSchema(column.dataType, includeExamples);
  return column.nullable ? withNull(schema) : schema;
}

/**
 * A CREATE must supply a column only when PostgreSQL has no other way to
 * fill it: NOT NULL, no DEFAULT, not identity, not generated. PostgreSQL
 * still has the final word (a trigger may fill it) - this only documents
 * what a well-formed request needs.
 */
function isRequiredOnCreate(column: ColumnDefinition): boolean {
  return !column.nullable && column.defaultExpression === null && !column.isIdentity && !column.isGenerated;
}

/**
 * Write-body schema: the columns the action's own grant ALLOWs, minus
 * GENERATED columns (PostgreSQL rejects any explicit value). Password
 * columns are marked write-only.
 */
function writeSchema(input: TableViewSpecInput, decision: FieldDecision, action: "CREATE" | "UPDATE"): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const column of input.resource.columns) {
    if (column.isGenerated || decision(column.name) !== "ALLOW") continue;
    const schema = columnSchema(column, input.includeExamples);
    properties[column.name] = input.passwordColumns.has(column.name)
      ? { ...schema, format: "password", writeOnly: true, description: "Stored as a one-way hash; never returned." }
      : schema;
    if (action === "CREATE" && isRequiredOnCreate(column)) required.push(column.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    // Nested writes (Data_API.md §6; CREATE-only, not with bulk=true): "$<child_table>" -> child rows.
    ...(action === "CREATE"
      ? { patternProperties: { "^\\$": { type: "array", items: { type: "object" }, description: "Nested child rows, keyed by `$<child_table>`." } } }
      : {}),
    // Any other key is rejected (INVALID_FIELD / FIELD_PERMISSION_DENIED).
    additionalProperties: false,
  };
}

const bulkParameter = (description: string): ParameterObject => ({
  name: "bulk",
  in: "query",
  schema: { type: "boolean" },
  description: `${description} All items run in one transaction; one failure rolls back the whole batch. Max api.bulk_max_items.`,
});

function jsonBody(schema: JsonSchema, required = true): NonNullable<OperationObject["requestBody"]> {
  return { required, content: { "application/json": { schema } } };
}

/**
 * Builds OpenAPI paths + component schemas for one TABLE or VIEW
 * resource, restricted to what the requesting principal can actually do
 * (Data_API.md §14.1: "principal-effective spec"):
 *
 * - `{schema}_{name}`: the row as returned by every operation (the READ
 *   grant's fields, or just the primary key without one; password columns
 *   never);
 * - `{schema}_{name}_create` / `_update`: what a write may send, per that
 *   action's own field grant.
 */
export function buildTableOrViewSpec(input: TableViewSpecInput): TableViewSpecOutput {
  // Every response - reads and mutations alike (apps/server response-projection.ts) - is the READ
  // grant's fields; a principal without READ gets back only the primary key of what it wrote.
  const rowDecision: FieldDecision =
    input.fieldDecisions.READ ?? ((field) => (input.resource.primaryKey.includes(field) ? "ALLOW" : "DENY"));
  const rowColumns = input.resource.columns.filter(
    (column) => rowDecision(column.name) === "ALLOW" && !input.passwordColumns.has(column.name),
  );
  const properties: Record<string, JsonSchema> = {};
  for (const column of rowColumns) properties[column.name] = columnSchema(column, input.includeExamples);

  const rowSchemaName = `${input.schema}_${input.name}`;
  const schemas: Record<string, JsonSchema> = {
    [rowSchemaName]: {
      type: "object",
      properties,
      [FIELDS_EXTENSION]: rowColumns.map((c) => c.name),
      [RELATIONS_EXTENSION]: input.resource.relations.map((r) => ({
        field: r.sourceColumn,
        target: `${r.targetSchema}.${r.targetTable}`,
      })),
    },
  };
  const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });

  const kind = input.type === "TABLE" ? "table" : "view";
  const basePath = `/api/${input.schema}/${kind}/${input.name}`;
  const itemPath = `${basePath}/{pk}`;
  const pkParameter: ParameterObject = { name: "pk", in: "path", required: true, schema: { type: "string" } };
  const singlePk = input.resource.primaryKey.length === 1 ? input.resource.primaryKey[0]! : undefined;

  const response = (status: "200" | "201", data: JsonSchema, errors = errorResponses()): OperationObject["responses"] => ({
    ...errors,
    [status]: {
      description: status === "201" ? "Created" : "OK",
      content: { "application/json": { schema: { type: "object", properties: { data } } } },
    },
  });
  const rows: JsonSchema = { type: "array", items: ref(rowSchemaName) };
  const writeErrors = errorResponses([...WRITE_ERROR_STATUSES, "413"]);

  const paths: Record<string, PathItem> = {};
  const collection: PathItem = {};
  const item: PathItem = {};

  if (input.allowedActions.has("READ")) {
    collection.get = {
      operationId: operationId("list", input.schema, input.name),
      summary: `List ${input.name}`,
      tags: [input.schema],
      [OPERATORS_EXTENSION]: { comparison: COMPARISON_OPERATORS, logical: LOGICAL_OPERATORS },
      parameters: [
        { name: "fields", in: "query", schema: { type: "string" }, description: "Comma/bracket-notation field selection." },
        { name: "where", in: "query", schema: {}, description: "Bracket-notation filter expression." },
        { name: "flags", in: "query", schema: {}, description: "flags[<name>]=<filter>, the where grammar: which of these each row meets, answered in meta.flags (one list of names per row, in data's order) - never a filter on which rows come back." },
        { name: "search", in: "query", schema: { type: "string" }, description: "Words to find, each in some text field read (case and accents aside); a number also matches a numeric field exactly." },
        { name: "search_fields", in: "query", schema: { type: "string" }, description: "Comma list of the fields search looks in - each one a field the request reads." },
        { name: "limit", in: "query", schema: { type: "integer" } },
        { name: "offset", in: "query", schema: { type: "integer" } },
      ],
      responses: response("200", rows),
    };
    if (singlePk) {
      item.get = {
        operationId: operationId("get", input.schema, input.name),
        summary: `Get one ${input.name} by primary key`,
        tags: [input.schema],
        parameters: [pkParameter],
        responses: response("200", ref(rowSchemaName)),
      };
    }
  }

  const createDecision = input.fieldDecisions.CREATE;
  if (input.type === "TABLE" && input.allowedActions.has("CREATE") && createDecision) {
    const createName = `${rowSchemaName}_create`;
    schemas[createName] = writeSchema(input, createDecision, "CREATE");
    collection.post = {
      operationId: operationId("create", input.schema, input.name),
      summary: `Create ${input.name}`,
      tags: [input.schema],
      parameters: [bulkParameter("When true, `data` is an array of rows."), idempotencyKeyHeader(input.requireIdempotencyKey === true)],
      requestBody: jsonBody({
        type: "object",
        required: ["data"],
        properties: {
          data: { oneOf: [ref(createName), { type: "array", items: ref(createName) }] },
          on_conflict: {
            type: "object",
            description:
              "INSERT ... ON CONFLICT (Data_API.md §5.7): `target` names a PRIMARY KEY/UNIQUE column set; " +
              "`action` is NOTHING or UPDATE, with `data` values that may reference `$INSERT.<field>`. " +
              "UPDATE also needs the UPDATE grant: a row it updates is authorized and audited as an UPDATE. " +
              "A row NOTHING skips answers `null` (still 201).",
            required: ["target", "action"],
            properties: {
              target: { type: "array", items: { type: "string" } },
              action: { type: "string", enum: ["NOTHING", "UPDATE"] },
              data: { type: "object", additionalProperties: true },
            },
          },
        },
      }),
      // on_conflict NOTHING: a skipped row is `null` - the whole `data`, or its place in a bulk array.
      responses: response("201", {
        oneOf: [ref(rowSchemaName), { type: "null" }, { type: "array", items: { oneOf: [ref(rowSchemaName), { type: "null" }] } }],
      }, writeErrors),
    };
  }

  const updateDecision = input.fieldDecisions.UPDATE;
  if (input.type === "TABLE" && input.allowedActions.has("UPDATE") && updateDecision) {
    const updateName = `${rowSchemaName}_update`;
    schemas[updateName] = writeSchema(input, updateDecision, "UPDATE");
    // bulk=true: each item carries its own primary key to target that row.
    const bulkItem: JsonSchema | undefined = singlePk
      ? { allOf: [ref(updateName), { type: "object", required: [singlePk], properties: { [singlePk]: {} } }] }
      : undefined;
    collection.patch = {
      operationId: operationId("update_many", input.schema, input.name),
      summary: `Update every ${input.name} row matching \`where\``,
      tags: [input.schema],
      parameters: [
        { name: "where", in: "query", schema: {}, description: "Required unless api.require_where_for_update is disabled." },
        ...(singlePk ? [bulkParameter(`When true, \`data\` is an array of rows, each identified by \`${singlePk}\`.`)] : []),
      ],
      requestBody: jsonBody({
        type: "object",
        required: ["data"],
        properties: { data: bulkItem ? { oneOf: [ref(updateName), { type: "array", items: bulkItem }] } : ref(updateName) },
      }),
      responses: response("200", rows, writeErrors),
    };
    if (singlePk) {
      item.patch = {
        operationId: operationId("update", input.schema, input.name),
        summary: `Update one ${input.name} by primary key`,
        tags: [input.schema],
        parameters: [pkParameter],
        requestBody: jsonBody({ type: "object", required: ["data"], properties: { data: ref(updateName) } }),
        responses: response("200", ref(rowSchemaName), writeErrors),
      };
    }
  }

  if (input.type === "TABLE" && input.allowedActions.has("DELETE")) {
    const deleteErrors = errorResponses(WRITE_ERROR_STATUSES);
    collection.delete = {
      operationId: operationId("delete_many", input.schema, input.name),
      summary: `Delete every ${input.name} row matching \`where\``,
      tags: [input.schema],
      parameters: [
        { name: "where", in: "query", schema: {}, description: "Required unless api.require_where_for_delete is disabled." },
        ...(singlePk ? [bulkParameter(`When true, the body's \`data\` lists the rows to delete by \`${singlePk}\`.`)] : []),
      ],
      ...(singlePk
        ? {
            requestBody: jsonBody(
              {
                type: "object",
                properties: { data: { type: "array", items: { type: "object", required: [singlePk], properties: { [singlePk]: {} } } } },
              },
              false,
            ),
          }
        : {}),
      responses: response("200", rows, deleteErrors),
    };
    if (singlePk) {
      item.delete = {
        operationId: operationId("delete", input.schema, input.name),
        summary: `Delete one ${input.name} by primary key`,
        tags: [input.schema],
        parameters: [pkParameter],
        responses: response("200", ref(rowSchemaName), deleteErrors),
      };
    }
  }

  if (Object.keys(collection).length > 0) paths[basePath] = collection;
  if (Object.keys(item).length > 0) paths[itemPath] = item;

  return { paths, schemas };
}
