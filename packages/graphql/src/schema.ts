import {
  GraphQLEnumType,
  GraphQLString,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  type GraphQLScalarType,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigMap,
  type GraphQLInputFieldConfigMap,
  type GraphQLResolveInfo,
  type GraphQLOutputType,
} from "graphql";
import type { Database } from "@totalbase/database";
import { getFunctionDetail, type ColumnDefinition } from "@totalbase/pg-catalog";
import type { EffectivePermissionService, PermissionDecision, ResourceAction } from "@totalbase/permissions";
import { TotalBaseError } from "@totalbase/errors";
import { SchemaContext, type OnConflictSpec, type ResolvedResource } from "@totalbase/query-engine";
import { getPasswordColumns } from "@totalbase/resources";
import { GraphQLJSON, ON_CONFLICT, ORDER_DIRECTION, SHARED_TYPE_NAMES, columnType, comparisonType, isGraphQLName, isOrderable } from "./types.js";
import { filterFromInput, nestRows, orderByFromInput, pathKey, selectedPaths, subFieldNodes, type Batcher, type Shape, type Shapes } from "./translate.js";

type FieldDecision = (field: string) => PermissionDecision;

/** A TABLE or VIEW as a root field names it - the executor resolves it as the REST route does (exposure, status). */
export interface GraphQLResourceRef {
  schema: string;
  name: string;
  type: "TABLE" | "VIEW";
}

/**
 * What a root field runs: the Data API's read and write paths and its function calls, for the request's
 * principal (apps/server's data-read.ts, data-write.ts, @totalbase/mutations' function-call-service.ts). The
 * schema only translates; everything that decides is behind this.
 */
export interface GraphQLDataExecutor {
  /** `withVersion`: each row's version (Data_API.md §5.3) under ROW_VERSION_COLUMN, for `_version`; `limitPer`: limit and offset per value of that column. */
  readRows(
    resource: GraphQLResourceRef,
    rawQuery: Record<string, unknown>,
    options?: { withVersion?: boolean; limitPer?: string },
  ): Promise<{ data: unknown[]; meta?: { count?: number } | undefined }>;
  createRows(resource: GraphQLResourceRef, input: { data: unknown; bulk: boolean; onConflict?: OnConflictSpec | undefined }): Promise<unknown>;
  /** `version`: If-Match's (Data_API.md §5.3); answers the row and its new version. */
  updateRowByKey(resource: GraphQLResourceRef, pk: string, data: unknown, version: string | undefined): Promise<{ row: unknown; version: string | undefined }>;
  updateRows(resource: GraphQLResourceRef, input: { data: unknown; where: unknown }): Promise<unknown[]>;
  deleteRowByKey(resource: GraphQLResourceRef, pk: string, version: string | undefined): Promise<unknown>;
  deleteRows(resource: GraphQLResourceRef, input: { where: unknown }): Promise<unknown[]>;
  /** POST /api/{schema}/function/{name}: the overload is the one its arguments' names match (Data_API.md §7). */
  callFunction(schema: string, name: string, args: Record<string, unknown>): Promise<unknown>;
  /**
   * A realtime subscription (Data_API.md §16.4), authorized before it exists; its changes until the iterator
   * returns. Only over the WebSocket - absent, a subscription is refused.
   */
  subscribe?(resource: GraphQLResourceRef, intent: GraphQLSubscriptionIntent): Promise<AsyncIterable<GraphQLChange>>;
}

export interface GraphQLSubscriptionIntent {
  events: ("create" | "update" | "delete")[];
  /** rows: each change read again with the subscriber's grants; summary: only that rows changed, nothing read (Data_API.md §16.5). */
  mode: "rows" | "summary";
  fields?: string;
  where?: unknown;
}

/** One message of a subscription: rows for create and update, keys for delete; an error that leaves it on, or that ends it. */
export interface GraphQLChange {
  event: "init" | "create" | "update" | "delete" | "truncate" | "reset";
  data?: Record<string, unknown>[];
  error?: unknown;
}

const REALTIME_EVENT = new GraphQLEnumType({
  name: "realtime_event",
  description: "INIT: the subscription is on. RESET: changes may have been missed - read again.",
  values: Object.fromEntries(["INIT", "CREATE", "UPDATE", "DELETE", "TRUNCATE", "RESET"].map((value) => [value, { value }])),
});

/** The contextValue an execution against a built schema takes; executeGraphQL adds the request's batcher. */
export interface GraphQLExecutionContext {
  executor: GraphQLDataExecutor;
  batcher?: Batcher;
}

/** A table row's version (Data_API.md §5.3): read with the row, sent back as `version` - If-Match's. */
const VERSION_FIELD = "_version";
const VERSION_FIELD_CONFIG = {
  type: GraphQLString,
  description: "The row's version: send it as version to _update_by_pk or _delete_by_pk, which refuse it once the row changed (ROW_VERSION_CONFLICT). Not in subscriptions.",
};
const VERSION_ARG = { type: GraphQLString, description: "The _version you read: refused with ROW_VERSION_CONFLICT if the row changed since." };

function versionOf(args: Record<string, unknown>): string | undefined {
  const version = args["version"];
  if (version === undefined || version === null) return undefined;
  if (typeof version !== "string" || !/^\d+$/.test(version)) throw new TotalBaseError("INVALID_QUERY", "version must be a _version this API answered.");
  return version;
}

