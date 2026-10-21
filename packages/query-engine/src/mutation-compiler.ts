import { TotalBaseError, deniedMessage } from "@totalbase/errors";
import type { PermissionDecision } from "@totalbase/permissions";
import type { FilterNode } from "./ast.js";
import { compileFilter, type FilterCompileContext } from "./filter-compiler.js";
import { mutationFilterContext, type RelatedResolver } from "./mutation-filter-context.js";
import {
  deleteWithReturning,
  excludedColumnSql,
  insertManyWithReturningCte,
  insertWithReturningCte,
  onConflictNothingSql,
  onConflictUpdateSql,
  pointLiteral,
  qualifiedTable,
  quoteIdentifier,
  updateFromLockedRowsCte,
  updateReturningOldCte,
  updateWithReturningCte,
  upsertWithReturningCte,
} from "./pg-dialect.js";
import type { ResolvedResource } from "./schema-context.js";

export interface OnConflictNothing {
  target: string[];
  action: "NOTHING";
}
export interface OnConflictUpdate {
  target: string[];
  action: "UPDATE";
  /** Values may be literals or the string "$INSERT.<field>", resolved to PostgreSQL's EXCLUDED.<field>. */
  data: Record<string, unknown>;
}
export type OnConflictSpec = OnConflictNothing | OnConflictUpdate;

/** One "Payload check" (totalbase.permissions.payload_checks) - a role-scoped CREATE/UPDATE business-rule check, evaluated against the resulting row. Not a PostgreSQL CHECK constraint. */
export interface PayloadCheckRule {
  rule: FilterNode;
  label: string | null;
}

export interface MutationCompileContext {
  root: ResolvedResource;
  fieldDecision: (field: string) => PermissionDecision;
  rowFilter: FilterNode | undefined;
  /** AND-combined (every ALLOW grant's checks apply), unlike rowFilter's OR. undefined/empty = no checks. */
  payloadChecks: PayloadCheckRule[] | undefined;
  resolveUserVariable: (field: string) => unknown;
  /**
   * compileInsert with `on_conflict` action UPDATE only: the caller's UPDATE
   * authorization, which the DO UPDATE branch must satisfy (an existing row
   * becoming an update is an UPDATE - Data_API.md §5.7). Its absence
   * makes such an on_conflict fail closed.
   */
  conflictUpdate?: ConflictUpdateAuthorization;
  /**
   * The server supports RETURNING OLD (PostgreSQL 18+): compileUpdate then
   * reads a table without a primary key's old values in the UPDATE itself.
   * Unset/false (PostgreSQL 15-17): such a table records new values only.
   */
  returningOld?: boolean;
  /**
   * Resolves a relation path's tables (SchemaContext.resolveRelated): with it, the grant's row filter and payload
   * checks may follow foreign keys (`technician.user`, Security.md §6.5). Without it, they can't.
   */
  related?: RelatedResolver;
}

/** The UPDATE grant's decisions, resolved by the same Permission Resolver as the CREATE ones beside them. */
export interface ConflictUpdateAuthorization {
  fieldDecision: (field: string) => PermissionDecision;
  rowFilter: FilterNode | undefined;
  payloadChecks: PayloadCheckRule[] | undefined;
}

/** One __payload_check_N column appended per payload check, so the caller can report exactly which one(s) failed by label. */
export interface PayloadCheckColumn {
  column: string;
  label: string | null;
}

/** One __old_N column compileUpdate returns per requested old-value field: the value `field` had before this UPDATE. */
export interface OldValueColumn {
  column: string;
  field: string;
}

export interface CompiledMutation {
  sql: string;
  params: unknown[];
  /** Only meaningful for compileInsert/compileUpdate - empty for compileDelete. */
  payloadCheckColumns: PayloadCheckColumn[];
  /** compileUpdate, and compileInsert's DO UPDATE branch, for the oldValueFields it was asked for - empty otherwise. */
  oldValueColumns: OldValueColumn[];
  /**
   * compileInsert with `on_conflict` action UPDATE only: the boolean column
   * telling each returned row's branch - true inserted (a CREATE), false an
   * existing row updated (an UPDATE). Such a statement returning no row
   * means the conflicting row exists but the UPDATE row filter excluded it.
   */
  insertedColumn?: string;
}

