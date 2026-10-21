import { DASHBOARD_WIDGET_GROUPS, DASHBOARD_WIDGET_TYPES, dashboardWidgetDefinition, type ColumnPresentation, type DashboardWidgetGroup, type DashboardWidgetType } from '@totalbase/tb-catalog'
import type { RoleColor } from '~/types/permission'
import { useCatalogText } from '~/utils/catalog-text'
import { designerCatalogText } from '~/utils/designer-catalog-text'

/** Shape of `totalbase.dashboards` rows as returned by the Admin API — Dashboards.md. */
/** A dashboard's tab (D7) - UTabs' item. */
export interface DashboardTab {
  value: string
  label: string
  icon?: string
}

export interface Dashboard {
  id: string
  name: string
  slug: string
  description: string | null
  /** What the App menu shows - null: its name. Live, never versioned. */
  menuLabel: string | null
  icon: string | null
  color: RoleColor | null
  /** LISTED shows in the App menu and list; EMBEDDED_ONLY is only mounted inside a DataView page (a `TDashboard` widget). */
  scope: 'LISTED' | 'EMBEDDED_ONLY'
  /** The App viewer's auto-refresh interval in seconds (one of DASHBOARD_REFRESH_INTERVALS); null = off. Not versioned. */
  refreshIntervalSeconds: number | null
  /** A signed embed token may show its published version outside TotalBase (Dashboards.md §9.5). */
  embeddingEnabled?: boolean
  /** Draft variable definitions ($VAR.*) - Dashboards.md §3.3. */
  variables: DashboardVariable[]
  /** Its tabs (D7) - none: one grid. The App reads the published ones. */
  tabs?: DashboardTab[]
  /** The draft differs from the live version, or there's no version yet (GET /dashboards and GET /dashboards/:id) - Foundations.md §13.5. */
  hasUnpublishedChanges?: boolean
  /** The live (highest) version, null until first published - GET /dashboards only. */
  liveVersion?: number | null
  createdAt: string
  updatedAt: string
}

export type DashboardVariableType = 'DATE_RANGE' | 'SELECT' | 'TEXT' | 'NUMBER'
export type DateRangePreset = 'last_hour' | 'today' | 'last_7_days' | 'last_30_days' | 'last_90_days' | 'this_month' | 'last_month' | 'this_year' | 'all'
export type DateRangeValue = DateRangePreset | { from: string, to: string }

/** A fixed list's option: its value and, optionally, the text the viewer reads. */
export interface DashboardStaticOption {
  value: string
  label?: string
}

export type DashboardVariableOptions
  = | { source: 'STATIC', values: DashboardStaticOption[] }
    | { source: 'QUERY', query: string }
    | { source: 'TABLE', resource: string, filters?: { column: string, variable: string }[] }

/** A variable's default (D22): a constant, or a field of the viewer's own user row. */
export type DashboardVariableDefault = { source: 'constant', value: unknown } | { source: 'user', field: string }

/** One `$VAR.<name>` - a filter the viewer picks, never a security boundary (that's `$USER.*`). */
export interface DashboardVariable {
  name: string
  label: string
  type: DashboardVariableType
  multiple?: boolean
  options?: DashboardVariableOptions
  default?: DashboardVariableDefault
  /** Its default resolved for whoever reads it (server-derived, D22) - what the bar starts with. */
  defaultValue?: unknown
  /** SELECT with an options query or table filters: the variables it reads - its options reload when one changes (server-derived). */
  dependsOn?: string[]
}

export interface DashboardVariableOption {
  value: string
  label: string
}

export const DATE_RANGE_PRESETS: { value: DateRangePreset, label: string }[] = [
  { value: 'last_hour', label: 'Last hour' },
  { value: 'today', label: 'Today' },
  { value: 'last_7_days', label: 'Last 7 days' },
  { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'last_90_days', label: 'Last 90 days' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'this_year', label: 'This year' },
  { value: 'all', label: 'All time' }
]