/** A field whose resolver is a Data API call - what graphql.max_calls counts. */
export const DATA_API_CALL = { totalbaseCall: true };

export interface GraphQLSchemaOptions {
  /** The always-on field floor every Data API call applies (apps/server: protected columns, guarded writes), as buildPublicOpenApiSpec takes it. */
  guardFieldDecision?: (resource: ResolvedResource, action: ResourceAction, decision: FieldDecision) => FieldDecision;
  /** api.max_relation_depth: how many hops relation fields go. */
  maxRelationDepth: number;
  /** graphql.default_schema: whose objects are named without the `{schema}_` prefix. */
  defaultSchema: string;
  /** api.max_limit: the most child rows one one-to-many read returns - more is refused, never cut. */
  maxLimit: number;
  /** realtime.enabled: a Subscription type for the tables exposing REALTIME. */
  subscriptions: boolean;
}

/** A TABLE the caller may create rows of, as a nested create reaches it (Data_API.md §6): its columns and result. */
interface Creatable {
  ref: GraphQLResourceRef;
  base: string;
  resource: ResolvedResource;
  /** The create input's columns, and which are required. */
  columns: { column: ColumnDefinition; required: boolean; password: boolean }[];
  result: GraphQLObjectType | undefined;
}

/**
 * Nested create (Data_API.md §17.5): the child fields a resource's create input and result gain, and how each
 * maps to REST's `$<child_table>` - filled once every resource is built (addNestedCreateFields).
 */
interface NestedCreates {
  inputFields: Map<string, GraphQLInputFieldConfigMap>;
  resultFields: Map<string, GraphQLFieldConfigMap<unknown, GraphQLExecutionContext>>;
  children: Map<string, Map<string, { table: string; childKey: string }>>;
}

/** A readable TABLE or VIEW, as a one-to-many field reaches it: its row type and its read's inputs. */
interface Readable {
  ref: GraphQLResourceRef;
  base: string;
  resource: ResolvedResource;
  read: ReadNode;
  object: GraphQLObjectType;
  where: GraphQLInputObjectType;
  orderBy: GraphQLInputObjectType;
}

interface ResourceRow {
  id: string;
  postgres_oid: number;
  schema: string;
  name: string;
  type: "TABLE" | "VIEW" | "FUNCTION";
  exposed_methods: string[];
  function_class: "UNCLASSIFIED" | "QUERY" | "ACTION" | null;
}

const ACTION_METHOD: Record<"CREATE" | "READ" | "UPDATE" | "DELETE", string> = { CREATE: "POST", READ: "GET", UPDATE: "PATCH", DELETE: "DELETE" };

/** A row type, as read: the columns its READ grant allows and its relation fields, each one hop further. */
interface ReadNode {
  typeName: string;
  columns: ColumnDefinition[];
  relations: { field: string; fk: string; node: ReadNode }[];
}

/**
 * The GraphQL schema of what `roleIds` may do right now (Data_API.md §17.3): built from the same catalog,
 * resources, permissions and guardrails as the OpenAPI document (Data_API.md §14.1). It lists; it never
 * authorizes - every root field still goes through the executor, the Permission Resolver and PostgreSQL.
 */
