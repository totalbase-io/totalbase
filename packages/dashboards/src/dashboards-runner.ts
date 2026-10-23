import { quoteIdentifier } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { dashboardDecision, dashboardRoleLabel, dashboardWidgetDefinition, resolveDashboardRoles, type DashboardDecisionLanguage, type DashboardRoleAssignment, type DashboardWidgetType } from "@totalbase/tb-catalog";
import { typeResult, type TypedResultColumn } from "./typed-result.js";
import { markVariables, resolveMarks, widgetTotals } from "./widget-marks.js";
import { PIVOT_MAX_COLUMNS, pivotDistinctColumnsSql, pivotSql, type PivotAggregate, type PivotSpec } from "./pivot-query.js";
import { cacheKey } from "./widget-runs.js";
import type { DashboardRoleDecision } from "./dashboard-spec.js";
import { bindSqlVariables, listSqlVariableRefs, referencedVariableNames } from "./sql-variables.js";
import type { DashboardVariable } from "./variables.js";
import { MAX_MEMOIZED, toWidgetContent, type AdminDashboardWidgetContent, type BrokenDashboardWidget, type DashboardDraftRun, type DashboardQueryContext, type DashboardQueryLimits, type DashboardQueryResult, type DashboardsContext, type DashboardViewer, type WidgetSnapshotRow } from "./dashboards-types.js";
import { VariableResolver } from "./dashboards-variable-resolver.js";
import { getDashboard } from "./dashboards-crud.js";
import { assertRolesDraw, clickTargetProblems, getWidget } from "./dashboards-widgets.js";
import { getLiveSnapshot, latestVersionNumber, versionSnapshot } from "./dashboards-versions.js";

/** What a query names that PostgreSQL can lose under it - a dropped or renamed column, table, view or function. */
export const BROKEN_QUERY_CODES = new Set(["UNDEFINED_COLUMN", "UNDEFINED_TABLE", "UNDEFINED_FUNCTION"]);

/**
 * Trailing semicolons/whitespace are stripped (the query is wrapped as a
 * subquery, where a `;` is a syntax error) - everything else is left to
 * PostgreSQL itself to accept or reject.
 */
export function normalizeQuery(raw: string): string {
  const trimmed = raw.trim().replace(/;+\s*$/, "").trim();
  if (trimmed.length === 0) {
    throw new TotalBaseError("DASHBOARD_QUERY_INVALID", "The query is empty.");
  }
  return trimmed;
}

/** Each role's columns as a run took them, and why (DM3): chosen in config, or a default by its rule. */
export function roleDecisions(type: DashboardWidgetType, roles: Record<string, DashboardRoleAssignment>, language: DashboardDecisionLanguage): Record<string, DashboardRoleDecision> {
  const definition = dashboardWidgetDefinition(type);
  return Object.fromEntries(Object.entries(roles).map(([id, role]) => {
    const label = dashboardRoleLabel(id, (definition.roles as Record<string, { label: string }>)[id]?.label ?? id, language);
    const reason = role.source === "config"
      ? dashboardDecision("role-config", language, { role: label }, role.columns.join(", "))
      : dashboardDecision(role.rule === "all-of-kind" ? "role-all-of-kind" : "role-first-of-kind", language, { role: label }, role.columns.join(", "));
    return [id, { columns: role.columns, source: role.source, ...(role.rule && { rule: role.rule }), reason }];
  }));
}

/** A pivot's `sortBy`, as its aggregation reads it - ASC unless DESC (the inspector's default). */
export function pivotSortBy(raw: unknown): { value: string; direction: "ASC" | "DESC" } | null {
  if (!raw || typeof raw !== "object") return null;
  const { value, direction } = raw as { value?: unknown; direction?: unknown };
  return typeof value === "string" ? { value, direction: direction === "DESC" ? "DESC" : "ASC" } : null;
}

// --- Query execution ---

/**
 * Runs one widget query read-only (AGENTS.md section 7 "Dashboard
 * widget SQL"). Every guarantee comes from PostgreSQL, not from parsing
 * the SQL here:
 * - its own READ ONLY transaction - any write (including inside a
 *   function it calls) fails with SQLSTATE 25006 - always rolled back, so
 *   not even a session setting it changes (`set_config(..., false)`)
 *   outlives it on the pooled connection (Database.readOnlyTransaction);
 * - `statement_timeout` for the transaction;
 * - extended protocol (`query(sql, params)`, never `queryRaw`), which
 *   rejects stacked statements outright;
 * - wrapped as a subquery with LIMIT maxRows + 1 - the extra row only
 *   detects truncation. The newline before `)` keeps a trailing `--`
 *   comment in the query from swallowing the closing parenthesis;
 * - `$USER.*` / `$VAR.*` become cast positional parameters
 *   (sql-variables.ts), never interpolated text.
 */