export const DASHBOARD_VARIABLE_TYPES: { value: DashboardVariableType, label: string, description: string }[] = [
  { value: 'DATE_RANGE', label: 'Date range', description: 'Use as $VAR.<name>.from / $VAR.<name>.to (timestamptz).' },
  { value: 'SELECT', label: 'Select', description: 'One option (text) or several (text[] - use = ANY(...)).' },
  { value: 'TEXT', label: 'Text', description: 'Free text (text).' },
  { value: 'NUMBER', label: 'Number', description: 'A number (numeric).' }
]

// The widget types, their palette entry and properties: the dashboard widget catalog (@totalbase/tb-catalog), shared with the server.
export type { DashboardWidgetGroup, DashboardWidgetProp, DashboardWidgetType } from '@totalbase/tb-catalog'

/**
 * A widget's data is an admin-authored SQL query (Dashboards.md §2);
 * `config` maps its result columns and holds appearance.
 * `query` is null until configured - a presentation widget (D3) draws
 * without one, its `config` a page control's `props` and `bindings`.
 */
export interface DashboardWidgetContent {
  id: string
  dashboard: string
  type: DashboardWidgetType
  label: string | null
  gridX: number
  gridY: number
  gridW: number
  gridH: number
  query: string | null
  config: Record<string, unknown>
  /** `$VAR.*` names its query uses (server-computed) - only these widgets re-run when a value changes. */
  referencedVariables: string[]
  /** The tab it is on (D7) - null: the first. */
  tab?: string | null
}

/** A draft widget - its content plus when it was created and last changed. */
export interface DashboardWidget extends DashboardWidgetContent {
  createdAt: string
  updatedAt: string
}

/** A widget's result column, typed by the server (Dashboards.md §2.3). */
export interface DashboardQueryColumn {
  name: string
  dataType: string
  /** The table's (or view's) column it is, when the query took it as is - none for an expression. */
  origin?: { schema: string, table: string, column: string, resourceId: string | null }
  /** That column's presentation - its label names the series, its format the numbers. */
  presentation?: ColumnPresentation
  /** Its origin is a foreign key to files, or that table's id - a file's id (§5.16). */
  fileReference?: boolean
  /** A numeric/bigint value too long for a number arrives as its exact text. */
  lossy?: boolean
}

export interface DashboardQueryResult {
  columns: DashboardQueryColumn[]
  rows: Record<string, unknown>[]
  truncated: boolean
  /** How long PostgreSQL took - the editor's "12 rows · 85 ms". */
  durationMs: number
  /** A published widget's result reused from the server's cache. */
  cached: boolean
  /** A TABLE's totals by column (D28) - computed by PostgreSQL over every row; null when no column has a total. */
  totals?: Record<string, unknown> | null
  /** Its thresholds' and references' values, resolved on the server (D5) - null when it has none. */
  marks?: DashboardWidgetMarks | null
  /** Each file its file columns returned, by id (§5.16, D14): a link signed for this widget - null when it returns none. */
  files?: Record<string, DashboardFileLink> | null
}

/** A file a widget's query returned (Dashboards.md §5.16): its signed link, name and type. */
export interface DashboardFileLink {
  /** Signed for 15 minutes - null where it isn't served (`blocked`). */
  url: string | null
  name: string
  mimeType: string
  /** An image, drawn in line; anything else is a download. */
  image: boolean
  /** An embed's PRIVATE file without allowFiles - "Image not available on this link". */
  blocked?: true
}

/**
 * A widget's marks with their values resolved (D5), index-aligned with `config.thresholds` / `config.references`:
 * null where a column or a variable has no number; a reference's `value` may stay a statistic ECharts computes.
 */
export interface DashboardWidgetMarks {
  thresholds?: (number | null)[]
  references?: { value?: number | string | null, from?: number | null, to?: number | null }[]
}

/** A widget run slower than this is marked in the editor (D24). */
export const DASHBOARD_SLOW_QUERY_MS = 1_000