export async function buildGraphQLSchema(
  database: Database,
  effectivePermissions: EffectivePermissionService,
  roleIds: string[],
  options: GraphQLSchemaOptions,
): Promise<GraphQLSchema> {
  const { rows } = await database.query<ResourceRow>(
    `SELECT id, postgres_oid, "schema", name, type, exposed_methods, function_class FROM totalbase.resources
     WHERE status = 'ACTIVE' AND exposed_methods <> '{}'
     ORDER BY ("schema" = $1) DESC, "schema", name`,
    [options.defaultSchema],
  );
  const schemaContext = new SchemaContext(database);
  const taken = new Set<string>(SHARED_TYPE_NAMES);
  const shapes: Shapes = new Map();
  const query: GraphQLFieldConfigMap<unknown, GraphQLExecutionContext> = {};
  const mutation: GraphQLFieldConfigMap<unknown, GraphQLExecutionContext> = {};
  const subscription: GraphQLFieldConfigMap<unknown, GraphQLExecutionContext> = {};
  const readables = new Map<string, Readable>();
  const toManyFields = new Map<string, GraphQLFieldConfigMap<unknown, GraphQLExecutionContext>>();
  const creatables = new Map<string, Creatable>();
  const nested: NestedCreates = { inputFields: new Map(), resultFields: new Map(), children: new Map() };

  for (const row of rows) {
    // `__` separates a schema from its object (GraphQL names have no `.`): a name that holds it is left out, so
    // `sales__orders` is only ever sales.orders. The default schema's objects come first and keep their names.
    if (row.schema.includes("__") || row.name.includes("__")) continue;
    const base = row.schema === options.defaultSchema ? row.name : `${row.schema}__${row.name}`;
    if (!isGraphQLName(base)) continue;

    if (row.type === "FUNCTION") {
      const built = await buildFunction(database, effectivePermissions, roleIds, row, base);
      if (!built || built.names.some((name) => taken.has(name))) continue;
      for (const name of built.names) taken.add(name);
      (row.function_class === "QUERY" ? query : mutation)[base] = { ...built.field, extensions: DATA_API_CALL };
      continue;
    }
    const ref: GraphQLResourceRef = { schema: row.schema, name: row.name, type: row.type };

    const actions = (row.type === "TABLE" ? (["CREATE", "READ", "UPDATE", "DELETE"] as const) : (["READ"] as const)).filter((action) =>
      row.exposed_methods.includes(ACTION_METHOD[action]),
    );
    const decisions = new Map<ResourceAction, FieldDecision>();
    const resource = await schemaContext.loadRoot(row.schema, row.name, row.postgres_oid);
    const guard = options.guardFieldDecision ?? ((_resource, _action, decision) => decision);
    for (const action of actions) {
      const permission = await effectivePermissions.resolve(roleIds, row.id, action);
      if (permission.action === "ALLOW") decisions.set(action, guard(resource, action, permission.fieldDecision));
    }
    if (decisions.size === 0) continue;

    const passwordColumns = await getPasswordColumns(database, row.id);
    const readDecision = decisions.get("READ");
    const read = readDecision
      ? await readNode(schemaContext, resource, (path) => (passwordColumns.has(path) ? "DENY" : readDecision(path)), base, [], options.maxRelationDepth)
      : undefined;

    const built = buildResource({ row, ref, resource, base, read, decisions, passwordColumns }, shapes, toManyFields, nested);
    // Another resource's generated names (or a shared type's) win: this one is left out rather than renamed.
    if ([...built.names].some((name) => taken.has(name))) continue;
    for (const name of built.names) taken.add(name);
    for (const [name, shape] of built.shapes) shapes.set(name, shape);
    for (const [name, field] of Object.entries(built.query)) query[name] = { ...field, extensions: DATA_API_CALL };
    for (const [name, field] of Object.entries(built.mutation)) mutation[name] = { ...field, extensions: DATA_API_CALL };
    if (built.readable) readables.set(`${row.schema}.${row.name}`, built.readable);
    if (built.creatable) creatables.set(`${row.schema}.${row.name}`, built.creatable);
    if (options.subscriptions && built.readable && row.exposed_methods.includes("REALTIME")) {
      const field = subscriptionField(built.readable, shapes, taken);
      if (field) subscription[base] = field;
    }
  }

  addToManyFields(readables, shapes, toManyFields, options.maxLimit);
  addNestedCreateFields(creatables, nested, taken);

  return new GraphQLSchema({
    // A schema needs a Query type with a field even for a caller who may read nothing.
    query: new GraphQLObjectType({
      name: "Query",
      fields: Object.keys(query).length > 0 ? query : { _empty: { type: GraphQLInt, description: "Nothing here is readable with your roles.", resolve: () => null } },
    }),
    ...(Object.keys(mutation).length > 0 && { mutation: new GraphQLObjectType({ name: "Mutation", fields: mutation }) }),
    ...(Object.keys(subscription).length > 0 && { subscription: new GraphQLObjectType({ name: "Subscription", fields: subscription }) }),
  });
}

async function readNode(
  schemaContext: SchemaContext,
  resource: ResolvedResource,
  decision: FieldDecision,
  typeName: string,
  prefix: string[],
  depthLeft: number,
): Promise<ReadNode | undefined> {
  const path = (name: string) => [...prefix, name].join(".");
  const columns = resource.columns.filter((column) => isGraphQLName(column.name) && decision(path(column.name)) === "ALLOW");
  const relations: ReadNode["relations"] = [];
  if (depthLeft > 0) {
    const columnNames = new Set(resource.columns.map((column) => column.name));
    const seen = new Set<string>();
    for (const relation of resource.relations) {
      const field = `${relation.sourceColumn}_row`;
      // A real column of that name keeps it; a composite key's other columns repeat its first.
      if (!isGraphQLName(relation.sourceColumn) || columnNames.has(field) || seen.has(relation.sourceColumn)) continue;
      seen.add(relation.sourceColumn);
      let target: ResolvedResource;
      try {
        // INVALID_RELATION for a target that isn't ACTIVE with GET exposed (Security.md §6.10) - not a field then.
        target = await schemaContext.resolveRelated(relation.targetSchema, relation.targetTable);
      } catch {
        continue;
      }
      const node = await readNode(schemaContext, target, decision, `${typeName}__${field}`, [...prefix, relation.sourceColumn], depthLeft - 1);
      if (node) relations.push({ field, fk: relation.sourceColumn, node });
    }
  }
  return columns.length > 0 || relations.length > 0 ? { typeName, columns, relations } : undefined;
}

interface BuiltResource {
  readable: Readable | undefined;
  creatable: Creatable | undefined;
  names: Set<string>;
  shapes: Map<string, Shape>;
  query: GraphQLFieldConfigMap<unknown, GraphQLExecutionContext>;
  mutation: GraphQLFieldConfigMap<unknown, GraphQLExecutionContext>;
}