export async function executeQuery(ctx: DashboardsContext, rawSql: string, limits: DashboardQueryLimits, context: DashboardQueryContext): Promise<DashboardQueryResult> {
  const { variableValues: _values, ...result } = await runQuery(ctx, rawSql, limits, context);
  return result;
}

export async function runQuery(
  ctx: DashboardsContext,
  rawSql: string,
  limits: DashboardQueryLimits,
  context: DashboardQueryContext,
  /** A table's totals by column (D28) and the variables its marks read (D5) - in the same transaction. */
  extras: { totals?: Record<string, string>; variables?: string[]; pivot?: PivotSpec; orderBy?: { column: string; direction: "ASC" | "DESC" } } = {},
): Promise<DashboardQueryResult & { variableValues: Record<string, unknown> }> {
  const sql = normalizeQuery(rawSql);
  const maxRows = Math.max(1, Math.floor(limits.maxRows));
  const started = performance.now();
  const { result, totals, variableValues } = await ctx.database.readOnlyTransaction(async (client) => {
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(Math.max(1, Math.floor(limits.timeoutMs)))]);
    if (context.timezone) await client.query("SELECT set_config('TimeZone', $1, true)", [context.timezone]);
    const resolver = new VariableResolver(client, context);
    const bound = await bindSqlVariables(sql, (ref) => resolver.resolve(ref));
    // A pivot (D17): its detail aggregated by PostgreSQL - at most PIVOT_MAX_COLUMNS values across its Columns.
    if (extras.pivot?.columns.length) {
      const { rows } = await client.query<{ n: number }>(pivotDistinctColumnsSql(bound.sql, extras.pivot.columns), bound.params);
      const n = rows[0]?.n ?? 0;
      if (n > PIVOT_MAX_COLUMNS) throw new TotalBaseError("DASHBOARD_PIVOT_TOO_MANY_COLUMNS", `Pivot table's Columns have ${n} values - at most ${PIVOT_MAX_COLUMNS}: filter the query, or move a level to Rows.`);
    }
    const result = await client.query(
      extras.pivot
        ? pivotSql(bound.sql, extras.pivot, maxRows + 1)
        // An order the widget draws (a funnel's largest first) is PostgreSQL's, before the cap (DB36).
        : `SELECT * FROM (\n${bound.sql}\n) AS dashboard_widget_query${extras.orderBy ? ` ORDER BY ${quoteIdentifier(extras.orderBy.column)} ${extras.orderBy.direction} NULLS LAST` : ""} LIMIT ${maxRows + 1}`,
      bound.params,
    );
    // Totals by PostgreSQL over the whole result, not the rows sent (D28): the query wrapped once more, its own
    // columns only - quoted, from what it returned.
    const returned = new Set(result.fields.map((f) => f.name));
    const parts = Object.entries(extras.totals ?? {})
      .filter(([column]) => returned.has(column))
      .map(([column, kind]) => `${kind === "avg" ? "avg" : kind}(${quoteIdentifier(column)}) AS ${quoteIdentifier(column)}`);
    const totals = parts.length
      ? (await client.query(`SELECT ${parts.join(", ")} FROM (\n${bound.sql}\n) AS dashboard_widget_query`, bound.params)).rows[0] as Record<string, unknown>
      : undefined;
    const variableValues: Record<string, unknown> = {};
    for (const name of extras.variables ?? []) {
      if (!context.variables.some((v) => v.name === name)) continue;
      variableValues[name] = (await resolver.resolve({ kind: "VAR", name, part: null }).catch(() => ({ value: null }))).value;
    }
    return { result, totals, variableValues };
  });
  const truncated = result.rows.length > maxRows;
  const typed = await typeResult(ctx.database, result.fields, (truncated ? result.rows.slice(0, maxRows) : result.rows) as Record<string, unknown>[]);
  return { columns: typed.columns, rows: typed.rows, truncated, durationMs: Math.round(performance.now() - started), cached: false, totals: totals ?? null, marks: null, files: null, variableValues };
}

