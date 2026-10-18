import { quoteIdentifier } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import type { DashboardVariable } from "./variables.js";
import type { DashboardQueryLimits, DashboardsContext, DashboardVariableOption, DashboardViewer } from "./dashboards-types.js";
import { DENIED_USER_FIELDS, VariableResolver } from "./dashboards-variable-resolver.js";
import { getDashboard } from "./dashboards-crud.js";
import { executeQuery } from "./dashboards-runner.js";
import { getPublishedVariables, getVersion } from "./dashboards-versions.js";

/** A row presentation's literal text as a SQL string - an administrator's, standard_conforming_strings on. */
export function sqlLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** What variables name outside themselves, checked against the catalog (D22): a list's table and its filter columns, a default's user field. */
export async function checkVariableSources(ctx: DashboardsContext, variables: DashboardVariable[]): Promise<void> {
  let userColumns: Set<string> | null = null;
  for (const variable of variables) {
    if (variable.options?.source === "TABLE") {
      const target = await optionsTable(ctx, variable.options.resource);
      for (const filter of variable.options.filters ?? []) {
        if (!target.columns.includes(filter.column)) throw new TotalBaseError("DASHBOARD_VARIABLE_INVALID", `Variable "${variable.name}": ${target.name} has no column "${filter.column}".`);
      }
    }
    if (variable.default?.source === "user") {
      userColumns ??= new Set((await ctx.database.query<{ name: string }>(
        `SELECT attname AS name FROM pg_catalog.pg_attribute WHERE attrelid = 'totalbase.users'::regclass AND attnum > 0 AND NOT attisdropped`,
      )).rows.map((r) => r.name));
      const field = variable.default.field;
      if (!userColumns.has(field) || DENIED_USER_FIELDS.has(field)) throw new TotalBaseError("DASHBOARD_VARIABLE_INVALID", `Variable "${variable.name}": its default reads $USER.${field}, which isn't a column of the user it may read.`);
    }
  }
}

/**
 * A TABLE-sourced SELECT's options (D22) as the query it runs: its key the value, its row presentation the label
 * (its template, its display field, else the column a foreign key shows by default), ordered by the label, each
 * filter `($VAR.x IS NULL OR column = $VAR.x)` - or `= ANY` for a multiple one. Identifiers come from the catalog and
 * are quoted; values stay bound variables.
 */
export async function tableOptionsQuery(ctx: DashboardsContext, options: { resource: string; filters?: { column: string; variable: string }[] }, variables: DashboardVariable[]): Promise<string> {
  const target = await optionsTable(ctx, options.resource);
  const columns = new Set(target.columns);
  const quote = (name: string) => `t.${quoteIdentifier(name)}`;
  const template = target.rowPresentation.displayTemplate?.trim();
  let label: string;
  if (template) {
    const parts = template.split(/(\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\})/).filter((p) => p !== "");
    label = parts.map((part) => {
      const name = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(part)?.[1];
      return name && columns.has(name) ? `coalesce(${quote(name)}::text, '')` : `${sqlLiteral(part)}`;
    }).join(" || ");
  } else {
    const shown = target.rowPresentation.displayField && columns.has(target.rowPresentation.displayField) ? target.rowPresentation.displayField : target.defaultColumn;
    label = `${quote(shown)}::text`;
  }
  const where = (options.filters ?? []).map((filter) => {
    if (!columns.has(filter.column)) throw new TotalBaseError("DASHBOARD_VARIABLE_INVALID", `${target.name} has no column "${filter.column}".`);
    const other = variables.find((v) => v.name === filter.variable);
    const compare = other?.type === "SELECT" && other.multiple ? `${quote(filter.column)}::text = ANY($VAR.${filter.variable})` : `${quote(filter.column)}::text = $VAR.${filter.variable}::text`;
    return `($VAR.${filter.variable} IS NULL OR ${compare})`;
  });
  return `SELECT ${quote(target.key)}::text AS value, ${label} AS label FROM ${quoteIdentifier(target.schema)}.${quoteIdentifier(target.name)} t${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY 2`;
}