function buildResource(input: {
  row: ResourceRow;
  ref: GraphQLResourceRef;
  resource: ResolvedResource;
  base: string;
  read: ReadNode | undefined;
  decisions: Map<ResourceAction, FieldDecision>;
  passwordColumns: ReadonlySet<string>;
}, allShapes: Shapes, toManyFields: Map<string, GraphQLFieldConfigMap<unknown, GraphQLExecutionContext>>, nested: NestedCreates): BuiltResource {
  const { row, ref, resource, base, read, decisions, passwordColumns } = input;
  const key = `${row.schema}.${row.name}`;
  const names = new Set<string>();
  const shapes = new Map<string, Shape>();
  const nonNullColumn = (column: ColumnDefinition) => row.type === "TABLE" && !column.nullable;
  // A table row's version (Data_API.md §5.3) - `_version`, unless a column takes the name.
  const versioned = row.type === "TABLE" && !resource.columns.some((column) => column.name === VERSION_FIELD);

  // Row, where and order_by types per read node.
  const objects = new Map<string, GraphQLObjectType>();
  const wheres = new Map<string, GraphQLInputObjectType>();
  const orders = new Map<string, GraphQLInputObjectType>();
  const visit = (node: ReadNode) => {
    names.add(node.typeName).add(`${node.typeName}_where`).add(`${node.typeName}_order_by`);
    shapes.set(node.typeName, {
      relations: new Map(node.relations.map((r) => [r.field, { fk: r.fk, typeName: r.node.typeName }])),
      ...(node === read && versioned && { version: true }),
    });
    objects.set(node.typeName, new GraphQLObjectType({
      name: node.typeName,
      fields: () => ({
        ...Object.fromEntries(node.columns.map((column) => [column.name, { type: columnType(column.dataType, nonNullColumn(column)) }])),
        ...Object.fromEntries(node.relations.map((r) => [r.field, { type: objects.get(r.node.typeName)!, description: `The row ${r.fk} points at.` }])),
        ...(node === read && versioned && { [VERSION_FIELD]: VERSION_FIELD_CONFIG }),
        // A resource's own row type also lists the rows of other tables pointing at it (addToManyFields).
        ...(node === read ? toManyFields.get(node.typeName) : undefined),
      }),
    }));
    wheres.set(node.typeName, new GraphQLInputObjectType({
      name: `${node.typeName}_where`,
      fields: (): GraphQLInputFieldConfigMap => {
        const self = wheres.get(node.typeName)!;
        return {
          _and: { type: new GraphQLList(new GraphQLNonNull(self)) },
          _or: { type: new GraphQLList(new GraphQLNonNull(self)) },
          _not: { type: self },
          ...Object.fromEntries(node.columns.map((column) => [column.name, { type: comparisonType(column.dataType) }])),
          ...Object.fromEntries(node.relations.map((r) => [r.field, { type: wheres.get(r.node.typeName)! }])),
        };
      },
    }));
    const orderable = node.columns.filter((column) => isOrderable(column.dataType));
    orders.set(node.typeName, new GraphQLInputObjectType({
      name: `${node.typeName}_order_by`,
      description: "One field per item: list several items to order by several.",
      fields: () => ({
        ...Object.fromEntries(orderable.map((column) => [column.name, { type: ORDER_DIRECTION }])),
        ...Object.fromEntries(node.relations.map((r) => [r.field, { type: orders.get(r.node.typeName)! }])),
      }),
    }));
    for (const relation of node.relations) visit(relation.node);
  };
  if (read) visit(read);

  // What a write returns (apps/server response-projection.ts): the READ grant's root columns, or only the
  // primary key without READ - never a relation (Data_API.md §5.5).
  const resultColumns = read
    ? read.columns
    : resource.columns.filter((column) => resource.primaryKey.includes(column.name) && isGraphQLName(column.name));
  const resultName = `${base}_result`;
  const result = resultColumns.length > 0
    ? new GraphQLObjectType({
        name: resultName,
        fields: () => ({
          ...Object.fromEntries(resultColumns.filter((c) => !passwordColumns.has(c.name)).map((column) => [column.name, { type: columnType(column.dataType, nonNullColumn(column)) }])),
          ...(versioned && { [VERSION_FIELD]: { type: GraphQLString, description: "The row's new version: answered by _update_by_pk." } }),
          // The children a nested create made with it (addNestedCreateFields).
          ...nested.resultFields.get(key),
        }),
      })
    : undefined;
  if (result) names.add(resultName);

  const pkColumn = resource.primaryKey.length === 1 ? resource.columns.find((column) => column.name === resource.primaryKey[0]) : undefined;
  const pkArg = pkColumn && isGraphQLName(pkColumn.name) ? pkColumn : undefined;

  const writeColumns = (action: "CREATE" | "UPDATE") => {
    const decision = decisions.get(action);
    if (!decision) return [];
    return resource.columns
      .filter((column) => !column.isGenerated && isGraphQLName(column.name) && decision(column.name) === "ALLOW")
      .map((column) => ({
        column,
        required: action === "CREATE" && !column.nullable && column.defaultExpression === null && !column.isIdentity && !column.isGenerated,
        password: passwordColumns.has(column.name),
      }));
  };
  const writeInput = (action: "CREATE" | "UPDATE", name: string) => {
    const columns = writeColumns(action);
    if (columns.length === 0) return undefined;
    names.add(name);
    return new GraphQLInputObjectType({
      name,
      fields: () => ({
        ...inputFieldsOf(columns),
        // A create's children, written with it in one transaction (addNestedCreateFields).
        ...(action === "CREATE" ? nested.inputFields.get(key) : undefined),
      }),
    });
  };
  const createInput = row.type === "TABLE" ? writeInput("CREATE", `${base}_create`) : undefined;
  const updateInput = row.type === "TABLE" ? writeInput("UPDATE", `${base}_update`) : undefined;

  const queryFields = (): GraphQLFieldConfigMap<unknown, GraphQLExecutionContext> => {
    if (!read) return {};
    const object = objects.get(read.typeName)!;
    const readRows = async (args: Record<string, unknown>, context: GraphQLExecutionContext, info: GraphQLResolveInfo, where: unknown, limit?: number) => {
      const fields = selectedPaths(info, allShapes, read.typeName);
      const withVersion = versioned && subFieldNodes(info, VERSION_FIELD).length > 0;
      const { data: rows } = await context.executor.readRows(ref, {
        ...(fields.length > 0 && { fields: fields.join(",") }),
        ...(where !== undefined && where !== null && { where }),
        ...(args["order_by"] !== undefined && { order_by: orderByFromInput(args["order_by"], allShapes, read.typeName) }),
        ...(limit !== undefined ? { limit } : args["limit"] !== undefined && args["limit"] !== null && { limit: args["limit"] }),
        ...(args["offset"] !== undefined && args["offset"] !== null && { offset: args["offset"] }),
      }, { withVersion });
      return nestRows(rows, allShapes, read.typeName);
    };
    names.add(base);
    const fields: GraphQLFieldConfigMap<unknown, GraphQLExecutionContext> = {
      [base]: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(object))),
        args: {
          where: { type: wheres.get(read.typeName)! },
          order_by: { type: new GraphQLList(new GraphQLNonNull(orders.get(read.typeName)!)) },
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
        },
        resolve: (_source, args, context, info) => readRows(args, context, info, filterFromInput(args["where"], allShapes, read.typeName)),
      },
    };
    // REST's count=true (Data_API.md §3.10): the rows `where` matches within the row filter, none of them read.
    names.add(`${base}_count`);
    fields[`${base}_count`] = {
      type: new GraphQLNonNull(GraphQLInt),
      args: { where: { type: wheres.get(read.typeName)! } },
      resolve: async (_source, args, context) => {
        const where = filterFromInput(args["where"], allShapes, read.typeName);
        const { meta } = await context.executor.readRows(ref, {
          ...(read.columns[0] && { fields: read.columns[0].name }),
          ...(where !== undefined && where !== null && { where }),
          count: true,
          limit: 0,
        });
        return meta?.count ?? 0;
      },
    };
    // By key only for a single-column key the caller may read (Data_API.md §2.1, §4.2).
    if (pkArg && read.columns.some((column) => column.name === pkArg.name)) {
      fields[`${base}_by_pk`] = {
        type: object,
        args: { [pkArg.name]: { type: columnType(pkArg.dataType, true) } },
        resolve: async (_source, args, context, info) =>
          (await readRows({}, context, info, { [pkArg.name]: { _eq: args[pkArg.name] } }, 1))[0] ?? null,
      };
    }
    return fields;
  };

  const mutationFields = (): GraphQLFieldConfigMap<unknown, GraphQLExecutionContext> => {
    if (row.type !== "TABLE" || !result) return {};
    const fields: GraphQLFieldConfigMap<unknown, GraphQLExecutionContext> = {};
    const add = (name: string, config: GraphQLFieldConfig<unknown, GraphQLExecutionContext>) => {
      names.add(name);
      fields[name] = config;
    };
    const one = (value: unknown) => (value === undefined || value === null ? null : nestRows([value], allShapes, resultName)[0]);
    const many = (values: unknown) => nestRows(values as unknown[], allShapes, resultName);
    const where = read ? wheres.get(read.typeName) : undefined;
    const whereOf = (args: Record<string, unknown>) => (read && args["where"] !== undefined ? filterFromInput(args["where"], allShapes, read.typeName) : undefined);
    const pkType = pkArg ? columnType(pkArg.dataType, true) : undefined;

    if (createInput) {
      add(`${base}_insert`, {
        type: new GraphQLNonNull(new GraphQLList(result)),
        description: "One transaction for every row; a skipped row (on_conflict NOTHING) is null.",
        args: { data: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(createInput))) }, on_conflict: { type: ON_CONFLICT } },
        resolve: async (_s, args, context) =>
          many(await context.executor.createRows(ref, { data: toNestedPayload(args["data"], key, nested), bulk: true, onConflict: args["on_conflict"] as OnConflictSpec | undefined })),
      });
      add(`${base}_insert_one`, {
        type: result,
        args: { data: { type: new GraphQLNonNull(createInput) }, on_conflict: { type: ON_CONFLICT } },
        resolve: async (_s, args, context) =>
          fromNestedResult(one(await context.executor.createRows(ref, { data: toNestedPayload(args["data"], key, nested), bulk: false, onConflict: args["on_conflict"] as OnConflictSpec | undefined })), key, nested),
      });
    }
    if (updateInput) {
      if (where) {
        add(`${base}_update`, {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(result))),
          description: "Every row matching where - required unless api.require_where_for_update is off.",
          args: { where: { type: where }, data: { type: new GraphQLNonNull(updateInput) } },
          resolve: async (_s, args, context) => many(await context.executor.updateRows(ref, { data: args["data"], where: whereOf(args) })),
        });
      }
      if (pkArg && pkType) {
        add(`${base}_update_by_pk`, {
          type: result,
          args: { [pkArg.name]: { type: pkType }, data: { type: new GraphQLNonNull(updateInput) }, ...(versioned && { version: VERSION_ARG }) },
          resolve: async (_s, args, context) => {
            const { row, version } = await context.executor.updateRowByKey(ref, String(args[pkArg.name]), args["data"], versionOf(args));
            const updated = one(row);
            return updated && versioned ? { ...updated, [VERSION_FIELD]: version ?? null } : updated;
          },
        });
      }
    }
    if (decisions.has("DELETE")) {
      if (where) {
        add(`${base}_delete`, {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(result))),
          description: "Every row matching where - required unless api.require_where_for_delete is off.",
          args: { where: { type: where } },
          resolve: async (_s, args, context) => many(await context.executor.deleteRows(ref, { where: whereOf(args) })),
        });
      }
      if (pkArg && pkType) {
        add(`${base}_delete_by_pk`, {
          type: result,
          args: { [pkArg.name]: { type: pkType }, ...(versioned && { version: VERSION_ARG }) },
          resolve: async (_s, args, context) => one(await context.executor.deleteRowByKey(ref, String(args[pkArg.name]), versionOf(args))),
        });
      }
    }
    return fields;
  };

  // Built now, so the root field names are claimed with the types; resolved later against every resource's shapes.
  shapes.set(resultName, { relations: new Map() });
  const readable = read
    ? { ref, base, resource, read, object: objects.get(read.typeName)!, where: wheres.get(read.typeName)!, orderBy: orders.get(read.typeName)! }
    : undefined;
  const creatable = createInput && row.type === "TABLE" ? { ref, base, resource, columns: writeColumns("CREATE"), result } : undefined;
  return { readable, creatable, names, shapes, query: queryFields(), mutation: mutationFields() };
}

