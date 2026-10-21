import { deleteVersionsBefore, publishVersion, type Queryable, type VersionsTable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { dashboardWidgetDefinition, isPresentationWidget, resolveDashboardRoles } from "@totalbase/tb-catalog";
import type { DashboardTab } from "./tabs.js";
import type { DashboardVariable } from "./variables.js";
import { MAX_MEMOIZED, toAdminVersion, toWidgetContent, type AdminDashboard, type AdminDashboardVersion, type AdminDashboardVersionSnapshot, type AdminDashboardWidgetContent, type DashboardsContext, type VersionRow, type WidgetSnapshotRow } from "./dashboards-types.js";
import { createDashboard, getDashboard, getWithStatus } from "./dashboards-crud.js";
import { listWidgets, PROBE_TIMEOUT_MS, referenceProblems } from "./dashboards-widgets.js";
import { planQuery } from "./dashboards-runner.js";

/**
 * What a version snapshots: a widget's content only, no timestamps - so a
 * draft whose widgets were re-inserted by a Restore (fresh created_at)
 * still compares equal to the version it came from.
 */
export const WIDGET_SNAPSHOT_COLUMNS = "id, dashboard, type, label, grid_x, grid_y, grid_w, grid_h, query, config, tab";
export const VERSION_COLUMNS = `id, dashboard, version, restored_from_version, "user", published_at, note`;
/** The versions table as `@totalbase/database`'s shared versioning helpers see it. */
export const DASHBOARD_VERSIONS: VersionsTable = { table: "totalbase.dashboards_versions", owner: "dashboard", ownerTable: "totalbase.dashboards", columns: VERSION_COLUMNS };

/**
 * Foundations.md §13.5 as one SQL expression over a
 * `dashboards` row aliased `d`: the draft differs from the latest
 * version, or there is none. The draft's widgets are aggregated in the same
 * order and columns `draftSnapshot()` stores and compared with jsonb's
 * structural `=` - so the list (every row at once) and the editor header
 * can't disagree.
 */
export const HAS_UNPUBLISHED_CHANGES_SQL = `
  COALESCE((
    SELECT v.variables_snapshot = d.variables
       AND v.tabs_snapshot = d.tabs
       AND v.widgets_snapshot = (
         SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY w.grid_y, w.grid_x, w.id), '[]'::jsonb)
         FROM (SELECT ${WIDGET_SNAPSHOT_COLUMNS} FROM totalbase.dashboards_widgets WHERE dashboard = d.id) w
       )
    FROM totalbase.dashboards_versions v
    WHERE v.dashboard = d.id
    ORDER BY v.version DESC
    LIMIT 1
  ), false) = false`;

// --- Versions (Foundations.md §13) ---

/** The draft as a version would snapshot it - content only (WIDGET_SNAPSHOT_COLUMNS), deterministic order. */
export async function draftSnapshot(ctx: DashboardsContext, dashboard: AdminDashboard, on: Queryable = ctx.database): Promise<{ widgetsJson: string; variablesJson: string }> {
  const { rows } = await on.query<WidgetSnapshotRow>(
    `SELECT ${WIDGET_SNAPSHOT_COLUMNS} FROM totalbase.dashboards_widgets WHERE dashboard = $1 ORDER BY grid_y, grid_x, id`,
    [dashboard.id],
  );
  return { widgetsJson: JSON.stringify(rows), variablesJson: JSON.stringify(dashboard.variables) };
}

export async function latestVersionNumber(ctx: DashboardsContext, dashboardId: string): Promise<number | null> {
  const { rows } = await ctx.database.query<{ max: number | null }>(
    `SELECT MAX(version) AS max FROM totalbase.dashboards_versions WHERE dashboard = $1`,
    [dashboardId],
  );
  return rows[0]?.max ?? null;
}

/** Foundations.md §13.5 - see `HAS_UNPUBLISHED_CHANGES_SQL`. */
export async function hasUnpublishedChanges(ctx: DashboardsContext, dashboardId: string): Promise<boolean> {
  const { rows } = await ctx.database.query<{ changed: boolean }>(
    `SELECT ${HAS_UNPUBLISHED_CHANGES_SQL} AS changed FROM totalbase.dashboards d WHERE d.id = $1`,
    [dashboardId],
  );
  return rows[0]?.changed ?? true;
}

/**
 * Snapshots the draft as the next version - a no-op (returns the latest
 * version) when the draft equals it. A draft equal to an OLDER version
 * (Restore, Foundations.md §13.4) records it as `restored_from_version` - the newest one.
 */
export async function publish(ctx: DashboardsContext, dashboardId: string, userId: string | null, note: string | null = null): Promise<AdminDashboardVersion> {
  const dashboard = await getDashboard(ctx, dashboardId);
  // Never a widget that fails (DB10): its query planned (LIMIT 0, nothing read), its roles checked - else refused, listing each.
  const failing: string[] = [];
  for (const widget of await listWidgets(ctx, dashboardId)) {
    // One plan per widget serves both checks: its references and its roles (and PostgreSQL's refusal, if any).
    const plan = widget.query && !isPresentationWidget(widget.type) ? await planQuery(ctx, widget.query, dashboard.variables, PROBE_TIMEOUT_MS) : null;
    const columns = plan?.columns ?? null;
    // A click, a threshold or a total that names what isn't there - whatever the tab it's on (D6, D7).
    const references = await referenceProblems(ctx, dashboardWidgetDefinition(widget.type).label, widget.config, widget.query ? columns : [], dashboard.variables);
    if (references.length) failing.push(`"${widget.label || widget.type}": ${references.join(" ")}`);
    if (!widget.query || !dashboardWidgetDefinition(widget.type).query) continue;
    // Why it can't be published: PostgreSQL's refusal planning it, or a role it can't fill.
    const problem = plan === null ? null : plan.error ?? (resolveDashboardRoles(widget.type, widget.config, plan.columns).errors.join(" ") || null);
    if (problem) failing.push(`"${widget.label || widget.type}": ${problem}`);
  }
  if (failing.length) {
    throw new TotalBaseError("DASHBOARD_PUBLISH_BROKEN_WIDGETS", `Not published - ${failing.length === 1 ? "a widget fails" : `${failing.length} widgets fail`}: ${failing.join(" · ")}`);
  }
  const tabsJson = JSON.stringify(dashboard.tabs);

  // One transaction with the dashboard's row locked, the widgets read under that lock - `@totalbase/database`'s
  // `publishVersion`: the no-op on an unchanged draft, MAX + 1, `restored_from_version`.
  const row = await ctx.database.transaction((client) =>
    publishVersion<VersionRow>(client, DASHBOARD_VERSIONS, dashboardId, userId, async () => {
      const { widgetsJson, variablesJson } = await draftSnapshot(ctx, dashboard, client);
      return [
        { column: "widgets_snapshot", value: widgetsJson, cast: "jsonb" },
        { column: "variables_snapshot", value: variablesJson, cast: "jsonb" },
        { column: "tabs_snapshot", value: tabsJson, cast: "jsonb" },
      ];
    }, note),
  );
  forgetSnapshots(ctx, dashboardId);
  return toAdminVersion(row);
}

/** Newest first, summary only (no snapshot payloads). */
export async function listVersions(ctx: DashboardsContext, dashboardId: string): Promise<AdminDashboardVersion[]> {
  const { rows: exists } = await ctx.database.query(`SELECT 1 FROM totalbase.dashboards WHERE id = $1`, [dashboardId]);
  if (!exists[0]) throw new TotalBaseError("DASHBOARD_NOT_FOUND", `Dashboard not found: ${dashboardId}`);
  const { rows } = await ctx.database.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM totalbase.dashboards_versions WHERE dashboard = $1 ORDER BY version DESC`,
    [dashboardId],
  );
  return rows.map(toAdminVersion);
}

/**
 * Deletes every version before `before` (Foundations.md §13.4) - never the live (latest) one, so the next Publish stays latest + 1
 * and a number is never reused. A version deleted can't be restored.
 */
export async function deleteDashboardVersionsBefore(ctx: DashboardsContext, dashboardId: string, before: number): Promise<{ deleted: number[] }> {
  const { rows: exists } = await ctx.database.query(`SELECT 1 FROM totalbase.dashboards WHERE id = $1`, [dashboardId]);
  if (!exists[0]) throw new TotalBaseError("DASHBOARD_NOT_FOUND", `Dashboard not found: ${dashboardId}`);
  const deleted = await deleteVersionsBefore(ctx.database, DASHBOARD_VERSIONS, dashboardId, before);
  forgetSnapshots(ctx, dashboardId);
  return { deleted };
}

/** One version's full content - the read-only preview, and the source of Restore / Save as. */
export async function getVersion(ctx: DashboardsContext, dashboardId: string, version: number): Promise<AdminDashboardVersionSnapshot> {
  const { rows } = await ctx.database.query<VersionRow & { widgets_snapshot: WidgetSnapshotRow[]; variables_snapshot: DashboardVariable[]; tabs_snapshot: DashboardTab[] }>(
    `SELECT ${VERSION_COLUMNS}, widgets_snapshot, variables_snapshot, tabs_snapshot
     FROM totalbase.dashboards_versions WHERE dashboard = $1 AND version = $2`,
    [dashboardId, version],
  );
  const row = rows[0];
  if (!row) throw new TotalBaseError("DASHBOARD_VERSION_NOT_FOUND", `Version ${version} not found for Dashboard ${dashboardId}.`);
  return { ...toAdminVersion(row), widgets: row.widgets_snapshot.map(toWidgetContent), variables: row.variables_snapshot, tabs: row.tabs_snapshot ?? [] };
}

/** `getVersion` through the memo - the parsed snapshot shared by every read of that version until it is forgotten. */
export function versionSnapshot(ctx: DashboardsContext, dashboardId: string, version: number): Promise<AdminDashboardVersionSnapshot> {
  const key = `${dashboardId}/${version}`;
  const memoized = ctx.snapshots.get(key);
  if (memoized) {
    // Re-inserted as the newest: what a view keeps reading stays while idle versions leave first.
    ctx.snapshots.delete(key);
    ctx.snapshots.set(key, memoized);
    return memoized;
  }
  // The promise itself is memoized, so concurrent widget runs of a view share one load; a failed one isn't kept.
  const loading = getVersion(ctx, dashboardId, version);
  loading.catch(() => ctx.snapshots.delete(key));
  ctx.snapshots.set(key, loading);
  while (ctx.snapshots.size > MAX_MEMOIZED) ctx.snapshots.delete(ctx.snapshots.keys().next().value!);
  return loading;
}

/** Drops a dashboard's memoized snapshots - after a publish, a restore, a versions purge or its deletion. */
export function forgetSnapshots(ctx: DashboardsContext, dashboardId: string): void {
  for (const key of ctx.snapshots.keys()) {
    if (key.startsWith(`${dashboardId}/`)) ctx.snapshots.delete(key);
  }
  for (const key of ctx.plans.keys()) {
    if (key.startsWith(`${dashboardId}/`)) ctx.plans.delete(key);
  }
}

/**
 * The live (latest) version's snapshot - what Apps and an embed read: its widgets, variables and tabs, parsed once
 * per version. Null if never published. One MAX(version) query per call; the snapshot itself comes from the memo.
 */
export async function getLiveSnapshot(ctx: DashboardsContext, dashboardId: string): Promise<AdminDashboardVersionSnapshot | null> {
  const latest = await latestVersionNumber(ctx, dashboardId);
  return latest === null ? null : versionSnapshot(ctx, dashboardId, latest);
}

/** The live version's variable definitions - what Apps binds `$VAR.*` against. */
export async function getPublishedVariables(ctx: DashboardsContext, dashboardId: string): Promise<DashboardVariable[]> {
  return (await getLiveSnapshot(ctx, dashboardId))?.variables ?? [];
}

/** The live version's tabs (D7) - what the App and an embed show. None if never published. */
export async function getPublishedTabs(ctx: DashboardsContext, dashboardId: string): Promise<DashboardTab[]> {
  return (await getLiveSnapshot(ctx, dashboardId))?.tabs ?? [];
}

/** What Apps renders - the live version's widgets, not the draft. Empty if never published. */
export async function getPublishedWidgets(ctx: DashboardsContext, dashboardId: string): Promise<AdminDashboardWidgetContent[]> {
  return (await getLiveSnapshot(ctx, dashboardId))?.widgets ?? [];
}

/**
 * Restore (Foundations.md §13.4): version `version`'s content replaces the draft. Publishes
 * nothing - the next publish() does, recording `restored_from_version`
 * if the draft is still that version's content ("v8 · restored from v4").
 * The UI confirms first when the draft had unpublished changes.
 */
export async function restore(ctx: DashboardsContext, dashboardId: string, version: number): Promise<AdminDashboard> {
  const target = await getVersion(ctx, dashboardId, version);
  await ctx.database.transaction(async (client) => {
    await client.query(`UPDATE totalbase.dashboards SET variables = $2::jsonb, tabs = $3::jsonb, updated_at = now() WHERE id = $1`, [
      dashboardId,
      JSON.stringify(target.variables),
      JSON.stringify(target.tabs),
    ]);
    await client.query(`DELETE FROM totalbase.dashboards_widgets WHERE dashboard = $1`, [dashboardId]);
    for (const w of target.widgets) {
      await client.query(
        `INSERT INTO totalbase.dashboards_widgets
           (id, dashboard, type, label, grid_x, grid_y, grid_w, grid_h, query, config, tab)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
        [w.id, dashboardId, w.type, w.label, w.gridX, w.gridY, w.gridW, w.gridH, w.query, JSON.stringify(w.config), w.tab],
      );
    }
  });
  forgetSnapshots(ctx, dashboardId);
  return getDashboard(ctx, dashboardId);
}

