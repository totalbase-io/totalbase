import type { Queryable } from "@totalbase/database";
import { TotalBaseError, type TotalBaseErrorCode } from "@totalbase/errors";
import type { EffectivePermission, ResourceAction } from "@totalbase/permissions";
import { SchemaContext, compileFilter, mutationFilterContext, quoteIdentifier } from "@totalbase/query-engine";
import type { DataPrincipal, MutationsContext } from "./context.js";
import { buildRowFilter, userVariableResolver, type Limits } from "./mutation-service.js";

/**
 * Authorization for a dedicated endpoint (or a workflow operation) over one
 * of TotalBase's own tables (Files, Templates - Security.md
 * §9.3: what is not a plain row write keeps its own route, authorized
 * through the same resolver). The same model as the Data API: the action
 * grant, then the grant's row filter against the row itself, and field
 * grants for the columns written.
 */
export interface TableGrant {
  table: string;
  postgresOid: number;
  permission: EffectivePermission;
}

/** The narrow context a table-row check needs (apps/server's AppContext and the workflow engine's context satisfy it). */
export type TableAuthorizationContext = Pick<MutationsContext, "database" | "effectivePermissions" | "settings">;

/** The caller's grant for `action` on totalbase.`table`, or `errorCode` when they have none. */
export async function resolveTableGrant(
  context: TableAuthorizationContext,
  dataPrincipal: DataPrincipal,
  table: string,
  action: ResourceAction,
  errorCode: TotalBaseErrorCode,
): Promise<TableGrant> {
  const { rows } = await context.database.query<{ id: string; postgres_oid: number }>(
    `SELECT id, postgres_oid FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = $1`,
    [table],
  );
  const resource = rows[0];
  if (!resource) throw new TotalBaseError(errorCode, `${action} is not authorized.`);
  const permission = await context.effectivePermissions.resolve(dataPrincipal.roleIds, resource.id, action);
  if (permission.action !== "ALLOW") throw new TotalBaseError(errorCode, `${action} is not authorized.`);
  return { table, postgresOid: resource.postgres_oid, permission };
}

/** Whether row `rowId` satisfies the grant's row filter (an unscoped grant passes every row). Pass a transaction client to check a row mid-write. */
export async function rowPassesGrant(
  queryable: Queryable,
  context: TableAuthorizationContext,
  dataPrincipal: DataPrincipal,
  grant: TableGrant,
  rowId: string,
  limits: Limits,
): Promise<boolean> {
  const rowFilter = buildRowFilter(grant.permission, limits);
  if (!rowFilter) return true;
  const resource = await new SchemaContext(context.database).loadRoot("totalbase", grant.table, grant.postgresOid);
  const compiled = await compileFilter(rowFilter, mutationFilterContext(resource, "t", userVariableResolver(dataPrincipal)), 1);
  const { rows } = await queryable.query<{ id: string }>(
    `SELECT t.id FROM totalbase.${quoteIdentifier(grant.table)} t WHERE t.id = $1 AND (${compiled.sql})`,
    [rowId, ...compiled.params],
  );
  return rows.length > 0;
}

/** Throws unless every written column is granted (field precedence DENY > ALLOW > UNDEFINED, as in the Data API). */
export function assertColumnsGranted(grant: TableGrant, columns: string[], errorCode: TotalBaseErrorCode): void {
  const denied = columns.find((column) => grant.permission.fieldDecision(column) !== "ALLOW");
  if (denied) throw new TotalBaseError(errorCode, `Field not authorized: ${denied}`);
}

/** The Data API's filter limits, which a row-filter check compiles under. */
export async function rowFilterLimits(context: Pick<MutationsContext, "settings">): Promise<Limits> {
  const [maxFilterDepth, maxRelationDepth] = await Promise.all([
    context.settings.get("api.max_filter_depth"),
    context.settings.get("api.max_relation_depth"),
  ]);
  return { maxFilterDepth, maxRelationDepth };
}