function requireFieldAllowed(fieldDecision: (field: string) => PermissionDecision, field: string): void {
  if (fieldDecision(field) !== "ALLOW") {
    throw new TotalBaseError("FIELD_PERMISSION_DENIED", `Field not authorized: ${field}`);
  }
}

function requireColumn(root: ResolvedResource, field: string) {
  const column = root.columns.find((c) => c.name === field);
  if (!column) {
    throw new TotalBaseError("INVALID_FIELD", `Unknown field: ${root.table}.${field}`);
  }
  return column;
}

/**
 * JSON body values need no string coercion (unlike query-string literals);
 * jsonb objects are serialized by node-postgres automatically. `point` is
 * the one exception - node-postgres has no serializer for it, so a
 * `{ lng, lat }` object needs turning into its `"(x,y)"` literal here
 * (packages/database's own type parser is the read-side counterpart).
 */
function toParam(value: unknown, dataType: string): unknown {
  if (dataType === "point") return pointLiteral(value);
  return value;
}

function validateConflictTarget(root: ResolvedResource, target: string[]): void {
  const sorted = [...target].sort();
  const matchesSet = (set: string[]) => {
    const s = [...set].sort();
    return s.length === sorted.length && s.every((c, i) => c === sorted[i]);
  };
  const valid = matchesSet(root.primaryKey) || root.uniqueConstraints.some(matchesSet);
  if (!valid) {
    throw new TotalBaseError(
      "INVALID_ON_CONFLICT",
      `on_conflict.target must match a real PRIMARY KEY or UNIQUE constraint: ${target.join(", ")}`,
    );
  }
}

const TABLE_ALIAS = "t0";
const OLD_ROWS_ALIAS = "old_rows";

/**
 * Appends __authorized (row filter, Security.md §6.6 "authorize NEW") plus one
 * __payload_check_N column per payload check - each compiled to real SQL
 * and evaluated by PostgreSQL against the CTE's actual resulting row
 * (defaults, triggers, generated columns and all), not the raw payload
 * in JS. The caller checks every flag after the statement runs and rolls
 * back if any is false; payloadCheckColumns lets it report which
 * check(s) failed by label.
 */
async function appendAuthorizationFlags(
  baseSql: string,
  baseParams: unknown[],
  rowFilter: FilterNode | undefined,
  payloadChecks: PayloadCheckRule[] | undefined,
  filterContext: FilterCompileContext,
  fromClause: string,
  updatedBranch?: { insertedSql: string; rowFilter: FilterNode | undefined; payloadChecks: PayloadCheckRule[] | undefined },
): Promise<CompiledMutation> {
  let sql = baseSql;
  let params = baseParams;

  const compileFlag = async (filter: FilterNode | undefined): Promise<string> => {
    if (!filter) return "true";
    const compiled = await compileFilter(filter, filterContext, params.length);
    params = [...params, ...compiled.params];
    return `(${compiled.sql})`;
  };

  if (!updatedBranch) {
    sql += `, ${await compileFlag(rowFilter)} AS __authorized`;
  } else {
    // An upsert: the inserted row answers to the CREATE grant, an updated one to the UPDATE grant.
    const created = await compileFlag(rowFilter);
    const updated = await compileFlag(updatedBranch.rowFilter);
    sql += `, CASE WHEN ${updatedBranch.insertedSql} THEN ${created} ELSE ${updated} END AS __authorized`;
  }

  // Each check applies only on its own branch: CREATE's to an inserted row, UPDATE's to an updated one.
  const checks: { check: PayloadCheckRule; branch: "ANY" | "INSERTED" | "UPDATED" }[] = updatedBranch
    ? [
      ...(payloadChecks ?? []).map((check) => ({ check, branch: "INSERTED" as const })),
      ...(updatedBranch.payloadChecks ?? []).map((check) => ({ check, branch: "UPDATED" as const })),
    ]
    : (payloadChecks ?? []).map((check) => ({ check, branch: "ANY" as const }));

  const payloadCheckColumns: PayloadCheckColumn[] = [];
  for (const [index, { check, branch }] of checks.entries()) {
    const column = `__payload_check_${index}`;
    const flag = await compileFlag(check.rule);
    if (branch === "ANY") sql += `, ${flag} AS ${column}`;
    else if (branch === "INSERTED") sql += `, CASE WHEN ${updatedBranch!.insertedSql} THEN ${flag} ELSE true END AS ${column}`;
    else sql += `, CASE WHEN ${updatedBranch!.insertedSql} THEN true ELSE ${flag} END AS ${column}`;
    payloadCheckColumns.push({ column, label: check.label });
  }

  return { sql: `${sql}${fromClause}`, params, payloadCheckColumns, oldValueColumns: [] };
}

