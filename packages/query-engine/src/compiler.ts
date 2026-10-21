import { TotalBaseError } from "@totalbase/errors";
import type { PermissionDecision } from "@totalbase/permissions";
import type { AggregateNode, CompiledQuery, FieldNode, FilterNode, OrderNode, QueryAST } from "./ast.js";
import { compileFilter } from "./filter-compiler.js";
import { JoinRegistry, resolvePath } from "./path-resolver.js";
import { limitOffsetClause, quoteIdentifier, ROW_VERSION_SQL, searchMatchSql, searchPattern } from "./pg-dialect.js";
import type { ResolvedResource, SchemaContext } from "./schema-context.js";
import { coerceLiteral } from "./value-coercion.js";

export interface CompileOptions {
  root: ResolvedResource;
  ast: QueryAST;
  schemaContext: SchemaContext;
  /** Field-level permission decision; only called for fields that pass column resolution. */
  fieldDecision: (dottedPath: string) => PermissionDecision;
  /** Effective row filter from the permission resolver (already OR-combined across roles). undefined = unrestricted. */
  rowFilter: FilterNode | undefined;
  resolveUserVariable: (field: string) => unknown;
  defaultLimit: number;
  maxLimit: number;
  maxOffset: number;
  /** A table's row read by key: also its version (xmin as text, `__version`) - what If-Match sends back (T56). */
  withVersion?: boolean;
  /**
   * The resource's default order (Foundations.md §11.7), used when the request asks for none and isn't grouped or
   * aggregated - then the primary key as the tiebreaker, so pages never overlap. A column it no longer has is skipped.
   */
  defaultOrderBy?: readonly { column: string; direction: "asc" | "desc" }[];
}

const TEXTUAL_TYPES = /^(text|character varying|character|"char")(?:$|\s)/;

