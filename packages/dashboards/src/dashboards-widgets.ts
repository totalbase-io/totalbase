import { convertDashboardConfig, DASHBOARD_WIDGET_TYPES, dashboardRolesProblem, dashboardValueKind, dashboardWidgetDefinition, isDashboardWidgetType, isPresentationWidget, resolveDashboardRoles, validateDashboardWidgetConfig, type DashboardWidgetType } from "@totalbase/tb-catalog";
import { TotalBaseError } from "@totalbase/errors";
import { isUuid } from "@totalbase/shared";
import type { TypedResultColumn } from "./typed-result.js";
import { validateWidgetTab, type DashboardTab } from "./tabs.js";
import { widgetReferenceErrors } from "./widget-marks.js";
import type { DashboardVariable } from "./variables.js";
import { toAdminWidget, type AdminDashboardWidget, type CreateWidgetInput, type DashboardsContext, type UpdateWidgetInput, type WidgetRow } from "./dashboards-types.js";
import { getDashboard } from "./dashboards-crud.js";
import { probeColumns } from "./dashboards-runner.js";

/** A widget's size on the canvas, at least its catalog's smallest (DB11) - an editor and an agent alike. */
export function assertWidgetSize(type: DashboardWidgetType, width: number, height: number): void {
  const { minSize, label } = dashboardWidgetDefinition(type);
  if (width < minSize.w || height < minSize.h) {
    throw new TotalBaseError("DASHBOARD_WIDGET_INVALID", `${label} is at least ${minSize.w}x${minSize.h} on the canvas - got ${width}x${height}.`);
  }
}

/** How long checking a widget's roles on save may plan its query - it reads no row. */
export const PROBE_TIMEOUT_MS = 5_000;

export function validateWidgetType(raw: string): DashboardWidgetType {
  if (!isDashboardWidgetType(raw)) {
    throw new TotalBaseError("DASHBOARD_WIDGET_INVALID", `type must be one of: ${DASHBOARD_WIDGET_TYPES.join(", ")}`);
  }
  return raw;
}

export const WIDGET_COLUMNS = "id, dashboard, type, label, grid_x, grid_y, grid_w, grid_h, query, config, tab, created_at, updated_at";

// --- Widgets (live draft) ---

export async function listWidgets(ctx: DashboardsContext, dashboardId: string): Promise<AdminDashboardWidget[]> {
  await getDashboard(ctx, dashboardId);
  const { rows } = await ctx.database.query<WidgetRow>(
    `SELECT ${WIDGET_COLUMNS} FROM totalbase.dashboards_widgets WHERE dashboard = $1 ORDER BY grid_y, grid_x`,
    [dashboardId],
  );
  return rows.map(toAdminWidget);
}

export async function getWidget(ctx: DashboardsContext, dashboardId: string, widgetId: string): Promise<AdminDashboardWidget> {
  const { rows } = await ctx.database.query<WidgetRow>(
    `SELECT ${WIDGET_COLUMNS} FROM totalbase.dashboards_widgets WHERE id = $1 AND dashboard = $2`,
    [widgetId, dashboardId],
  );
  const row = rows[0];
  if (!row) throw new TotalBaseError("DASHBOARD_WIDGET_NOT_FOUND", `Widget not found: ${widgetId}`);
  return toAdminWidget(row);
}