const INSERTED_COLUMN = "__inserted";

/**
 * INSERT ... RETURNING *, with the effective row filter (Security.md §6.6:
 * "authorize NEW") checked via an __authorized flag column so the
 * caller can roll back the transaction if it's false.
 *
 * `on_conflict` DO UPDATE turns the statement into an upsert, authorized per
 * branch (Data_API.md §5.7): the inserted row by the CREATE grant
 * (`context`), an updated existing row by the UPDATE grant
 * (`context.conflictUpdate`) - its SET fields need UPDATE field ALLOW, its
 * row filter is the DO UPDATE's own WHERE against the existing row (OLD; a
 * row it rejects stays untouched and returns nothing) and is re-evaluated,
 * with UPDATE's payload checks, against the updated row (NEW).
 * `oldValueFields` (every column - the UPDATE's audit and outbox event, spec
 * Security.md §11.4) also returns, as __old_N, the
 * updated row's values from before the update, when the conflict target's
 * values are all in `data` (the row can only be found by them).
 */
export async function compileInsert(
  context: MutationCompileContext,
  data: Record<string, unknown>,
  onConflict?: OnConflictSpec,
  oldValueFields?: Iterable<string>,
): Promise<CompiledMutation> {
  const { root, fieldDecision, rowFilter, payloadChecks, resolveUserVariable } = context;
  // An empty `data` is a row made only of the table's defaults (DEFAULT
  // VALUES) - still checked against the row filter and payload checks below.
  const fields = Object.keys(data);

  const params: unknown[] = [];
  const columnsSql: string[] = [];
  const placeholders: string[] = [];

  for (const field of fields) {
    requireFieldAllowed(fieldDecision, field);
    const column = requireColumn(root, field);
    columnsSql.push(quoteIdentifier(field));
    params.push(toParam(data[field], column.dataType));
    placeholders.push(`$${params.length}`);
  }

  const table = qualifiedTable(root.schema, root.table);
  const filterContext = mutationFilterContext(root, "ins", resolveUserVariable, context.related);

  if (onConflict?.action !== "UPDATE") {
    let onConflictSql = "";
    if (onConflict) {
      validateConflictTarget(root, onConflict.target);
      onConflictSql = onConflictNothingSql(onConflict.target.map(quoteIdentifier).join(", "));
    }
    const sql = insertWithReturningCte("ins", table, columnsSql, placeholders, onConflictSql);
    return appendAuthorizationFlags(sql, params, rowFilter, payloadChecks, filterContext, " FROM ins");
  }

  validateConflictTarget(root, onConflict.target);
  const update = context.conflictUpdate;
  if (!update) {
    throw new TotalBaseError("ACTION_DENIED", deniedMessage("UPDATE", root.schema, root.table));
  }

  const setParts: string[] = [];
  for (const [field, value] of Object.entries(onConflict.data ?? {})) {
    requireFieldAllowed(update.fieldDecision, field);
    const column = requireColumn(root, field);
    if (typeof value === "string" && value.startsWith("$INSERT.")) {
      const sourceField = value.slice("$INSERT.".length);
      requireColumn(root, sourceField);
      setParts.push(`${quoteIdentifier(field)} = ${excludedColumnSql(sourceField)}`);
    } else {
      params.push(toParam(value, column.dataType));
      setParts.push(`${quoteIdentifier(field)} = $${params.length}`);
    }
  }
  if (setParts.length === 0) {
    throw new TotalBaseError("INVALID_ON_CONFLICT", "on_conflict action UPDATE requires at least one field in on_conflict.data.");
  }

  // OLD: the UPDATE row filter decides which existing rows the DO UPDATE may touch.
  let conflictWhere: string | undefined;
  if (update.rowFilter) {
    const compiled = await compileFilter(update.rowFilter, mutationFilterContext(root, TABLE_ALIAS, resolveUserVariable, context.related), params.length);
    conflictWhere = compiled.sql;
    params.push(...compiled.params);
  }
  const onConflictSql = onConflictUpdateSql(onConflict.target.map(quoteIdentifier).join(", "), setParts, conflictWhere);

  // The conflicting row is found by the target's values, which must all be in `data`.
  const oldFields = onConflict.target.every((field) => fields.includes(field))
    ? [...new Set(oldValueFields ?? [])].filter((field) => root.columns.some((c) => c.name === field))
    : [];
  const oldValueColumns: OldValueColumn[] = oldFields.map((field, index) => ({ column: `__old_${index}`, field }));
  const locked = oldValueColumns.length === 0
    ? undefined
    : {
      whereSql: onConflict.target
        .map((field) => `${TABLE_ALIAS}.${quoteIdentifier(field)} = $${fields.indexOf(field) + 1}`)
        .join(" AND "),
      oldColumns: oldValueColumns,
    };

  const { sql, fromClause } = upsertWithReturningCte(
    "ins", OLD_ROWS_ALIAS, table, TABLE_ALIAS, columnsSql, placeholders, onConflictSql, INSERTED_COLUMN, locked,
  );
  // NEW: per branch, against the row the statement returned.
  const compiled = await appendAuthorizationFlags(sql, params, rowFilter, payloadChecks, filterContext, fromClause, {
    insertedSql: `ins.${INSERTED_COLUMN}`,
    rowFilter: update.rowFilter,
    payloadChecks: update.payloadChecks,
  });
  return { ...compiled, oldValueColumns, insertedColumn: INSERTED_COLUMN };
}

