import { compileSelect, SchemaContext, type FilterNode } from "@totalbase/query-engine";
import { resolveTableResource, type ResolvedApiResource } from "@totalbase/resources";
import {
  buildRowFilter,
  loadPasswordColumns,
  protectedFieldDecision,
  rowFilterLimits,
  userVariableResolver,
  withPasswordColumnsDenied,
  type DataPrincipal,
  type MutationsContext,
} from "@totalbase/mutations";
import type { AdminDataView } from "./dataviews-admin-service.js";

/** At most this many rows of a settings table are told apart - a parameter table holds a handful. */
const MAX_KEYS = 1000;

export interface SettingsWritable {
  /** May the viewer write the value column at all (UPDATE ALLOW, and the column among its fields). */
  valueWritable: boolean;
  /** The keys of the rows it may update - every row it reads (null) when UPDATE has no row filter. */
  keys: string[] | null;
}

/** What `settingsWritable` read to answer, for the caller's READ audit row (audit_read) - null when it read no rows. */
export interface SettingsWritableRead {
  resource: ResolvedApiResource;
  keyColumn: string;
  rowCount: number;
}

/** The narrow context the check needs - apps/server's AppContext satisfies it. */
export type SettingsWritableContext = Pick<MutationsContext, "database" | "effectivePermissions" | "settings">;

/**
 * Which rows of a SETTINGS DataView the viewer may change (Specification_DataViews.md §5.12) - the
 * Permission Resolver's own answer, never a guess: UPDATE's field decision for the value column, and
 * its row filter compiled with READ's, as the Data API compiles any read (compileSelect: identifiers
 * from the catalog, quoted centrally; values parameterized), so each row shows locked or editable
 * before anyone tries to save it.
 */
export async function settingsWritable(
  context: SettingsWritableContext,
  principal: DataPrincipal,
  view: AdminDataView,
): Promise<{ writable: SettingsWritable; read: SettingsWritableRead | null }> {
  const layout = (view.viewConfig["settings_layout"] ?? {}) as { keyColumn?: string; valueColumn?: string };
  if (!view.sourceResourceSchema || !view.sourceResourceName || !layout.keyColumn || !layout.valueColumn) {
    return { writable: { valueWritable: false, keys: [] }, read: null };
  }

  const resource = await resolveTableResource(context, view.sourceResourceSchema, view.sourceResourceName, "GET");
  const [read, update] = await Promise.all([
    context.effectivePermissions.resolve(principal.roleIds, resource.id, "READ"),
    context.effectivePermissions.resolve(principal.roleIds, resource.id, "UPDATE"),
  ]);
  if (read.action !== "ALLOW" || update.action !== "ALLOW" || update.fieldDecision(layout.valueColumn) !== "ALLOW") {
    return { writable: { valueWritable: false, keys: [] }, read: null };
  }

  const limits = await rowFilterLimits(context);
  const updateFilter = buildRowFilter(update, limits);
  if (!updateFilter) return { writable: { valueWritable: true, keys: null }, read: null };

  const readFilter = buildRowFilter(read, limits);
  const where: FilterNode = readFilter ? { type: "and", children: [readFilter, updateFilter] } : updateFilter;
  const schemaContext = new SchemaContext(context.database);
  const root = await schemaContext.loadRoot(resource.schema, resource.name, resource.postgresOid);
  const passwordColumns = await loadPasswordColumns(context, resource.id);
  const keyColumn = layout.keyColumn;
  const compiled = await compileSelect({
    root,
    ast: { fields: [{ path: [keyColumn] }], where, search: undefined, groupBy: undefined, having: undefined, aggregates: undefined, orderBy: undefined, limit: MAX_KEYS, offset: undefined, count: false },
    schemaContext,
    fieldDecision: withPasswordColumnsDenied(protectedFieldDecision(root, read.fieldDecision), passwordColumns),
    rowFilter: undefined,
    resolveUserVariable: userVariableResolver(principal),
    defaultLimit: MAX_KEYS,
    maxLimit: MAX_KEYS,
    maxOffset: 0,
  });
  const { rows } = await context.database.query<Record<string, unknown>>(compiled.sql, compiled.params);
  return {
    writable: { valueWritable: true, keys: rows.map((row) => String(row[keyColumn])) },
    read: { resource, keyColumn, rowCount: rows.length },
  };
}