/** Adding a widget never asks for its source - it's inserted unconfigured and edited afterward (Specification_Dashboards.md §10.4). */
export async function addWidget(ctx: DashboardsContext, dashboardId: string, input: CreateWidgetInput): Promise<AdminDashboardWidget> {
  const dashboard = await getDashboard(ctx, dashboardId);
  const type = validateWidgetType(input.type);
  assertWidgetSize(type, input.gridW, input.gridH);
  const definition = dashboardWidgetDefinition(type);
  // Configured at once: every check an update makes, before the row exists (DB7) - a refused one leaves nothing.
  const config = input.config ?? {};
  const configErrors = validateDashboardWidgetConfig(type, config);
  if (configErrors.length) throw new TotalBaseError("DASHBOARD_WIDGET_INVALID", configErrors.join(" "));
  const tab = validateWidgetTab(input.tab, dashboard.tabs);
  const query = input.query && input.query.trim() !== "" ? input.query : null;
  let columns: TypedResultColumn[] | null = null;
  if (!definition.page && query) {
    columns = await probeColumns(ctx, query, dashboard.variables, PROBE_TIMEOUT_MS);
    if (columns) {
      const { errors, roles } = resolveDashboardRoles(type, config, columns);
      if (errors.length) throw new TotalBaseError("DASHBOARD_WIDGET_ROLES_INVALID", errors.join(" "));
      assertRolesDraw(type, config, roles);
    }
  }
  await assertWidgetReferences(ctx, definition.label, config, query ? columns : [], dashboard.variables);
  if (type === "TImage") await assertFixedImage(ctx, config);
  const { rows } = await ctx.database.query<WidgetRow>(
    `INSERT INTO totalbase.dashboards_widgets (dashboard, type, label, grid_x, grid_y, grid_w, grid_h, query, config, tab)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
     RETURNING ${WIDGET_COLUMNS}`,
    [dashboardId, type, input.label ?? null, input.gridX, input.gridY, input.gridW, input.gridH, query, JSON.stringify(config), tab],
  );
  return toAdminWidget(rows[0]!);
}

export async function updateWidget(ctx: DashboardsContext, dashboardId: string, widgetId: string, patch: UpdateWidgetInput): Promise<AdminDashboardWidget> {
  const current = await getWidget(ctx, dashboardId, widgetId);
  // A type switch stays among the data widgets: a presentation widget's props are its page widget's, no chart's.
  const type = patch.type !== undefined ? validateWidgetType(patch.type) : current.type;
  const typeChanged = type !== current.type;
  if (typeChanged && (isPresentationWidget(type) || isPresentationWidget(current.type))) {
    throw new TotalBaseError("DASHBOARD_WIDGET_INVALID", "A presentation widget (Image, Text, Frame...) keeps its type - only a chart switches, to another chart.");
  }
  // Switched without a config of its own: its equivalent roles and the props both types have.
  const config = patch.config ?? (typeChanged ? convertDashboardConfig(current.type, type, current.config) : undefined);
  // Its type's props and roles only, each with a value of its kind (the dashboard widget catalog).
  const configErrors = config !== undefined ? validateDashboardWidgetConfig(type, config) : [];
  if (configErrors.length) {
    throw new TotalBaseError("DASHBOARD_WIDGET_INVALID", configErrors.join(" "));
  }
  // Each role against what the query returns (D1): planned, never read - `LIMIT 0`. A query PostgreSQL refuses
  // saves as is: running it says why.
  const query = patch.query !== undefined ? patch.query : current.query;
  const dashboard = await getDashboard(ctx, dashboardId);
  const tab = patch.tab !== undefined ? validateWidgetTab(patch.tab, dashboard.tabs) : undefined;
  if (config !== undefined || patch.query !== undefined || typeChanged) {
    let columns: TypedResultColumn[] | null = null;
    const hasQuery = Boolean(query && query.trim() !== "");
    if (!isPresentationWidget(type) && hasQuery) {
      columns = await probeColumns(ctx, query!, dashboard.variables, PROBE_TIMEOUT_MS);
      if (columns) {
        const { errors, roles } = resolveDashboardRoles(type, config ?? current.config, columns);
        if (errors.length) throw new TotalBaseError("DASHBOARD_WIDGET_ROLES_INVALID", errors.join(" "));
        assertRolesDraw(type, config ?? current.config, roles);
      }
    }
    await assertWidgetReferences(ctx, dashboardWidgetDefinition(type).label, config ?? current.config, hasQuery ? columns : [], dashboard.variables);
    if (type === "TImage") await assertFixedImage(ctx, config ?? current.config);
  }

  if (patch.gridW !== undefined || patch.gridH !== undefined || typeChanged) assertWidgetSize(type, patch.gridW ?? current.gridW, patch.gridH ?? current.gridH);

  const sets: string[] = [];
  const values: unknown[] = [widgetId, dashboardId];
  function push(column: string, value: unknown, cast = ""): void {
    values.push(value);
    sets.push(`${column} = $${values.length}${cast}`);
  }
  if (typeChanged) push("type", type);
  if (patch.label !== undefined) push("label", patch.label);
  if (patch.gridX !== undefined) push("grid_x", patch.gridX);
  if (patch.gridY !== undefined) push("grid_y", patch.gridY);
  if (patch.gridW !== undefined) push("grid_w", patch.gridW);
  if (patch.gridH !== undefined) push("grid_h", patch.gridH);
  if (patch.query !== undefined) push("query", patch.query === null || patch.query.trim() === "" ? null : patch.query);
  if (config !== undefined) push("config", JSON.stringify(config), "::jsonb");
  if (tab !== undefined) push("tab", tab);
  if (sets.length === 0) return current;
  sets.push("updated_at = now()");

  const { rows } = await ctx.database.query<WidgetRow>(
    `UPDATE totalbase.dashboards_widgets SET ${sets.join(", ")} WHERE id = $1 AND dashboard = $2
     RETURNING ${WIDGET_COLUMNS}`,
    values,
  );
  return toAdminWidget(rows[0]!);
}

