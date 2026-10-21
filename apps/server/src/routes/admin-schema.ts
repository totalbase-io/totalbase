import type { FastifyInstance, FastifyRequest } from "fastify";
import { buildColumnCreationBody, isCheckConditionOperator, isColumnInputKey, type CheckCondition, type ColumnCreationBody, type CreationConfig } from "@totalbase/tb-catalog";
import type { Queryable } from "@totalbase/database";
import { dropColumnWidget, parseColumnPresentation, pushColumnPresentation } from "@totalbase/resources";
import {
  applyTableEditPlan,
  buildCreateTableSql,
  buildTableEditPlan,
  type ColumnInput,
  type DdlAuditor,
  type FK_ACTIONS,
  type IndexColumnInput,
  type IndexMethod,
  type TableEditOperation,
} from "@totalbase/schema";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { reconcileCatalog } from "../catalog-refresh.js";
import { TotalBaseError } from "@totalbase/errors";
import { dataEnvelope } from "@totalbase/openapi";
import { adminDoc, arrayOf, created, NO_CONTENT, object, ok, ref, UUID } from "../openapi-admin-docs.js";
import { CASCADE_PARAM, IDENTIFIER, NAMED, RESOURCE_ID_PARAM, SCHEMA_SCHEMAS } from "../openapi-admin-docs-database.js";
import { resourceByPathId } from "../resource-by-path-id.js";
import { requestData } from "../request-body.js";

const doc = (openapi: Parameters<typeof adminDoc>[1]) => adminDoc("schema", { schemas: SCHEMA_SCHEMAS, ...openapi });
const IDENT_PARAM = { schema: IDENTIFIER };
const TABLE_PARAMS = { schema: IDENT_PARAM, table: IDENT_PARAM };
const COLUMN_PARAMS = { ...TABLE_PARAMS, column: IDENT_PARAM };
const CONSTRAINT_PARAMS = { ...TABLE_PARAMS, name: { description: "The constraint's name (listed by GET /admin/api/catalog/table/{id}).", schema: IDENTIFIER } };
const COLUMNS = { ...arrayOf(IDENTIFIER), minItems: 1 };
const FK_ACTION = { type: "string", enum: ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"] };
/** A request body's documented shape: `{ data: <schema> }` (Data_API.md §2.5). */
const dataBody = (schema: Parameters<typeof dataEnvelope>[0]) => ({ schema: dataEnvelope(schema) });


interface InlineForeignKeyBody {
  targetSchema: string;
  targetTable: string;
  targetColumn: string;
  onDelete?: (typeof FK_ACTIONS)[number];
  onUpdate?: (typeof FK_ACTIONS)[number];
}

interface ColumnBody {
  name: string;
  dataType: string;
  nullable?: boolean;
  default?: string;
  primaryKey?: boolean;
  /** Inline single-column shorthand, folded into the same CREATE TABLE / ADD COLUMN statement - see ColumnInput. */
  unique?: boolean;
  check?: string;
  foreignKey?: InlineForeignKeyBody;
  checkMessage?: string;
  uniqueMessage?: string;
  foreignKeyMessage?: string;
  identity?: "ALWAYS" | "BY DEFAULT";
  generated?: string;
  /**
   * Add Column wizard only (DataViews.md §16.2) - the column
   * input catalog entry the user picked (`COLUMN_INPUTS`, its presentation's
   * `input`) and the rest of the column's presentation (`config`, §15),
   * written to totalbase.resources_columns once the column itself exists.
   * Omitted by every other caller: the column's control is then the rule's
   * (Automatic).
   */
  input?: string;
  config?: unknown;
  /** Add Column only: a UID column generated from `source` (DataViews.md §16.3). */
  uid?: { source?: unknown };
  /**
   * Add Column only, with `input`: the entry's creation config (`CreationConfig` - min/max, options, the relation's
   * target...). The server derives `dataType`/`check`/`foreignKey`/`uid`/`unique` from it (withCreation); any of
   * those sent beside it are ignored.
   */
  creation?: unknown;
}

function toColumnInput(body: ColumnBody): ColumnInput {
  return {
    name: body.name,
    dataType: body.dataType,
    nullable: body.nullable,
    default: body.default,
    primaryKey: body.primaryKey,
    unique: body.unique,
    check: body.check,
    checkMessage: body.checkMessage,
    uniqueMessage: body.uniqueMessage,
    foreignKeyMessage: body.foreignKeyMessage,
    identity: body.identity,
    generated: body.generated,
    foreignKey: body.foreignKey
      ? {
          targetSchema: body.foreignKey.targetSchema,
          targetTable: body.foreignKey.targetTable,
          targetColumn: body.foreignKey.targetColumn,
          onDelete: body.foreignKey.onDelete,
          onUpdate: body.foreignKey.onUpdate,
        }
      : undefined,
  };
}

type FkActionBody = (typeof FK_ACTIONS)[number];

/** A CHECK's input: its expression, or the conditions the admin built (each a column, an operator and a value) - one of the two. */
function toCheckInput(data: { expression?: unknown; conditions?: unknown }): string | CheckCondition[] {
  if (Array.isArray(data.conditions)) {
    if (typeof data.expression === "string" && data.expression.trim() !== "") throw new TotalBaseError("INVALID_QUERY", "Send either expression or conditions, not both.");
    return data.conditions.map((condition: unknown) => {
      if (!condition || typeof condition !== "object") throw new TotalBaseError("INVALID_QUERY", "Each condition is an object: field, operator, value.");
      const { field, operator, value } = condition as Record<string, unknown>;
      if (typeof field !== "string" || !isCheckConditionOperator(operator)) throw new TotalBaseError("INVALID_QUERY", "Each condition needs a field and a known operator.");
      const pair = Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "string") ? (value as [string, string]) : undefined;
      return { field, operator, value: pair ?? (typeof value === "string" ? value : undefined) };
    });
  }
  if (typeof data.expression !== "string") throw new TotalBaseError("INVALID_QUERY", "expression or conditions is required.");
  return data.expression;
}