/**
 * Every widget whose query names what PostgreSQL no longer has (Dashboards.md §2.8) - the
 * draft's and the live version's. PostgreSQL decides, not a parse here: each query is planned as
 * `SELECT * FROM (query) LIMIT 0` in its own READ ONLY transaction, its variables NULL of their type -
 * nothing is read. Other failures (a timeout, a bad cast) are the editor's to show, not a lost name.
 */
export async function brokenWidgets(ctx: DashboardsContext, timeoutMs: number): Promise<BrokenDashboardWidget[]> {
  const broken: BrokenDashboardWidget[] = [];
  // Every dashboard with its draft widgets and its live version in one read - the planning below is per query,
  // never the reading.
  const { rows: dashboards } = await ctx.database.query<{
    id: string;
    name: string;
    slug: string;
    variables: DashboardVariable[];
    draft_widgets: WidgetSnapshotRow[];
    live_version: number | null;
    live_widgets: WidgetSnapshotRow[] | null;
    live_variables: DashboardVariable[] | null;
  }>(
    `SELECT d.id, d.name, d.slug, d.variables,
            (SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY w.grid_y, w.grid_x), '[]'::jsonb)
             FROM totalbase.dashboards_widgets w WHERE w.dashboard = d.id) AS draft_widgets,
            v.version AS live_version, v.widgets_snapshot AS live_widgets, v.variables_snapshot AS live_variables
     FROM totalbase.dashboards d
     LEFT JOIN LATERAL (
       SELECT version, widgets_snapshot, variables_snapshot FROM totalbase.dashboards_versions
       WHERE dashboard = d.id ORDER BY version DESC LIMIT 1
     ) v ON true
     ORDER BY d.name`,
  );
  for (const dashboard of dashboards) {
    const checks: { version: number | null; widgets: AdminDashboardWidgetContent[]; variables: DashboardVariable[] }[] = [
      { version: null, widgets: dashboard.draft_widgets.map(toWidgetContent), variables: dashboard.variables },
    ];
    if (dashboard.live_version !== null) {
      checks.push({ version: dashboard.live_version, widgets: (dashboard.live_widgets ?? []).map(toWidgetContent), variables: dashboard.live_variables ?? [] });
    }
    const seen = new Set<string>();
    for (const { version, widgets, variables } of checks) {
      for (const widget of widgets) {
        const clickProblems = await clickTargetProblems(ctx, dashboardWidgetDefinition(widget.type).label, widget.config);
        if (clickProblems.length && !seen.has(`${widget.id}\nclick`)) {
          seen.add(`${widget.id}\nclick`);
          broken.push({
            dashboard: { id: dashboard.id, name: dashboard.name, slug: dashboard.slug },
            widget: { id: widget.id, label: widget.label, type: widget.type },
            version,
            code: "CLICK_TARGET_MISSING",
            message: clickProblems.join(" "),
            query: widget.query,
          });
        }
        // The same query in the draft and the live version is one problem, reported once (the draft's).
        if (!widget.query || seen.has(`${widget.id}\n${widget.query}`)) continue;
        seen.add(`${widget.id}\n${widget.query}`);
        const problem = await probeQuery(ctx, widget.query, variables, timeoutMs);
        if (problem) {
          broken.push({
            dashboard: { id: dashboard.id, name: dashboard.name, slug: dashboard.slug },
            widget: { id: widget.id, label: widget.label, type: widget.type },
            version,
            ...problem,
            query: widget.query,
          });
        }
      }
    }
  }
  return broken;
}

/**
 * A query planned, never run: its result columns, typed, without reading a row (`LIMIT 0`, variables NULL of their
 * type) - or PostgreSQL's refusal, as its message. One plan serves every check made of a query (publish checks a
 * widget's references and its roles from the same one).
 */
