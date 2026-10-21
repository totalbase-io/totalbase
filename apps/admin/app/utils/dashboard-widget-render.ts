import { isRoleColor, roleColorShade } from '~/types/permission'
import { PALETTE_COLORS, type ColumnPresentation, type PaletteColor, type TableColumnSettings } from '@totalbase/tb-catalog'
import type { TableAlign } from '~/utils/table-column-style'
import { formatNumberValue, formatTemporalValue } from '~/utils/format-pattern'
import type { DashboardFileLink, DashboardQueryColumn, DashboardQueryResult } from '~/types/dashboard'
import { compareDimension, type DimensionOrder, type PivotLeaf, type PivotSpec } from '~/utils/dashboard-pivot'
import { clockOptions } from '~/utils/datetime-local'

/**
 * What every dashboard widget's builder shares (Dashboards.md §5, D1): a result column's
 * title and number format - its presentation when its origin has one - the 17-color palette, row colors,
 * dates in the viewer's format, and the TABLE widget's cells. Pure functions; each widget's own drawing is
 * its builder's (dashboard-builders.ts).
 */

const NUMERIC_TYPES = /^(smallint|integer|bigint|numeric|decimal|real|double precision|money)\b/

export function resultColumn(result: DashboardQueryResult, name: string): DashboardQueryColumn | undefined {
  return result.columns.find(c => c.name === name)
}

export function isNumericColumn(result: DashboardQueryResult, name: string): boolean {
  const column = resultColumn(result, name)
  return Boolean(column && NUMERIC_TYPES.test(column.dataType))
}

/** A column's title: its presentation's label (its origin's, Dashboards.md §2.3), else its name in the query. */
export function columnTitle(result: DashboardQueryResult, name: string): string {
  return resultColumn(result, name)?.presentation?.label ?? name
}

/** A numeric value as a number - a lossy column's exact decimal text too (a chart's precision is the screen's). */
export function toNumber(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) ? value : 0
}

/** What formats a widget's numbers: its props, and the value column's presentation. */
export interface WidgetNumberFormatOptions {
  /** The widget's own config (unset props absent) - its Format (`displayFormat`), and Compact, whose default depends on whether it was set. */
  config: Record<string, unknown>
  /** The value column's presentation - its displayFormat applies when the widget has none of its own. */
  presentation?: ColumnPresentation
  locale?: string
}

/** The widget's own Format, else its column's - one vocabulary for every widget (D4). */
export function widgetNumberPattern(config: Record<string, unknown>, presentation?: ColumnPresentation): string | undefined {
  const own = typeof config.displayFormat === 'string' && config.displayFormat.trim() ? config.displayFormat : undefined
  return own ?? (presentation?.displayFormat?.trim() ? presentation.displayFormat : undefined)
}

/**
 * A widget's number, as text (Dashboards.md §5, D4): its Format (`displayFormat`, else its column's
 * presentation's), Compact on top of it (11.6M - on by default only when no format applies; with a format it keeps the
 * format's text and fixed decimals: "$ #,##0" reads "$ 1.3M"). Without a format, the locale's number. A lossy column's
 * exact decimal text is formatted exactly (Intl formats a decimal string without rounding it first).
 */
export function formatWidgetNumber(raw: unknown, options: WidgetNumberFormatOptions): string {
  const { config, presentation, locale } = options
  const pattern = widgetNumberPattern(config, presentation)
  const compact = typeof config.compact === 'boolean' ? config.compact : !pattern
  if (pattern) return formatNumberValue(toNumber(raw), pattern, { locale, compact })
  if (compact) return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(toNumber(raw))
  const exact = typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw) ? raw : toNumber(raw)
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(exact as number)
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}(T|\s)\d{2}:\d{2}/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * How dates read in a widget - the viewer's useDateTimeFormat() (their
 * timezone and patterns). Optional so the builders stay plain functions;
 * the default is the browser's own zone and format.
 */