/** One immutable dashboard version (Foundations.md §13) - summary. */
export interface DashboardVersion {
  id: string
  dashboard: string
  version: number
  restoredFromVersion: number | null
  user: string | null
  publishedAt: string
  note: string | null
}

/** One version's full content - the editor's read-only preview. */
export interface DashboardVersionSnapshot extends DashboardVersion {
  /** As published - a snapshot carries no timestamps. */
  widgets: DashboardWidgetContent[]
  variables: DashboardVariable[]
  tabs: DashboardTab[]
}

/** The widget bar (editor sidebar) - one entry per widget type: its group, its icon, its starting canvas size (12-column grid). */
export interface DashboardWidgetPaletteEntry {
  type: DashboardWidgetType
  label: string
  icon: string
  group: DashboardWidgetGroup
  size: { w: number, h: number }
}

export const DASHBOARD_WIDGET_PALETTE: DashboardWidgetPaletteEntry[] = DASHBOARD_WIDGET_TYPES.map((type) => {
  const { label, icon, size, group } = dashboardWidgetDefinition(type)
  return { type, label, icon, group, size: { ...size } }
})

export const DASHBOARD_WIDGET_META: Record<DashboardWidgetType, DashboardWidgetPaletteEntry> = Object.fromEntries(
  DASHBOARD_WIDGET_PALETTE.map(entry => [entry.type, entry])
) as Record<DashboardWidgetType, DashboardWidgetPaletteEntry>

/**
 * The dashboard widget catalog, the refresh intervals, the variable types and
 * the date-range presets in the UI's language (Admin_UI.md §14):
 * `dashboards.catalog.*` / `dashboards.variables.*` keys, the package's English
 * as the fallback. A role or a prop is its widget's own text when it has one
 * (`widgets.<TYPE>.roles.<id>`), else the shared one (`roles.<id>`). A
 * presentation widget is named as the page designer names its page widget.
 */
export function useDashboardCatalogText() {
  const i18n = useI18n()
  const text = useCatalogText()
  function part(type: DashboardWidgetType, kind: 'roles' | 'props', id: string, field: 'label' | 'description'): string {
    const definition = dashboardWidgetDefinition(type)
    const english = kind === 'roles' ? definition.roles[id]?.[field] : definition.props[id]?.[field]
    const own = `dashboards.catalog.widgets.${type}.${kind}.${id}.${field}`
    return i18n.te(own) ? i18n.t(own) : text(`dashboards.catalog.${kind}.${id}.${field}`, english ?? id)
  }
  return {
    widgetLabel: (type: DashboardWidgetType) => {
      const { label, page } = dashboardWidgetDefinition(type)
      return text(`dashboards.catalog.widgets.${type}.label`, page ? designerCatalogText(i18n).widgetLabel(page, label) : label)
    },
    widgetDescription: (type: DashboardWidgetType) => text(`dashboards.catalog.widgets.${type}.description`, dashboardWidgetDefinition(type).description),
    groupLabel: (group: DashboardWidgetGroup) => text(`dashboards.catalog.groups.${group}`, DASHBOARD_WIDGET_GROUPS[group]),
    roleLabel: (type: DashboardWidgetType, role: string) => part(type, 'roles', role, 'label'),
    roleDescription: (type: DashboardWidgetType, role: string) => part(type, 'roles', role, 'description'),
    propLabel: (type: DashboardWidgetType, prop: string) => part(type, 'props', prop, 'label'),
    propDescription: (type: DashboardWidgetType, prop: string) => part(type, 'props', prop, 'description'),
    refreshLabel: (seconds: number, english: string) => text(`dashboards.catalog.refresh.${seconds}`, english),
    presetLabel: (preset: { value: DateRangePreset, label: string }) => text(`dashboards.variables.presets.${preset.value}`, preset.label),
    variableTypeLabel: (type: { value: DashboardVariableType, label: string }) => text(`dashboards.variables.types.${type.value}.label`, type.label),
    variableTypeDescription: (type: { value: DashboardVariableType, description: string }) => text(`dashboards.variables.types.${type.value}.description`, type.description)
  }
}