export async function planQuery(ctx: DashboardsContext, rawSql: string, variables: DashboardVariable[], timeoutMs: number): Promise<{ columns: TypedResultColumn[]; error?: undefined } | { columns?: undefined; error: string }> {
  try {
    const result = await ctx.database.readOnlyTransaction(async (client) => {
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(Math.max(1, Math.floor(timeoutMs)))]);
      const resolver = new VariableResolver(client, { userId: null, variables, values: {} }, true);
      const bound = await bindSqlVariables(normalizeQuery(rawSql), (ref) => resolver.resolve(ref));
      return client.query(`SELECT * FROM (\n${bound.sql}\n) AS dashboard_widget_query LIMIT 0`, bound.params);
    });
    return { columns: (await typeResult(ctx.database, result.fields, [])).columns };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The tables a query reads, as PostgreSQL plans it: `EXPLAIN (VERBOSE, FORMAT JSON)` in a READ ONLY transaction,
 * variables NULL of their type - nothing is run. Views come out as the tables under them; a table read inside a
 * function the query calls doesn't show. Null when PostgreSQL refuses the query.
 */
export async function queryTables(ctx: DashboardsContext, rawSql: string, variables: DashboardVariable[], timeoutMs: number): Promise<{ schema: string; name: string }[] | null> {
  try {
    const plan = await ctx.database.readOnlyTransaction(async (client) => {
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(Math.max(1, Math.floor(timeoutMs)))]);
      const resolver = new VariableResolver(client, { userId: null, variables, values: {} }, true);
      const bound = await bindSqlVariables(normalizeQuery(rawSql), (ref) => resolver.resolve(ref));
      const { rows } = await client.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (VERBOSE, FORMAT JSON) SELECT * FROM (\n${bound.sql}\n) AS dashboard_widget_query`, bound.params);
      return rows[0]?.["QUERY PLAN"];
    });
    const tables = new Map<string, { schema: string; name: string }>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      const { "Relation Name": name, Schema: schema, ...rest } = node as Record<string, unknown>;
      if (typeof name === "string" && typeof schema === "string") tables.set(`${schema}.${name}`, { schema, name });
      Object.values(rest).forEach(walk);
    };
    walk(plan);
    if (tables.size === 0) return [];
    // A partition reads as its partitioned table - the resource (Foundations.md §11.1).
    const found = [...tables.values()];
    const { rows } = await ctx.database.query<{ schema: string; name: string }>(
      `SELECT DISTINCT rn.nspname AS "schema", rc.relname AS name
       FROM unnest($1::text[], $2::text[]) AS t(s, n)
       JOIN pg_namespace ns ON ns.nspname = t.s
       JOIN pg_class c ON c.relnamespace = ns.oid AND c.relname = t.n
       JOIN pg_class rc ON rc.oid = coalesce(pg_partition_root(c.oid), c.oid)
       JOIN pg_namespace rn ON rn.oid = rc.relnamespace
       ORDER BY 1, 2`,
      [found.map((t) => t.schema), found.map((t) => t.name)],
    );
    return rows;
  } catch {
    return null;
  }
}

/**
 * The live version's widgets whose query never names `$USER.*`, each with the tables it reads (`queryTables`) - what
 * the diagnosis checks against its viewers' row filters (DataViews.md §18). A widget PostgreSQL refuses is left out:
 * the broken-references check reports it.
 */
export async function unscopedWidgetTables(ctx: DashboardsContext, dashboardId: string, timeoutMs: number): Promise<{ widget: { id: string; name: string }; tables: { schema: string; name: string }[] }[]> {
  const snapshot = await getLiveSnapshot(ctx, dashboardId);
  const found: { widget: { id: string; name: string }; tables: { schema: string; name: string }[] }[] = [];
  for (const widget of snapshot?.widgets ?? []) {
    if (!widget.query || listSqlVariableRefs(widget.query).some((ref) => ref.kind === "USER")) continue;
    const tables = await queryTables(ctx, widget.query, snapshot!.variables, timeoutMs);
    if (tables?.length) found.push({ widget: { id: widget.id, name: widget.label || dashboardWidgetDefinition(widget.type).label }, tables });
  }
  return found;
}

/** `planQuery`'s columns - null when PostgreSQL refuses the query (saving it is allowed: running it says why). */
export async function probeColumns(ctx: DashboardsContext, rawSql: string, variables: DashboardVariable[], timeoutMs: number): Promise<TypedResultColumn[] | null> {
  return (await planQuery(ctx, rawSql, variables, timeoutMs)).columns ?? null;
}

/**
 * A published widget's plan, kept per version and widget: a PIVOT, a FUNNEL drawn largest first and a CALENDAR
 * need their roles before their query runs (the aggregation, the order), and a version's query never changes - so
 * they're planned once per version instead of once per view. A refused plan isn't kept (the run reports it). The
 * memo goes with the version's snapshot (`forgetSnapshots`) and with every catalog refresh (`forgetPlans`): DDL is
 * the one change that alters a query's columns without touching the version.
 */
export function plannedColumns(ctx: DashboardsContext, key: string, plan: () => Promise<TypedResultColumn[] | null>): Promise<TypedResultColumn[] | null> {
  const memoized = ctx.plans.get(key);
  if (memoized) {
    ctx.plans.delete(key);
    ctx.plans.set(key, memoized);
    return memoized;
  }
  const loading = plan();
  loading.then((columns) => { if (!columns) ctx.plans.delete(key); }, () => ctx.plans.delete(key));
  ctx.plans.set(key, loading);
  while (ctx.plans.size > MAX_MEMOIZED) ctx.plans.delete(ctx.plans.keys().next().value!);
  return loading;
}

/** Drops every memoized plan - after a catalog refresh (apps/server's reconcileCatalog), when columns may have changed under a query. */
export function forgetPlans(ctx: DashboardsContext): void {
  ctx.plans.clear();
}

/**
 * A widget's run, with each role checked against what its query returned (D1) - the same message as on save. A
 * query PostgreSQL refuses is the dashboard's own error (DB10): DASHBOARD_WIDGET_QUERY_FAILED, 422, PostgreSQL's
 * message, SQLSTATE and detail kept - never the Data API's mapping (a missing table there is a 404).
 */
export async function executeWidget(
  ctx: DashboardsContext,
  widget: { id: string; type: DashboardWidgetType; query: string; config: Record<string, unknown> },
  limits: DashboardQueryLimits,
  context: DashboardQueryContext,
  /** Whose dashboard (its queries at once), and - for a published widget - what its cached result is keyed by. */
  scope: { dashboardId: string; version?: number; published?: { version: number; refreshIntervalSeconds: number | null }; withRoles?: boolean },
): Promise<DashboardQueryResult & { roles?: Record<string, DashboardRoleAssignment> }> {
  // What the query returns, planned before it runs (a pivot's aggregation, a funnel's or calendar's order): a
  // version's widget is planned once and remembered (`plannedColumns`); a draft's, whose query changes, every run.
  const plan = () => probeColumns(ctx, widget.query, context.variables, limits.timeoutMs);
  const planned = scope.version === undefined ? plan : () => plannedColumns(ctx, `${scope.dashboardId}/${scope.version}/${widget.id}`, plan);
  const run = () => ctx.gates.run(scope.dashboardId, Math.max(1, limits.maxConcurrent ?? 4), () => runWidget(ctx, widget, limits, context, planned));
  // Each role's columns - the draft's author's only (DM3); a version's or a viewer's run carries none.
  if (scope.withRoles) return run();
  const ttlSeconds = scope.published && (limits.cacheSeconds ?? 0) > 0 ? scope.published.refreshIntervalSeconds ?? limits.cacheSeconds! : 0;
  const viewerRun = async () => {
    const { roles: _roles, ...result } = await run();
    return result;
  };
  if (!scope.published || ttlSeconds <= 0) return viewerRun();
  // Keyed by what changes the result: the version, the values, the viewer's zone - and who they are, when it reads them.
  const readsUser = /\$USER\./.test(widget.query) || context.variables.some((v) => v.default?.source === "user" && referencedVariableNames(widget.query).includes(v.name));
  const key = cacheKey({ d: scope.dashboardId, v: scope.published.version, w: widget.id, values: context.values, tz: context.timezone ?? null, user: readsUser ? context.userId : null });
  if (!limits.fresh) {
    const hit = ctx.results.get(key);
    if (hit) return { ...hit, cached: true };
  }
  return ctx.inFlight.run(key, async () => {
    const result = await viewerRun();
    ctx.results.set(key, result, ttlSeconds * 1000);
    return result;
  });
}

export async function runWidget(
  ctx: DashboardsContext,
  widget: { type: DashboardWidgetType; query: string; config: Record<string, unknown> },
  limits: DashboardQueryLimits,
  context: DashboardQueryContext,
  /** The query's columns planned (nothing read) - for the widget types that need their roles before the run. */
  planned: () => Promise<TypedResultColumn[] | null>,
): Promise<DashboardQueryResult & { roles?: Record<string, DashboardRoleAssignment> }> {
  let result: DashboardQueryResult & { variableValues: Record<string, unknown> };
  let resolvedRoles: Record<string, DashboardRoleAssignment> | undefined;
  // A pivot's roles decide its aggregation - read from the query's columns (planned, nothing read) first.
  let pivot: PivotSpec | undefined;
  if (widget.type === "PIVOT") {
    const columns = await planned();
    if (columns) {
      const resolved = resolveDashboardRoles(widget.type, widget.config, columns);
      if (resolved.errors.length) throw new TotalBaseError("DASHBOARD_WIDGET_ROLES_INVALID", resolved.errors.join(" "));
      assertRolesDraw(widget.type, widget.config, resolved.roles);
      resolvedRoles = resolved.roles;
      const aggregates = (widget.config.aggregates ?? {}) as Record<string, PivotAggregate>;
      pivot = {
        rows: resolved.roles.rows?.columns ?? [],
        columns: resolved.roles.columns?.columns ?? [],
        values: (resolved.roles.values?.columns ?? []).map((column) => ({ column, aggregate: aggregates[column]! })),
        subtotals: widget.config.subtotals !== false,
        rowTotals: widget.config.rowTotals !== false,
        columnTotals: widget.config.columnTotals !== false,
        sortBy: pivotSortBy(widget.config.sortBy),
      };
    }
  }
  // An order the drawing depends on is PostgreSQL's, before the cap (DB35, DB36): a funnel drawn largest first keeps
  // the largest steps; a calendar keeps the latest days (its years newest first).
  let orderBy: { column: string; direction: "ASC" | "DESC" } | undefined;
  const ordered = widget.type === "FUNNEL" && widget.config.sort === "DESC" ? "value" : widget.type === "CALENDAR" ? "date" : null;
  if (ordered) {
    const columns = await planned();
    const column = columns ? resolveDashboardRoles(widget.type, widget.config, columns).roles[ordered]?.columns[0] : undefined;
    if (column) orderBy = { column, direction: "DESC" };
  }
  try {
    result = await runQuery(ctx, widget.query, limits, context, { totals: widgetTotals(widget.config), variables: markVariables(widget.config), ...(pivot && { pivot }), ...(orderBy && { orderBy }) });
  } catch (error) {
    // Its time ran out (statement_timeout) - its own code, so a viewer reads it in their language (D23).
    if (error instanceof TotalBaseError && error.sqlstate === "57014") {
      throw new TotalBaseError("DASHBOARD_WIDGET_QUERY_TIMEOUT", `The query took longer than its limit (dashboards.query_timeout_ms, ${limits.timeoutMs} ms).`, { cause: error, sqlstate: error.sqlstate });
    }
    if (error instanceof TotalBaseError && error.source === "POSTGRESQL") {
      throw new TotalBaseError("DASHBOARD_WIDGET_QUERY_FAILED", error.message, { cause: error, sqlstate: error.sqlstate, detail: error.detail, hint: error.hint });
    }
    throw error;
  }
  if (!pivot) {
    const { errors, roles } = resolveDashboardRoles(widget.type, widget.config, result.columns);
    if (errors.length) throw new TotalBaseError("DASHBOARD_WIDGET_ROLES_INVALID", errors.join(" "));
    assertRolesDraw(widget.type, widget.config, roles);
    resolvedRoles = roles;
    // A funnel's steps and a hierarchy's leaves are amounts: never negative (D13, D18).
    if (widget.type === "FUNNEL" || widget.type === "TREEMAP" || widget.type === "SUNBURST") {
      const column = roles.value?.columns[0];
      const index = column ? result.rows.findIndex((row) => typeof row[column] === "number" ? (row[column] as number) < 0 : Number(row[column]) < 0) : -1;
      if (index >= 0) {
        const shown = Object.entries(result.rows[index]!).filter(([name]) => !name.startsWith("_")).map(([name, value]) => `${name}: ${String(value)}`).join(", ");
        throw new TotalBaseError("DASHBOARD_WIDGET_NEGATIVE_VALUE", `${dashboardWidgetDefinition(widget.type).label}'s Value is negative in row ${index + 1} (${shown}) - its values are 0 or more.`);
      }
    }
  }
  const { variableValues, ...run } = result;
  return { ...run, marks: resolveMarks(widget.config, run.rows, variableValues) ?? null, ...(resolvedRoles && { roles: resolvedRoles }) };
}

