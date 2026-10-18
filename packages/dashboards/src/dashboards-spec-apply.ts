import { createHash } from "node:crypto";
import type { Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { validateRoleColor } from "@totalbase/permissions";
import { slugify, validateDescription, validateMenuLabel, validateName, validateSlug } from "@totalbase/shared";
import { dashboardWidgetConfigIssues, dashboardWidgetDefinition, resolveDashboardRoles, type DashboardDecisionLanguage, type DashboardRoleAssignment, type DashboardWidgetType } from "@totalbase/tb-catalog";
import type { TypedResultColumn } from "./typed-result.js";
import { validateTabs, validateWidgetTab } from "./tabs.js";
import { validateVariables, type DashboardVariable } from "./variables.js";
import { canonicalJson, diffSpecs, emptyDiff, placeWidgets, type DashboardRoleDecision, type DashboardSpec, type DashboardSpecDiff, type DashboardSpecError, type NormalizedSpec } from "./dashboard-spec.js";
import type { AdminDashboard, DashboardsContext } from "./dashboards-types.js";
import { getDashboard, remapDashboardUniqueViolation, validateRefreshInterval } from "./dashboards-crud.js";
import { checkVariableSources } from "./dashboards-variable-options.js";
import { assertFixedImage, assertRolesDraw, assertWidgetSize, listWidgets, PROBE_TIMEOUT_MS, referenceProblems, validateWidgetType } from "./dashboards-widgets.js";
import { probeColumns, probeQuery, roleDecisions } from "./dashboards-runner.js";
import { hasUnpublishedChanges, latestVersionNumber } from "./dashboards-versions.js";

/** A variable's problem's path (DB41): `variables[i]` and the key it names - `variables[2].default.vlaue`. */
export function variablePath(index: number, message: string): string {
  const match = /^variables\[0\]((?:\.[A-Za-z0-9_]+|\[\d+\])*)(?: has no "([^"]+)")?/.exec(message);
  if (!match) return `variables[${index}]`;
  return `variables[${index}]${match[1] ?? ""}${match[2] ? `.${match[2]}` : ""}`;
}

/** Which role a roles error is about (its label in the message) - `.value` for apply_dashboard's path; none: the roles. */
export function rolePathOf(type: DashboardWidgetType, message: string): string {
  const definition = dashboardWidgetDefinition(type);
  for (const [id, role] of Object.entries(definition.roles as Record<string, { label: string }>)) {
    if (message.includes(`'s ${role.label}:`) || message.includes(`for ${role.label} -`)) return `.${id}`;
  }
  return "";
}