export interface DateDisplay {
  dateTime: (value: string, fallback?: Intl.DateTimeFormatOptions) => string
  date: (value: string, fallback?: Intl.DateTimeFormatOptions) => string
  day: (value: string, fallback?: Intl.DateTimeFormatOptions) => string
  /** The browser's regional settings, for numbers (useUiLocale's intlLocale) - the browser's own when absent. */
  locale?: string
  /** The UI's language, for words a format produces - a calendar's day and month names (useUiLocale's languageTag). */
  language?: string
  /** The UI's words for an empty category, a boolean without labels of its own and a total row - English when absent. */
  text?: { empty: string, yes: string, no: string, total?: string, cumulative?: string, field?: string, value?: string }
  /** A gauge's target line, in the UI's language: "of 100". */
  ofTarget?: (target: string) => string
}

export const BROWSER_DATES: DateDisplay = {
  dateTime: (value, fallback) => new Date(value).toLocaleString(undefined, { ...clockOptions(), ...fallback }),
  date: (value, fallback) => new Date(value).toLocaleDateString(undefined, fallback),
  // A `date` has no time zone - read it in UTC so it never shifts a day.
  day: (value, fallback) => new Date(value).toLocaleDateString(undefined, { ...fallback, timeZone: 'UTC' })
}

/** A category's text: a CHECK value's label (its column's presentation), a date in the viewer's format, else as is. */
export function categoryLabel(raw: unknown, dates: DateDisplay = BROWSER_DATES, presentation?: ColumnPresentation): string {
  if (raw === null || raw === undefined || raw === '') return presentation?.emptyText ?? dates.text?.empty ?? '(empty)'
  if (typeof raw === 'string' && ISO_DATE.test(raw)) return dates.day(raw, { dateStyle: 'medium' })
  if (typeof raw === 'string' && ISO_DATETIME.test(raw)) {
    const date = new Date(raw)
    if (!Number.isNaN(date.getTime())) return dates.date(raw, { dateStyle: 'medium' })
  }
  if (typeof raw === 'boolean') return raw ? (presentation?.booleanLabels?.true ?? dates.text?.yes ?? 'Yes') : (presentation?.booleanLabels?.false ?? dates.text?.no ?? 'No')
  return presentation?.options?.[String(raw)]?.label ?? String(raw)
}

/** A file column (§5.16): its origin is a foreign key to files, or that table's id. */
export function isFileColumn(result: DashboardQueryResult, name: string): boolean {
  return resultColumn(result, name)?.fileReference === true
}

/** The file a cell holds - its signed link, when the run returned one for it (§5.16). */
export function fileLink(result: DashboardQueryResult, raw: unknown): DashboardFileLink | undefined {
  return typeof raw === 'string' ? result.files?.[raw] ?? undefined : undefined
}

/** How a column's values order (a pivot's dimensions, a heatmap's axes): numbers and time ascending, text by its CHECK list. */
export function columnOrder(result: DashboardQueryResult, name: string): DimensionOrder {
  const column = resultColumn(result, name)
  if (!column) return { kind: 'text' }
  if (NUMERIC_TYPES.test(column.dataType)) return { kind: 'number' }
  if (/^(date|timestamp)/.test(column.dataType)) return { kind: 'time' }
  const options = column.presentation?.options
  return { kind: 'text', ...(options && Object.keys(options).length ? { options: Object.keys(options) } : {}) }
}

/**
 * An axis' categories (a heatmap's): each value once, in the query's order (its ORDER BY decides) - time sorted, and
 * a column with a CHECK list in that list's order.
 */
export function orderedCategories(values: readonly unknown[], order: DimensionOrder): unknown[] {
  const seen = new Map<string, unknown>()
  for (const value of values) {
    const key = JSON.stringify(value ?? null)
    if (!seen.has(key)) seen.set(key, value)
  }
  const distinct = [...seen.values()]
  if (order.kind === 'time' || (order.kind === 'text' && order.options?.length)) return distinct.sort((a, b) => compareDimension(a, b, order))
  return distinct
}

const canvasColorCache = new Map<string, string>()

/**
 * Any CSS color -> `rgba(...)`. The palette is written in `oklch()`,
 * which ECharts' own color parser (zrender) can't read - it silently
 * drops the color. The browser's canvas can, so it does the conversion
 * once per color.
 */
function toCanvasColor(css: string): string {
  const cached = canvasColorCache.get(css)
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return css
  context.fillStyle = css
  context.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
  const rgba = `rgba(${r}, ${g}, ${b}, ${Number(((a ?? 255) / 255).toFixed(3))})`
  canvasColorCache.set(css, rgba)
  return rgba
}