export async function deleteWidget(ctx: DashboardsContext, dashboardId: string, widgetId: string): Promise<void> {
  await getDashboard(ctx, dashboardId);
  const { rowCount } = await ctx.database.query(
    `DELETE FROM totalbase.dashboards_widgets WHERE id = $1 AND dashboard = $2`,
    [widgetId, dashboardId],
  );
  if (!rowCount) throw new TotalBaseError("DASHBOARD_WIDGET_NOT_FOUND", `Widget not found: ${widgetId}`);
}

/**
 * What a widget's roles can't draw beyond each role's own check (tanda 3): a COMBO's two values (D11), a PIVOT's
 * aggregate for every value (D17) - each its own code.
 */
export function assertRolesDraw(type: DashboardWidgetType, config: Record<string, unknown>, roles: ReturnType<typeof resolveDashboardRoles>["roles"]): void {
  const problem = dashboardRolesProblem(type, config, roles);
  if (problem) throw new TotalBaseError(problem.code, problem.message);
  if (type === "PIVOT") {
    const aggregates = (config.aggregates ?? {}) as Record<string, unknown>;
    const missing = (roles.values?.columns ?? []).filter((column) => typeof aggregates[column] !== "string");
    if (missing.length) {
      throw new TotalBaseError("DASHBOARD_PIVOT_AGGREGATE_REQUIRED", `Pivot table needs an aggregate for ${missing.map((c) => `"${c}"`).join(", ")} - one of sum, avg, min, max, count: aggregates: {"${missing[0]}": "sum"}.`);
    }
  }
}

/**
 * What a widget's marks and click name (DB15 for these places, D5, D6): its query's columns, the dashboard's
 * variables, a click's target DataView or dashboard (by id) and that dashboard's tab - refused with
 * DASHBOARD_WIDGET_REFERENCE_INVALID, each with its path and what was expected.
 */
export async function assertWidgetReferences(ctx: DashboardsContext, label: string, config: Record<string, unknown>, columns: readonly { name: string; dataType?: string }[] | null, variables: DashboardVariable[]): Promise<void> {
  const errors = await referenceProblems(ctx, label, config, columns, variables);
  if (errors.length) throw new TotalBaseError("DASHBOARD_WIDGET_REFERENCE_INVALID", errors.join(" "));
}

