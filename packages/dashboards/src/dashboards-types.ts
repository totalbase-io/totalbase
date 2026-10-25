import type { Database } from "@totalbase/database";
import type { RoleColor } from "@totalbase/permissions";
import type { DashboardRefreshInterval, DashboardWidgetType } from "@totalbase/tb-catalog";
import type { TypedResultColumn } from "./typed-result.js";
import type { DashboardTab } from "./tabs.js";
import { markVariables, type DashboardWidgetMarks } from "./widget-marks.js";
import type { KeyedSemaphore, MemoryWidgetResultCache, SingleFlight } from "./widget-runs.js";
import type { DashboardRoleDecision } from "./dashboard-spec.js";
import { referencedVariableNames } from "./sql-variables.js";
import type { DashboardVariable } from "./variables.js";

// The widget types and what each one's `config` may hold are the dashboard
// widget catalog's (@totalbase/tb-catalog) - one catalog for the admin and here.
export { DASHBOARD_REFRESH_INTERVALS, DASHBOARD_WIDGET_TYPES, type DashboardRefreshInterval, type DashboardWidgetType } from "@totalbase/tb-catalog";

/** LISTED shows in the App's menu and list; EMBEDDED_ONLY is only mounted inside a DataView page, by a `TDashboard` widget (Dashboards.md §9.3). */
export type DashboardScope = "LISTED" | "EMBEDDED_ONLY";

export interface AdminDashboard {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  /** What the App menu shows - null: its name. Live, like the name: never part of a published version. */
  menuLabel: string | null;
  icon: string | null;
  color: RoleColor | null;
  scope: DashboardScope;
  /** The App viewer's auto-refresh interval in seconds (Dashboards.md §9.4); null = off. Not versioned, like scope. */
  refreshIntervalSeconds: DashboardRefreshInterval | null;
  /** Whether a signed embed token may show its published version outside TotalBase (Dashboards.md §9.5). Not versioned; off by default, and a copy starts off. */
  embeddingEnabled: boolean;
  /** Whether a manager may open it to the roles below theirs (Security.md §9.7) - an administrator's word that its SQL is written with $USER.*. Not versioned; off by default. */
  delegable: boolean;
  /** Draft variable definitions ($VAR.*) - see variables.ts. */
  variables: DashboardVariable[];
  /** Its tabs (D7) - none: one grid. Versioned with its widgets. */
  tabs: DashboardTab[];
  /** list() and getWithStatus() only: the draft differs from the latest version (or there is none). Foundations.md §13.5. */
  hasUnpublishedChanges?: boolean;
  /** list() only: the live (highest) version, null until first published. */
  liveVersion?: number | null;
  createdAt: string;
  updatedAt: string;
}

/** A widget's content - what a version snapshots (no timestamps, see WIDGET_SNAPSHOT_COLUMNS). */
export interface AdminDashboardWidgetContent {
  id: string;
  dashboard: string;
  type: DashboardWidgetType;
  label: string | null;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
  /** Admin-authored SQL; null = not configured yet (a presentation widget draws without one). */
  query: string | null;
  /** Column mapping + appearance for this widget type. */
  config: Record<string, unknown>;
  /** The tab it is on (D7) - null: the first (or the only grid). */
  tab: string | null;
  /** `$VAR.*` names the query uses - a host re-runs only the widgets a changed value affects. */
  referencedVariables: string[];
}

/** A draft widget - its content plus when it was created and last changed. */
export interface AdminDashboardWidget extends AdminDashboardWidgetContent {
  createdAt: string;
  updatedAt: string;
}

/**
 * A widget whose query PostgreSQL no longer accepts - a column, a table or view, or a function it names
 * is gone (Dashboards.md §2.8). `version`: null for the draft, else the live version.
 */
export interface BrokenDashboardWidget {
  dashboard: { id: string; name: string; slug: string };
  widget: { id: string; label: string | null; type: string };
  version: number | null;
  /** PostgreSQL's code for a lost name in its query, or CLICK_TARGET_MISSING: its click's DataView, dashboard or tab is gone (D6). */
  code: "UNDEFINED_COLUMN" | "UNDEFINED_TABLE" | "UNDEFINED_FUNCTION" | "CLICK_TARGET_MISSING";
  message: string;
  query: string | null;
}

/** One immutable version (Foundations.md §13) - summary, no snapshot payload. */
export interface AdminDashboardVersion {
  id: string;
  dashboard: string;
  version: number;
  restoredFromVersion: number | null;
  user: string | null;
  publishedAt: string;
  /** The publisher's note (Foundations.md §13.3). */
  note: string | null;
}