/**
 * A `color` prop holds one of the palette names (`blue`, `emerald`...),
 * resolved from the same shade table roles and the TABLE widget use
 * (roleColorShade - 500 in light mode, 400 in dark). Returned as `rgba()`
 * so ECharts can use it.
 */
export function resolvePaletteColor(name: unknown): string | undefined {
  if (!isRoleColor(name) || import.meta.server) return undefined
  const mode = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  return toCanvasColor(roleColorShade(name, mode))
}

export interface ChartTheme {
  primary: string
  secondary: string
  success: string
  warning: string
  error: string
  text: string
  textMuted: string
  border: string
}

/** Any CSS color (incl. the theme's oklch() values) made safe for ECharts' canvas. */
export function themeColor(css: string): string {
  return import.meta.server ? css : toCanvasColor(css)
}

/** Every theme color canvas-safe (see toCanvasColor) - axis lines, label text, gauge track included. */
export function canvasTheme(theme: ChartTheme): ChartTheme {
  return Object.fromEntries(Object.entries(theme).map(([key, value]) => [key, themeColor(value)])) as unknown as ChartTheme
}

/**
 * The 17 palette hues in the order series and slices take them - neighbors far apart on the color wheel, so the
 * first few always read apart, and all 17 come before one repeats (DB5).
 */
export const SERIES_HUES: readonly PaletteColor[] = ['blue', 'emerald', 'amber', 'violet', 'rose', 'cyan', 'orange', 'lime', 'fuchsia', 'teal', 'indigo', 'yellow', 'pink', 'sky', 'green', 'purple', 'red']
if (SERIES_HUES.length !== PALETTE_COLORS.length) throw new Error('SERIES_HUES must hold every palette color once.')

/** A widget's colors, in order: its Color first when set (then the other 16), else all 17 hues. */
export function seriesPalette(color: unknown): string[] {
  const first = isRoleColor(color) ? color as PaletteColor : undefined
  const hues = first ? [first, ...SERIES_HUES.filter(h => h !== first)] : [...SERIES_HUES]
  return hues.map(h => resolvePaletteColor(h) ?? h)
}

/**
 * Metadata columns: any result column whose name starts with `_` is never
 * displayed - it carries presentation (`_color`, `_<col>_color`) or
 * is just a helper (`_id`, `_sort_key`).
 */
export function isMetadataColumn(name: string): boolean {
  return name.startsWith('_')
}

/** The row-color column: the configured `colorColumn` when the query returns it, else `_color`. */
export function colorColumn(result: DashboardQueryResult, config: Record<string, unknown>): string | undefined {
  const configured = typeof config.colorColumn === 'string' ? config.colorColumn : undefined
  if (configured && resultColumn(result, configured)) return configured
  return resultColumn(result, '_color') ? '_color' : undefined
}

/** One row's color from the color column - a palette name, canvas-safe; anything else -> undefined (the widget's color). */
export function rowColor(row: Record<string, unknown>, column: string | undefined): string | undefined {
  return column ? resolvePaletteColor(row[column]) : undefined
}

// --- TABLE widget -----------------------------------------------------------

/** Per-column settings - `config.columnSettings[<result column name>]`: the one table-column model a page's Table shares. */
export type TableColumnConfig = TableColumnSettings

export interface TableColumnModel {
  name: string
  dataType: string
  header: string
  align: TableAlign
  numeric: boolean
  /** Companion `_<name>_color` metadata column - when present, each cell renders as a badge in that row's color. */
  badgeColorColumn: string | null
  /** Its settings over its presentation (its origin's): what formats its cells. */
  settings: TableColumnConfig
  /** A lossy numeric column: its exact text is shown, never rounded through a number. */
  lossy: boolean
}

const DATE_TYPE = /^date$/
const TIMESTAMP_TYPE = /^timestamp/
const TIMESTAMPTZ_TYPE = /^timestamp.* with time zone$/
const TIME_TYPE = /^time\b/
const BOOLEAN_TYPE = /^boolean$/

export function tableColumnSettings(config: Record<string, unknown>): Record<string, TableColumnConfig> {
  const raw = config.columnSettings
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, TableColumnConfig>) : {}
}