export async function referenceProblems(ctx: DashboardsContext, label: string, config: Record<string, unknown>, columns: readonly { name: string; dataType?: string }[] | null, variables: DashboardVariable[]): Promise<string[]> {
  const errors = widgetReferenceErrors(label, config, columns ? columns.map((c) => c.name) : null, variables, columns ? Object.fromEntries(columns.map((c) => [c.name, c.dataType ? dashboardValueKind({ dataType: c.dataType }) : "category"])) : undefined);
  errors.push(...(await clickTargetProblems(ctx, label, config)));
  return errors;
}

/**
 * A fixed image (DB14): an https URL, or a file that exists and is PUBLIC - anyone who opens the dashboard sees it.
 * A file from the query goes in its formula (bindings.src: {{row.<file column>}}), served signed.
 */
export async function assertFixedImage(ctx: DashboardsContext, config: Record<string, unknown>): Promise<void> {
  const src = (config.props as Record<string, unknown> | undefined)?.src;
  if (typeof src !== "string" || !src.trim()) return;
  const value = src.trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    const { rows } = await ctx.database.query<{ visibility: string }>(`SELECT visibility FROM totalbase.files WHERE id = $1`, [value]);
    if (!rows[0]) throw new TotalBaseError("DASHBOARD_WIDGET_INVALID", `Image's src: no file "${value}" - an uploaded file's id, or an https URL.`);
    if (rows[0].visibility !== "PUBLIC") throw new TotalBaseError("DASHBOARD_WIDGET_INVALID", `Image's src: the file is ${rows[0].visibility} - a fixed image is a PUBLIC file (anyone who opens the dashboard sees it); a file from the query goes in bindings.src: {{row.<column>}}.`);
    return;
  }
  if (!/^https:\/\//i.test(value)) throw new TotalBaseError("DASHBOARD_WIDGET_INVALID", `Image's src: an https URL or an uploaded file's id - got "${value.slice(0, 80)}".`);
}

/** A click's target, gone or never there: its DataView, its dashboard, the dashboard's tab. */
export async function clickTargetProblems(ctx: DashboardsContext, label: string, config: Record<string, unknown>): Promise<string[]> {
  const click = config.click as Record<string, unknown> | undefined;
  if (!click || typeof click !== "object") return [];
  if ((click.action === "DATAVIEW" || click.action === "RECORD") && typeof click.dataview === "string") {
    const found = isUuid(click.dataview)
      ? (await ctx.database.query(`SELECT 1 FROM totalbase.dataviews WHERE id = $1`, [click.dataview])).rows.length > 0
      : false;
    if (!found) return [`${label}'s click.dataview: no DataView "${click.dataview}" - a DataView's id (list_dataviews).`];
  }
  if (click.action === "DATAVIEW" && click.filter !== undefined && click.filter !== null && (typeof click.filter !== "object" || Array.isArray(click.filter))) {
    return [`${label}'s click.filter takes a filter object - the Data API's where grammar: {"column": {"_eq": "{{row.x}}"}}.`];
  }
  if (click.action === "DASHBOARD" && typeof click.dashboard === "string") {
    const { rows } = isUuid(click.dashboard)
      ? await ctx.database.query<{ tabs: DashboardTab[]; variables: DashboardVariable[] }>(`SELECT tabs, variables FROM totalbase.dashboards WHERE id = $1`, [click.dashboard])
      : { rows: [] };
    const target = rows[0];
    if (!target) return [`${label}'s click.dashboard: no dashboard "${click.dashboard}" - a dashboard's id (list_dashboards).`];
    const problems: string[] = [];
    if (typeof click.tab === "string" && !target.tabs.some((t) => t.value === click.tab)) {
      problems.push(`${label}'s click.tab: that dashboard has no tab "${click.tab}" - its tabs: ${target.tabs.map((t) => t.value).join(", ") || "none"}.`);
    }
    const targetNames = target.variables.map((v) => v.name);
    for (const name of Object.keys((click.variables as Record<string, unknown> | undefined) ?? {})) {
      if (!targetNames.includes(name)) problems.push(`${label}'s click.variables.${name}: that dashboard has no variable "${name}" - its variables: ${targetNames.join(", ") || "none"}.`);
    }
    return problems;
  }
  return [];
}