/**
 * A FUNCTION with EXECUTE allowed and POST exposed as one root field (Data_API.md §17.6): QUERY on Query,
 * ACTION and UNCLASSIFIED on Mutation - an unclassified one may write. Its arguments are its IN parameters,
 * required without a default; the result is JSON - a list for one that returns rows - as the catalog doesn't
 * describe its columns (OpenAPI leaves it open too). Overloads share the name: the first one's arguments, and
 * the call resolves the overload by the names it gets.
 */
async function buildFunction(
  database: Database,
  effectivePermissions: EffectivePermissionService,
  roleIds: string[],
  row: ResourceRow,
  base: string,
): Promise<{ field: GraphQLFieldConfig<unknown, GraphQLExecutionContext>; names: string[] } | undefined> {
  if (!row.exposed_methods.includes("POST")) return undefined;
  if ((await effectivePermissions.resolve(roleIds, row.id, "EXECUTE")).action !== "ALLOW") return undefined;
  const detail = await getFunctionDetail(database, row.postgres_oid);
  if (detail.parameters.some((parameter) => !isGraphQLName(parameter.name))) return undefined;

  // The result typed as PostgreSQL declares it (Data_API.md §17.6): a row's columns as `{base}_returns`, a
  // scalar's type; what it doesn't declare (SETOF record, void, a pseudo-type) stays JSON. Nullable throughout:
  // a function's result columns carry no NOT NULL.
  const names = [base];
  let type: GraphQLOutputType = GraphQLJSON;
  if (detail.returnsRows) {
    const columns = detail.resultColumns;
    const typed = columns && columns.every((column) => isGraphQLName(column.name) && !column.name.startsWith("__"));
    let item: GraphQLOutputType = GraphQLJSON;
    if (typed) {
      const typeName = `${base}_returns`;
      names.push(typeName);
      item = new GraphQLObjectType({
        name: typeName,
        description: `A row ${base} returns.`,
        fields: Object.fromEntries(columns.map((column) => [column.name, { type: columnType(column.dataType, false) }])),
      });
    }
    type = new GraphQLNonNull(new GraphQLList(item));
  } else if (detail.resultType !== null) {
    type = columnType(detail.resultType, false);
  }
  return {
    names,
    field: {
      type,
      ...(row.function_class === "UNCLASSIFIED" || row.function_class === null
        ? { description: "Not classified: treat it as one that may change data." }
        : {}),
      args: Object.fromEntries(detail.parameters.map((parameter) => [parameter.name, { type: columnType(parameter.dataType, !parameter.hasDefault) }])),
      resolve: async (_source, args, context) => {
        // An argument left out is left out: PostgreSQL's default applies.
        const given = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
        const result = await context.executor.callFunction(row.schema, row.name, given);
        return result === undefined ? null : JSON.parse(JSON.stringify(result));
      },
    },
  };
}

