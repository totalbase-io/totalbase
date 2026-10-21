import type { Database, Queryable } from "@totalbase/database";
import type { DashboardDecisionLanguage } from "@totalbase/tb-catalog";
import type { TypedResultColumn } from "./typed-result.js";
import type { DashboardTab } from "./tabs.js";
import { KeyedSemaphore, MemoryWidgetResultCache, SingleFlight } from "./widget-runs.js";
import type { DashboardRoleDecision, DashboardSpec, DashboardSpecDiff } from "./dashboard-spec.js";
import type { DashboardVariable } from "./variables.js";
import type {
  AdminDashboard,
  AdminDashboardVersion,
  AdminDashboardVersionSnapshot,
  AdminDashboardWidget,
  AdminDashboardWidgetContent,
  BrokenDashboardWidget,
  CreateDashboardInput,
  CreateWidgetInput,
  DashboardDraftRun,
  DashboardQueryContext,
  DashboardQueryLimits,
  DashboardQueryResult,
  DashboardsContext,
  DashboardVariableOption,
  DashboardViewer,
  UpdateDashboardInput,
  UpdateWidgetInput,
} from "./dashboards-types.js";
import * as crud from "./dashboards-crud.js";
import * as widgets from "./dashboards-widgets.js";
import * as runner from "./dashboards-runner.js";
import * as options from "./dashboards-variable-options.js";
import * as spec from "./dashboards-spec-apply.js";
import * as versions from "./dashboards-versions.js";

// The public shapes stay importable from here (and from the package index) - routes, MCP tools and tests
// never learned the module split.
export * from "./dashboards-types.js";
export { roleDecisions } from "./dashboards-runner.js";

/**
 * Admin management of dashboards/dashboards_widgets plus the
 * widget SQL executor. See Dashboards.md §2
 * (SQL-sourced widgets) and AGENTS.md section 7 "Dashboard
 * widget SQL".
 *
 * Same identity/versioning split as DataViewsAdminService: identity
 * stays live; `dashboards_widgets` is the editable draft and
 * `dashboards_versions` snapshots it per version - Apps only
 * ever reads (and executes) the latest snapshot.
 *
 * A façade: each responsibility lives in its own module (`dashboards-crud`,
 * `-widgets`, `-runner`, `-variable-options`, `-spec-apply`, `-versions`,
 * `-variable-resolver`), plain functions over the one `DashboardsContext`
 * this class holds - the pool and this instance's memos (D24). The methods
 * below are the stable surface routes, MCP tools and tests call.
 */
export class DashboardsAdminService {
  private readonly ctx: DashboardsContext;

  constructor(database: Database) {
    this.ctx = {
      database,
      results: new MemoryWidgetResultCache<DashboardQueryResult>(),
      inFlight: new SingleFlight<DashboardQueryResult>(),
      gates: new KeyedSemaphore(),
      snapshots: new Map(),
      plans: new Map(),
    };
  }

  // --- Dashboards and their roles (dashboards-crud.ts)

  /** Every dashboard with its versioning status - the admin's Dashboards list marks drafts and unpublished changes. */
  list(): Promise<AdminDashboard[]> {
    return crud.listDashboards(this.ctx);
  }

  /** Apps list and menu: published, LISTED dashboards only - `roleIds === null` is an Administrator. See `listPublished`. */
  listPublished(roleIds: string[] | null): Promise<AdminDashboard[]> {
    return crud.listPublished(this.ctx, roleIds);
  }

  /** Published dashboards kept out of the App menu (`EMBEDDED_ONLY`) - the App menu editor's Hidden section. */
  listHiddenFromMenu(): Promise<AdminDashboard[]> {
    return crud.listHiddenFromMenu(this.ctx);
  }

  /** Whether any of `roleIds` is granted this dashboard (Administrators are checked by the caller, not here). */
  isVisibleToRoles(dashboardId: string, roleIds: string[]): Promise<boolean> {
    return crud.isVisibleToRoles(this.ctx, dashboardId, roleIds);
  }

  get(id: string): Promise<AdminDashboard> {
    return crud.getDashboard(this.ctx, id);
  }

  /** get() plus the draft-vs-latest-version flag (Foundations.md §13.5) - the editor's GET only. */
  getWithStatus(id: string): Promise<AdminDashboard> {
    return crud.getWithStatus(this.ctx, id);
  }

  getBySlug(slug: string): Promise<AdminDashboard> {
    return crud.getDashboardBySlug(this.ctx, slug);
  }