/**
 * The columns a TABLE widget displays: its Columns role's (`shown`, in that order), never a metadata (`_*`) column nor
 * the row color column, none hidden. Each titled and formatted by its settings over its presentation; alignment by
 * its real type (numbers right, booleans centered).
 */
export function tableColumns(result: DashboardQueryResult, config: Record<string, unknown>, shown?: readonly string[]): TableColumnModel[] {
  const settings = tableColumnSettings(config)
  const color = colorColumn(result, config)
  const names = new Set(result.columns.map(c => c.name))
  const order = shown ?? result.columns.map(c => c.name)
  return order
    .map(name => resultColumn(result, name))
    .filter((c): c is DashboardQueryColumn => Boolean(c) && !isMetadataColumn(c!.name) && c!.name !== color && settings[c!.name]?.hidden !== true)
    .map((c) => {
      const numeric = isNumericColumn(result, c.name)
      const inherited = c.presentation ?? {}
      const own: TableColumnConfig = { ...pickTableSettings(inherited), ...(settings[c.name] ?? {}) }
      const badge = `_${c.name}_color`
      return {
        name: c.name,
        dataType: c.dataType,
        header: (settings[c.name]?.label?.trim() || inherited.shortLabel || inherited.label) ?? c.name,
        align: own.align ?? (numeric ? 'right' : BOOLEAN_TYPE.test(c.dataType) ? 'center' : 'left'),
        numeric,
        badgeColorColumn: names.has(badge) ? badge : null,
        settings: own,
        lossy: c.lossy === true
      }
    })
}

/** What a table column takes of a presentation - its format, empty text, labels and look. */
function pickTableSettings(presentation: ColumnPresentation): TableColumnConfig {
  const { displayFormat, emptyText, booleanLabels, linkType, options, align, fontSize, bold, italic, mono, underline, strike, color, background } = presentation
  return Object.fromEntries(Object.entries({ displayFormat, emptyText, booleanLabels, linkType, options, align, fontSize, bold, italic, mono, underline, strike, color, background }).filter(([, v]) => v !== undefined)) as TableColumnConfig
}

/**
 * Display text for one cell, by the column's real type and its settings:
 * its Format (`displayFormat` - a number or a date pattern), else numbers
 * localized - a lossy one's exact text - and dates readable; its Empty
 * text for NULL; its true/false labels; a CHECK value's label. A
 * timestamp with time zone reads in `timezone` (the viewer's).
 */
export function formatTableCell(raw: unknown, column: Pick<TableColumnModel, 'dataType' | 'numeric' | 'settings'> & { lossy?: boolean }, dates: DateDisplay = BROWSER_DATES, timezone?: string): string {
  const { settings } = column
  if (raw === null || raw === undefined) return settings.emptyText ?? ''
  const pattern = settings.displayFormat
  if (column.numeric) {
    // A pattern says how many decimals show - an exact decimal text too (an average's 83.1666...); only a whole
    // number past a double's digits keeps its text.
    if (pattern && !(column.lossy && typeof raw === 'string' && /^-?\d{16,}$/.test(raw))) return formatNumberValue(toNumber(raw), pattern, { locale: dates.locale })
    return formatWidgetNumber(raw, { config: { compact: false }, locale: dates.locale })
  }
  if (typeof raw === 'string' && (DATE_TYPE.test(column.dataType) || TIMESTAMP_TYPE.test(column.dataType))) {
    const isDate = DATE_TYPE.test(column.dataType)
    if (pattern) return formatTemporalValue(raw, pattern, isDate ? 'date' : 'datetime', TIMESTAMPTZ_TYPE.test(column.dataType) ? timezone : undefined)
    const date = new Date(raw)
    if (!Number.isNaN(date.getTime())) {
      return isDate
        ? dates.day(raw, { dateStyle: 'medium' })
        : dates.dateTime(raw, { dateStyle: 'medium', timeStyle: 'short' })
    }
  }
  if (typeof raw === 'string' && pattern && TIME_TYPE.test(column.dataType)) return formatTemporalValue(raw, pattern, 'time')
  if (typeof raw === 'boolean') return raw ? (settings.booleanLabels?.true ?? dates.text?.yes ?? 'Yes') : (settings.booleanLabels?.false ?? dates.text?.no ?? 'No')
  if (raw && typeof raw === 'object' && 'lat' in raw && 'lng' in raw) {
    const point = raw as { lat: unknown, lng: unknown }
    return `(${point.lng}, ${point.lat})`
  }
  if (typeof raw === 'object') return JSON.stringify(raw)
  return settings.options?.[String(raw)]?.label ?? String(raw)
}