/**
 * Add Column with a column input catalog entry and its creation config (`input` + `creation`): the data type, the
 * CHECK, the foreign key, the UID of the entry are derived here, by the catalog's own `buildColumnCreationBody` -
 * the admin sends what the user chose, never the DDL (AGENTS.md §6). Without `creation`, the body is taken as sent.
 */
function withCreation(column: ColumnBody): ColumnBody {
  if (column.creation === undefined) return column;
  if (!isColumnInputKey(column.input)) throw new TotalBaseError("INVALID_QUERY", "`creation` needs `input`: a creatable column input catalog entry.");
  if (!column.creation || typeof column.creation !== "object" || Array.isArray(column.creation)) throw new TotalBaseError("INVALID_QUERY", "`creation` must be an object.");
  if (typeof column.name !== "string") throw new TotalBaseError("INVALID_QUERY", "name is required.");
  let derived: ColumnCreationBody;
  try {
    derived = buildColumnCreationBody(column.input, column.name, column.creation as CreationConfig);
  } catch (error) {
    throw new TotalBaseError("INVALID_QUERY", error instanceof Error ? error.message : "Invalid column creation config.");
  }
  const { creation: _creation, dataType: _dataType, check: _check, foreignKey: _foreignKey, uid: _uid, unique, ...rest } = column;
  // A scalar entry's own UNIQUE (a UID is always unique); else the user's choice.
  const derivedUnique = derived.unique ?? unique;
  return {
    ...rest,
    dataType: derived.dataType,
    ...(derived.check !== undefined && { check: derived.check }),
    ...(derived.foreignKey !== undefined && { foreignKey: derived.foreignKey }),
    ...(derived.uid !== undefined && { uid: derived.uid }),
    ...(derivedUnique !== undefined && { unique: derivedUnique }),
  };
}

/**
 * Wire format for one entry in the Edit Table drawer's batch - the
 * drawer diffs its draft against the table's original state and sends
 * the resulting list here. `kind` values are snake_case enum values; keys
 * are camelCase like every other request body.
 */
type EditOperationBody =
  | { kind: "rename_table", newName: string }
  | { kind: "add_column", column: ColumnBody }
  | { kind: "alter_column", column: string, patch: { rename?: string, dataType?: string, nullable?: boolean, default?: string | null } }
  | { kind: "drop_column", column: string, cascade?: boolean }
  | { kind: "set_primary_key", columns: string[] }
  | { kind: "add_unique", columns: string[], name?: string }
  | { kind: "add_foreign_key", column: string, targetSchema: string, targetTable: string, targetColumn: string, onDelete?: FkActionBody, onUpdate?: FkActionBody, name?: string }
  | { kind: "add_check", name: string, expression: string, message?: string | null }
  | { kind: "set_constraint_message", name: string, message: string | null }
  | { kind: "drop_constraint", name: string }
  | { kind: "create_index", name?: string, columns: (string | IndexColumnInput)[], method?: IndexMethod, unique?: boolean, where?: string, concurrently?: boolean }
  | { kind: "drop_index", name: string, concurrently?: boolean };

function toTableEditOperation(body: EditOperationBody): TableEditOperation {
  switch (body.kind) {
    case "rename_table":
      return { kind: "rename_table", newName: body.newName };
    case "add_column":
      return { kind: "add_column", column: toColumnInput(body.column) };
    case "alter_column":
      return {
        kind: "alter_column",
        column: body.column,
        patch: { rename: body.patch.rename, dataType: body.patch.dataType, nullable: body.patch.nullable, default: body.patch.default },
      };
    case "drop_column":
      return { kind: "drop_column", column: body.column, cascade: body.cascade };
    case "set_primary_key":
      return { kind: "set_primary_key", columns: body.columns };
    case "add_unique":
      return { kind: "add_unique", columns: body.columns, name: body.name };
    case "add_foreign_key":
      return {
        kind: "add_foreign_key",
        input: {
          column: body.column,
          targetSchema: body.targetSchema,
          targetTable: body.targetTable,
          targetColumn: body.targetColumn,
          onDelete: body.onDelete,
          onUpdate: body.onUpdate,
          name: body.name,
        },
      };
    case "add_check":
      return { kind: "add_check", name: body.name, expression: body.expression, message: body.message };
    case "set_constraint_message":
      return { kind: "set_constraint_message", name: body.name, message: typeof body.message === "string" ? body.message : null };
    case "drop_constraint":
      return { kind: "drop_constraint", name: body.name };
    case "create_index":
      return {
        kind: "create_index",
        input: { name: body.name, columns: body.columns, method: body.method, unique: body.unique, where: body.where, concurrently: body.concurrently },
      };
    case "drop_index":
      return { kind: "drop_index", name: body.name, concurrently: body.concurrently };
  }
}