const NUMERIC_TYPES = /^(smallint|integer|bigint|numeric|real|double precision)(?:$|\()/;
const NUMERIC_TERM = /^-?\d+(\.\d+)?$/;

function isTextualType(dataType: string): boolean {
  return TEXTUAL_TYPES.test(dataType);
}

function requireAllowed(decision: PermissionDecision, dottedPath: string): void {
  if (decision !== "ALLOW") {
    throw new TotalBaseError("FIELD_PERMISSION_DENIED", `Field not authorized: ${dottedPath}`);
  }
}

/** The resource's default order, then its primary key - nothing when neither exists (PostgreSQL's order, as before). */
function defaultOrder(root: ResolvedResource, defaults: readonly { column: string; direction: "asc" | "desc" }[]): OrderNode[] | undefined {
  const known = new Set(root.columns.map((c) => c.name));
  const nodes: OrderNode[] = defaults
    .filter((d) => known.has(d.column))
    .map((d) => ({ path: [d.column], direction: d.direction === "desc" ? "DESC" : "ASC" }));
  for (const column of root.primaryKey) {
    if (!nodes.some((n) => n.path[0] === column)) nodes.push({ path: [column], direction: "ASC" });
  }
  return nodes.length ? nodes : undefined;
}

/** The column a flag is read in - `takeFlags` turns them into `meta.flags`. */
export function flagColumn(index: number): string {
  return `__flag_${index}`;
}

/**
 * The flags each row met, by name, in the rows' order (`meta.flags`) - their columns taken out of the rows.
 */
export function takeFlags(rows: Record<string, unknown>[], flags: readonly { name: string }[] | undefined): string[][] | undefined {
  if (!flags?.length) return undefined;
  return rows.map((row) => flags.flatMap((flag, index) => {
    const column = flagColumn(index);
    const met = row[column] === true;
    delete row[column];
    return met ? [flag.name] : [];
  }));
}

export async function compileSelect(options: CompileOptions): Promise<CompiledQuery> {
  const { root, schemaContext, fieldDecision } = options;
  // The default order is the server's, not the request's (Data_API.md §3.6): like a row filter (§6.5)
  // it needs no field grant - a role reading only `name` still lists the rows in key order - but a DENY (a
  // protected or denied column) never orders them: that column is left out of it.
  const implicitOrder = !(options.ast.orderBy?.length || options.ast.groupBy?.length || options.ast.aggregates?.length);
  const ast = implicitOrder
    ? { ...options.ast, orderBy: defaultOrder(root, options.defaultOrderBy ?? [])?.filter((node) => fieldDecision(node.path.join(".")) !== "DENY") }
    : options.ast;
  const orderDecision = implicitOrder ? () => "ALLOW" as const : fieldDecision;
  const registry = new JoinRegistry();
  const params: unknown[] = [];

  const pushParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const filterContext = {
    async resolveColumn(path: string[]) {
      const resolved = await resolvePath(schemaContext, registry, root, path);
      requireAllowed(fieldDecision(path.join(".")), path.join("."));
      return { columnSql: resolved.columnSql, dataType: resolved.resource.columns.find((c) => c.name === resolved.columnName)!.dataType };
    },
    coerceLiteral,
    resolveUserVariable: options.resolveUserVariable,
  };

  // The permission's own row filter is the grant's, written by an administrator - its paths need no field grant
  // (Security.md §6.5), only never a DENY: a protected or a Password column stays out of every filter
  // (§10.2), and a field an administrator denied does too.
  const rowFilterContext = {
    ...filterContext,
    async resolveColumn(path: string[]) {
      const resolved = await resolvePath(schemaContext, registry, root, path);
      if (fieldDecision(path.join(".")) === "DENY") requireAllowed("DENY", path.join("."));
      return { columnSql: resolved.columnSql, dataType: resolved.resource.columns.find((c) => c.name === resolved.columnName)!.dataType };
    },
  };

  const isGrouped = Boolean(ast.aggregates?.length || ast.groupBy?.length);

  const selectColumns: string[] = [];
  const groupBySql: string[] = [];

  if (isGrouped) {
    for (const groupPath of ast.groupBy ?? []) {
      const dotted = groupPath.join(".");
      requireAllowed(fieldDecision(dotted), dotted);
      const resolved = await resolvePath(schemaContext, registry, root, groupPath);
      const alias = quoteIdentifier(dotted);
      selectColumns.push(`${resolved.columnSql} AS ${alias}`);
      groupBySql.push(resolved.columnSql);
    }
    for (const agg of ast.aggregates ?? []) {
      selectColumns.push(await compileAggregate(agg, schemaContext, registry, root, fieldDecision));
    }
  } else {
    const fields = await resolveProjection(ast.fields, root, schemaContext, registry, fieldDecision);
    for (const { alias, columnSql } of fields) {
      selectColumns.push(`${columnSql} AS ${quoteIdentifier(alias)}`);
    }
    if (options.withVersion) selectColumns.push(ROW_VERSION_SQL(registry.rootAlias));
  }

  // WHERE: request filter AND permission row filter, combined.
  const whereParts: string[] = [];
  if (ast.where) {
    const compiled = await compileFilter(ast.where, filterContext, params.length);
    whereParts.push(compiled.sql);
    params.push(...compiled.params);
  }
  if (options.rowFilter) {
    const compiled = await compileFilter(options.rowFilter, rowFilterContext, params.length);
    whereParts.push(compiled.sql);
    params.push(...compiled.params);
  }
  if (ast.search) {
    const searchSql = await compileSearch(ast.search, ast.fields, ast.searchFields, root, schemaContext, registry, fieldDecision, pushParam);
    if (searchSql) whereParts.push(searchSql);
  }

  // Joins may have been added by WHERE/search resolution after the projection was built; that's fine,
  // registry.joins accumulates everything and is emitted once below.

  let fromSql = ` FROM ${quoteIdentifier(root.schema)}.${quoteIdentifier(root.table)} AS ${registry.rootAlias}`;
  for (const join of registry.joins) fromSql += ` ${join.sql}`;
  if (whereParts.length > 0) fromSql += ` WHERE ${whereParts.join(" AND ")}`;

  let groupHavingSql = "";
  if (isGrouped && groupBySql.length > 0) {
    groupHavingSql += ` GROUP BY ${groupBySql.join(", ")}`;
  }
  const havingParams: unknown[] = [];
  if (ast.having) {
    const havingContext = havingFilterContext(
      filterContext,
      ast.aggregates ?? [],
      schemaContext,
      registry,
      root,
      fieldDecision,
    );
    const compiled = await compileFilter(ast.having, havingContext, params.length + havingParams.length);
    groupHavingSql += ` HAVING ${compiled.sql}`;
    havingParams.push(...compiled.params);
  }

  let orderBySql = "";
  if (ast.orderBy?.length) {
    const orderParts = await Promise.all(
      ast.orderBy.map((node) => compileOrderNode(node, ast.aggregates ?? [], schemaContext, registry, root, orderDecision)),
    );
    orderBySql = ` ORDER BY ${orderParts.join(", ")}`;
  }

  // Params up to this point (WHERE + HAVING) are shared by both the row
  // query and the count query; flags and LIMIT/OFFSET params are row-query only.
  const sharedParams = [...params, ...havingParams];

  // Flags (Data_API.md §3.9): each a boolean column - whether the row meets that filter, compiled as
  // `where` is (the same paths and field permissions). Never on a grouped read: a group isn't a row.
  const flagParams: unknown[] = [];
  if (ast.flags?.length) {
    if (isGrouped) throw new TotalBaseError("INVALID_QUERY", "flags apply to rows - not to a grouped read.");
    for (const [index, flag] of ast.flags.entries()) {
      const compiled = await compileFilter(flag.filter, filterContext, sharedParams.length + flagParams.length);
      selectColumns.push(`COALESCE((${compiled.sql}), false) AS ${quoteIdentifier(flagColumn(index))}`);
      flagParams.push(...compiled.params);
    }
  }

  const limit = Math.min(ast.limit ?? options.defaultLimit, options.maxLimit);
  const offset = Math.min(ast.offset ?? 0, options.maxOffset);
  const rowParams = [...sharedParams, ...flagParams, limit, offset];
  const sql =
    `SELECT ${selectColumns.join(", ")}${fromSql}${groupHavingSql}${orderBySql}` +
    limitOffsetClause(`$${rowParams.length - 1}`, `$${rowParams.length}`);

  let countSql: string | undefined;
  let countParams: unknown[] | undefined;
  if (ast.count) {
    countSql = isGrouped
      ? `SELECT count(*) AS count FROM (SELECT 1${fromSql}${groupHavingSql}) sub`
      : `SELECT count(*) AS count${fromSql}`;
    countParams = sharedParams;
  }

  return { sql, params: rowParams, countSql, countParams };
}

async function resolveProjection(
  fields: FieldNode[] | undefined,
  root: ResolvedResource,
  schemaContext: SchemaContext,
  registry: JoinRegistry,
  fieldDecision: (dottedPath: string) => PermissionDecision,
): Promise<{ alias: string; columnSql: string }[]> {
  if (fields && fields.length > 0) {
    const seenAliases = new Set<string>();
    const result: { alias: string; columnSql: string }[] = [];
    for (const field of fields) {
      const dotted = field.path.join(".");
      requireAllowed(fieldDecision(dotted), dotted);
      const resolved = await resolvePath(schemaContext, registry, root, field.path);
      const alias = field.alias ?? (field.path.length > 1 ? dotted : field.path[0]!);
      if (seenAliases.has(alias)) {
        throw new TotalBaseError("INVALID_ALIAS", `Duplicate output alias: ${alias}`);
      }
      seenAliases.add(alias);
      result.push({ alias, columnSql: resolved.columnSql });
    }
    return result;
  }

  // No explicit fields: project every root column the caller is authorized to READ.
  const result: { alias: string; columnSql: string }[] = [];
  for (const column of root.columns) {
    if (fieldDecision(column.name) !== "ALLOW") continue;
    result.push({ alias: column.name, columnSql: `${registry.rootAlias}.${quoteIdentifier(column.name)}` });
  }
  return result;
}

/** Builds the bare aggregate SQL expression, e.g. "SUM(t0."price")", without an alias. */
async function aggregateExpressionSql(
  agg: AggregateNode,
  schemaContext: SchemaContext,
  registry: JoinRegistry,
  root: ResolvedResource,
  fieldDecision: (dottedPath: string) => PermissionDecision,
): Promise<string> {
  const fn = agg.fn.slice(1).toUpperCase(); // "_sum" -> "SUM"

  if (agg.path === "*") {
    if (agg.fn !== "_count") {
      throw new TotalBaseError("INVALID_QUERY", `${agg.fn}[*] is only valid for _count.`);
    }
    return "COUNT(*)";
  }

  const dotted = agg.path.join(".");
  requireAllowed(fieldDecision(dotted), dotted);
  const resolved = await resolvePath(schemaContext, registry, root, agg.path);
  return `${fn}(${resolved.columnSql})`;
}

async function compileAggregate(
  agg: AggregateNode,
  schemaContext: SchemaContext,
  registry: JoinRegistry,
  root: ResolvedResource,
  fieldDecision: (dottedPath: string) => PermissionDecision,
): Promise<string> {
  const expr = await aggregateExpressionSql(agg, schemaContext, registry, root, fieldDecision);
  return `${expr} AS ${quoteIdentifier(agg.alias)}`;
}

function havingFilterContext(
  base: {
    resolveColumn(path: string[]): Promise<{ columnSql: string; dataType: string }>;
    coerceLiteral(raw: string, dataType: string): unknown;
    resolveUserVariable(field: string): unknown;
  },
  aggregates: AggregateNode[],
  schemaContext: SchemaContext,
  registry: JoinRegistry,
  root: ResolvedResource,
  fieldDecision: (dottedPath: string) => PermissionDecision,
) {
  return {
    ...base,
    async resolveColumn(path: string[]) {
      if (path.length === 1) {
        const agg = aggregates.find((a) => a.alias === path[0]);
        if (agg) {
          // PostgreSQL does not allow referencing a SELECT-list alias in
          // HAVING, so the aggregate expression is rebuilt here rather
          // than quoting the alias.
          const expr = await aggregateExpressionSql(agg, schemaContext, registry, root, fieldDecision);
          return { columnSql: expr, dataType: "numeric" };
        }
      }
      return base.resolveColumn(path);
    },
  };
}

async function compileOrderNode(
  node: OrderNode,
  aggregates: AggregateNode[],
  schemaContext: SchemaContext,
  registry: JoinRegistry,
  root: ResolvedResource,
  fieldDecision: (dottedPath: string) => PermissionDecision,
): Promise<string> {
  if (node.path.length === 1) {
    const agg = aggregates.find((a) => a.alias === node.path[0]);
    if (agg) return `${quoteIdentifier(agg.alias)} ${node.direction}`;
  }
  const dotted = node.path.join(".");
  requireAllowed(fieldDecision(dotted), dotted);
  const resolved = await resolvePath(schemaContext, registry, root, node.path);
  return `${resolved.columnSql} ${node.direction}`;
}

async function compileSearch(
  search: string,
  fields: FieldNode[] | undefined,
  searchFields: string[][] | undefined,
  root: ResolvedResource,
  schemaContext: SchemaContext,
  registry: JoinRegistry,
  fieldDecision: (dottedPath: string) => PermissionDecision,
  pushParam: (value: unknown) => string,
): Promise<string | undefined> {
  // Data_API.md §3.5: `search_fields` names exactly the paths searched; else the fields read; else
  // the root columns. A field the role may not read (a protected or password column among them) is skipped - never
  // searched, never an error. No other FK is traversed.
  const candidatePaths: string[][] = searchFields ?? (fields?.length ? fields.map((f) => f.path) : root.columns.map((c) => [c.name]));

  const resolvedFields: { columnSql: string; kind: SearchKind }[] = [];
  for (const path of candidatePaths) {
    if (fieldDecision(path.join(".")) !== "ALLOW") continue;
    const resolved = await resolvePath(schemaContext, registry, root, path);
    const kind = searchKindOf(resolved.resource.columns.find((c) => c.name === resolved.columnName)!.dataType);
    if (kind) resolvedFields.push({ columnSql: resolved.columnSql, kind });
  }

  // Every word is a term; a row matches when each term is found in some field (AND across terms, OR across
  // fields). Text by substring, case and accents aside; a number, a UUID, a date (ISO) or a time (HH:mm) only
  // by its exact value, and only in a field of that kind.
  const terms = search.trim().split(/\s+/).filter((t) => t.length > 0);
  const termParts: string[] = [];
  for (const term of terms) {
    const parts: string[] = [];
    for (const field of resolvedFields) {
      const sql = termMatchSql(field.columnSql, field.kind, term, pushParam);
      if (sql) parts.push(sql);
    }
    // Nothing this term can match in: no row matches - never the whole table, as if there were no search at all.
    if (parts.length === 0) return "FALSE";
    termParts.push(`(${parts.join(" OR ")})`);
  }
  if (termParts.length === 0) return undefined;
  return termParts.length === 1 ? termParts[0] : `(${termParts.join(" AND ")})`;
}

type SearchKind = "text" | "number" | "uuid" | "date" | "timestamp" | "time";

/** Which columns a search can compare, by PostgreSQL type - anything else (boolean, json, arrays, geometry...) is never searched. */
function searchKindOf(dataType: string): SearchKind | null {
  if (isTextualType(dataType)) return "text";
  if (NUMERIC_TYPES.test(dataType)) return "number";
  if (dataType === "uuid") return "uuid";
  if (dataType === "date") return "date";
  if (/^timestamp/.test(dataType)) return "timestamp";
  if (/^time(?:\(\d+\))?(?: without time zone)?$/.test(dataType)) return "time";
  return null;
}

/** A whole UUID typed as a term (copied from a URL). */
const UUID_TERM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A day in ISO form - what the API takes; the admin turns what its viewer types in their own format into it. */
const DATE_TERM = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_TERM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** A real calendar day - `2026-02-30` is not one, and is never sent to PostgreSQL to fail on. */
function isCalendarDay(term: string): boolean {
  const m = DATE_TERM.exec(term);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** One term against one field, or null when the term can't match that kind. */
function termMatchSql(columnSql: string, kind: SearchKind, term: string, pushParam: (value: unknown) => string): string | null {
  switch (kind) {
    case "text":
      return searchMatchSql(columnSql, pushParam(searchPattern(term)));
    case "number":
      return NUMERIC_TERM.test(term) ? `${columnSql} = ${pushParam(term)}::numeric` : null;
    case "uuid":
      return UUID_TERM.test(term) ? `${columnSql} = ${pushParam(term.toLowerCase())}::uuid` : null;
    case "date":
      return isCalendarDay(term) ? `${columnSql} = ${pushParam(term)}::date` : null;
    case "timestamp": {
      // That whole day, in the session's time zone - PostgreSQL's cast decides where it starts and ends.
      if (!isCalendarDay(term)) return null;
      const day = pushParam(term);
      return `(${columnSql} >= ${day}::date AND ${columnSql} < ${day}::date + 1)`;
    }
    case "time": {
      if (!TIME_TERM.test(term)) return null;
      const minute = pushParam(term);
      return `(${columnSql} >= ${minute}::time AND ${columnSql} < ${minute}::time + interval '1 minute')`;
    }
  }
}