/** Which of a config's props a reference error is about - the first one it names; none: the config. */
export function referencePathOf(config: Record<string, unknown>, message: string): string {
  const key = Object.keys(config).find((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(message));
  return key ? `.${key}` : "";
}

// --- The draft as one document (Specification_Dashboards.md §10.6, DM2) ---

/** The draft with nothing implicit - what a spec is compared with. */
export async function normalizedDraft(ctx: DashboardsContext, dashboard: AdminDashboard): Promise<NormalizedSpec> {
  const widgets = await listWidgets(ctx, dashboard.id);
  return {
    dashboard: { name: dashboard.name, slug: dashboard.slug, description: dashboard.description, icon: dashboard.icon, menuLabel: dashboard.menuLabel, color: dashboard.color, scope: dashboard.scope, refreshIntervalSeconds: dashboard.refreshIntervalSeconds },
    variables: dashboard.variables,
    tabs: dashboard.tabs,
    widgets: widgets.map((w) => ({ id: w.id, type: w.type, label: w.label, tab: w.tab, grid: { x: w.gridX, y: w.gridY, w: w.gridW, h: w.gridH }, query: w.query, config: w.config })),
  };
}

/** What the draft is now, as a short hash of its spec - apply_dashboard's draftVersion. */
export function draftVersion(spec: NormalizedSpec): string {
  return createHash("sha256").update(canonicalJson(spec)).digest("hex").slice(0, 16);
}

/** The draft as a spec (get_dashboard): what apply_dashboard takes back as is - applied unchanged, nothing changes. */
export async function getSpec(ctx: DashboardsContext, id: string): Promise<{ id: string; draftVersion: string; liveVersion: number | null; hasUnpublishedChanges: boolean; spec: DashboardSpec }> {
  const dashboard = await getDashboard(ctx, id);
  const draft = await normalizedDraft(ctx, dashboard);
  const spec: DashboardSpec = {
    ...(draft.dashboard as Omit<DashboardSpec, "widgets" | "variables" | "tabs">),
    variables: draft.variables,
    tabs: draft.tabs,
    widgets: draft.widgets.map((w) => ({ id: w.id, type: w.type, label: w.label, tab: w.tab, grid: w.grid, query: w.query, config: w.config })),
  };
  return {
    id,
    draftVersion: draftVersion(draft),
    liveVersion: await latestVersionNumber(ctx, id),
    hasUnpublishedChanges: await hasUnpublishedChanges(ctx, id),
    spec,
  };
}

/**
 * Replaces a dashboard's whole draft with a spec, in one transaction (DM2) - or creates it, without `id`. Every check
 * the single tools make (update_dashboard's and save_widget's), plus what crosses them in the spec (a click's
 * variable, a widget's tab); all problems at once, each at its path (DASHBOARD_SPEC_INVALID) - nothing applied. A
 * `draftVersion` older than the draft is DASHBOARD_DRAFT_CHANGED. `dryRun` checks and answers the difference only.
 * `onApplied` runs in the same transaction (the route's audit event).
 */
export async function applySpec(
  ctx: DashboardsContext,
  id: string | null,
  input: { spec: unknown; draftVersion?: string | undefined; dryRun?: boolean | undefined },
  language: DashboardDecisionLanguage,
  onApplied?: (client: Queryable, summary: { dashboardId: string; created: boolean; diff: DashboardSpecDiff }) => Promise<void>,
): Promise<{
  id: string | null;
  created: boolean;
  applied: boolean;
  draftVersion: string | null;
  diff: DashboardSpecDiff;
  widgets: { path: string; id: string | null; columns: TypedResultColumn[] | null; roles: Record<string, DashboardRoleDecision> | null }[];
}> {
  const errors: DashboardSpecError[] = [];
  const fail = (path: string, error: unknown) => {
    if (error instanceof TotalBaseError) errors.push({ path, code: error.code, message: error.message });
    else throw error;
  };
  const attempt = async <T>(path: string, run: () => T | Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      fail(path, error);
      return undefined;
    }
  };
  const raw = input.spec;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TotalBaseError("DASHBOARD_SPEC_INVALID", "spec must be an object: {name, variables, tabs, widgets, ...}.");
  const spec = raw as Record<string, unknown>;
  const SPEC_KEYS = ["name", "slug", "description", "icon", "menuLabel", "color", "scope", "refreshIntervalSeconds", "variables", "tabs", "widgets"];
  for (const key of Object.keys(spec)) {
    if (!SPEC_KEYS.includes(key)) errors.push({ path: key, code: "DASHBOARD_SPEC_INVALID", message: `spec has no "${key}" - it takes: ${SPEC_KEYS.join(", ")}.` });
  }

  const current = id ? await getDashboard(ctx, id) : null;
  const draft = current ? await normalizedDraft(ctx, current) : null;
  if (draft && input.draftVersion !== undefined && input.draftVersion !== draftVersion(draft)) {
    throw new TotalBaseError("DASHBOARD_DRAFT_CHANGED", `The draft changed since it was read (its draftVersion is now ${draftVersion(draft)}) - read it again with get_dashboard and apply on that.`);
  }

  // The dashboard's own keys - unset is its default (a spec is the whole draft).
  const name = await attempt("name", () => validateName(spec.name as string));
  const slug = await attempt("slug", () => validateSlug(typeof spec.slug === "string" && spec.slug.trim() ? spec.slug : slugify(String(spec.name ?? ""))));
  const description = await attempt("description", () => validateDescription((spec.description ?? null) as string | null));
  const menuLabel = await attempt("menuLabel", () => validateMenuLabel((spec.menuLabel ?? null) as string | null));
  const color = await attempt("color", () => validateRoleColor((spec.color ?? null) as string | null, "INVALID_DASHBOARD_COLOR"));
  const refreshIntervalSeconds = await attempt("refreshIntervalSeconds", () => validateRefreshInterval(spec.refreshIntervalSeconds ?? null));
  const scope = spec.scope ?? "LISTED";
  if (scope !== "LISTED" && scope !== "EMBEDDED_ONLY") errors.push({ path: "scope", code: "DASHBOARD_SPEC_INVALID", message: `scope is LISTED or EMBEDDED_ONLY - got ${JSON.stringify(scope)}.` });
  if (spec.icon !== undefined && spec.icon !== null && typeof spec.icon !== "string") errors.push({ path: "icon", code: "DASHBOARD_SPEC_INVALID", message: "icon takes a Lucide icon name, e.g. i-lucide-chart-pie." });
  if (name !== undefined || slug !== undefined) {
    const { rows } = await ctx.database.query<{ name: string; slug: string }>(
      `SELECT name, slug FROM totalbase.dashboards WHERE (lower(name) = lower($1) OR slug = $2) AND id IS DISTINCT FROM $3::uuid`,
      [name ?? "", slug ?? "", id],
    );
    if (name !== undefined && rows.some((r) => r.name.toLowerCase() === name.toLowerCase())) errors.push({ path: "name", code: "DASHBOARD_NAME_DUPLICATE", message: `A dashboard is already named "${name}".` });
    if (slug !== undefined && rows.some((r) => r.slug === slug)) errors.push({ path: "slug", code: "DASHBOARD_SLUG_DUPLICATE", message: `A dashboard already has the slug "${slug}".` });
  }
  // The variables: a problem at its own path (DB41) - each checked alone to find it; the widgets then check against
  // the ones that hold, never against a broken one (no false error in a click or a query that uses it).
  let variables: DashboardVariable[] = [];
  const broken = new Set<string>();
  const rawVariables = spec.variables ?? [];
  try {
    variables = validateVariables(rawVariables);
    await checkVariableSources(ctx, variables);
  } catch (error) {
    if (!(error instanceof TotalBaseError)) throw error;
    const good: DashboardVariable[] = [];
    if (Array.isArray(rawVariables)) {
      rawVariables.forEach((item, index) => {
        try {
          good.push(validateVariables([item])[0]!);
        } catch (alone) {
          if (!(alone instanceof TotalBaseError)) throw alone;
          const message = alone.message.replace(/^variables\[0\]/, `variables[${index}]`);
          errors.push({ path: variablePath(index, alone.message), code: alone.code, message });
          const name = (item as { name?: unknown } | null)?.name;
          if (typeof name === "string") broken.add(name);
        }
      });
    }
    // Each holds alone: what fails is between them, or their sources.
    if (broken.size === 0) {
      errors.push({ path: "variables", code: error.code, message: error.message });
      for (const v of good) broken.add(v.name);
    }
    try {
      variables = validateVariables(good.filter((v) => !broken.has(v.name)));
    } catch {
      variables = [];
    }
  }
  const tabs = (await attempt("tabs", () => validateTabs(spec.tabs ?? []))) ?? [];

  // The widgets: each as save_widget checks it, against this spec's variables and tabs.
  const rawWidgets = Array.isArray(spec.widgets) ? spec.widgets : [];
  if (!Array.isArray(spec.widgets)) errors.push({ path: "widgets", code: "DASHBOARD_SPEC_INVALID", message: "widgets takes a list of widgets: [{type, label, query, config, grid?, tab?, id?}]." });
  const own = new Set(draft?.widgets.map((w) => w.id) ?? []);
  const seen = new Set<string>();
  const WIDGET_KEYS = ["id", "type", "label", "tab", "grid", "query", "config"];
  type Checked = { path: string; id: string | undefined; type: DashboardWidgetType; label: string | null; tab: string | null; grid: { x: number; y: number; w: number; h: number } | undefined; query: string | null; config: Record<string, unknown>; columns: TypedResultColumn[] | null; roles: Record<string, DashboardRoleAssignment> | null };
  const checked: Checked[] = [];
  for (const [index, item] of rawWidgets.entries()) {
    const path = `widgets[${index}]`;
    const before = errors.length;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push({ path, code: "DASHBOARD_WIDGET_INVALID", message: "A widget is an object: {type, label, query, config, grid?, tab?, id?}." });
      continue;
    }
    const widget = item as Record<string, unknown>;
    for (const key of Object.keys(widget)) {
      if (!WIDGET_KEYS.includes(key)) errors.push({ path: `${path}.${key}`, code: "DASHBOARD_WIDGET_INVALID", message: `A widget has no "${key}" - it takes: ${WIDGET_KEYS.join(", ")}.` });
    }
    const widgetId = typeof widget.id === "string" ? widget.id : undefined;
    if (widget.id !== undefined && widget.id !== null && (!widgetId || !own.has(widgetId))) {
      errors.push({ path: `${path}.id`, code: "DASHBOARD_WIDGET_NOT_FOUND", message: `${JSON.stringify(widget.id)} isn't a widget of this dashboard - leave id out for a new one.` });
      continue;
    }
    if (widgetId && seen.has(widgetId)) {
      errors.push({ path: `${path}.id`, code: "DASHBOARD_WIDGET_INVALID", message: `Widget ${widgetId} is in the spec twice.` });
      continue;
    }
    if (widgetId) seen.add(widgetId);
    const type = await attempt(`${path}.type`, () => validateWidgetType(String(widget.type ?? "")));
    if (type === undefined) continue;
    const definition = dashboardWidgetDefinition(type);
    const label = widget.label === undefined || widget.label === null ? null : String(widget.label);
    let grid: Checked["grid"];
    if (widget.grid !== undefined && widget.grid !== null) {
      const g = widget.grid as Record<string, unknown>;
      const ok = typeof g === "object" && ["x", "y", "w", "h"].every((k) => Number.isInteger(g[k])) && (g.x as number) >= 0 && (g.y as number) >= 0 && (g.w as number) >= 1 && (g.h as number) >= 1 && (g.x as number) + (g.w as number) <= 12;
      if (!ok) errors.push({ path: `${path}.grid`, code: "DASHBOARD_WIDGET_INVALID", message: `grid takes {x, y, w, h}: whole numbers, x 0-11, w 1-12, x + w at most 12 - got ${JSON.stringify(widget.grid)}.` });
      else {
        grid = { x: g.x as number, y: g.y as number, w: g.w as number, h: g.h as number };
        await attempt(`${path}.grid`, () => assertWidgetSize(type, grid!.w, grid!.h));
      }
    }
    const tab = (await attempt(`${path}.tab`, () => validateWidgetTab((widget.tab ?? null) as string | null, tabs))) ?? null;
    const config = (widget.config ?? {}) as Record<string, unknown>;
    const issues = dashboardWidgetConfigIssues(type, config);
    for (const issue of issues) errors.push({ path: `${path}.config${issue.path ? `.${issue.path}` : ""}`, code: "DASHBOARD_WIDGET_INVALID", message: issue.message });
    const query = typeof widget.query === "string" && widget.query.trim() !== "" ? widget.query : null;
    let columns: TypedResultColumn[] | null = null;
    let roles: Record<string, DashboardRoleAssignment> | null = null;
    // Every problem of the widget, not only its first (DB41) - but nothing it can't know: a variable that's broken
    // in this spec is said once, at its own path, not again by each query and click that uses it.
    const queryUsesBroken = [...broken].some((name) => new RegExp(`\\$VAR\\.${name}\\b`).test(query ?? ""));
    const namesBroken = (message: string) => [...broken].some((name) => message.includes(`"${name}"`) || message.includes(`vars.${name}`));
    const issuePaths = new Set(issues.map((i) => i.path));
    if (typeof config === "object" && config !== null && !Array.isArray(config)) {
      if (!definition.page && query && !queryUsesBroken) {
        columns = await probeColumns(ctx, query, variables, PROBE_TIMEOUT_MS);
        if (!columns) {
          const problem = await probeQuery(ctx, query, variables, PROBE_TIMEOUT_MS);
          if (problem) errors.push({ path: `${path}.query`, code: "DASHBOARD_WIDGET_QUERY_FAILED", message: problem.message });
        } else {
          const resolved = resolveDashboardRoles(type, config, columns);
          for (const message of resolved.errors) {
            const rolePath = `roles${rolePathOf(type, message)}`;
            // A role its config already refused (not a column name) isn't said twice.
            if (!issuePaths.has(rolePath)) errors.push({ path: `${path}.config.${rolePath}`, code: "DASHBOARD_WIDGET_ROLES_INVALID", message });
          }
          if (resolved.errors.length === 0) {
            roles = resolved.roles;
            await attempt(`${path}.config.roles`, () => assertRolesDraw(type, config, resolved.roles));
          }
        }
      }
      for (const message of await referenceProblems(ctx, definition.label, config, query && !queryUsesBroken ? columns : query ? null : [], variables)) {
        if (namesBroken(message)) continue;
        const at = referencePathOf(config, message);
        // A prop its shape already refused isn't checked again for what it names.
        if (![...issuePaths].some((p) => `.${p}` === at || `.${p}`.startsWith(`${at}.`))) errors.push({ path: `${path}.config${at}`, code: "DASHBOARD_WIDGET_REFERENCE_INVALID", message });
      }
      if (type === "TImage") await attempt(`${path}.config.props`, () => assertFixedImage(ctx, config));
    }
    if (errors.length > before) continue;
    checked.push({ path, id: widgetId, type, label, tab, grid, query, config, columns, roles });
  }
  if (errors.length) {
    throw new TotalBaseError("DASHBOARD_SPEC_INVALID", `The spec has ${errors.length === 1 ? "a problem" : `${errors.length} problems`} - nothing was applied: ${errors.map((e) => `${e.path}: ${e.message}`).join(" · ")}`, { all: errors.map((e) => ({ ...e, code: e.code as never })) });
  }

  // Widgets without a grid: placed in order, at their type's default size.
  const places = placeWidgets(checked.map((w) => ({ grid: w.grid, size: dashboardWidgetDefinition(w.type).size })));
  const next: NormalizedSpec = {
    dashboard: { name, slug, description, icon: (spec.icon ?? null) as string | null, menuLabel, color, scope, refreshIntervalSeconds },
    variables,
    tabs,
    widgets: checked.map((w, i) => ({ id: w.id, type: w.type, label: w.label, tab: w.tab, grid: places[i]!, query: w.query, config: w.config })),
  };
  const diff = diffSpecs(draft ?? { dashboard: { name: null, slug: null, description: null, icon: null, menuLabel: null, color: null, scope: null, refreshIntervalSeconds: null }, variables: [], tabs: [], widgets: [] }, next);
  const planned = checked.map((w) => ({ path: w.path, id: w.id ?? null, columns: w.columns, roles: w.roles ? roleDecisions(w.type, w.roles, language) : null }));
  if (input.dryRun || (current && emptyDiff(diff))) {
    return { id, created: false, applied: false, draftVersion: draft ? draftVersion(draft) : null, diff, widgets: planned };
  }

  try {
    const result = await ctx.database.transaction(async (client) => {
      const values = [name, slug, description, next.dashboard.icon, menuLabel, color, scope, refreshIntervalSeconds, JSON.stringify(variables), JSON.stringify(tabs)];
      const dashboardId = current
        ? (await client.query<{ id: string }>(
            `UPDATE totalbase.dashboards SET name = $2, slug = $3, description = $4, icon = $5, menu_label = $6, color = $7, scope = $8,
               refresh_interval_seconds = $9, variables = $10::jsonb, tabs = $11::jsonb, updated_at = now() WHERE id = $1 RETURNING id`,
            [current.id, ...values],
          )).rows[0]!.id
        : (await client.query<{ id: string }>(
            `INSERT INTO totalbase.dashboards (name, slug, description, icon, menu_label, color, scope, refresh_interval_seconds, variables, tabs)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb) RETURNING id`,
            values,
          )).rows[0]!.id;
      const deleted = diff.widgets.deleted.map((w) => w.id);
      if (deleted.length) await client.query(`DELETE FROM totalbase.dashboards_widgets WHERE dashboard = $1 AND id = ANY($2::uuid[])`, [dashboardId, deleted]);
      const ids: string[] = [];
      for (const widget of next.widgets) {
        const params = [widget.type, widget.label, widget.grid.x, widget.grid.y, widget.grid.w, widget.grid.h, widget.query, JSON.stringify(widget.config), widget.tab];
        if (widget.id) {
          await client.query(
            `UPDATE totalbase.dashboards_widgets SET type = $3, label = $4, grid_x = $5, grid_y = $6, grid_w = $7, grid_h = $8, query = $9, config = $10::jsonb, tab = $11, updated_at = now()
             WHERE id = $1 AND dashboard = $2 AND (type, label, grid_x, grid_y, grid_w, grid_h, query, config, tab) IS DISTINCT FROM ($3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
            [widget.id, dashboardId, ...params],
          );
          ids.push(widget.id);
        } else {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO totalbase.dashboards_widgets (dashboard, type, label, grid_x, grid_y, grid_w, grid_h, query, config, tab)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10) RETURNING id`,
            [dashboardId, ...params],
          );
          ids.push(rows[0]!.id);
        }
      }
      await onApplied?.(client, { dashboardId, created: !current, diff });
      return { dashboardId, ids };
    });
    const after = await normalizedDraft(ctx, await getDashboard(ctx, result.dashboardId));
    return {
      id: result.dashboardId,
      created: !current,
      applied: true,
      draftVersion: draftVersion(after),
      diff,
      widgets: planned.map((w, i) => ({ ...w, id: result.ids[i]! })),
    };
  } catch (error) {
    remapDashboardUniqueViolation(error);
  }
}
