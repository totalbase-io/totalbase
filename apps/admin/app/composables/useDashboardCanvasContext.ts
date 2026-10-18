import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { DashboardTab, DashboardVariable, DashboardWidgetContent } from '~/types/dashboard'

/**
 * Bridges the Dashboard editor's canvas state into DashboardWidgetCard.vue
 * - same reasoning as DataView's useDesignCanvasContext.ts: GridStack
 * mounts the card through its own `component`/`props` JSON widget
 * mechanism, not a normal parent template binding, so only the widget's
 * own immutable id travels as a real widget prop. Everything that can
 * change later is read reactively through this injected context.
 */
export interface DashboardCanvasContext {
  dashboardId: string
  widgets: ComputedRef<DashboardWidgetContent[]>
  onEdit: (widget: DashboardWidgetContent) => void
  /** Asks before deleting (the editor's confirm). */
  onDelete: (widget: DashboardWidgetContent) => void
  /** A copy right below the canvas - the editor's only; the App's read-only view has none. */
  onDuplicate?: (widget: DashboardWidgetContent) => void
  /** Bumped by the header's Refresh action - every mounted card re-runs its query. */
  refreshKey: Ref<number>
  /** The App's viewer only: each card re-runs its query this often (seconds; null = off) - Specification_Dashboards.md §9.4. The editor's canvas has none. */
  refreshIntervalSeconds?: Ref<number | null>
  /** The variables' definitions - a card's empty text reads whether it filters by a period (D23). */
  variables?: Readonly<Ref<DashboardVariable[]>>
  /** A card's run came back - the viewer's "Updated 2 min ago" (D23). */
  onLoaded?: () => void
  /** The variables bar's explicitly-set `$VAR.*` values - sent with every data request. */
  variableValues: Ref<Record<string, unknown>>
  /** What the bar shows for each variable's value (an option's label, a preset's name) - `{{vars.<name>.label}}` (D3). */
  variableLabels?: Readonly<Ref<Record<string, string>>>
  /** Who is viewing, as `{{user.<field>}}` reads them - none in an embed (D3). */
  user?: Readonly<Ref<Record<string, unknown> | null>>
  /** A version is being previewed (Specification.md §13.4): no edit/remove, no drag. */
  readOnly: Ref<boolean>
  /** API path a card fetches its data from - the draft's query, the previewed version's snapshot, or (App) the published widget. */
  dataPath: (widget: DashboardWidgetContent) => string
  /** Which API `dataPath` is on: the editor's Admin API, or the App's (a viewer, never shown SQL - a widget carries `configured` instead of its query). Default admin. */
  plane?: 'admin' | 'app'
  /** The client `dataPath` is called with, when it isn't the plane's own - a signed embed's (useEmbedApi). */
  client?: { post: <T>(path: string, body?: unknown) => Promise<{ data: T }> }
  /**
   * A viewer's clicks (D6): a widget's `config.click` runs - a FILTER sets a variable through `onFilter` (the App's
   * page pushes it to the URL, so Back undoes it), the rest navigate. Unset: the editor's canvas - no click runs.
   */
  onFilter?: (variable: string, value: unknown) => void
  /** Its tabs (D7) - the editor's ⋮ moves a widget to another. */
  tabs?: Readonly<Ref<DashboardTab[]>>
  onMoveToTab?: (widget: DashboardWidgetContent, tab: string) => void
  /** A viewer's downloads (D8): offered in the card's ⋮ (an embed only when it allows them), each recorded at `auditPath`. */
  exports?: { allowed: boolean, auditPath: (widget: DashboardWidgetContent) => string }
}

/** A widget as the App serves it: no SQL, just whether there is one. */
export type ViewerDashboardWidget = Omit<DashboardWidgetContent, 'query'> & { query?: string | null, configured?: boolean }

export const DASHBOARD_CANVAS_CONTEXT_KEY: InjectionKey<DashboardCanvasContext> = Symbol('dashboard-canvas-context')