export async function probeQuery(ctx: DashboardsContext, rawSql: string, variables: DashboardVariable[], timeoutMs: number): Promise<{ code: BrokenDashboardWidget["code"]; message: string } | null> {
  try {
    await ctx.database.readOnlyTransaction(async (client) => {
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(Math.max(1, Math.floor(timeoutMs)))]);
      const resolver = new VariableResolver(client, { userId: null, variables, values: {} }, true);
      const bound = await bindSqlVariables(normalizeQuery(rawSql), (ref) => resolver.resolve(ref));
      await client.query(`SELECT * FROM (\n${bound.sql}\n) AS dashboard_widget_query LIMIT 0`, bound.params);
    });
    return null;
  } catch (error) {
    if (error instanceof TotalBaseError && BROKEN_QUERY_CODES.has(error.code)) {
      return { code: error.code as BrokenDashboardWidget["code"], message: error.message };
    }
    return null;
  }
}

/** The editor: ad-hoc SQL (the drawer's Run) against the draft's variable definitions. */
export async function executeDraftQuery(ctx: DashboardsContext, dashboardId: string, sql: string, limits: DashboardQueryLimits, viewer: DashboardViewer, values: Record<string, unknown>): Promise<DashboardQueryResult> {
  const dashboard = await getDashboard(ctx, dashboardId);
  return executeQuery(ctx, sql, limits, { ...viewer, variables: dashboard.variables, values });
}