/**
 * Save as (Foundations.md §13.4): a NEW dashboard whose draft is version `version`'s
 * content - fresh widget ids, identity (description/icon/color) and the auto-refresh interval copied,
 * no versions (unpublished) and no role grants (starts admin-only).
 */
/**
 * Duplicate (D26): a new dashboard from this one's draft - its identity under a new name and slug, its variables and
 * widgets - unpublished, opened by no role, with no embeds (who sees a copy is decided anew).
 */
export async function duplicateDashboard(ctx: DashboardsContext, dashboardId: string, input: { name: string; slug?: string | undefined }): Promise<AdminDashboard> {
  const source = await getDashboard(ctx, dashboardId);
  return copyInto(ctx, source, input, source.variables, await listWidgets(ctx, dashboardId), source.tabs);
}

export async function duplicateVersion(ctx: DashboardsContext, dashboardId: string, version: number, input: { name: string; slug?: string | undefined }): Promise<AdminDashboard> {
  const source = await getDashboard(ctx, dashboardId);
  const target = await getVersion(ctx, dashboardId, version);
  return copyInto(ctx, source, input, target.variables, target.widgets, target.tabs);
}

export async function copyInto(ctx: DashboardsContext, source: AdminDashboard, input: { name: string; slug?: string | undefined }, variables: DashboardVariable[], widgets: AdminDashboardWidgetContent[], tabs: DashboardTab[]): Promise<AdminDashboard> {
  const created = await createDashboard(ctx, {
    name: input.name,
    slug: input.slug,
    description: source.description,
    icon: source.icon,
    color: source.color,
    refreshIntervalSeconds: source.refreshIntervalSeconds,
  });
  await ctx.database.transaction(async (client) => {
    await client.query(`UPDATE totalbase.dashboards SET variables = $2::jsonb, menu_label = $3, scope = $4, tabs = $5::jsonb WHERE id = $1`, [created.id, JSON.stringify(variables), source.menuLabel ?? null, source.scope, JSON.stringify(tabs)]);
    for (const w of widgets) {
      await client.query(
        `INSERT INTO totalbase.dashboards_widgets
           (dashboard, type, label, grid_x, grid_y, grid_w, grid_h, query, config, tab)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
        [created.id, w.type, w.label, w.gridX, w.gridY, w.gridW, w.gridH, w.query, JSON.stringify(w.config), w.tab],
      );
    }
  });
  return getWithStatus(ctx, created.id);
}