/**
 * What a DDL audit entry names: the table (schema + table) or the
 * view/function (its resource, schema and name). The names stay in
 * `metadata` because a dropped object's resource is later purged and the
 * entry's `resource` reference is then cleared (ON DELETE SET NULL).
 */
interface DdlTarget {
  schema?: string;
  table?: string;
  name?: string;
  resourceId?: string;
}

/** The ACTIVE table resource a statement acts on - read on the DDL's own transaction, before the catalog reconcile renames or retires it. */
async function tableResourceId(client: Queryable, schema: string, table: string): Promise<string | undefined> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM totalbase.resources
     WHERE "schema" = $1 AND name = $2 AND type = 'TABLE' AND status = 'ACTIVE'
     ORDER BY updated_at DESC LIMIT 1`,
    [schema, table],
  );
  return rows[0]?.id;
}

/**
 * Runs one schema-management operation with its audit entry
 * (Administration.md §3.14): action `DDL`, written by the
 * service on the DDL's own transaction (`DdlAuditor`) - the operation and
 * its statements in `metadata`, the affected resource when it already
 * exists. A CONCURRENTLY statement is recorded right after it ran. An
 * operation that fails is recorded FAILED, best-effort on a fresh
 * connection, never masking the error.
 */
async function auditedDdl<T>(
  context: AppContext,
  request: FastifyRequest,
  operation: string,
  target: DdlTarget,
  run: (audit: DdlAuditor) => Promise<T>,
): Promise<T> {
  const startedAt = new Date();
  const base = {
    requestId: request.id,
    principal: { type: "ADMIN" as const, id: request.admin!.id },
    action: "DDL" as const,
    source: "admin",
    ip: request.ip,
    userAgent: request.headers["user-agent"],
    startedAt,
  };
  const names = {
    ...(target.schema !== undefined ? { schema: target.schema } : {}),
    ...(target.table !== undefined ? { table: target.table } : {}),
    ...(target.name !== undefined ? { name: target.name } : {}),
    ...(request.adminToken ? { token: request.adminToken } : {}),
  };
  const audit: DdlAuditor = async (client, record) => {
    const resourceId = target.resourceId
      ?? (target.schema !== undefined && target.table !== undefined ? await tableResourceId(client, target.schema, target.table) : undefined);
    await context.audit.record(client, {
      ...base,
      resourceId,
      status: "EXECUTED",
      metadata: { operation: record.operation, ...names, statements: record.statements, ...(record.concurrent ? { concurrent: true } : {}) },
      finishedAt: new Date(),
    });
  };
  try {
    return await run(audit);
  } catch (error) {
    try {
      await context.audit.record(context.database, {
        ...base,
        resourceId: target.resourceId,
        status: "FAILED",
        metadata: { operation, ...names },
        error: error instanceof TotalBaseError
          ? { code: error.code, sqlstate: error.sqlstate, message: error.message, detail: error.detail, hint: error.hint }
          : { message: error instanceof Error ? error.message : String(error) },
        finishedAt: new Date(),
      });
    } catch {
      // best-effort; never mask the DDL's own error
    }
    throw error;
  }
}

// The editor's own DDL always reconciles, whatever
// catalog.auto_refresh_after_ddl says: its responses (e.g. a new table's
// resource id) are read from the reconciled resources.
async function refreshCatalog(context: AppContext): Promise<void> {
  await reconcileCatalog(context);
}

/**
 * Structured table/column/constraint management
 * (Administration.md §3). The spec's path template
 * ("/schema/tables/{resource}") omits a schema segment even
 * though every operation is schema-qualified and a brand-new table has
 * no totalbase.resources row yet to reference by id; resolved here (per
 * AGENTS.md section 27) as {schema}/tables/{table}, mirroring the Data
 * API's own {schema}/table/{resource} nesting.
 *
 * PK/UNIQUE/FK/CHECK get their own sub-resources under the table
 * (Administration.md §3.6, §3.9 each describe a distinct
 * "visual editor"), rather than being folded into the table/column
 * bodies as a terser endpoint list might otherwise suggest.
 */
export function registerAdminSchemaRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);

  app.post<{ Body: { data?: { name: string } } }>(
    "/admin/api/schema",
    {
      preHandler,
      ...doc({
        summary: "Create a PostgreSQL schema",
        description: "CREATE SCHEMA <name>. A name already in use fails with PostgreSQL's own error.",
        requestBody: dataBody(object({ name: IDENTIFIER }, ["name"])),
        response: created(object({ name: { type: "string" } })),
      }),
    },
    async (request, reply) => {
      const { name } = requestData(request.body);
      await auditedDdl(context, request, "create_schema", { schema: name }, (audit) => context.tableSchema.createSchema(name, audit));
      reply.code(201);
      return { data: { name } };
    },
  );

  const CREATE_TABLE_BODY = dataBody(object({
    name: IDENTIFIER,
    columns: { ...arrayOf(ref("SchemaColumnDefinition")), minItems: 1 },
    uniques: {
      ...arrayOf({ ...arrayOf(IDENTIFIER), minItems: 2 }),
      description: "Table-level UNIQUE constraints over several of its columns, each named `<table>_<col>_<col>_key` - a junction table's pair (or triple) of foreign keys.",
    },
  }, ["name", "columns"]));
  const toCreateTableInput = (schema: string, data: { name: string; columns: ColumnBody[]; uniques?: unknown }) => {
    if (!Array.isArray(data.columns)) throw new TotalBaseError("INVALID_QUERY", "columns must be a list.");
    if (data.uniques !== undefined && (!Array.isArray(data.uniques) || data.uniques.some((u) => !Array.isArray(u) || u.some((c) => typeof c !== "string")))) {
      throw new TotalBaseError("INVALID_QUERY", "uniques must be a list of column-name lists.");
    }
    return { schema, name: data.name, columns: data.columns.map(toColumnInput), uniques: data.uniques as string[][] | undefined };
  };

  // The DDL preview shown before the admin confirms: same validation, same
  // SQL-building code createTable() itself calls - returned instead of
  // executed, so it can never drift from what actually runs.
  app.post<{ Params: { schema: string }; Body: { data?: { name: string; columns: ColumnBody[]; uniques?: unknown } } }>(
    "/admin/api/schema/:schema/tables/preview",
    {
      preHandler,
      ...doc({
        summary: "Preview a table's CREATE TABLE",
        description: "Takes the same body as POST /admin/api/schema/{schema}/tables, validates it and answers the exact statement that would run. Runs nothing.",
        pathParameters: { schema: IDENT_PARAM },
        requestBody: CREATE_TABLE_BODY,
        response: ok(object({ sql: { type: "string" } })),
      }),
    },
    async (request) => ({ data: { sql: buildCreateTableSql(toCreateTableInput(request.params.schema, requestData(request.body))) } }),
  );

  app.post<{ Params: { schema: string }; Body: { data?: { name: string; columns: ColumnBody[]; uniques?: unknown } } }>(
    "/admin/api/schema/:schema/tables",
    {
      preHandler,
      ...doc({
        summary: "Create a table",
        description:
          "Structured CREATE TABLE: each column with its type, nullability, default, primary key and inline UNIQUE/CHECK/" +
          "FOREIGN KEY, all in one statement - the table comes into being complete or not at all. TotalBase builds the DDL " +
          "(defaults and checks are expressions, never statements). The table becomes a hidden resource (identity by OID): " +
          "expose it (PATCH /admin/api/resources/{id}) and grant permissions to reach it through the Data API. " +
          "POST .../tables/preview answers the statement without running it. An existing table name: 409 DUPLICATE_TABLE.",
        pathParameters: { schema: IDENT_PARAM },
        requestBody: CREATE_TABLE_BODY,
        response: created(object({
          schema: { type: "string" },
          name: { type: "string" },
          id: { ...UUID, type: ["string", "null"], description: "The new table's TotalBase resource id." },
          oid: { type: ["integer", "null"], description: "Its PostgreSQL OID." },
        })),
      }),
    },
    async (request, reply) => {
      const input = toCreateTableInput(request.params.schema, requestData(request.body));
      await auditedDdl(context, request, "create_table", { schema: input.schema, table: input.name }, (audit) => context.tableSchema.createTable(input, audit));
      await refreshCatalog(context);
      const { rows } = await context.database.query<{ id: string; oid: number }>(
        `SELECT r.id, r.postgres_oid AS oid FROM totalbase.resources r WHERE r.schema = $1 AND r.name = $2 AND r.type = 'TABLE'`,
        [input.schema, input.name],
      );
      reply.code(201);
      return { data: { schema: input.schema, name: input.name, id: rows[0]?.id ?? null, oid: rows[0]?.oid ?? null } };
    },
  );

  app.patch<{ Params: { schema: string; table: string }; Body: { data?: { name: string } } }>(
    "/admin/api/schema/:schema/tables/:table",
    {
      preHandler,
      ...doc({
        summary: "Rename a table",
        description: "ALTER TABLE ... RENAME TO. The resource keeps its id, exposure and permissions (same OID).",
        pathParameters: TABLE_PARAMS,
        requestBody: dataBody(object({ name: { ...IDENTIFIER, description: "The new name." } }, ["name"])),
        response: ok(object({ schema: { type: "string" }, name: { type: "string" } })),
      }),
    },
    async (request) => {
      const { name } = requestData(request.body);
      const { schema, table } = request.params;
      await auditedDdl(context, request, "rename_table", { schema, table }, (audit) => context.tableSchema.renameTable(schema, table, name, audit));
      await refreshCatalog(context);
      return { data: { schema: request.params.schema, name } };
    },
  );

  app.delete<{ Params: { schema: string; table: string }; Querystring: { cascade?: string } }>(
    "/admin/api/schema/:schema/tables/:table",
    {
      preHandler,
      ...doc({
        summary: "Drop a table",
        description: "DROP TABLE - its data is gone. Its resource turns MISSING; a table later created with the same name is a new, hidden resource.",
        pathParameters: TABLE_PARAMS,
        parameters: [CASCADE_PARAM],
        response: NO_CONTENT,
        errors: ["409"],
      }),
    },
    async (request, reply) => {
      const { schema, table } = request.params;
      await auditedDdl(context, request, "drop_table", { schema, table }, (audit) => context.tableSchema.dropTable(schema, table, request.query.cascade === "true", audit));
      await refreshCatalog(context);
      reply.code(204);
    },
  );

  app.post<{ Params: { schema: string; table: string }; Body: { data?: ColumnBody } }>(
    "/admin/api/schema/:schema/tables/:table/columns",
    {
      preHandler,
      ...doc({
        summary: "Add a column",
        description:
          "ALTER TABLE ... ADD COLUMN, with its inline UNIQUE/CHECK/FOREIGN KEY in the same statement. `primaryKey` is ignored " +
          "here (use the primary-key route). Adding NOT NULL without a default to a table that has rows fails (PostgreSQL). " +
          "`input` (a column input catalog entry - its control) and `config` (its presentation) record how the column shows, in the same transaction: the table must " +
          "then be an ACTIVE resource (404 otherwise, and no column is added). `uid` makes it a UID column: a trigger fills it " +
          "with the slug of `uid.source` whenever a row is written with it empty.",
        pathParameters: TABLE_PARAMS,
        requestBody: dataBody(ref("SchemaAddColumn")),
        response: created(object({ name: { type: "string", description: "The new column's name." } })),
      }),
    },
    async (request, reply) => {
      const column = withCreation(requestData(request.body));
      const { schema, table } = request.params;
      // Checked before the DDL, so a bad presentation never leaves a column behind.
      const withPresentation = column.input !== undefined || column.config !== undefined;
      const config = { ...((column.config ?? {}) as Record<string, unknown>), ...(column.input !== undefined && { input: column.input }) };
      const presentation = withPresentation
        ? parseColumnPresentation(config, column.dataType, column.foreignKey ? { targetSchema: column.foreignKey.targetSchema, targetTable: column.foreignKey.targetTable } : null)
        : undefined;
      await auditedDdl(context, request, "add_column", { schema, table }, (audit) => context.tableSchema.addColumn(
        schema,
        table,
        { ...toColumnInput(column), uid: column.uid ? { source: String(column.uid.source ?? "") } : undefined },
        presentation === undefined ? undefined : (client) => pushColumnPresentation(client, { schema, table, columnName: column.name, config: presentation }),
        audit,
      ));
      reply.code(201);
      return { data: { name: column.name } };
    },
  );

  app.patch<{
    Params: { schema: string; table: string; column: string };
    Body: { data?: { rename?: string; dataType?: string; nullable?: boolean; default?: string | null } };
  }>("/admin/api/schema/:schema/tables/:table/columns/:column", {
      preHandler,
      ...doc({
        summary: "Change a column",
        description:
          "Rename, change type, nullability or default - only the keys sent, in one transaction (type, nullability, default, " +
          "rename): all apply or none.",
        pathParameters: COLUMN_PARAMS,
        requestBody: dataBody(ref("SchemaColumnPatch")),
        response: NO_CONTENT,
      }),
    }, async (request, reply) => {
    const patch = requestData(request.body);
    const { schema, table, column } = request.params;
    await auditedDdl(context, request, "alter_column", { schema, table }, (audit) => context.tableSchema.alterColumn(schema, table, column, {
      rename: patch.rename,
      dataType: patch.dataType,
      nullable: patch.nullable,
      default: patch.default,
    }, audit));
    reply.code(204);
  });

  app.delete<{ Params: { schema: string; table: string; column: string }; Querystring: { cascade?: string } }>(
    "/admin/api/schema/:schema/tables/:table/columns/:column",
    {
      preHandler,
      ...doc({
        summary: "Drop a column",
        description: "ALTER TABLE ... DROP COLUMN - its data is gone - and its admin presentation with it.",
        pathParameters: COLUMN_PARAMS,
        parameters: [CASCADE_PARAM],
        response: NO_CONTENT,
        errors: ["409"],
      }),
    },
    async (request, reply) => {
      const { schema, table, column } = request.params;
      await auditedDdl(context, request, "drop_column", { schema, table }, (audit) =>
        context.tableSchema.dropColumn(schema, table, column, request.query.cascade === "true", audit));
      await dropColumnWidget(context.database, {
        schema: request.params.schema,
        table: request.params.table,
        columnName: request.params.column,
      });
      reply.code(204);
    },
  );

  app.post<{ Params: { schema: string; table: string }; Body: { data?: { columns: string[]; name?: string } } }>(
    "/admin/api/schema/:schema/tables/:table/primary-key",
    {
      preHandler,
      ...doc({
        summary: "Set the primary key",
        description:
          "Replaces the table's primary key in one transaction: drops the existing one (if any), then adds PRIMARY KEY (columns) - " +
          "a key PostgreSQL rejects (the columns hold NULLs or duplicates) leaves the old one in place. Default name `<table>_pkey`.",
        pathParameters: TABLE_PARAMS,
        requestBody: dataBody(object({ columns: COLUMNS, name: { ...IDENTIFIER, description: "Constraint name; default `<table>_pkey`." } }, ["columns"])),
        response: NO_CONTENT,
      }),
    },
    async (request, reply) => {
      const { columns, name } = requestData(request.body);
      const { schema, table } = request.params;
      await auditedDdl(context, request, "set_primary_key", { schema, table }, (audit) => context.tableSchema.setPrimaryKey(schema, table, columns, name, audit));
      reply.code(204);
    },
  );

  app.delete<{ Params: { schema: string; table: string } }>(
    "/admin/api/schema/:schema/tables/:table/primary-key",
    {
      preHandler,
      ...doc({
        summary: "Drop the primary key",
        description: "404 UNDEFINED_OBJECT when the table has none. A foreign key that references it makes this fail unless dropped first.",
        pathParameters: TABLE_PARAMS,
        response: NO_CONTENT,
        errors: ["409"],
      }),
    },
    async (request, reply) => {
      const { schema, table } = request.params;
      await auditedDdl(context, request, "drop_primary_key", { schema, table }, (audit) => context.tableSchema.dropPrimaryKey(schema, table, audit));
      reply.code(204);
    },
  );

  app.post<{ Params: { schema: string; table: string }; Body: { data?: { columns: string[]; name?: string } } }>(
    "/admin/api/schema/:schema/tables/:table/unique-constraints",
    {
      preHandler,
      ...doc({
        summary: "Add a UNIQUE constraint",
        description: "Fails (409 UNIQUE_VIOLATION) if existing rows already repeat the values.",
        pathParameters: TABLE_PARAMS,
        requestBody: dataBody(object({ columns: COLUMNS, name: { ...IDENTIFIER, description: "Default `<table>_<col1>_<col2>..._key`." } }, ["columns"])),
        response: created(NAMED),
      }),
    },
    async (request, reply) => {
      const data = requestData(request.body);
      const { schema, table } = request.params;
      const name = await auditedDdl(context, request, "add_unique", { schema, table }, (audit) =>
        context.tableSchema.addUniqueConstraint(schema, table, data.columns, data.name, audit));
      reply.code(201);
      return { data: { name } };
    },
  );

  app.delete<{ Params: { schema: string; table: string; name: string } }>(
    "/admin/api/schema/:schema/tables/:table/unique-constraints/:name",
    {
      preHandler,
      ...doc({ summary: "Drop a UNIQUE constraint", description: "DROP CONSTRAINT by name.", pathParameters: CONSTRAINT_PARAMS, response: NO_CONTENT, errors: ["409"] }),
    },
    async (request, reply) => {
      const { schema, table, name } = request.params;
      await auditedDdl(context, request, "drop_constraint", { schema, table }, (audit) => context.tableSchema.dropConstraint(schema, table, name, audit));
      reply.code(204);
    },
  );

  app.post<{
    Params: { schema: string; table: string };
    Body: {
      data?: {
        column: string;
        targetSchema: string;
        targetTable: string;
        targetColumn: string;
        onDelete?: FkActionBody;
        onUpdate?: FkActionBody;
        name?: string;
      };
    };
  }>("/admin/api/schema/:schema/tables/:table/foreign-keys", {
      preHandler,
      ...doc({
        summary: "Add a foreign key",
        description:
          "Single-column FOREIGN KEY (column) REFERENCES targetSchema.targetTable (targetColumn) - the target column must be " +
          "its primary key or UNIQUE. Becomes a relation the Data API can traverse. Fails (409 FOREIGN_KEY_VIOLATION) if " +
          "existing rows point nowhere.",
        pathParameters: TABLE_PARAMS,
        requestBody: dataBody(
          object(
            {
              column: IDENTIFIER,
              targetSchema: IDENTIFIER,
              targetTable: IDENTIFIER,
              targetColumn: IDENTIFIER,
              onDelete: FK_ACTION,
              onUpdate: FK_ACTION,
              name: { ...IDENTIFIER, description: "Default `<table>_<column>_fkey`." },
            },
            ["column", "targetSchema", "targetTable", "targetColumn"],
          ),
        ),
        response: created(NAMED),
      }),
    }, async (request, reply) => {
    const data = requestData(request.body);
    const { schema, table } = request.params;
    const name = await auditedDdl(context, request, "add_foreign_key", { schema, table }, (audit) => context.tableSchema.addForeignKey(schema, table, {
      column: data.column,
      targetSchema: data.targetSchema,
      targetTable: data.targetTable,
      targetColumn: data.targetColumn,
      onDelete: data.onDelete,
      onUpdate: data.onUpdate,
      name: data.name,
    }, audit));
    reply.code(201);
    return { data: { name } };
  });

  app.delete<{ Params: { schema: string; table: string; name: string } }>(
    "/admin/api/schema/:schema/tables/:table/foreign-keys/:name",
    {
      preHandler,
      ...doc({ summary: "Drop a foreign key", description: "DROP CONSTRAINT by name.", pathParameters: CONSTRAINT_PARAMS, response: NO_CONTENT, errors: ["409"] }),
    },
    async (request, reply) => {
      const { schema, table, name } = request.params;
      await auditedDdl(context, request, "drop_constraint", { schema, table }, (audit) => context.tableSchema.dropConstraint(schema, table, name, audit));
      reply.code(204);
    },
  );

  app.post<{ Params: { schema: string; table: string }; Body: { data?: { name: string; expression?: string; conditions?: unknown; message?: string | null } } }>(
    "/admin/api/schema/:schema/tables/:table/checks",
    {
      preHandler,
      ...doc({
        summary: "Add a CHECK constraint",
        description:
          "ADD CONSTRAINT <name> CHECK (<expression>): send the boolean expression only, e.g. `price > 0` or " +
          "`status IN ('draft', 'sent')` - TotalBase builds the statement. Rejected: `;`, SQL comments, `$$`, unbalanced " +
          "parentheses, DDL/DML keywords. Or send `conditions` instead - column, operator (the filter grammar's: _eq, _gt, _in, " +
          "_between, _null...), value - and TotalBase writes the expression over the table's real columns (AND-joined); one " +
          "of the two. Existing rows that fail it make it fail (422 CHECK_VIOLATION). `message`, stored as " +
          "the constraint's COMMENT, replaces PostgreSQL's generic text when a write violates it.",
        pathParameters: TABLE_PARAMS,
        requestBody: dataBody(
          object(
            {
              name: IDENTIFIER,
              expression: { type: "string", maxLength: 2000, description: "A boolean SQL expression over the table's columns." },
              conditions: { ...arrayOf(ref("SchemaCheckCondition")), description: "Built conditions, instead of `expression` - the server writes the expression." },
              message: { type: ["string", "null"], description: "Error message shown when a write violates it." },
            },
            ["name"],
          ),
        ),
        response: created(NAMED),
      }),
    },
    async (request, reply) => {
      const data = requestData(request.body);
      const { schema, table } = request.params;
      const check = toCheckInput(data);
      await auditedDdl(context, request, "add_check", { schema, table }, (audit) =>
        context.tableSchema.addCheckConstraint(schema, table, data.name, check, data.message, audit));
      reply.code(201);
      return { data: { name: data.name } };
    },
  );

  app.post<{ Params: { schema: string; table: string }; Body: { data?: { parentColumn?: string } } }>(
    "/admin/api/schema/:schema/tables/:table/cycle-guard",
    {
      preHandler,
      ...doc({
        summary: "Protect a self-reference against cycles",
        description:
          "A trigger on the table (BEFORE INSERT OR UPDATE OF `parentColumn`) refusing a row placed under itself or under one of " +
          "its own descendants - check_violation, for every writer - a TREE DataView's table (DataViews.md §5.14). " +
          "Needs a single-column primary key; created again, it is replaced.",
        pathParameters: TABLE_PARAMS,
        requestBody: dataBody(object({ parentColumn: IDENTIFIER }, ["parentColumn"])),
        response: NO_CONTENT,
      }),
    },
    async (request, reply) => {
      const data = requestData(request.body);
      const { schema, table } = request.params;
      if (typeof data.parentColumn !== "string") throw new TotalBaseError("INVALID_QUERY", "parentColumn is required.");
      await auditedDdl(context, request, "add_cycle_guard", { schema, table }, (audit) =>
        context.tableSchema.addCycleGuard(schema, table, data.parentColumn!, audit));
      reply.code(204);
    },
  );

  app.delete<{ Params: { schema: string; table: string; name: string } }>(
    "/admin/api/schema/:schema/tables/:table/checks/:name",
    {
      preHandler,
      ...doc({ summary: "Drop a CHECK constraint", description: "DROP CONSTRAINT by name.", pathParameters: CONSTRAINT_PARAMS, response: NO_CONTENT, errors: ["409"] }),
    },
    async (request, reply) => {
      const { schema, table, name } = request.params;
      await auditedDdl(context, request, "drop_constraint", { schema, table }, (audit) => context.tableSchema.dropConstraint(schema, table, name, audit));
      reply.code(204);
    },
  );

  app.get<{ Params: { schema: string; table: string } }>(
    "/admin/api/schema/:schema/tables/:table/indexes",
    {
      preHandler,
      ...doc({
        summary: "A table's indexes, with their definition",
        description: "An unknown schema or table: 404 RESOURCE_NOT_FOUND.",
        pathParameters: TABLE_PARAMS,
        response: ok(arrayOf(ref("SchemaIndex"))),
      }),
    },
    async (request) => ({ data: await context.indexes.list(request.params.schema, request.params.table) }),
  );

  // The Edit Table drawer's single "Save" - a batch of operations built
  // by diffing its draft against the table's original state, run as one
  // plan. Its preview route returns that same plan - the SQL split into
  // the transactional batch and the CONCURRENTLY-only statements that
  // can't join it (PostgreSQL forbids CONCURRENTLY inside a transaction
  // block) - so the confirmation the admin sees can never drift from
  // what actually runs.
  const EDIT_BODY = dataBody(object({ operations: arrayOf(ref("SchemaEditOperation")) }, ["operations"]));
  const editPlan = (params: { schema: string; table: string }, requestBody: { data?: { operations: EditOperationBody[] } } | undefined) => {
    const { operations } = requestData(requestBody);
    if (!Array.isArray(operations)) throw new TotalBaseError("INVALID_QUERY", "operations must be a list.");
    return buildTableEditPlan(context.database, params.schema, params.table, operations.map(toTableEditOperation));
  };

  app.post<{ Params: { schema: string; table: string }; Body: { data?: { operations: EditOperationBody[] } } }>(
    "/admin/api/schema/:schema/tables/:table/edit/preview",
    {
      preHandler,
      ...doc({
        summary: "Preview a batch of table changes",
        description: "Takes the same body as POST .../edit and answers the exact statements it would run - the transactional batch and the CONCURRENTLY ones after it. Runs nothing.",
        pathParameters: TABLE_PARAMS,
        requestBody: EDIT_BODY,
        response: ok(ref("SchemaTableEditPlan")),
      }),
    },
    async (request) => ({ data: await editPlan(request.params, request.body) }),
  );

  app.post<{ Params: { schema: string; table: string }; Body: { data?: { operations: EditOperationBody[] } } }>(
    "/admin/api/schema/:schema/tables/:table/edit",
    {
      preHandler,
      ...doc({
        summary: "Apply a batch of table changes",
        description:
          "Every operation - rename, add/alter/drop columns, primary key, UNIQUE, foreign keys, CHECKs, indexes - in order, in " +
          "one transaction: all apply or none. Exception: CONCURRENTLY index operations, which PostgreSQL forbids inside a " +
          "transaction, run one by one after it commits. POST .../edit/preview answers the exact statements without running " +
          "them. Operations apply in order; after a `rename_table` the later ones (CONCURRENTLY included) address the table by its new name.",
        pathParameters: TABLE_PARAMS,
        requestBody: EDIT_BODY,
        response: NO_CONTENT,
      }),
    },
    async (request, reply) => {
      const { schema, table } = request.params;
      await auditedDdl(context, request, "edit_table", { schema, table }, async (audit) =>
        applyTableEditPlan(context.database, await editPlan(request.params, request.body), audit));
      await refreshCatalog(context);
      reply.code(204);
    },
  );

  // Views/functions are otherwise introspect-only (Administration.md §4.4)
  // - drop is the one write operation the admin UI's Resources
  // grid needs for them (parity with the table "Drop" action). Keyed by
  // resource id (or OID, like the catalog routes), not schema+name like
  // tables: functions can be overloaded (Foundations.md §11.7), so a name alone
  // doesn't identify one.
  const RESOURCE_PATH = (what: string) => ({ id: { ...RESOURCE_ID_PARAM, description: `The ${what}'s TotalBase resource id, or its PostgreSQL OID.` } });

  app.delete<{ Params: { id: string }; Querystring: { cascade?: string } }>(
    "/admin/api/schema/views/:id",
    {
      preHandler,
      ...doc({
        summary: "Drop a view",
        description: "DROP VIEW (a materialized view too). 400 INVALID_QUERY when the resource is not a VIEW.",
        pathParameters: RESOURCE_PATH("view"),
        parameters: [CASCADE_PARAM],
        response: NO_CONTENT,
        errors: ["409"],
      }),
    },
    async (request, reply) => {
      const resource = await resourceByPathId(context, request.params.id);
      if (resource.type !== "VIEW") throw new TotalBaseError("INVALID_QUERY", `Resource ${request.params.id} is not a VIEW.`);
      await auditedDdl(context, request, "drop_view", { resourceId: resource.id, schema: resource.schema, name: resource.name }, (audit) =>
        context.relationDrop.dropView(resource.postgresOid, request.query.cascade === "true", audit));
      await refreshCatalog(context);
      reply.code(204);
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { cascade?: string } }>(
    "/admin/api/schema/functions/:id",
    {
      preHandler,
      ...doc({
        summary: "Drop a function",
        description: "DROP FUNCTION of exactly this overload (by OID). 400 INVALID_QUERY when the resource is not a FUNCTION.",
        pathParameters: RESOURCE_PATH("function"),
        parameters: [CASCADE_PARAM],
        response: NO_CONTENT,
        errors: ["409"],
      }),
    },
    async (request, reply) => {
      const resource = await resourceByPathId(context, request.params.id);
      if (resource.type !== "FUNCTION") throw new TotalBaseError("INVALID_QUERY", `Resource ${request.params.id} is not a FUNCTION.`);
      await auditedDdl(context, request, "drop_function", { resourceId: resource.id, schema: resource.schema, name: resource.name }, (audit) =>
        context.relationDrop.dropFunction(resource.postgresOid, request.query.cascade === "true", audit));
      await refreshCatalog(context);
      reply.code(204);
    },
  );
}