/** The editor canvas: a widget's saved draft query. */
/** A draft widget's run - with each role's columns and why (DM3) in the App's `language`. */
export async function executeDraftWidget(ctx: DashboardsContext, dashboardId: string, widgetId: string, limits: DashboardQueryLimits, viewer: DashboardViewer, values: Record<string, unknown>, language: DashboardDecisionLanguage = "en"): Promise<DashboardDraftRun> {
  const dashboard = await getDashboard(ctx, dashboardId);
  const widget = await getWidget(ctx, dashboardId, widgetId);
  if (!widget.query) throw new TotalBaseError("DASHBOARD_WIDGET_NOT_CONFIGURED", "This widget has no query yet.");
  const { roles, ...result } = await executeWidget(ctx, { id: widget.id, type: widget.type, query: widget.query, config: widget.config }, limits, { ...viewer, variables: dashboard.variables, values }, { dashboardId, withRoles: true });
  return { ...result, ...(roles && { roles: roleDecisions(widget.type, roles, language) }) };
}

/** Apps: a published widget, looked up by id in the latest snapshot - neither the query nor the variable definitions come from the caller. */
export async function executePublishedWidget(ctx: DashboardsContext, dashboardId: string, widgetId: string, limits: DashboardQueryLimits, viewer: DashboardViewer, values: Record<string, unknown>): Promise<DashboardQueryResult> {
  const latest = await latestVersionNumber(ctx, dashboardId);
  if (latest === null) throw new TotalBaseError("DASHBOARD_WIDGET_NOT_FOUND", `Widget not found: ${widgetId}`);
  return executeVersionWidget(ctx, dashboardId, latest, widgetId, limits, viewer, values, true);
}