  create(input: CreateDashboardInput): Promise<AdminDashboard> {
    return crud.createDashboard(this.ctx, input);
  }

  update(id: string, patch: UpdateDashboardInput): Promise<AdminDashboard> {
    return crud.updateDashboard(this.ctx, id, patch);
  }

  delete(id: string): Promise<void> {
    return crud.deleteDashboard(this.ctx, id);
  }

  listRoles(dashboardId: string): Promise<string[]> {
    return crud.listRoles(this.ctx, dashboardId);
  }

  /** Replaces the whole grant set - the admin UI edits it as one multi-select. */
  setRoles(dashboardId: string, roleIds: string[]): Promise<string[]> {
    return crud.setRoles(this.ctx, dashboardId, roleIds);
  }

  // --- Widgets, the live draft (dashboards-widgets.ts)

  listWidgets(dashboardId: string): Promise<AdminDashboardWidget[]> {
    return widgets.listWidgets(this.ctx, dashboardId);
  }

  getWidget(dashboardId: string, widgetId: string): Promise<AdminDashboardWidget> {
    return widgets.getWidget(this.ctx, dashboardId, widgetId);
  }

  /** Adding a widget never asks for its source - it's inserted unconfigured and edited afterward (Dashboards.md §10.4). */
  addWidget(dashboardId: string, input: CreateWidgetInput): Promise<AdminDashboardWidget> {
    return widgets.addWidget(this.ctx, dashboardId, input);
  }

  updateWidget(dashboardId: string, widgetId: string, patch: UpdateWidgetInput): Promise<AdminDashboardWidget> {
    return widgets.updateWidget(this.ctx, dashboardId, widgetId, patch);
  }

  deleteWidget(dashboardId: string, widgetId: string): Promise<void> {
    return widgets.deleteWidget(this.ctx, dashboardId, widgetId);
  }

  // --- Query execution (dashboards-runner.ts)

  /** Runs one widget query read-only (AGENTS.md section 7 "Dashboard widget SQL") - see `executeQuery`. */
  executeQuery(rawSql: string, limits: DashboardQueryLimits, context: DashboardQueryContext): Promise<DashboardQueryResult> {
    return runner.executeQuery(this.ctx, rawSql, limits, context);
  }

  /** Every widget whose query names what PostgreSQL no longer has (Dashboards.md §2.8). */
  brokenWidgets(timeoutMs: number): Promise<BrokenDashboardWidget[]> {
    return runner.brokenWidgets(this.ctx, timeoutMs);
  }

  /** Drops every memoized plan - after a catalog refresh (apps/server's reconcileCatalog), when columns may have changed under a query. */
  forgetPlans(): void {
    runner.forgetPlans(this.ctx);
  }

  /** The editor: ad-hoc SQL (the drawer's Run) against the draft's variable definitions. */
  executeDraftQuery(dashboardId: string, sql: string, limits: DashboardQueryLimits, viewer: DashboardViewer, values: Record<string, unknown>): Promise<DashboardQueryResult> {
    return runner.executeDraftQuery(this.ctx, dashboardId, sql, limits, viewer, values);
  }

  /** The editor canvas: a draft widget's run - with each role's columns and why (DM3) in the App's `language`. */
  executeDraftWidget(dashboardId: string, widgetId: string, limits: DashboardQueryLimits, viewer: DashboardViewer, values: Record<string, unknown>, language: DashboardDecisionLanguage = "en"): Promise<DashboardDraftRun> {
    return runner.executeDraftWidget(this.ctx, dashboardId, widgetId, limits, viewer, values, language);
  }

  /** Apps: a published widget, looked up by id in the latest snapshot - neither the query nor the variable definitions come from the caller. */
  executePublishedWidget(dashboardId: string, widgetId: string, limits: DashboardQueryLimits, viewer: DashboardViewer, values: Record<string, unknown>): Promise<DashboardQueryResult> {
    return runner.executePublishedWidget(this.ctx, dashboardId, widgetId, limits, viewer, values);
  }

  /** A widget as it was in version `version` - Apps (latest) and the editor's read-only preview (any version). */
  executeVersionWidget(dashboardId: string, version: number, widgetId: string, limits: DashboardQueryLimits, viewer: DashboardViewer, values: Record<string, unknown>, cached = false): Promise<DashboardQueryResult> {
    return runner.executeVersionWidget(this.ctx, dashboardId, version, widgetId, limits, viewer, values, cached);
  }