/**
 * One-to-many fields (Data_API.md §17.4): for each readable child table with a single-column foreign key into a
 * readable parent, `{child}_by_{fk}` on the parent's row type - the child rows pointing at that row. Each is a
 * read of the child table with the caller's own grants on it (its READ, fields, row filter, audit), as nested
 * CREATE writes each child under its own (Data_API.md §6.4): one read per field and level, not per row - the
 * keys of every parent row in one `_in`. Offered only where the caller reads the child's foreign key and the
 * parent's key, which group them; more child rows than api.max_limit is an error, never a cut list.
 */
function addToManyFields(
  readables: Map<string, Readable>,
  shapes: Shapes,
  toManyFields: Map<string, GraphQLFieldConfigMap<unknown, GraphQLExecutionContext>>,
  maxLimit: number,
): void {
  for (const child of readables.values()) {
    const columnsOf = (r: Readable) => new Set(r.read.columns.map((column) => column.name));
    const childColumns = columnsOf(child);
    for (const relation of child.resource.relations) {
      // A composite foreign key lists each column under one constraint name: it has no single key to group by.
      if (child.resource.relations.filter((other) => other.name === relation.name).length !== 1) continue;
      const parent = readables.get(`${relation.targetSchema}.${relation.targetTable}`);
      if (!parent || !childColumns.has(relation.sourceColumn) || !columnsOf(parent).has(relation.targetColumn)) continue;

      const field = `${child.base}_by_${relation.sourceColumn}`;
      const parentShape = shapes.get(parent.read.typeName)!;
      const fields = (toManyFields.get(parent.read.typeName) ?? {}) as GraphQLFieldConfigMap<unknown, GraphQLExecutionContext>;
      const taken = new Set([...parent.read.columns.map((c) => c.name), ...parentShape.relations.keys(), ...Object.keys(fields)]);
      if (!isGraphQLName(field) || taken.has(field)) continue;

      const fk = relation.sourceColumn;
      const parentKey = relation.targetColumn;
      fields[field] = {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(child.object))),
        description: `The ${child.base} rows whose ${fk} points at this row.`,
        extensions: DATA_API_CALL,
        args: {
          where: { type: child.where },
          order_by: { type: new GraphQLList(new GraphQLNonNull(child.orderBy)) },
          limit: { type: GraphQLInt, description: "At most this many rows for each parent row, in order_by's order." },
          offset: { type: GraphQLInt, description: "Skips this many rows of each parent row first." },
        },
        resolve: async (source, args, context, info) => {
          const key = (source as Record<string, unknown>)[parentKey];
          if (key === null || key === undefined) return [];
          // Every parent row of this field, alias and arguments in the response shares one read.
          const batch = `${pathKey(info.path)}:${JSON.stringify(args)}`;
          const perParent = (args["limit"] ?? null) !== null || (args["offset"] ?? null) !== null;
          return context.batcher!.load(batch, String(key), async (keys) => {
            const paths = new Set([...selectedPaths(info, shapes, child.read.typeName), fk]);
            const inKeys = { [fk]: { _in: keys } };
            const where = args["where"] !== undefined && args["where"] !== null
              ? { _and: [inKeys, filterFromInput(args["where"], shapes, child.read.typeName)] }
              : inKeys;
            const { data, meta } = await context.executor.readRows(child.ref, {
              fields: [...paths].join(","),
              where,
              ...(args["order_by"] !== undefined && args["order_by"] !== null && { order_by: orderByFromInput(args["order_by"], shapes, child.read.typeName) }),
              // A limit or offset is each parent's (limitPer): still at most api.max_limit rows in all.
              ...(perParent ? { limit: args["limit"] ?? maxLimit, offset: args["offset"] ?? 0 } : { limit: maxLimit }),
              count: true,
            }, {
              withVersion: shapes.get(child.read.typeName)?.version === true && subFieldNodes(info, VERSION_FIELD).length > 0,
              ...(perParent && { limitPer: fk }),
            });
            if ((meta?.count ?? 0) > data.length) {
              throw new TotalBaseError(
                "QUERY_COMPLEXITY_LIMIT_EXCEEDED",
                `${field} has more than api.max_limit (${maxLimit}) rows for these ${parent.base} rows - narrow it with where or limit, or read fewer ${parent.base} rows.`,
              );
            }
            const grouped = new Map<string, unknown[]>();
            for (const row of nestRows(data, shapes, child.read.typeName)) {
              const value = String(row[fk]);
              grouped.set(value, [...(grouped.get(value) ?? []), row]);
            }
            return grouped;
          });
        },
      };
      toManyFields.set(parent.read.typeName, fields);
      parentShape.toMany = new Map([...(parentShape.toMany ?? []), [field, { parentKey }]]);
    }
  }
}