/** A widget as it was in version `version` - Apps (latest) and the editor's read-only preview (any version). */
export async function executeVersionWidget(
  ctx: DashboardsContext,
  dashboardId: string,
  version: number,
  widgetId: string,
  limits: DashboardQueryLimits,
  viewer: DashboardViewer,
  values: Record<string, unknown>,
  /** Apps, embeds and the MCP: the result is reused (D24); the editor's preview always runs. */
  cached = false,
): Promise<DashboardQueryResult> {
  const snapshot = await versionSnapshot(ctx, dashboardId, version);
  const widget = snapshot.widgets.find((w) => w.id === widgetId);
  if (!widget) throw new TotalBaseError("DASHBOARD_WIDGET_NOT_FOUND", `Widget not found: ${widgetId}`);
  if (!widget.query) throw new TotalBaseError("DASHBOARD_WIDGET_NOT_CONFIGURED", "This widget has no query.");
  const published = cached ? { version, refreshIntervalSeconds: (await getDashboard(ctx, dashboardId)).refreshIntervalSeconds } : undefined;
  return executeWidget(ctx, { id: widget.id, type: widget.type, query: widget.query, config: widget.config }, limits, { ...viewer, variables: snapshot.variables, values }, { dashboardId, version, ...(published && { published }) });
}