/**
 * compileInsert for a bulk CREATE whose items all carry the same fields
 * (`fields`, every item's own keys) and no `on_conflict`: one INSERT over
 * the items as a jsonb array (insertManyWithReturningCte), returning one
 * row per item in request order, each with the same __authorized and
 * __payload_check_N flags a single-row INSERT returns.
 * Items with mixed field sets, an `on_conflict`, or no fields at all
 * (DEFAULT VALUES is single-row) stay on compileInsert, one per item.
 */
export async function compileInsertMany(
  context: MutationCompileContext,
  fields: string[],
  items: Record<string, unknown>[],
): Promise<CompiledMutation> {
  const { root, fieldDecision, rowFilter, payloadChecks, resolveUserVariable } = context;
  if (fields.length === 0) {
    throw new TotalBaseError("INVALID_QUERY", "A multi-row INSERT needs at least one field.");
  }
  const columnsSql: string[] = [];
  const dataTypes: Record<string, string> = {};
  for (const field of fields) {
    requireFieldAllowed(fieldDecision, field);
    columnsSql.push(quoteIdentifier(field));
    dataTypes[field] = requireColumn(root, field).dataType;
  }
  // The same per-value preparation a single-row INSERT's parameters get (toParam), item by item.
  const docs = items.map((item) => Object.fromEntries(fields.map((field) => [field, toParam(item[field], dataTypes[field]!)])));
  const params: unknown[] = [JSON.stringify(docs)];

  const sql = insertManyWithReturningCte("ins", qualifiedTable(root.schema, root.table), columnsSql, "$1");
  return appendAuthorizationFlags(sql, params, rowFilter, payloadChecks, mutationFilterContext(root, "ins", resolveUserVariable, context.related), " FROM ins");
}