/** One version's full content - the editor's read-only preview. */
export interface AdminDashboardVersionSnapshot extends AdminDashboardVersion {
  /** As published - a snapshot carries no timestamps. */
  widgets: AdminDashboardWidgetContent[];
  variables: DashboardVariable[];
  tabs: DashboardTab[];
}

export type DashboardQueryColumn = TypedResultColumn;

export interface DashboardQueryResult {
  columns: DashboardQueryColumn[];
  rows: Record<string, unknown>[];
  /** True when the row cap cut the result short. */
  truncated: boolean;
  /** How long PostgreSQL took (D24) - the editor's "12 rows · 85 ms". */
  durationMs: number;
  /** Served from the cache (D24) - `durationMs` is then the run that filled it. */
  cached: boolean;
  /** A table's totals by column (D28) - computed by PostgreSQL over every row the query returns, not only those sent. Null: none asked. */
  totals: Record<string, unknown> | null;
  /** Its thresholds' and reference lines' values, resolved (D5): a column of its row, a variable's value. Null: none. */
  marks: DashboardWidgetMarks | null;
  /** Each file a file column returned, with its signed link (D14) - filled by the route that serves it; null: none. */
  files: Record<string, { url: string | null; name: string; mimeType: string; image: boolean; blocked?: true }> | null;
}

export interface DashboardQueryLimits {
  timeoutMs: number;
  maxRows: number;
  /** At most this many widget queries of one dashboard at once (`dashboards.max_concurrent_queries`, D24). */
  maxConcurrent?: number;
  /** How long a published widget's result is reused (`dashboards.cache_seconds`; 0: never) - its dashboard's refresh interval when it has one. */
  cacheSeconds?: number;
  /** Refresh: run it now, whatever the cache holds (and keep the new result). */
  fresh?: boolean;
}

/** What `$USER.*` / `$VAR.*` resolve against for one execution. */
/** Who runs a widget's query: `$USER.*` reads their real row, and the query runs in their time zone. */
export interface DashboardViewer {
  /** Null = no user (any `$USER.*` fails). */
  userId: string | null;
  /** Their effective time zone (profile, else instance, else browser) - the transaction's `TimeZone`, so `now()`, `date_trunc` and a timestamptz cast to a date cut days where they see them. Unset: PostgreSQL's own. */
  timezone?: string | undefined;
}

export interface DashboardQueryContext extends DashboardViewer {
  /** The definitions in effect - the draft's in the editor, the published snapshot's in Apps. */
  variables: DashboardVariable[];
  /** Viewer-chosen values by variable name; a missing name falls back to the definition's default. */
  values: Record<string, unknown>;
}

export interface DashboardVariableOption {
  value: string;
  label: string;
}

export interface CreateDashboardInput {
  name: string;
  slug?: string | undefined;
  description?: string | null | undefined;
  icon?: string | null | undefined;
  color?: string | null | undefined;
  scope?: DashboardScope | undefined;
  refreshIntervalSeconds?: number | null | undefined;
}

export interface UpdateDashboardInput {
  name?: string | undefined;
  slug?: string | undefined;
  description?: string | null | undefined;
  /** The App menu's label - empty or null: its name. */
  menuLabel?: string | null | undefined;
  icon?: string | null | undefined;
  color?: string | null | undefined;
  scope?: DashboardScope | undefined;
  refreshIntervalSeconds?: number | null | undefined;
  embeddingEnabled?: boolean | undefined;
  delegable?: boolean | undefined;
  /** Replaces the whole definition list - validated by validateVariables(). */
  variables?: unknown;
  /** Replaces its tabs (D7) - a tab that holds widgets can't go (DASHBOARD_TAB_NOT_EMPTY); [] joins them in one grid. */
  tabs?: unknown;
}

export interface CreateWidgetInput {
  type: DashboardWidgetType;
  label?: string | null | undefined;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
  /** Configured in the same call - checked as an update is, before anything is inserted (all or nothing). */
  query?: string | null | undefined;
  config?: Record<string, unknown> | undefined;
  /** Its tab (D7) - unset: the first. */
  tab?: string | null | undefined;
}