/**
 * A table exposing REALTIME as a Subscription field (Data_API.md §17.7): `{name}(where, events)` delivers
 * `{name}_change` - the event, the rows of a create or update (read again with the subscriber's grants), the keys
 * of a delete. Asking for neither `rows`, `keys` nor `where` makes it a summary: only that rows changed, the
 * cheapest way to follow a table (Data_API.md §16.5). Only with a readable single-column key: every event names
 * its rows by it.
 */
function subscriptionField(
  readable: Readable,
  shapes: Shapes,
  taken: Set<string>,
): GraphQLFieldConfig<unknown, GraphQLExecutionContext> | undefined {
  const { resource, read } = readable;
  const key = resource.primaryKey.length === 1 ? read.columns.find((column) => column.name === resource.primaryKey[0]) : undefined;
  const changeName = `${readable.base}_change`;
  if (!key || taken.has(changeName)) return undefined;
  taken.add(changeName);
  const change = new GraphQLObjectType({
    name: changeName,
    fields: {
      event: { type: new GraphQLNonNull(REALTIME_EVENT) },
      rows: { type: new GraphQLList(new GraphQLNonNull(readable.object)), description: "CREATE and UPDATE: the rows as you may read them now." },
      keys: { type: new GraphQLList(new GraphQLNonNull(columnType(key.dataType, false) as GraphQLScalarType)), description: `DELETE: the deleted rows' ${key.name}.` },
    },
  });
  return {
    type: new GraphQLNonNull(change),
    extensions: DATA_API_CALL,
    args: {
      where: { type: readable.where },
      events: { type: new GraphQLList(new GraphQLNonNull(REALTIME_EVENT)), description: "CREATE, UPDATE, DELETE; all three when left out." },
    },
    subscribe: async (_source, args, context, info) => {
      if (!context.executor.subscribe) {
        throw new TotalBaseError("INVALID_QUERY", "A subscription runs over the WebSocket at /api/graphql (graphql-transport-ws).");
      }
      const events = (args["events"] as string[] | undefined) ?? ["CREATE", "UPDATE", "DELETE"];
      if (events.some((event) => event !== "CREATE" && event !== "UPDATE" && event !== "DELETE")) {
        throw new TotalBaseError("INVALID_QUERY", "events takes CREATE, UPDATE and DELETE.");
      }
      const rowsNodes = subFieldNodes(info, "rows");
      const where = args["where"] !== undefined && args["where"] !== null ? filterFromInput(args["where"], shapes, read.typeName) : undefined;
      const mode = rowsNodes.length > 0 || subFieldNodes(info, "keys").length > 0 || where !== undefined ? "rows" : "summary";
      const paths = mode === "rows" ? new Set([key.name, ...selectedPaths({ ...info, fieldNodes: rowsNodes }, shapes, read.typeName, { toMany: "refuse" })]) : undefined;
      return context.executor.subscribe(readable.ref, {
        events: events.map((event) => event.toLowerCase() as "create" | "update" | "delete"),
        mode,
        ...(paths && { fields: [...paths].join(",") }),
        ...(where !== undefined && { where }),
      });
    },
    resolve: (payload) => {
      const { event, data, error } = payload as GraphQLChange;
      if (error !== undefined) throw error;
      return {
        event: event.toUpperCase(),
        rows: (event === "create" || event === "update") && data ? nestRows(data, shapes, read.typeName) : null,
        keys: event === "delete" && data ? data.map((row) => row[key.name]) : null,
      };
    },
  };
}