/** A TABLE options source's table: an active TABLE resource with a single-column key. */
export async function optionsTable(ctx: DashboardsContext, resourceId: string): Promise<{ schema: string; name: string; key: string; columns: string[]; defaultColumn: string; rowPresentation: { displayField?: string; displayTemplate?: string } }> {
  const { rows } = await ctx.database.query<{ schema: string; name: string; oid: number; row_presentation: { displayField?: string; displayTemplate?: string } | null }>(
    `SELECT "schema", name, postgres_oid AS oid, row_presentation FROM totalbase.resources WHERE id = $1 AND type = 'TABLE' AND status = 'ACTIVE'`,
    [resourceId],
  );
  const resource = rows[0];
  if (!resource) throw new TotalBaseError("DASHBOARD_VARIABLE_INVALID", `options.resource ${resourceId} is not an active table.`);
  const { rows: attrs } = await ctx.database.query<{ name: string; type: string; key: boolean }>(
    `SELECT a.attname AS name, format_type(a.atttypid, NULL) AS type,
            EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = a.attrelid AND c.contype = 'p' AND c.conkey = ARRAY[a.attnum]) AS key
     FROM pg_catalog.pg_attribute a WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    [resource.oid],
  );
  const key = attrs.find((a) => a.key)?.name;
  if (!key) throw new TotalBaseError("DASHBOARD_VARIABLE_INVALID", `${resource.name} has no single-column primary key to be a list's value.`);
  const named = attrs.find((a) => ["name", "label", "title", "display_name"].includes(a.name.toLowerCase()));
  const text = attrs.find((a) => a.name !== key && /^(text|character varying|character|citext)/.test(a.type));
  return { schema: resource.schema, name: resource.name, key, columns: attrs.map((a) => a.name), defaultColumn: (named ?? text)?.name ?? key, rowPresentation: resource.row_presentation ?? {} };
}

/**
 * A SELECT variable's options, for the variables bar. An options query
 * runs through the same read-only executor; it may use `$USER.*` (e.g.
 * only the viewer's own branches) but no `$VAR.*` - there are no
 * variable definitions in its context, so a reference is "undefined".
 */
export async function variableOptions(
  ctx: DashboardsContext,
  dashboardId: string,
  name: string,
  /** Whose definitions: the draft's, the live version's, or a specific version's (the read-only preview). */
  from: "DRAFT" | "PUBLISHED" | number,
  limits: DashboardQueryLimits,
  viewer: DashboardViewer,
  /** The viewer's current values - only those of the variables its query depends on are bound (§3.6). */
  values: Record<string, unknown> = {},
): Promise<DashboardVariableOption[]> {
  const variables = from === "DRAFT"
    ? (await getDashboard(ctx, dashboardId)).variables
    : from === "PUBLISHED"
      ? await getPublishedVariables(ctx, dashboardId)
      : (await getVersion(ctx, dashboardId, from)).variables;
  const variable = variables.find((v) => v.name === name);
  // No such variable is a missing path id (404); one that isn't a SELECT is an invalid request for it (422).
  if (!variable) throw new TotalBaseError("DASHBOARD_VARIABLE_NOT_FOUND", `No variable named "${name}".`);
  if (variable.type !== "SELECT" || !variable.options) {
    throw new TotalBaseError("DASHBOARD_VARIABLE_INVALID", `"${name}" is not a SELECT variable.`);
  }
  if (variable.options.source === "STATIC") {
    return variable.options.values.map((option) => ({ value: option.value, label: option.label ?? option.value }));
  }
  const dependsOn = variable.dependsOn ?? [];
  const query = variable.options.source === "QUERY" ? variable.options.query : await tableOptionsQuery(ctx, variable.options, variables);
  const result = await executeQuery(ctx, query, { timeoutMs: limits.timeoutMs, maxRows: Math.min(limits.maxRows, 500) }, {
    ...viewer,
    variables: variables.filter((v) => dependsOn.includes(v.name)),
    values: Object.fromEntries(Object.entries(values).filter(([name]) => dependsOn.includes(name))),
  });
  const [valueColumn, labelColumn] = result.columns.map((c) => c.name);
  if (!valueColumn) return [];
  return result.rows
    .filter((row) => row[valueColumn] !== null && row[valueColumn] !== undefined)
    .map((row) => ({
      value: String(row[valueColumn]),
      label: String(labelColumn !== undefined && row[labelColumn] !== null ? row[labelColumn] : row[valueColumn]),
    }));
}

/**
 * Variables as a viewer's bar shows them (D22): each with `defaultValue` - its default resolved for that viewer (a
 * user default reads their own row; none without one: an embed's).
 */
export async function withDefaultValues(ctx: DashboardsContext, variables: DashboardVariable[], userId: string | null): Promise<(DashboardVariable & { defaultValue: unknown })[]> {
  const resolver = new VariableResolver(ctx.database, { userId, variables, values: {} });
  return Promise.all(variables.map(async (variable) => ({ ...variable, defaultValue: await resolver.defaultValue(variable).catch(() => null) })));
}
