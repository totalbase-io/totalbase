import type { PermissionDecision } from "@totalbase/permissions";
import { compileRowExists, relatedResolver, SchemaContext, type FilterNode, type ResolvedResource } from "@totalbase/query-engine";
import type { Queryable } from "@totalbase/database";
import { buildRowFilter, userVariableResolver, type Limits } from "./mutation-service.js";
import type { DataPrincipal, MutationsContext } from "./context.js";
import { withPasswordColumnsDenied } from "./password-fields.js";
import { protectedFieldDecision } from "./totalbase-guardrails.js";

/**
 * A written row as its caller gets it (`written` "deleted": a row DELETE removed). Read inside the write's
 * transaction - `client` - so a row is judged as the write left it.
 */
export type RowProjection = (row: Record<string, unknown>, client: Queryable, deleted?: { readable: boolean }) => Promise<Record<string, unknown>>;

/**
 * What a mutation may hand back to its caller. Every write is `RETURNING *`,
 * and that full row is still what audit/outbox record - but the caller only
 * sees what a GET would show them: the principal's READ field grant, with
 * the same always-on floor (protected columns, Password columns) every read
 * call site applies, and only for a row the READ grant's row filter lets them
 * read (Security.md §6.6) - a role may update rows it can't read; a deleted
 * row by its `__readable` flag (readRowFilter, compileDelete). Otherwise - no
 * READ grant, a row outside its filter - only the primary key comes back, so
 * the caller can still address the row it just wrote.
 *
 * Resolve once per resource per operation (not per row), like
 * loadPasswordColumns.
 */
export async function mutationResponseProjection(
  context: MutationsContext,
  dataPrincipal: DataPrincipal,
  root: ResolvedResource,
  resourceId: string,
  passwordColumns: Set<string>,
  limits: Limits,
): Promise<RowProjection> {
  const read = await context.effectivePermissions.resolve(dataPrincipal.roleIds, resourceId, "READ");
  const visible = await readableFieldDecision(context, dataPrincipal, root, resourceId, passwordColumns);
  const keyOnly = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([field]) => root.primaryKey.includes(field)));
  const full = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([field]) => visible(field) === "ALLOW"));
  const readFilter = read.action === "ALLOW" ? buildRowFilter(read, limits) : undefined;
  if (read.action !== "ALLOW" || !readFilter) return async (row) => (read.action === "ALLOW" ? full(row) : keyOnly(row));
  const checkContext = {
    root,
    fieldDecision: () => "DENY" as const,
    whereFieldDecision: (field: string) => (root.primaryKey.includes(field) ? ("ALLOW" as const) : ("DENY" as const)),
    rowFilter: readFilter,
    payloadChecks: undefined,
    resolveUserVariable: userVariableResolver(dataPrincipal),
    related: relatedResolver(new SchemaContext(context.database)),
  };
  return async (row, client, deleted) => {
    if (deleted) return deleted.readable ? full(row) : keyOnly(row);
    if (root.primaryKey.length === 0 || root.primaryKey.some((key) => row[key] === undefined)) return keyOnly(row);
    const byKey: FilterNode = root.primaryKey.length === 1
      ? { type: "comparison", path: [root.primaryKey[0]!], operator: "_eq", value: String(row[root.primaryKey[0]!]) }
      : { type: "and", children: root.primaryKey.map((key) => ({ type: "comparison" as const, path: [key], operator: "_eq" as const, value: String(row[key]) })) };
    const compiled = await compileRowExists(checkContext, byKey);
    const { rows } = await client.query(compiled.sql, compiled.params);
    return rows.length > 0 ? full(row) : keyOnly(row);
  };
}

/** The caller's READ row filter on a resource - a DELETE's `readFilter`, so its answer can tell a row they may read. */
export async function readRowFilter(context: MutationsContext, dataPrincipal: DataPrincipal, resourceId: string, limits: Limits): Promise<FilterNode | undefined> {
  const read = await context.effectivePermissions.resolve(dataPrincipal.roleIds, resourceId, "READ");
  return read.action === "ALLOW" ? buildRowFilter(read, limits) : undefined;
}

/**
 * What the caller may read of a resource, field by field, as a GET decides it: the READ grant's field decisions with
 * protected and Password columns denied - or, without a READ grant, the primary key alone (the row's address).
 */
export async function readableFieldDecision(
  context: MutationsContext,
  dataPrincipal: DataPrincipal,
  root: ResolvedResource,
  resourceId: string,
  passwordColumns: Set<string>,
): Promise<(field: string) => PermissionDecision> {
  const read = await context.effectivePermissions.resolve(dataPrincipal.roleIds, resourceId, "READ");
  return read.action === "ALLOW"
    ? withPasswordColumnsDenied(protectedFieldDecision(root, read.fieldDecision), passwordColumns)
    : (field: string) => (root.primaryKey.includes(field) ? "ALLOW" : "DENY");
}

/**
 * Which fields a write's own `where` may name (Security.md §6.4): what the caller may read, and the primary key - the
 * address a by-key write names, whatever the READ grant says of it. A field they can't read is never a filter: which
 * rows a write touched would tell its values.
 */
export async function writeWhereFieldDecision(
  context: MutationsContext,
  dataPrincipal: DataPrincipal,
  root: ResolvedResource,
  resourceId: string,
  passwordColumns: Set<string>,
): Promise<(field: string) => PermissionDecision> {
  const readable = await readableFieldDecision(context, dataPrincipal, root, resourceId, passwordColumns);
  return (field) => (root.primaryKey.includes(field) && !passwordColumns.has(field) ? "ALLOW" : readable(field));
}