/**
 * UPDATE ... RETURNING *. WHERE enforces OLD authorization (rows must
 * already satisfy the row filter to be touched); __authorized reflects
 * whether the resulting NEW row still satisfies it (Security.md §6.6).
 *
 * `oldValueFields` (every column - the UPDATE's audit and outbox event,
 * Security.md §11.4) also returns each of those columns' value before the UPDATE, as
 * __old_N (see oldValueColumns), in the same statement: a CTE selects and
 * locks the target rows (`FOR UPDATE OF t0`, so the values read are the
 * ones this UPDATE then overwrites, even under a concurrent writer) and
 * the UPDATE joins them by primary key. A table with no primary key to
 * join by reads them with RETURNING OLD on PostgreSQL 18+
 * (`context.returningOld`) and not at all before it. Without such fields
 * it is the plain UPDATE.
 */
export async function compileUpdate(
  context: MutationCompileContext,
  data: Record<string, unknown>,
  where: FilterNode | undefined,
  oldValueFields?: Iterable<string>,
  /** If-Match: the row's version (xmin) the caller read - a row written since isn't matched (T56). */
  expectedVersion?: string,
): Promise<CompiledMutation> {
  const { root, fieldDecision, rowFilter, payloadChecks, resolveUserVariable } = context;
  const fields = Object.keys(data);
  if (fields.length === 0) {
    throw new TotalBaseError("INVALID_QUERY", "UPDATE requires at least one field in data.");
  }

  const params: unknown[] = [];
  const setParts: string[] = [];
  for (const field of fields) {
    requireFieldAllowed(fieldDecision, field);
    const column = requireColumn(root, field);
    params.push(toParam(data[field], column.dataType));
    setParts.push(`${quoteIdentifier(field)} = $${params.length}`);
  }

  // The request's where reads the table's own columns; the grant's row filter may follow its foreign keys.
  const whereContext = mutationFilterContext(root, TABLE_ALIAS, resolveUserVariable);
  const oldContext = mutationFilterContext(root, TABLE_ALIAS, resolveUserVariable, context.related);
  const whereParts: string[] = [];

  if (where) {
    const compiled = await compileFilter(where, whereContext, params.length);
    whereParts.push(compiled.sql);
    params.push(...compiled.params);
  }
  if (rowFilter) {
    const compiled = await compileFilter(rowFilter, oldContext, params.length);
    whereParts.push(compiled.sql);
    params.push(...compiled.params);
  }
  if (expectedVersion !== undefined) {
    params.push(expectedVersion);
    whereParts.push(`${TABLE_ALIAS}.xmin::text = $${params.length}`);
  }

  const whereSql = whereParts.length > 0 ? ` WHERE ${whereParts.join(" AND ")}` : "";
  const table = qualifiedTable(root.schema, root.table);

  // Unknown names (a configured field whose column was dropped since) are skipped, not an error.
  const hasPrimaryKey = root.primaryKey.length > 0;
  const oldFields = !hasPrimaryKey && context.returningOld !== true
    ? []
    : [...new Set(oldValueFields ?? [])].filter((field) => root.columns.some((c) => c.name === field));
  const oldValueColumns: OldValueColumn[] = oldFields.map((field, index) => ({ column: `__old_${index}`, field }));

  const sql = oldValueColumns.length === 0
    ? updateWithReturningCte("upd", table, TABLE_ALIAS, setParts, whereSql)
    : !hasPrimaryKey
    ? updateReturningOldCte("upd", table, TABLE_ALIAS, setParts, whereSql, OLD_ROWS_ALIAS, oldValueColumns)
    : updateFromLockedRowsCte(
      "upd",
      OLD_ROWS_ALIAS,
      table,
      TABLE_ALIAS,
      setParts,
      whereSql,
      root.primaryKey.map((field, index) => ({ field, column: `__old_key_${index}` })),
      oldValueColumns,
    );

  // Re-evaluate the row filter (and payload checks) against the CTE's NEW values (the "upd" alias).
  const newContext = mutationFilterContext(root, "upd", resolveUserVariable, context.related);
  const compiled = await appendAuthorizationFlags(sql, params, rowFilter, payloadChecks, newContext, " FROM upd");
  return { ...compiled, oldValueColumns };
}