/** Sort comparator for one column: numbers as numbers, dates as instants, everything else locale-aware text; NULLs last. */
export function compareTableCells(a: unknown, b: unknown, column: Pick<TableColumnModel, 'dataType' | 'numeric'>): number {
  const aNull = a === null || a === undefined
  const bNull = b === null || b === undefined
  if (aNull || bNull) return aNull === bNull ? 0 : aNull ? 1 : -1
  if (column.numeric) return toNumber(a) - toNumber(b)
  if (DATE_TYPE.test(column.dataType) || TIMESTAMP_TYPE.test(column.dataType)) return new Date(String(a)).getTime() - new Date(String(b)).getTime()
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

// --- PIVOT widget (D17) -------------------------------------------------------

/** A PIVOT's roles - what its spec and its texts read. */
export interface PivotRoles {
  rows: string[]
  columns: string[]
  values: string[]
}

/** A PIVOT's placement spec from its config: its roles, `sortBy`, each dimension's order (time, number, CHECK list). */
export function pivotSpec(result: DashboardQueryResult, config: Record<string, unknown>, roles: PivotRoles): PivotSpec {
  const sort = config.sortBy && typeof config.sortBy === 'object' ? config.sortBy as { value?: unknown, direction?: unknown } : null
  return {
    ...roles,
    sortBy: sort && typeof sort.value === 'string' ? { value: sort.value, direction: sort.direction === 'DESC' ? 'DESC' : 'ASC' } : null,
    order: column => columnOrder(result, column)
  }
}

/**
 * A PIVOT's texts: each column's title, a dimension's value and an aggregated value in its column's settings over its
 * presentation (`columnSettings`, as a TABLE's) - a count as a plain number; an empty cell its Empty text.
 */
export function pivotTexts(result: DashboardQueryResult, config: Record<string, unknown>, roles: PivotRoles, dates: DateDisplay = BROWSER_DATES, timezone?: string) {
  const settings = tableColumnSettings(config)
  // Every role column, hidden or not - a pivot has no hidden cells.
  const models = new Map(tableColumns(result, { ...config, columnSettings: Object.fromEntries(Object.entries(settings).map(([name, s]) => [name, { ...s, hidden: false }])) }, [...roles.rows, ...roles.columns, ...roles.values]).map(m => [m.name, m]))
  const aggregates = config.aggregates && typeof config.aggregates === 'object' ? config.aggregates as Record<string, unknown> : {}
  const empty = (column: string) => models.get(column)?.settings.emptyText
  const totalWord = dates.text?.total ?? 'Total'
  const texts = {
    total: totalWord,
    title: (column: string) => models.get(column)?.header ?? columnTitle(result, column),
    dimension: (column: string, raw: unknown) => {
      const model = models.get(column)
      if (raw === null || raw === undefined || !model) return raw === null || raw === undefined ? (empty(column) ?? dates.text?.empty ?? '(empty)') : String(raw)
      return formatTableCell(raw, model, dates, timezone)
    },
    value: (column: string, raw: unknown) => {
      const model = models.get(column)
      if (raw === null || raw === undefined) return empty(column) ?? ''
      if (aggregates[column] === 'count' || !model) return formatWidgetNumber(raw, { config: { compact: false }, locale: dates.locale })
      return formatTableCell(raw, model, dates, timezone)
    },
    /** A value column's header, flat: its Columns values (or Total) and, with several values, its value's title. */
    leafTitle: (leaf: PivotLeaf) => {
      const parts = leaf.total ? [totalWord] : leaf.path.map((raw, i) => texts.dimension(roles.columns[i]!, raw))
      if (roles.values.length > 1 || parts.length === 0) parts.push(texts.title(leaf.value))
      return parts.join(' · ')
    }
  }
  return texts
}