export interface UpdateWidgetInput {
  /** Another data widget's type - a chart switched, its query kept. Never to or from a presentation widget. */
  type?: string | undefined;
  label?: string | null | undefined;
  gridX?: number | undefined;
  gridY?: number | undefined;
  gridW?: number | undefined;
  gridH?: number | undefined;
  query?: string | null | undefined;
  config?: Record<string, unknown> | undefined;
  /** Moved to another tab (D7); null: the first. */
  tab?: string | null | undefined;
}

export interface DashboardRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  menu_label: string | null;
  icon: string | null;
  color: string | null;
  scope: DashboardScope;
  refresh_interval_seconds: DashboardRefreshInterval | null;
  embedding_enabled: boolean;
  delegable: boolean;
  variables: DashboardVariable[];
  tabs: DashboardTab[];
  created_at: string;
  updated_at: string;
}

export function toAdminDashboard(row: DashboardRow): AdminDashboard {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    menuLabel: row.menu_label,
    icon: row.icon,
    color: row.color as RoleColor | null,
    scope: row.scope,
    refreshIntervalSeconds: row.refresh_interval_seconds,
    embeddingEnabled: row.embedding_enabled,
    delegable: row.delegable,
    variables: row.variables,
    tabs: row.tabs ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface WidgetRow {
  id: string;
  dashboard: string;
  type: DashboardWidgetType;
  label: string | null;
  grid_x: number;
  grid_y: number;
  grid_w: number;
  grid_h: number;
  query: string | null;
  config: Record<string, unknown>;
  tab: string | null;
  created_at: string;
  updated_at: string;
}

export type WidgetSnapshotRow = Omit<WidgetRow, "created_at" | "updated_at">;

export function toWidgetContent(row: WidgetSnapshotRow): AdminDashboardWidgetContent {
  return {
    id: row.id,
    dashboard: row.dashboard,
    type: row.type,
    label: row.label,
    gridX: row.grid_x,
    gridY: row.grid_y,
    gridW: row.grid_w,
    gridH: row.grid_h,
    query: row.query,
    config: row.config,
    tab: row.tab ?? null,
    // What it reads: its query's variables, and those its thresholds and reference lines take (DB24).
    referencedVariables: [...new Set([...referencedVariableNames(row.query), ...markVariables(row.config ?? {})])],
  };
}

export function toAdminWidget(row: WidgetRow): AdminDashboardWidget {
  return { ...toWidgetContent(row), createdAt: row.created_at, updatedAt: row.updated_at };
}

export interface VersionRow {
  id: string;
  dashboard: string;
  version: number;
  restored_from_version: number | null;
  user: string | null;
  published_at: string;
  note: string | null;
}

export function toAdminVersion(row: VersionRow): AdminDashboardVersion {
  return {
    id: row.id,
    dashboard: row.dashboard,
    version: row.version,
    restoredFromVersion: row.restored_from_version,
    user: row.user,
    publishedAt: row.published_at,
    note: row.note,
  };
}

/** What a run's result carries for its author (DM3): each role's columns and why - a draft run only. */
export interface DashboardDraftRun extends DashboardQueryResult {
  roles?: Record<string, DashboardRoleDecision>;
}

/**
 * What every Dashboards module works over - the façade's private state, passed explicitly: the pool and this
 * instance's memos (D24) - published widgets' results, identical runs in flight, each dashboard's queries at once,
 * parsed version snapshots and planned columns. The façade creates them once; `forgetSnapshots`/`forgetPlans`
 * (dashboards-versions.ts, dashboards-runner.ts) drop them.
 */
export interface DashboardsContext {
  database: Database;
  /** Published widgets' results, identical runs in flight, and each dashboard's queries at once (D24) - this instance's. */
  results: MemoryWidgetResultCache<DashboardQueryResult>;
  inFlight: SingleFlight<DashboardQueryResult>;
  gates: KeyedSemaphore;
  /**
   * Version snapshots already parsed, keyed `dashboard/version` - a version row never changes, so N widgets of one
   * dashboard view parse its JSON once instead of once per widget (and per embed check). Bounded by count, oldest
   * use out first; a dashboard's entries are dropped when its versions change or it is deleted (`forgetSnapshots`).
   */
  snapshots: Map<string, Promise<AdminDashboardVersionSnapshot>>;
  /** Published widgets' planned columns, keyed `dashboard/version/widget` (`plannedColumns`) - same bound and lifetime as the snapshots. */
  plans: Map<string, Promise<TypedResultColumn[] | null>>;
}

/** How many snapshots, and how many plans, the memos keep at most - oldest use out first. */
export const MAX_MEMOIZED = 256;