/** DELETE ... RETURNING *. WHERE enforces OLD authorization only (Security.md §6.6). */
export async function compileDelete(
  context: MutationCompileContext,
  where: FilterNode | undefined,
  /** If-Match: the row's version (xmin) the caller read (T56). */
  expectedVersion?: string,
): Promise<CompiledMutation> {
  const { root, rowFilter, resolveUserVariable } = context;
  const whereContext = mutationFilterContext(root, TABLE_ALIAS, resolveUserVariable);
  const filterContext = mutationFilterContext(root, TABLE_ALIAS, resolveUserVariable, context.related);
  const params: unknown[] = [];
  const whereParts: string[] = [];

  if (where) {
    const compiled = await compileFilter(where, whereContext, params.length);
    whereParts.push(compiled.sql);
    params.push(...compiled.params);
  }
  if (rowFilter) {
    const compiled = await compileFilter(rowFilter, filterContext, params.length);
    whereParts.push(compiled.sql);
    params.push(...compiled.params);
  }

  if (expectedVersion !== undefined) {
    params.push(expectedVersion);
    whereParts.push(`${TABLE_ALIAS}.xmin::text = $${params.length}`);
  }

  const whereSql = whereParts.length > 0 ? ` WHERE ${whereParts.join(" AND ")}` : "";
  const sql = deleteWithReturning(qualifiedTable(root.schema, root.table), TABLE_ALIAS, whereSql);
  return { sql, params, payloadCheckColumns: [], oldValueColumns: [] };
}

/**
 * Whether a row matching `where` is one this caller may act on (its row filter) - a write that matched nothing
 * under If-Match tells a row written since (409) from one that isn't there for them (404), never revealing a row
 * the filter hides (T56).
 */
export async function compileRowExists(context: MutationCompileContext, where: FilterNode): Promise<{ sql: string; params: unknown[] }> {
  const { root, rowFilter, resolveUserVariable } = context;
  const contexts = [mutationFilterContext(root, TABLE_ALIAS, resolveUserVariable), mutationFilterContext(root, TABLE_ALIAS, resolveUserVariable, context.related)];
  const params: unknown[] = [];
  const parts: string[] = [];
  for (const [index, filter] of [where, rowFilter].entries()) {
    if (!filter) continue;
    const compiled = await compileFilter(filter, contexts[index]!, params.length);
    parts.push(compiled.sql);
    params.push(...compiled.params);
  }
  return { sql: `SELECT 1 FROM ${qualifiedTable(root.schema, root.table)} AS ${TABLE_ALIAS} WHERE ${parts.join(" AND ")} LIMIT 1`, params };
}

/**
 * Resolves, through the pool, every table the grant's row filters and payload checks reach through a relation, so
 * compiling the write inside its transaction finds them already in `related`'s cache (SchemaContext) and never waits
 * on a second connection. A filter that names an unknown path fails here, before BEGIN, as it would there.
 */
export async function preloadRelations(context: MutationCompileContext): Promise<void> {
  if (!context.related) return;
  const filters: FilterNode[] = [
    ...(context.rowFilter ? [context.rowFilter] : []),
    ...(context.payloadChecks ?? []).map((check) => check.rule),
    ...(context.conflictUpdate?.rowFilter ? [context.conflictUpdate.rowFilter] : []),
    ...(context.conflictUpdate?.payloadChecks ?? []).map((check) => check.rule),
  ];
  const filterContext = mutationFilterContext(context.root, TABLE_ALIAS, context.resolveUserVariable, context.related);
  for (const filter of filters) await compileFilter(filter, filterContext, 0);
}