  // --- Variables (dashboards-variable-options.ts)

  /** A SELECT variable's options, for the variables bar - see `variableOptions`. */
  variableOptions(dashboardId: string, name: string, from: "DRAFT" | "PUBLISHED" | number, limits: DashboardQueryLimits, viewer: DashboardViewer, values: Record<string, unknown> = {}): Promise<DashboardVariableOption[]> {
    return options.variableOptions(this.ctx, dashboardId, name, from, limits, viewer, values);
  }

  /** Variables as a viewer's bar shows them (D22): each with `defaultValue` resolved for that viewer. */
  withDefaultValues(variables: DashboardVariable[], userId: string | null): Promise<(DashboardVariable & { defaultValue: unknown })[]> {
    return options.withDefaultValues(this.ctx, variables, userId);
  }

  // --- The draft as one document (dashboards-spec-apply.ts, Dashboards.md §8.3, DM2)

  /** The draft as a spec (get_dashboard): what apply_dashboard takes back as is. */
  getSpec(id: string): Promise<{ id: string; draftVersion: string; liveVersion: number | null; hasUnpublishedChanges: boolean; spec: DashboardSpec }> {
    return spec.getSpec(this.ctx, id);
  }

  /** Replaces a dashboard's whole draft with a spec, in one transaction - or creates it, without `id`. See `applySpec`. */
  applySpec(
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
    return spec.applySpec(this.ctx, id, input, language, onApplied);
  }

  // --- Versions (dashboards-versions.ts, Foundations.md §13)

  /** Snapshots the draft as the next version - a no-op when the draft equals the latest. See `publish`. */
  publish(dashboardId: string, userId: string | null, note: string | null = null): Promise<AdminDashboardVersion> {
    return versions.publish(this.ctx, dashboardId, userId, note);
  }

  /** Newest first, summary only (no snapshot payloads). */
  listVersions(dashboardId: string): Promise<AdminDashboardVersion[]> {
    return versions.listVersions(this.ctx, dashboardId);
  }

  /** Deletes every version before `before` (Foundations.md §13.4) - never the live one. */
  deleteVersionsBefore(dashboardId: string, before: number): Promise<{ deleted: number[] }> {
    return versions.deleteDashboardVersionsBefore(this.ctx, dashboardId, before);
  }

  /** One version's full content - the read-only preview, and the source of Restore / Save as. */
  getVersion(dashboardId: string, version: number): Promise<AdminDashboardVersionSnapshot> {
    return versions.getVersion(this.ctx, dashboardId, version);
  }

  /** The live (latest) version's snapshot - what Apps and an embed read; null if never published. */
  getLiveSnapshot(dashboardId: string): Promise<AdminDashboardVersionSnapshot | null> {
    return versions.getLiveSnapshot(this.ctx, dashboardId);
  }

  /** The live version's variable definitions - what Apps binds `$VAR.*` against. */
  getPublishedVariables(dashboardId: string): Promise<DashboardVariable[]> {
    return versions.getPublishedVariables(this.ctx, dashboardId);
  }

  /** The live version's tabs (D7) - what the App and an embed show. None if never published. */
  getPublishedTabs(dashboardId: string): Promise<DashboardTab[]> {
    return versions.getPublishedTabs(this.ctx, dashboardId);
  }

  /** What Apps renders - the live version's widgets, not the draft. Empty if never published. */
  getPublishedWidgets(dashboardId: string): Promise<AdminDashboardWidgetContent[]> {
    return versions.getPublishedWidgets(this.ctx, dashboardId);
  }

  /** Restore (Foundations.md §13.4): version `version`'s content replaces the draft; publishes nothing. */
  restore(dashboardId: string, version: number): Promise<AdminDashboard> {
    return versions.restore(this.ctx, dashboardId, version);
  }

  /** Duplicate (D26): a new dashboard from this one's draft - unpublished, opened by no role, with no embeds. */
  duplicate(dashboardId: string, input: { name: string; slug?: string | undefined }): Promise<AdminDashboard> {
    return versions.duplicateDashboard(this.ctx, dashboardId, input);
  }

  /** Save as (Foundations.md §13.4): a NEW dashboard whose draft is version `version`'s content. */
  duplicateVersion(dashboardId: string, version: number, input: { name: string; slug?: string | undefined }): Promise<AdminDashboard> {
    return versions.duplicateVersion(this.ctx, dashboardId, version, input);
  }
}