function inputFieldsOf(columns: Creatable["columns"]): GraphQLInputFieldConfigMap {
  return Object.fromEntries(columns.map(({ column, required, password }) => [column.name, {
    type: columnType(column.dataType, required),
    ...(password && { description: "Stored as a one-way hash; never returned." }),
  }]));
}

/**
 * Nested create (Data_API.md §17.5, §6): a create input gains `{child}_by_{fk}` - the child rows
 * written with the parent in one transaction, each under the caller's own CREATE on the child - where REST's
 * `$<child_table>` reaches: a child table in the parent's schema the caller may create rows of, with exactly one
 * single-column foreign key to the parent. Its input is the child's create input without that key, which
 * TotalBase sets; the result lists the children made.
 */
function addNestedCreateFields(creatables: Map<string, Creatable>, nested: NestedCreates, taken: Set<string>): void {
  for (const [childKey, child] of creatables) {
    for (const relation of child.resource.relations) {
      const parentKey = `${relation.targetSchema}.${relation.targetTable}`;
      const parent = creatables.get(parentKey);
      if (!parent || child.ref.schema !== parent.ref.schema) continue;
      // Exactly one foreign key to the parent, of one column - REST refuses an ambiguous one (AMBIGUOUS_NESTED_RELATION).
      const toParent = child.resource.relations.filter((other) => other.targetSchema === relation.targetSchema && other.targetTable === relation.targetTable);
      if (toParent.length !== 1 || child.resource.relations.filter((other) => other.name === relation.name).length !== 1) continue;

      const fk = relation.sourceColumn;
      const field = `${child.base}_by_${fk}`;
      const inputName = `${child.base}_create_by_${fk}`;
      const parentFields = new Set([...parent.columns.map((c) => c.column.name), ...Object.keys(nested.inputFields.get(parentKey) ?? {})]);
      if (!isGraphQLName(field) || parentFields.has(field) || taken.has(inputName)) continue;
      taken.add(inputName);

      const columns = child.columns.filter((c) => c.column.name !== fk);
      const input = new GraphQLInputObjectType({
        name: inputName,
        description: `A ${child.base} row created with its parent: ${fk} is set by TotalBase.`,
        fields: () => ({ ...inputFieldsOf(columns), ...nested.inputFields.get(childKey) }),
      });
      nested.inputFields.set(parentKey, { ...nested.inputFields.get(parentKey), [field]: { type: new GraphQLList(new GraphQLNonNull(input)) } });
      nested.children.set(parentKey, new Map([...(nested.children.get(parentKey) ?? []), [field, { table: child.ref.name, childKey }]]));
      if (child.result) {
        nested.resultFields.set(parentKey, {
          ...nested.resultFields.get(parentKey),
          [field]: { type: new GraphQLList(new GraphQLNonNull(child.result)), description: "The rows a nested create made with this one." },
        });
      }
    }
  }
}

/** A create input as REST's nested payload: each `{child}_by_{fk}` under `$<child_table>`, recursively. */
function toNestedPayload(data: unknown, key: string, nested: NestedCreates): unknown {
  if (Array.isArray(data)) return data.map((item) => toNestedPayload(item, key, nested));
  const children = nested.children.get(key);
  if (!children || typeof data !== "object" || data === null) return data;
  return Object.fromEntries(Object.entries(data).map(([field, value]) => {
    const child = children.get(field);
    return child ? [`$${child.table}`, toNestedPayload(value, child.childKey, nested)] : [field, value];
  }));
}

/** REST's nested answer back: `$<child_table>` under its `{child}_by_{fk}` field. */
function fromNestedResult(row: Record<string, unknown> | null | undefined, key: string, nested: NestedCreates): Record<string, unknown> | null {
  const children = nested.children.get(key);
  if (!row || !children) return row ?? null;
  const out = { ...row };
  for (const [field, child] of children) {
    const value = out[`$${child.table}`];
    if (value === undefined) continue;
    delete out[`$${child.table}`];
    out[field] = Array.isArray(value) ? value.map((item) => fromNestedResult(item as Record<string, unknown>, child.childKey, nested)) : value;
  }
  return out;
}
