import {
  dashboardRolesProblem,
  dashboardWidgetDefinition,
  dashboardWidgetProps,
  resolveDashboardRoles,
  type DashboardWidgetType
} from '@totalbase/tb-catalog'
import type { DashboardQueryResult } from '~/types/dashboard'
import {
  BROWSER_DATES,
  canvasTheme,
  categoryLabel,
  colorColumn,
  columnOrder,
  columnTitle,
  formatWidgetNumber,
  isNumericColumn,
  orderedCategories,
  resolvePaletteColor,
  resultColumn,
  rowColor,
  seriesPalette,
  themeColor,
  toNumber,
  widgetNumberPattern,
  type ChartTheme,
  type DateDisplay
} from '~/utils/dashboard-widget-render'
import { buildHierarchy, type HierarchyNode } from '~/utils/dashboard-hierarchy'

/**
 * One builder per dashboard widget (Dashboards.md §5, D1): its query's typed result, its roles and its
 * props in, what it draws out - an ECharts option, or the model of one of the App's own renderers (KPI, ranking, map,
 * table). Adding a widget is its catalog entry (@totalbase/tb-catalog) and its builder here - the editor, the guide and the
 * MCP read the catalog.
 */

/** The card's room, in pixels - where a chart lays its legend and sizes its text (DB1, DB2). */
export interface WidgetSize {
  width: number
  height: number
}

export interface BuildContext {
  type: DashboardWidgetType
  /** The widget's own config - its props as set (unset absent) and its roles. */
  config: Record<string, unknown>
  /** Its props, each unset one at its default (the catalog's). */
  props: Record<string, unknown>
  result: DashboardQueryResult
  /** Each role's columns - assigned or by default. */
  roles: Record<string, string[]>
  /** Canvas-safe theme colors (Nuxt UI's tokens, light or dark). */
  theme: ChartTheme
  dates: DateDisplay
  size: WidgetSize
  /** Set when a click on its marks does something (D6) - the App's, never the editor's. */
  click: ClickDisplay | null
}

/** A clickable widget's look (D6): the last line of its tooltip - its `click.hint`, else the App's words for its action. */
export interface ClickDisplay {
  hint: string
}

/**
 * The row behind a chart's mark (D6) - what a click on it hands its card. `grid`: a cartesian chart, where a click
 * away from a mark (a line between its points) picks the category under it - `value` there is the value axis' value
 * under the pointer, which picks the nearest series.
 */
export interface ChartPick {
  grid: boolean
  horizontal: boolean
  /** `data`: the clicked mark's own data item - a tree's node (TREEMAP, SUNBURST) carries its id there. */
  rowAt: (seriesIndex: number | null, dataIndex: number, value?: number, data?: unknown) => Record<string, unknown> | undefined
}

export interface KpiModel {
  renderer: 'kpi'
  value: string
  color?: string
  delta?: { text: string, positive: boolean, up: boolean }
  sparkline?: Record<string, unknown>
  /** Against its Target role: "of 100". */
  target?: string
  /** The row it shows (its last) - what a click hands its card (D6). */
  row?: Record<string, unknown>
}
export interface RankingRow {
  label: string
  /** Its Image role's file id - a thumbnail beside it (D14). */
  image?: string
  value: string
  color?: string
  /** 0-100, relative to the largest value - the inline bar's width. */
  pct: number
  row: Record<string, unknown>
}
export interface MapPoint {
  lat: number
  lng: number
  label: string
  value: number | null
  valueText: string | null
  /** From the row color column, when the row has a valid one. */
  color?: string
  row: Record<string, unknown>
}
/** A PROGRESS bar (D12): its value against its target - past it the bar is full and the percent real. */
export interface ProgressModel {
  renderer: 'progress'
  value: string
  /** "of $ 30M" - unless showTarget is off. */
  target?: string
  /** "46 %" - unless showPercent is off or the target is 0. */
  percent?: string
  /** The bar, 0-100. */
  bar: number
  /** Its threshold's color, else its Color - canvas-safe; unset, the theme's primary. */
  color?: string
  /** The row it shows (its last) - what a click hands its card (D6). */
  row?: Record<string, unknown>
}
/** A DETAIL (D14): the first row's fields and its image's column. */
export interface DetailModel {
  renderer: 'detail'
  columns: string[]
  image: string | null
  layout: 'AUTO' | 'ONE' | 'TWO'
}
/** A PIVOT (D17): its roles - the grid is placed from its aggregated rows by DashboardWidgetPivot.vue (utils/dashboard-pivot.ts). */
export interface PivotWidgetModel {
  renderer: 'pivot'
  rows: string[]
  columns: string[]
  values: string[]
}
/** A notice under a chart, in the UI's language (`dashboards.widgetView.<key>`): a calendar's years or months cut to the latest. */
export interface BuiltNotice {
  key: string
  params: Record<string, unknown>
}
export type BuiltWidget
  = | { renderer: 'echarts', option: Record<string, unknown>, pick?: ChartPick, notice?: BuiltNotice }
    | KpiModel
    | ProgressModel
    | { renderer: 'ranking', rows: RankingRow[], color: string }
    | { renderer: 'map', points: MapPoint[], color: string, cluster: boolean }
    | { renderer: 'table', columns: string[] }
    | DetailModel
    | PivotWidgetModel

type Builder = (context: BuildContext) => BuiltWidget

// --- Shared pieces --------------------------------------------------------

const first = (context: BuildContext, role: string): string | undefined => context.roles[role]?.[0]
const presentationOf = (context: BuildContext, column: string | undefined) => (column ? resultColumn(context.result, column)?.presentation : undefined)

/** A role column's number, formatted as the widget says (its props over the column's presentation). */
function numberText(context: BuildContext, raw: unknown, column: string | undefined): string {
  return formatWidgetNumber(raw, { config: context.config, presentation: presentationOf(context, column), locale: context.dates.locale })
}

/** What every ECharts option shares: the theme's text, its palette, the App's locale-aware tooltips, aria with decals. */
function base(context: BuildContext, colors: string[]): Record<string, unknown> {
  return {
    color: colors,
    textStyle: { color: context.theme.text },
    // Read out by assistive technology, and patterns that tell series apart without their color.
    aria: { enabled: true, decal: { show: true } },
    tooltip: { confine: true }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined)
const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }
/** Tooltips are HTML: every name and value from the query goes in escaped. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => HTML_ESCAPES[c]!)
}

/** One tooltip line: the mark's swatch (ECharts' own), its name and its value. */
function tooltipLine(marker: string, name: string, value: string): string {
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:16px"><span>${marker}${escapeHtml(name)}</span><span style="font-weight:600">${escapeHtml(value)}</span></div>`
}

/** A clickable widget's tooltip ends saying what a click does (D6). */
function tooltipHint(context: BuildContext): string {
  return context.click ? `<div style="margin-top:6px;font-size:11px;opacity:0.7">${escapeHtml(context.click.hint)}</div>` : ''
}

/** A canvas-safe `rgba()` at another opacity - a band's tint. */
function withAlpha(color: string, alpha: number): string {
  const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(color)
  return match ? `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})` : color
}

/** A CHECK value's theme color (its presentation's `options`) as a palette hue. */
const THEME_TO_HUE: Record<string, string> = { primary: 'sky', secondary: 'violet', success: 'emerald', info: 'blue', warning: 'amber', error: 'red', neutral: 'zinc' }

/** A value's color from its column's presentation (a CHECK value's), canvas-safe - the pie's slices, a long format's series. */
function optionColor(presentation: ReturnType<typeof presentationOf>, raw: unknown): string | undefined {
  const color = presentation?.options?.[String(raw)]?.color
  return color ? resolvePaletteColor(THEME_TO_HUE[color] ?? color) : undefined
}

/**
 * Its thresholds (D5) as stops, lowest first: the base (no `from`) and each next one from its value up - the value
 * resolved on the server (`marks.thresholds`, a column's or a variable's), a plain number as stored. One whose value
 * has no number is left out.
 */
function thresholdStops(context: BuildContext): ThresholdStop[] {
  const list = Array.isArray(context.config.thresholds) ? context.config.thresholds : []
  const resolved = context.result.marks?.thresholds
  const stops: ThresholdStop[] = []
  list.forEach((item, index) => {
    const threshold = record(item)
    const color = resolvePaletteColor(threshold?.color)
    if (!threshold || !color) return
    const label = text(threshold.label)
    if (threshold.from === undefined || threshold.from === null) {
      stops.push({ from: -Infinity, color, ...(label ? { label } : {}) })
      return
    }
    const from = resolved ? resolved[index] : finite(threshold.from)
    if (typeof from === 'number' && Number.isFinite(from)) stops.push({ from, color, ...(label ? { label } : {}) })
  })
  return stops.sort((a, b) => a.from - b.from)
}

interface ThresholdStop {
  from: number
  color: string
  label?: string
}

/** The color of the threshold a value falls in (the highest `from` at or below it) - undefined without thresholds. */
function thresholdColor(stops: { from: number, color: string }[], value: number): string | undefined {
  let color: string | undefined
  for (const stop of stops) if (value >= stop.from) color = stop.color
  return color
}

/** The widget's accent: its Color, else the theme's primary. */
function accent(context: BuildContext): string {
  return resolvePaletteColor(context.props.color) ?? themeColor(context.theme.primary)
}

/** Its series colors: its Color first when set; one series alone takes the accent; several the 17 hues (DB5). */
function palette(context: BuildContext, count: number): string[] {
  if (count <= 1 && !context.props.color) return [accent(context)]
  return seriesPalette(context.props.color)
}

/**
 * The legend's room in a card of `size` (DB1): wrapped below the chart while it fits in three lines, else one
 * scrolling line - the chart gets the rest, never its place.
 */
function legendLayout(names: string[], size: WidgetSize): { scroll: boolean, height: number } {
  const itemWidth = (name: string) => 24 + Math.min(name.length, 28) * 6.5 + 10
  let lines = 1
  let line = 0
  for (const name of names) {
    const width = itemWidth(name)
    if (line + width > size.width - 16 && line > 0) {
      lines++
      line = 0
    }
    line += width
  }
  const scroll = lines > 3 || size.width < 220
  return { scroll, height: (scroll ? 1 : lines) * 22 + 8 }
}

// --- Category + series (BAR, BAR_HORIZONTAL, LINE, AREA) --------------------

type SeriesType = 'bar' | 'line' | 'area'

/** One series of a category chart: by a Values column (wide) or by a value of the Series column (long). */
interface CategorySeries {
  /** What `config.series` keys it by: its column (wide), or its Series value (long). */
  key: string
  name: string
  /** Its Values column - the one it reads its numbers (and their format) from. */
  column?: string
  values: (number | null)[]
  /** Each point's row in the result - what a click on it hands its card (D6). */
  rowIndexes: (number | null)[]
  /** One bar per row: its row color (`_color`). */
  colors?: (string | undefined)[]
  /** Long format: its Series value's color, from the Series column's presentation. */
  presetColor?: string
}

/** The rows as series: wide (one per Values column) or long (one per Series value, its one Values column). */
function seriesOf(context: BuildContext): { categories: unknown[], series: CategorySeries[] } {
  const category = first(context, 'category')
  const values = context.roles.values ?? []
  const seriesColumn = first(context, 'series')
  const rows = context.result.rows
  const rowColorKey = colorColumn(context.result, context.config)
  if (seriesColumn && values[0]) {
    const value = values[0]
    const seriesPresentation = presentationOf(context, seriesColumn)
    const categories: unknown[] = []
    const seen = new Set<string>()
    const groups = new Map<string, { raw: unknown, byCategory: Map<string, number> }>()
    rows.forEach((row, index) => {
      const key = String(row[category ?? ''])
      if (!seen.has(key)) {
        seen.add(key)
        categories.push(category ? row[category] : null)
      }
      const name = String(row[seriesColumn])
      if (!groups.has(name)) groups.set(name, { raw: row[seriesColumn], byCategory: new Map() })
      groups.get(name)!.byCategory.set(key, index)
    })
    return {
      categories,
      series: [...groups.entries()].map(([key, { raw, byCategory }]) => {
        const rowIndexes = categories.map(c => byCategory.get(String(c)) ?? null)
        return {
          key,
          name: categoryLabel(raw, context.dates, seriesPresentation),
          column: value,
          values: rowIndexes.map(i => (i === null ? null : toNumber(rows[i]![value]))),
          rowIndexes,
          presetColor: optionColor(seriesPresentation, raw)
        }
      })
    }
  }
  return {
    categories: rows.map(row => (category ? row[category] : null)),
    series: values.map(column => ({
      key: column,
      name: columnTitle(context.result, column),
      column,
      values: rows.map(row => toNumber(row[column])),
      rowIndexes: rows.map((_, i) => i),
      // One bar per row: its row color (`_color`) - with several series a row is a group.
      ...(values.length === 1 && rowColorKey ? { colors: rows.map(row => rowColor(row, rowColorKey)) } : {})
    }))
  }
}

/** A series' own settings (`config.series.<key>`, D4). */
function seriesSettings(context: BuildContext, key: string): Record<string, unknown> {
  return record(record(context.config.series)?.[key]) ?? {}
}

/** A series' Format: its own, else the widget's, else its column's presentation's (D4). */
function seriesPattern(context: BuildContext, s: CategorySeries): string | undefined {
  return text(seriesSettings(context, s.key).displayFormat) ?? widgetNumberPattern(context.config, presentationOf(context, s.column))
}

/** A series' numbers as text - its own Format; Compact as the widget says. */
function seriesFormatter(context: BuildContext, s: CategorySeries): (raw: unknown) => string {
  const own = text(seriesSettings(context, s.key).displayFormat)
  const config = own ? { ...context.config, displayFormat: own } : context.config
  const presentation = presentationOf(context, s.column)
  return raw => formatWidgetNumber(raw, { config, presentation, locale: context.dates.locale })
}

/** What a drawn series carries besides its data: its type, its value axis (0 left, 1 right), its color and format. */
type DrawnSeries = CategorySeries & { type: SeriesType, axis: 0 | 1, color?: string, format: (raw: unknown) => string, pattern?: string }

/**
 * A value axis (D4): `axes.value` (left) or `axes.value2` (right) - its title, min, max, log scale and Format, else
 * its first series' Format; compact unless the widget turns Compact off. Unset min: 0 when it holds a bar or an area,
 * fitted to the data when it holds only lines.
 */
function valueAxis(context: BuildContext, index: 0 | 1, onAxis: DrawnSeries[], horizontal: boolean): { axis: Record<string, unknown>, format: (raw: unknown) => string, title: boolean } {
  const settings = record(record(context.config.axes)?.[index === 0 ? 'value' : 'value2']) ?? {}
  const pattern = text(settings.displayFormat) ?? onAxis[0]?.pattern
  const compact = typeof context.config.compact === 'boolean' ? context.config.compact : true
  const formatConfig = { ...(pattern ? { displayFormat: pattern } : {}), compact }
  const format = (raw: unknown) => formatWidgetNumber(raw, { config: formatConfig, locale: context.dates.locale })
  const log = settings.log === true
  const min = finite(settings.min)
  const max = finite(settings.max)
  const fitted = onAxis.length > 0 && onAxis.every(s => s.type === 'line')
  const title = text(settings.title)
  const muted = context.theme.textMuted
  return {
    format,
    title: Boolean(title),
    axis: {
      type: log ? 'log' : 'value',
      ...(title
        ? horizontal
          ? { name: title, nameLocation: 'middle', nameGap: 28, nameTextStyle: { color: muted } }
          : { name: title, nameLocation: 'end', nameGap: 10, nameTextStyle: { color: muted, align: index === 0 ? 'left' : 'right' } }
        : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(fitted && !log && min === undefined ? { scale: true } : {}),
      ...(index === 1 ? { position: horizontal ? 'top' : 'right', alignTicks: true } : {}),
      axisLabel: { color: muted, hideOverlap: true, formatter: (v: number) => format(v) },
      splitLine: index === 0 ? { lineStyle: { color: context.theme.border } } : { show: false }
    }
  }
}

const REFERENCE_STATISTICS = new Set(['average', 'min', 'max', 'median'])

/**
 * Its reference lines and bands (D5), as each series' markLine / markArea - on the series it names, else the first.
 * Values resolved on the server (`marks.references`); a statistic (average, min, max, median) ECharts computes over
 * the series. Labels read in their value axis' format.
 */
function referenceMarks(
  context: BuildContext,
  drawn: Pick<DrawnSeries, 'key' | 'column' | 'name' | 'axis'>[],
  horizontal: boolean,
  axisFormats: ((raw: unknown) => string)[],
  /** A scatter's: a line's `axis: "x"` is a vertical line at that x, in the x axis' format (D16). */
  xFormat?: (raw: unknown) => string
): Map<number, { lines: Record<string, unknown>[], bands: Record<string, unknown>[][] }> {
  const marks = new Map<number, { lines: Record<string, unknown>[], bands: Record<string, unknown>[][] }>()
  const list = Array.isArray(context.config.references) ? context.config.references : []
  const resolved = context.result.marks?.references
  list.forEach((item, index) => {
    const reference = record(item)
    if (!reference) return
    const onX = Boolean(xFormat) && reference.axis === 'x'
    const dim = onX || (horizontal && !xFormat) ? 'xAxis' : 'yAxis'
    const named = text(reference.series)
    const target = named ? drawn.findIndex(s => s.key === named || s.column === named || s.name === named) : 0
    const seriesIndex = Math.max(0, target)
    const series = drawn[seriesIndex]
    if (!series) return
    const format = onX ? xFormat! : axisFormats[series.axis] ?? axisFormats[0]!
    const color = resolvePaletteColor(reference.color) ?? context.theme.textMuted
    const label = text(reference.label)
    const own = marks.get(seriesIndex) ?? { lines: [], bands: [] }
    marks.set(seriesIndex, own)
    if (reference.type === 'band') {
      const from = resolved ? resolved[index]?.from : finite(reference.from)
      const to = resolved ? resolved[index]?.to : finite(reference.to)
      if (typeof from !== 'number' || typeof to !== 'number') return
      own.bands.push([
        { [dim]: from, name: label ?? `${format(from)} – ${format(to)}`, itemStyle: { color: withAlpha(color, 0.12) }, label: { color } },
        { [dim]: to }
      ])
      return
    }
    const value = resolved ? resolved[index]?.value : reference.value
    const at = typeof value === 'number' && Number.isFinite(value) ? { [dim]: value } : typeof value === 'string' && REFERENCE_STATISTICS.has(value) ? { type: value } : null
    if (!at) return
    own.lines.push({
      ...at,
      lineStyle: { color, type: 'dashed', width: 1 },
      label: { color, position: 'insideEndTop', formatter: (p: { value: unknown }) => (label ? `${label}: ${format(p.value)}` : format(p.value)) }
    })
  })
  return marks
}

/**
 * BAR, BAR_HORIZONTAL, LINE, AREA - and COMBO (D11): BAR's chart whose first value is bars on the left axis and the
 * rest lines on the right, each axis in its series' format; `config.series` changes any of it, as on a BAR.
 */
function categorySeries(kind: 'bar' | 'barHorizontal' | 'line' | 'area' | 'combo'): Builder {
  return (context) => {
    const { theme } = context
    const { categories, series } = seriesOf(context)
    const category = first(context, 'category')
    const categoryPresentation = presentationOf(context, category)
    const isTime = category ? resultColumn(context.result, category)?.dataType.match(/^(date|timestamp)/) !== null : false
    const names = categories.map(c => categoryLabel(c, context.dates, categoryPresentation))
    const horizontal = kind === 'barHorizontal'
    const defaultType: SeriesType = kind === 'line' ? 'line' : kind === 'area' ? 'area' : 'bar'
    const colors = palette(context, series.length)
    // Each series as configured (D4): its name, color, type (a mixed chart), value axis and Format.
    const drawn: DrawnSeries[] = series.map((s, index) => {
      const own = seriesSettings(context, s.key)
      const comboLine = kind === 'combo' && index > 0
      const type = own.type === 'bar' || own.type === 'line' || own.type === 'area' ? own.type : comboLine ? 'line' : defaultType
      return {
        ...s,
        name: text(own.label) ?? s.name,
        type,
        axis: own.axis === 'right' ? 1 : own.axis === 'left' ? 0 : comboLine ? 1 : 0,
        color: resolvePaletteColor(own.color) ?? s.presetColor,
        format: seriesFormatter(context, s),
        pattern: seriesPattern(context, s)
      }
    })
    const anyBar = drawn.some(s => s.type === 'bar')
    const showLegend = context.props.showLegend === true && drawn.length > 1
    const legend = showLegend ? legendLayout(drawn.map(s => s.name), context.size) : null
    const axesIndexes: (0 | 1)[] = drawn.some(s => s.axis === 1) ? [0, 1] : [0]
    const valueAxes = axesIndexes.map(index => valueAxis(context, index, drawn.filter(s => s.axis === index), horizontal))
    const categoryTitle = text(record(record(context.config.axes)?.category)?.title)
    const axisLabel = { color: theme.textMuted }
    // A date category on a time-ordered axis reads its labels in the viewer's format; its points stay in the query's order.
    const categoryAxis = {
      type: 'category',
      data: names,
      boundaryGap: anyBar,
      axisLabel: horizontal ? { ...axisLabel, interval: 0, width: 110, overflow: 'truncate' } : { ...axisLabel, hideOverlap: isTime },
      ...(horizontal ? { inverse: true } : {}),
      ...(categoryTitle
        ? horizontal
          // Inverse: its start is the top.
          ? { name: categoryTitle, nameLocation: 'start', nameGap: 10, nameTextStyle: { color: theme.textMuted, align: 'right' } }
          : { name: categoryTitle, nameLocation: 'middle', nameGap: 28, nameTextStyle: { color: theme.textMuted } }
        : {})
    }
    const zoom = context.props.zoom === true
    // The room titles and the zoom bar take around the plot - containLabel only reserves the labels'.
    const titleAbove = horizontal ? (Boolean(categoryTitle) || Boolean(valueAxes[1]?.title)) : valueAxes.some(a => a.title)
    const titleBelow = horizontal ? Boolean(valueAxes[0]?.title) : Boolean(categoryTitle)
    const grid = {
      left: 8,
      right: 16 + (zoom && horizontal ? 24 : 0),
      top: (legend ? legend.height : 12) + (titleAbove ? 20 : 0),
      bottom: 8 + (titleBelow ? 22 : 0) + (zoom && !horizontal ? 30 : 0),
      containLabel: true
    }
    const zoomAxis = horizontal ? { yAxisIndex: 0 } : { xAxisIndex: 0 }
    const dataZoom = zoom
      ? [
          { type: 'slider', ...zoomAxis, ...(horizontal ? { orient: 'vertical', right: 4, width: 14 } : { bottom: 4, height: 18 }), textStyle: { color: theme.textMuted }, borderColor: theme.border },
          { type: 'inside', ...zoomAxis, zoomOnMouseWheel: true, moveOnMouseMove: true, moveOnMouseWheel: false }
        ]
      : undefined
    const references = referenceMarks(context, drawn, horizontal, valueAxes.map(a => a.format))
    const stacked = context.props.stacked === true
    const hint = tooltipHint(context)
    const valueAxisOption = valueAxes.length === 1 ? valueAxes[0]!.axis : valueAxes.map(a => a.axis)
    // The Tooltip role's columns (tanda 3) read from the category's row - wide format, one row per category.
    const tooltipRowOf = (dataIndex: number | undefined) => (dataIndex === undefined || !(context.roles.tooltip?.length) ? undefined : context.result.rows[drawn[0]?.rowIndexes[dataIndex] ?? -1])
    const axisKey = horizontal ? 'xAxisIndex' : 'yAxisIndex'
    return {
      renderer: 'echarts',
      pick: {
        grid: true,
        horizontal,
        rowAt: (seriesIndex, dataIndex, value) => {
          let s = seriesIndex === null ? undefined : drawn[seriesIndex]
          // Away from a mark: the series nearest the pointer at that category.
          if (!s) {
            const at = drawn.filter(d => d.rowIndexes[dataIndex] !== null && d.rowIndexes[dataIndex] !== undefined)
            s = at.sort((a, b) => Math.abs((a.values[dataIndex] ?? 0) - (value ?? 0)) - Math.abs((b.values[dataIndex] ?? 0) - (value ?? 0)))[0]
          }
          const index = s?.rowIndexes[dataIndex]
          return index === null || index === undefined ? undefined : context.result.rows[index]
        }
      },
      option: {
        ...base(context, colors),
        // Each series in its own Format (D4); a clickable chart says what a click does (D6).
        tooltip: {
          trigger: 'axis',
          confine: true,
          formatter: (params: unknown) => {
            const list = (Array.isArray(params) ? params : [params]) as { seriesIndex: number, dataIndex: number, marker: string, seriesName: string, value: unknown, axisValueLabel?: string }[]
            const head = list[0]?.axisValueLabel ? `<div style="margin-bottom:4px">${escapeHtml(String(list[0].axisValueLabel))}</div>` : ''
            const lines = list
              .filter(p => p.value !== null && p.value !== undefined && p.value !== '-')
              .map(p => tooltipLine(p.marker, p.seriesName, drawn[p.seriesIndex]?.format(p.value) ?? String(p.value)))
            const row = tooltipRowOf(list[0]?.dataIndex)
            return head + lines.join('') + (row ? tooltipExtras(context, row) : '') + hint
          }
        },
        legend: { show: showLegend, type: legend?.scroll ? 'scroll' : 'plain', top: 0, textStyle: { color: theme.textMuted } },
        grid,
        xAxis: horizontal ? valueAxisOption : categoryAxis,
        yAxis: horizontal ? categoryAxis : valueAxisOption,
        ...(dataZoom ? { dataZoom } : {}),
        series: drawn.map((s, index) => {
          const isBar = s.type === 'bar'
          const marks = references.get(index)
          return {
            name: s.name,
            type: isBar ? 'bar' : 'line',
            data: s.values.map((v, i) => (s.colors?.[i] ? { value: v, itemStyle: { color: s.colors[i] } } : v)),
            cursor: context.click ? 'pointer' : 'default',
            ...(s.axis === 1 ? { [axisKey]: 1 } : {}),
            ...(s.color ? { itemStyle: { color: s.color } } : {}),
            ...(isBar ? { barMaxWidth: horizontal ? 24 : 40 } : { smooth: context.props.smooth === true, showSymbol: categories.length <= 30, connectNulls: true }),
            ...(stacked ? { stack: `total${s.axis}` } : {}),
            ...(s.type === 'area' ? { areaStyle: { opacity: 0.2 } } : {}),
            ...(marks?.lines.length ? { markLine: { silent: true, symbol: 'none', data: marks.lines } } : {}),
            ...(marks?.bands.length ? { markArea: { silent: true, label: { show: true, position: 'insideTopLeft' }, data: marks.bands } } : {})
          }
        })
      }
    }
  }
}

// --- Proportion (PIE, DONUT) ----------------------------------------------

function proportion(donut: boolean): Builder {
  return (context) => {
    const label = first(context, 'category')
    const value = first(context, 'value')
    const labelPresentation = presentationOf(context, label)
    const rowColorKey = colorColumn(context.result, context.config)
    const data = context.result.rows.map((row) => {
      const color = rowColor(row, rowColorKey) ?? (label ? optionColor(labelPresentation, row[label]) : undefined)
      return { name: categoryLabel(label ? row[label] : null, context.dates, labelPresentation), value: value ? toNumber(row[value]) : 0, ...(color ? { itemStyle: { color } } : {}) }
    })
    const showLegend = context.props.showLegend === true
    // The legend reserves its room below; the ring is sized by what's left (DB1).
    const legend = showLegend ? legendLayout(data.map(d => d.name), context.size) : null
    const room = { width: context.size.width, height: context.size.height - (legend?.height ?? 0) }
    const radius = Math.max(16, Math.min(room.width, room.height) / 2 - 8)
    const hint = tooltipHint(context)
    return {
      renderer: 'echarts',
      pick: { grid: false, horizontal: false, rowAt: (_, dataIndex) => context.result.rows[dataIndex] },
      option: {
        ...base(context, seriesPalette(undefined)),
        tooltip: {
          trigger: 'item',
          confine: true,
          formatter: (p: { marker: string, name: string, value: unknown, percent?: number }) =>
            tooltipLine(p.marker, p.name, `${numberText(context, p.value, value)}${p.percent === undefined ? '' : ` (${p.percent.toLocaleString(context.dates.locale)}%)`}`) + hint
        },
        legend: { show: showLegend, type: legend?.scroll ? 'scroll' : 'plain', orient: 'horizontal', left: 'center', bottom: 0, textStyle: { color: context.theme.textMuted } },
        series: [{
          type: 'pie',
          radius: donut ? [Math.round(radius * 0.62), Math.round(radius)] : Math.round(radius),
          center: [Math.round(room.width / 2), Math.round(room.height / 2)],
          label: { show: false },
          cursor: context.click ? 'pointer' : 'default',
          data
        }]
      }
    }
  }
}

// --- Value (KPI, GAUGE) -----------------------------------------------------

/** The value's column across the rows (with Time, a series: the last row is now). */
function lastValue(context: BuildContext, role = 'value'): { raw: unknown, column?: string } {
  const column = first(context, role)
  const rows = context.result.rows
  return { raw: column ? rows[rows.length - 1]?.[column] : undefined, column }
}

const kpi: Builder = (context) => {
  const { raw, column } = lastValue(context)
  const rows = context.result.rows
  const series = column ? rows.map(row => toNumber(row[column])) : []
  const current = toNumber(raw)
  const compare = first(context, 'compare')
  const last = rows[rows.length - 1]
  const previous = compare ? (last ? toNumber(last[compare]) : null) : series.length > 1 ? series[series.length - 2]! : null
  const pct = previous === null || previous === 0 ? null : ((current - previous) / Math.abs(previous)) * 100
  // The threshold its value falls in wins over its Color (D5).
  const color = thresholdColor(thresholdStops(context), current) ?? resolvePaletteColor(context.props.color)
  const target = first(context, 'target')
  const model: KpiModel = { renderer: 'kpi', value: numberText(context, raw, column), ...(color ? { color } : {}), ...(last ? { row: last } : {}) }
  if (context.props.showDelta === true && pct !== null) {
    const up = pct >= 0
    model.delta = { text: `${up ? '+' : ''}${pct.toLocaleString(context.dates.locale, { maximumFractionDigits: 1 })}%`, up, positive: context.props.lowerIsBetter === true ? !up : up }
  }
  if (context.props.sparkline === true && series.length > 1) {
    const line = color ?? themeColor(context.theme.primary)
    model.sparkline = {
      grid: { left: 0, right: 0, top: 2, bottom: 2 },
      xAxis: { type: 'category', show: false, boundaryGap: false, data: series.map((_, i) => i) },
      yAxis: { type: 'value', show: false, scale: true },
      series: [{ type: 'line', data: series, smooth: true, showSymbol: false, lineStyle: { width: 1.5, color: line }, areaStyle: { color: line, opacity: 0.12 } }]
    }
  }
  if (target && last) model.target = numberText(context, last[target], column)
  return model
}

/** A gauge's arc in its thresholds' bands (D5): `[fraction of the arc, color]` stops, from 0 to its target. */
function gaugeBands(stops: { from: number, color: string }[], target: number): [number, string][] | null {
  if (stops.length === 0 || target <= 0) return null
  const bands: [number, string][] = []
  stops.forEach((stop, index) => {
    const next = stops[index + 1]
    const end = next ? Math.min(1, Math.max(0, next.from / target)) : 1
    const previous = bands.length ? bands[bands.length - 1]![0] : 0
    if (end > previous || !next) bands.push([Math.max(end, previous), stop.color])
  })
  return bands
}

/**
 * The arc and its text, all in ECharts: the value and "of <target>" sized by the arc's inner radius - never spilling
 * into the arc, never under a readable size (DB2). With thresholds, the arc in their bands and the value in its own
 * band's color (D5).
 */
const gauge: Builder = (context) => {
  const { raw, column } = lastValue(context)
  const targetColumn = first(context, 'target')
  const last = context.result.rows[context.result.rows.length - 1]
  const targetRaw = targetColumn && last ? last[targetColumn] : context.props.target
  const target = toNumber(targetRaw) > 0 ? toNumber(targetRaw) : 100
  const stops = thresholdStops(context)
  const color = thresholdColor(stops, toNumber(raw)) ?? accent(context)
  const bands = gaugeBands(stops, target)
  const width = 12
  // A 270° arc: as wide as the card, and its center low enough for the arc's ends to clear the bottom.
  const radius = Math.max(24, Math.min(context.size.width / 2 - 8, (context.size.height - 8) / 1.71))
  const inner = radius - width - 4
  const valueText = numberText(context, raw, column)
  const targetText = context.dates.ofTarget?.(numberText(context, target, column)) ?? `of ${numberText(context, target, column)}`
  // As large as the hole allows: wide enough for its characters across the inner circle, at most half its radius.
  const valueSize = Math.max(14, Math.min(inner * 0.5, (inner * 1.6) / Math.max(1, valueText.length * 0.6)))
  const targetSize = Math.max(11, Math.min(valueSize * 0.4, (inner * 1.4) / Math.max(1, targetText.length * 0.55)))
  return {
    renderer: 'echarts',
    option: {
      ...base(context, [color]),
      series: [{
        type: 'gauge',
        min: 0,
        max: target,
        radius,
        center: [context.size.width / 2, 8 + radius],
        progress: { show: true, width, itemStyle: { color } },
        // Its bands tinted under the value's progress: every band reads, the value's own the strongest.
        axisLine: { lineStyle: { width, color: bands ? bands.map(([end, band]) => [end, withAlpha(band, 0.3)]) : [[1, context.theme.border]] } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        pointer: { show: false },
        anchor: { show: false },
        title: { show: true, offsetCenter: [0, valueSize * 0.9], fontSize: targetSize, color: context.theme.textMuted },
        detail: { show: true, offsetCenter: [0, -targetSize * 0.2], fontSize: valueSize, fontWeight: 600, color, formatter: () => valueText },
        data: [{ value: Math.min(toNumber(raw), target), name: targetText }]
      }]
    }
  }
}

// --- Ranking, map, table ----------------------------------------------------

const ranking: Builder = (context) => {
  const label = first(context, 'category')
  const value = first(context, 'value')
  const rowColorKey = colorColumn(context.result, context.config)
  const image = first(context, 'image')
  const rows = context.result.rows.map(row => ({
    label: categoryLabel(label ? row[label] : null, context.dates, presentationOf(context, label)),
    image: image && typeof row[image] === 'string' ? row[image] as string : undefined,
    raw: value ? row[value] : null,
    color: rowColor(row, rowColorKey),
    row
  }))
  const max = Math.max(0, ...rows.map(r => Math.abs(toNumber(r.raw))))
  return {
    renderer: 'ranking',
    color: accent(context),
    rows: rows.map(r => ({ label: r.label, ...(r.image ? { image: r.image } : {}), value: numberText(context, r.raw, value), ...(r.color ? { color: r.color } : {}), pct: max === 0 ? 0 : (Math.abs(toNumber(r.raw)) / max) * 100, row: r.row }))
  }
}

/** A PostgreSQL `point` - x = longitude, y = latitude; @totalbase/database parses it to `{lng, lat}`. */
function parsePoint(raw: unknown): { lat: number, lng: number } | null {
  if (raw && typeof raw === 'object' && 'lat' in raw && 'lng' in raw) return { lat: Number((raw as { lat: unknown }).lat), lng: Number((raw as { lng: unknown }).lng) }
  if (typeof raw === 'string') {
    const match = /^\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)$/.exec(raw)
    if (match) return { lng: Number(match[1]), lat: Number(match[2]) }
  }
  return null
}

/** Points from its Location (a point), or its Latitude and Longitude chosen by hand - never guessed by name (DB4). */
const map: Builder = (context) => {
  const location = first(context, 'location')
  const latitude = first(context, 'latitude')
  const longitude = first(context, 'longitude')
  const label = first(context, 'label')
  const size = first(context, 'size')
  const rowColorKey = colorColumn(context.result, context.config)
  const points: MapPoint[] = []
  for (const row of context.result.rows) {
    const at = location ? parsePoint(row[location]) : latitude && longitude && row[latitude] !== null && row[longitude] !== null ? { lat: toNumber(row[latitude]), lng: toNumber(row[longitude]) } : null
    if (!at || !Number.isFinite(at.lat) || !Number.isFinite(at.lng) || Math.abs(at.lat) > 90 || Math.abs(at.lng) > 180) continue
    points.push({
      lat: at.lat,
      lng: at.lng,
      label: label ? categoryLabel(row[label], context.dates, presentationOf(context, label)) : '',
      value: size ? toNumber(row[size]) : null,
      valueText: size ? numberText(context, row[size], size) : null,
      color: rowColor(row, rowColorKey),
      row
    })
  }
  return { renderer: 'map', points, color: accent(context), cluster: context.props.cluster === true }
}

const table: Builder = context => ({ renderer: 'table', columns: context.roles.columns ?? [] })

// --- Tanda 3: shared ---------------------------------------------------------

/** A column's value as its tooltip line reads it: a number in its presentation's format (never compact), else its label. */
function cellText(context: BuildContext, column: string, raw: unknown): string {
  const presentation = presentationOf(context, column)
  if (!isNumericColumn(context.result, column)) return categoryLabel(raw, context.dates, presentation)
  if (raw === null || raw === undefined) return presentation?.emptyText ?? ''
  return formatWidgetNumber(raw, { config: { compact: false }, presentation, locale: context.dates.locale })
}

/** The Tooltip role's columns (tanda 3): each with its title and in its format, after the mark's own lines. */
function tooltipExtras(context: BuildContext, row: Record<string, unknown>): string {
  return (context.roles.tooltip ?? []).map(column => tooltipLine('', columnTitle(context.result, column), cellText(context, column, row[column]))).join('')
}

/** A tooltip's title line. */
function tooltipHead(value: string): string {
  return `<div style="margin-bottom:4px;font-weight:600">${escapeHtml(value)}</div>`
}

/** A share as the UI's language writes it - "46 %", "115 %"; a decimal below 10. */
function percentText(context: BuildContext, percent: number): string {
  return new Intl.NumberFormat(context.dates.locale, { style: 'percent', maximumFractionDigits: Math.abs(percent) < 10 ? 1 : 0 }).format(percent / 100)
}

// --- Progress (D12) ------------------------------------------------------------

/**
 * A value toward its target (the Target role's, else the `target` prop), from its last row: "$ 13.9M of $ 30M · 46 %".
 * Its thresholds on the value or, `thresholdsOn: PERCENT`, on its percent color the bar; past the target the bar is
 * full and the percent real (115 %).
 */
const progress: Builder = (context) => {
  const { raw, column } = lastValue(context)
  const rows = context.result.rows
  const last = rows[rows.length - 1]
  const targetColumn = first(context, 'target')
  const targetRaw = targetColumn ? last?.[targetColumn] : context.props.target
  const value = toNumber(raw)
  const target = toNumber(targetRaw)
  const percent = target > 0 ? (value / target) * 100 : null
  const measured = context.props.thresholdsOn === 'PERCENT' ? percent : value
  const color = (measured === null ? undefined : thresholdColor(thresholdStops(context), measured)) ?? resolvePaletteColor(context.props.color)
  const targetText = numberText(context, targetRaw, targetColumn ?? column)
  return {
    renderer: 'progress',
    value: numberText(context, raw, column),
    ...(context.props.showTarget !== false ? { target: context.dates.ofTarget?.(targetText) ?? `of ${targetText}` } : {}),
    ...(context.props.showPercent !== false && percent !== null ? { percent: percentText(context, percent) } : {}),
    bar: percent === null ? 0 : Math.max(0, Math.min(100, percent)),
    ...(color ? { color } : {}),
    ...(last ? { row: last } : {})
  }
}

// --- Color scales (HEATMAP, CALENDAR - D10) -------------------------------------

/**
 * A heatmap's or a calendar's color: a continuous scale from the background (the hue faint) to its Color (else the
 * theme's primary), or - with thresholds (D5) - fixed bands of their colors, each named in the legend. The legend sits
 * below, centered; `height` is the room it takes.
 */
function colorScale(context: BuildContext, values: number[], format: (raw: unknown) => string): { visualMap: Record<string, unknown>, height: number } {
  const show = context.props.showLegend !== false
  const stops = thresholdStops(context)
  const textStyle = { color: context.theme.textMuted, fontSize: 11 }
  if (stops.length > 0) {
    const pieces = stops.map((stop, index) => {
      const next = stops[index + 1]
      const range = stop.from === -Infinity
        ? (next ? { lt: next.from } : { gte: -Number.MAX_VALUE })
        : (next ? { gte: stop.from, lt: next.from } : { gte: stop.from })
      const label = stop.label ?? (stop.from === -Infinity ? (next ? `< ${format(next.from)}` : '') : next ? `${format(stop.from)} – ${format(next.from)}` : `≥ ${format(stop.from)}`)
      return { ...range, color: stop.color, label }
    })
    const lines = legendLayout(pieces.map(p => p.label), context.size)
    return {
      height: show ? lines.height : 0,
      visualMap: { type: 'piecewise', show, pieces, orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 12, itemHeight: 12, textStyle, outOfRange: { color: withAlpha(context.theme.textMuted, 0.15) } }
    }
  }
  const color = accent(context)
  const min = values.length ? Math.min(...values) : 0
  const max = values.length ? Math.max(...values) : 1
  return {
    height: show ? 36 : 0,
    visualMap: {
      type: 'continuous',
      show,
      min,
      max: max === min ? min + 1 : max,
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemHeight: Math.max(60, Math.min(160, context.size.width / 3)),
      itemWidth: 10,
      text: [format(max), format(min)],
      textStyle,
      inRange: { color: [withAlpha(color, 0.08), color] }
    }
  }
}

// --- Heatmap (D10) ---------------------------------------------------------------

/**
 * A grid of X × Y, each cell colored by its value. Categories in the query's order (its ORDER BY decides) - time
 * sorted, a CHECK list's values by their labels in its order; Y's first on top. A missing cell stays empty, never 0.
 */
const heatmap: Builder = (context) => {
  const x = first(context, 'x')!
  const y = first(context, 'y')!
  const value = first(context, 'value')
  const rows = context.result.rows
  const xValues = orderedCategories(rows.map(row => row[x]), columnOrder(context.result, x))
  const yValues = orderedCategories(rows.map(row => row[y]), columnOrder(context.result, y))
  const at = (list: unknown[]) => new Map(list.map((v, i) => [JSON.stringify(v ?? null), i]))
  const xAt = at(xValues)
  const yAt = at(yValues)
  const data: [number, number, number][] = []
  const rowIndexes: number[] = []
  rows.forEach((row, index) => {
    const raw = value ? row[value] : null
    if (raw === null || raw === undefined) return
    data.push([xAt.get(JSON.stringify(row[x] ?? null))!, yAt.get(JSON.stringify(row[y] ?? null))!, toNumber(raw)])
    rowIndexes.push(index)
  })
  const format = (raw: unknown) => numberText(context, raw, value)
  const scale = colorScale(context, data.map(d => d[2]), format)
  const xNames = xValues.map(v => categoryLabel(v, context.dates, presentationOf(context, x)))
  const yNames = yValues.map(v => categoryLabel(v, context.dates, presentationOf(context, y)))
  const axisLabel = { color: context.theme.textMuted, fontSize: 11 }
  const hint = tooltipHint(context)
  return {
    renderer: 'echarts',
    pick: { grid: false, horizontal: false, rowAt: (_, dataIndex) => rows[rowIndexes[dataIndex] ?? -1] },
    option: {
      ...base(context, [accent(context)]),
      tooltip: {
        trigger: 'item',
        confine: true,
        formatter: (p: { dataIndex: number, marker: string, value: [number, number, number] }) => {
          const row = rows[rowIndexes[p.dataIndex] ?? -1]
          return tooltipHead(`${yNames[p.value[1]]} · ${xNames[p.value[0]]}`)
            + tooltipLine(p.marker, value ? columnTitle(context.result, value) : '', format(p.value[2]))
            + (row ? tooltipExtras(context, row) : '') + hint
        }
      },
      grid: { left: 8, right: 8, top: 8, bottom: 8 + scale.height, containLabel: true },
      xAxis: { type: 'category', data: xNames, splitArea: { show: false }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { ...axisLabel, hideOverlap: true } },
      // Its first category on top, as the query orders it.
      yAxis: { type: 'category', data: yNames, inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { ...axisLabel, width: 110, overflow: 'truncate' } },
      visualMap: scale.visualMap,
      series: [{
        type: 'heatmap',
        name: value ? columnTitle(context.result, value) : '',
        data,
        cursor: context.click ? 'pointer' : 'default',
        label: { show: context.props.showValues === true, fontSize: 10, formatter: (p: { value: [number, number, number] }) => format(p.value[2]) },
        // A cell's color is its value (the scale's legend reads it), not a series - no decal pattern.
        itemStyle: { borderColor: 'transparent', borderWidth: 2, borderRadius: 3, decal: { symbol: 'none' } },
        emphasis: { itemStyle: { borderColor: context.theme.text, borderWidth: 1 } }
      }]
    }
  }
}

// --- Calendar (D10) --------------------------------------------------------------

/** A calendar's years: the latest `max` of those the days fall in, latest first - and how many there are. */
export function calendarYears(days: readonly string[], max = 3): { years: number[], count: number } {
  const all = [...new Set(days.map(day => Number(day.slice(0, 4))).filter(Number.isFinite))].sort((a, b) => b - a)
  return { years: all.slice(0, max), count: all.length }
}

/** Countries whose week starts on Sunday, when the browser can't say (Intl.Locale's week info). */
const SUNDAY_FIRST = new Set(['US', 'CA', 'MX', 'BR', 'JP', 'IL', 'PH', 'KR', 'TW', 'HK', 'IN', 'ZA', 'AU', 'CO', 'VE', 'PE', 'GT', 'HN', 'NI', 'PA', 'PR', 'SV', 'DO', 'PY', 'BO'])

/**
 * The week's first day in a locale (0 Sunday, 1 Monday...) - the browser's week info, else its region's custom. No
 * locale: the browser's own regional settings (DB33), as numbers and dates read.
 */
export function firstDayOfWeek(locale?: string): number {
  try {
    const intl = new Intl.Locale(locale ?? new Intl.DateTimeFormat().resolvedOptions().locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }, weekInfo?: { firstDay: number } }
    const info = intl.getWeekInfo?.() ?? intl.weekInfo
    if (info?.firstDay) return info.firstDay % 7
    const region = intl.maximize().region
    return region && SUNDAY_FIRST.has(region) ? 0 : 1
  } catch {
    return 1
  }
}

/**
 * A calendar's day and month names in the UI's language (ECharts' nameMap: days from Sunday, months from January),
 * its week's first day from the viewer's regional settings (Dashboards.md §5, DB33/DB34).
 */
export function calendarNames(language?: string, regional?: string): { days: string[], months: string[], firstDay: number } {
  const weekday = new Intl.DateTimeFormat(language, { weekday: 'narrow', timeZone: 'UTC' })
  const month = new Intl.DateTimeFormat(language, { month: 'short', timeZone: 'UTC' })
  // 2023-01-01 was a Sunday.
  return {
    days: Array.from({ length: 7 }, (_, i) => weekday.format(new Date(Date.UTC(2023, 0, 1 + i)))),
    months: Array.from({ length: 12 }, (_, i) => month.format(new Date(Date.UTC(2023, i, 15)))),
    firstDay: firstDayOfWeek(regional ?? language)
  }
}

/** A Date column's day as `YYYY-MM-DD`: a date as it is, a timestamp in the viewer's own day. */
function dayOf(raw: unknown): string | null {
  if (typeof raw !== 'string' && !(raw instanceof Date)) return null
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const date = new Date(raw as string)
  if (Number.isNaN(date.getTime())) return null
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** `YYYY-MM-DD` of a day `months` calendar months before the given one's month start (UTC, no time zone involved). */
function monthStart(day: string, monthsBack: number): string {
  const date = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1 - monthsBack, 1))
  return date.toISOString().slice(0, 10)
}
function monthEnd(day: string): string {
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).toISOString().slice(0, 10)
}

/** Smallest legible cell, in px - fewer years (or months, on a phone) rather than smaller cells (DB34). */
const CALENDAR_MIN_CELL = 9

/**
 * Every day colored by its value, in the UI's language, its week from the viewer's first day:
 * - wide: a calendar per year, latest first, as many of the latest three as fit at a legible cell - its cells as wide
 *   as the card allows (up to twice their height), so a full-width card is filled;
 * - narrow (a phone): the latest months that fit at a legible cell, one row of weeks - a year of 53 weeks never fits.
 * What doesn't show is said under it.
 */
const calendar: Builder = (context) => {
  const date = first(context, 'date')!
  const value = first(context, 'value')
  const rows = context.result.rows
  const entries = rows.flatMap((row, index) => {
    const day = dayOf(row[date])
    const raw = value ? row[value] : null
    return day && raw !== null && raw !== undefined ? [{ day, value: toNumber(raw), index }] : []
  })
  const format = (raw: unknown) => numberText(context, raw, value)
  const scale = colorScale(context, entries.map(e => e.value), format)
  const names = calendarNames(context.dates.language ?? context.dates.locale, context.dates.locale)
  const { width, height } = context.size
  const muted = context.theme.textMuted
  const NOTICE = 20
  const room = (withNotice: boolean) => height - scale.height - 8 - (withNotice ? NOTICE : 0)

  let groups: { range: string | [string, string], list: typeof entries }[]
  let cellWidth: number
  let cellHeight: number
  let notice: BuiltNotice | undefined
  if (width < 600) {
    const latest = entries.reduce((max, e) => (e.day > max ? e.day : max), entries[0]?.day ?? new Date().toISOString().slice(0, 10))
    const weeks = Math.max(5, Math.floor((width - 40) / 12))
    const months = Math.max(1, Math.min(12, Math.floor(weeks / 4.45)))
    const from = monthStart(latest, months - 1)
    const to = monthEnd(latest)
    const cut = entries.some(e => e.day < from)
    const span = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1
    cellWidth = (width - 40) / (Math.ceil(span / 7) + 1)
    cellHeight = Math.max(4, Math.min(cellWidth, (room(cut) - 24) / 7))
    groups = [{ range: [from, to], list: entries.filter(e => e.day >= from && e.day <= to) }]
    if (cut) notice = { key: 'calendarMonthsCut', params: { months } }
  } else {
    const { years: latest, count } = calendarYears(entries.map(e => e.day))
    const fullWidth = (width - 64) / 53
    let n = Math.max(1, latest.length)
    const fits = (k: number) => Math.min(fullWidth, (room(count > k) - k * 24) / (7 * k))
    while (n > 1 && fits(n) < CALENDAR_MIN_CELL) n--
    cellHeight = Math.max(4, fits(n))
    cellWidth = Math.max(cellHeight, Math.min(fullWidth, cellHeight * 2))
    const years = latest.slice(0, n)
    groups = years.map(year => ({ range: String(year), list: entries.filter(e => Number(e.day.slice(0, 4)) === year) }))
    if (count > years.length) notice = { key: 'calendarYearsCut', params: { shown: years.length, count } }
  }
  const narrow = width < 600
  const hint = tooltipHint(context)
  return {
    renderer: 'echarts',
    ...(notice ? { notice } : {}),
    pick: { grid: false, horizontal: false, rowAt: (seriesIndex, dataIndex) => rows[groups[seriesIndex ?? 0]?.list[dataIndex]?.index ?? -1] },
    option: {
      ...base(context, [accent(context)]),
      tooltip: {
        trigger: 'item',
        confine: true,
        formatter: (p: { seriesIndex: number, dataIndex: number, marker: string, value: [string, number] }) => {
          const row = rows[groups[p.seriesIndex]?.list[p.dataIndex]?.index ?? -1]
          return tooltipHead(context.dates.day(p.value[0], { dateStyle: 'medium' }))
            + tooltipLine(p.marker, value ? columnTitle(context.result, value) : '', format(p.value[1]))
            + (row ? tooltipExtras(context, row) : '') + hint
        }
      },
      visualMap: scale.visualMap,
      calendar: groups.map((group, i) => ({
        range: group.range,
        orient: 'horizontal',
        cellSize: [cellWidth, cellHeight],
        left: narrow ? 28 : 48,
        top: 22 + i * (cellHeight * 7 + 24),
        splitLine: { lineStyle: { color: context.theme.border, width: 1 } },
        itemStyle: { color: 'transparent', borderColor: withAlpha(context.theme.border, 0.6), borderWidth: 0.5 },
        dayLabel: { show: cellHeight >= 8, firstDay: names.firstDay, nameMap: names.days, color: muted, fontSize: Math.min(10, Math.max(8, Math.floor(cellHeight))) },
        monthLabel: { nameMap: names.months, color: muted, fontSize: 10 },
        // A phone's months carry no year label of their own: its latest months, said by the notice when cut.
        yearLabel: { show: !narrow, color: muted, fontSize: 11, position: 'left', margin: 28 }
      })),
      series: groups.map((group, i) => ({
        type: 'heatmap',
        coordinateSystem: 'calendar',
        calendarIndex: i,
        name: value ? columnTitle(context.result, value) : '',
        cursor: context.click ? 'pointer' : 'default',
        // Each year is its own series only to place it; a day's color is its value - no decal pattern.
        itemStyle: { decal: { symbol: 'none' } },
        data: group.list.map(e => [e.day, e.value])
      }))
    }
  }
}

// --- Waterfall (D15) -------------------------------------------------------------

export interface WaterfallStep {
  kind: 'increase' | 'decrease' | 'total'
  /** Its change - a total's, the running sum. */
  change: number
  /** The running sum after it. */
  cumulative: number
  /** Where its bar starts and ends - a change from the sum before it, a total from 0. */
  low: number
  high: number
  /** Its row - none for the final total. */
  rowIndex: number | null
}

/** Each row's step: a change from the running sum, or a total (a true Total role) drawn from 0 - then the final total. */
export function waterfallSteps(items: readonly { value: number | null, total: boolean }[], finalTotal: boolean): WaterfallStep[] {
  let sum = 0
  const totalStep = (rowIndex: number | null): WaterfallStep => ({ kind: 'total', change: sum, cumulative: sum, low: Math.min(0, sum), high: Math.max(0, sum), rowIndex })
  const steps = items.map((item, index): WaterfallStep => {
    if (item.total) return totalStep(index)
    const change = item.value ?? 0
    const start = sum
    sum += change
    return { kind: change < 0 ? 'decrease' : 'increase', change, cumulative: sum, low: Math.min(start, sum), high: Math.max(start, sum), rowIndex: index }
  })
  if (finalTotal) steps.push(totalStep(null))
  return steps
}

/**
 * A step's bar as three stacked pieces (ECharts stacks positives and negatives apart): a transparent base and the
 * visible part above zero and below it - a bar that crosses zero is its two visible parts, no base.
 */
export function waterfallStack(step: Pick<WaterfallStep, 'low' | 'high'>): { base: number | null, positive: number | null, negative: number | null } {
  if (step.low >= 0) return { base: step.low, positive: step.high - step.low, negative: null }
  if (step.high <= 0) return { base: step.high, positive: null, negative: step.low - step.high }
  return { base: null, positive: step.high, negative: step.low }
}

const waterfall: Builder = (context) => {
  const category = first(context, 'category')
  const value = first(context, 'value')
  const total = first(context, 'total')
  const rows = context.result.rows
  const steps = waterfallSteps(rows.map(row => ({ value: value && row[value] !== null && row[value] !== undefined ? toNumber(row[value]) : null, total: total ? row[total] === true : false })), context.props.finalTotal !== false)
  const totalWord = context.dates.text?.total ?? 'Total'
  const names = steps.map(step => (step.rowIndex === null ? text(context.props.finalTotalLabel) ?? totalWord : categoryLabel(category ? rows[step.rowIndex]![category] : null, context.dates, presentationOf(context, category))))
  const colors = {
    increase: resolvePaletteColor(context.props.increaseColor) ?? context.theme.success,
    decrease: resolvePaletteColor(context.props.decreaseColor) ?? context.theme.error,
    total: resolvePaletteColor(context.props.totalColor) ?? themeColor(context.theme.primary)
  }
  const pattern = widgetNumberPattern(context.config, presentationOf(context, value))
  const axis = valueAxis(context, 0, [{ type: 'bar', pattern } as unknown as DrawnSeries], false)
  const format = (raw: unknown) => numberText(context, raw, value)
  const marks = referenceMarks(context, [{ key: value ?? '', column: value, name: '', axis: 0 }], false, [axis.format]).get(0)
  const pieces = steps.map(waterfallStack)
  const piece = (key: 'positive' | 'negative') => pieces.map((p, i) => (p[key] === null ? '-' : { value: p[key], itemStyle: { color: colors[steps[i]!.kind] } }))
  const hint = tooltipHint(context)
  const changeTitle = value ? columnTitle(context.result, value) : ''
  return {
    renderer: 'echarts',
    pick: { grid: true, horizontal: false, rowAt: (_, dataIndex) => rows[steps[dataIndex]?.rowIndex ?? -1] },
    option: {
      ...base(context, [colors.increase]),
      tooltip: {
        trigger: 'axis',
        confine: true,
        axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const index = ((Array.isArray(params) ? params[0] : params) as { dataIndex: number } | undefined)?.dataIndex ?? -1
          const step = steps[index]
          if (!step) return ''
          const row = step.rowIndex === null ? undefined : rows[step.rowIndex]
          const marker = `<span style="display:inline-block;margin-right:6px;border-radius:2px;width:10px;height:10px;background:${colors[step.kind]}"></span>`
          return tooltipHead(names[index]!)
            + (step.kind === 'total' ? '' : tooltipLine(marker, changeTitle, `${step.change > 0 ? '+' : ''}${format(step.change)}`))
            + tooltipLine(step.kind === 'total' ? marker : '', step.kind === 'total' ? totalWord : (context.dates.text?.cumulative ?? 'Cumulative'), format(step.cumulative))
            + (row ? tooltipExtras(context, row) : '') + hint
        }
      },
      grid: { left: 8, right: 16, top: axis.title ? 32 : 12, bottom: 8, containLabel: true },
      xAxis: { type: 'category', data: names, axisLabel: { color: context.theme.textMuted, hideOverlap: true } },
      yAxis: axis.axis,
      series: [
        { type: 'bar', stack: 'waterfall', silent: true, itemStyle: { color: 'transparent', decal: { symbol: 'none' } }, emphasis: { disabled: true }, data: pieces.map(p => p.base ?? '-'), barMaxWidth: 48 },
        {
          type: 'bar',
          stack: 'waterfall',
          name: changeTitle,
          cursor: context.click ? 'pointer' : 'default',
          data: piece('positive'),
          barMaxWidth: 48,
          ...(marks?.lines.length ? { markLine: { silent: true, symbol: 'none', data: marks.lines } } : {}),
          ...(marks?.bands.length ? { markArea: { silent: true, label: { show: true, position: 'insideTopLeft' }, data: marks.bands } } : {})
        },
        { type: 'bar', stack: 'waterfall', name: changeTitle, cursor: context.click ? 'pointer' : 'default', data: piece('negative'), barMaxWidth: 48 }
      ]
    }
  }
}

// --- Funnel (D13) ------------------------------------------------------------------

/**
 * Steps in the query's order (`sort: DESC`, the largest first), each with its share of the first step or of the
 * previous one (`conversion`) in its label and tooltip. Colored as a pie: the palette, `_color`, its presentation.
 */
const funnel: Builder = (context) => {
  const label = first(context, 'category')
  const value = first(context, 'value')
  const rows = context.result.rows
  const labelPresentation = presentationOf(context, label)
  const rowColorKey = colorColumn(context.result, context.config)
  const steps = rows.map((row, index) => ({
    index,
    name: categoryLabel(label ? row[label] : null, context.dates, labelPresentation),
    value: value ? toNumber(row[value]) : 0,
    color: rowColor(row, rowColorKey) ?? (label ? optionColor(labelPresentation, row[label]) : undefined)
  }))
  if (context.props.sort === 'DESC') steps.sort((a, b) => b.value - a.value)
  const conversion = context.props.conversion
  const share = (i: number): number | null => {
    const base = conversion === 'FIRST' ? steps[0]?.value : conversion === 'PREVIOUS' ? (i === 0 ? steps[0]?.value : steps[i - 1]?.value) : undefined
    return base ? (steps[i]!.value / base) * 100 : null
  }
  const shares = steps.map((_, i) => share(i))
  const showLegend = context.props.showLegend === true
  const legend = showLegend ? legendLayout(steps.map(s => s.name), context.size) : null
  const format = (raw: unknown) => numberText(context, raw, value)
  const hint = tooltipHint(context)
  return {
    renderer: 'echarts',
    pick: { grid: false, horizontal: false, rowAt: (_, dataIndex) => rows[steps[dataIndex]?.index ?? -1] },
    option: {
      ...base(context, seriesPalette(undefined)),
      tooltip: {
        trigger: 'item',
        confine: true,
        formatter: (p: { dataIndex: number, marker: string, name: string, value: unknown }) => {
          const pct = shares[p.dataIndex]
          const row = rows[steps[p.dataIndex]?.index ?? -1]
          return tooltipLine(p.marker, p.name, `${format(p.value)}${pct === null || pct === undefined ? '' : ` (${percentText(context, pct)})`}`) + (row ? tooltipExtras(context, row) : '') + hint
        }
      },
      legend: { show: showLegend, type: legend?.scroll ? 'scroll' : 'plain', left: 'center', bottom: 0, textStyle: { color: context.theme.textMuted } },
      series: [{
        type: 'funnel',
        // The query's order (or ours, DESC) - never ECharts' own.
        sort: 'none',
        left: 8,
        right: 8,
        top: 8,
        bottom: 8 + (legend?.height ?? 0),
        minSize: '8%',
        gap: 2,
        cursor: context.click ? 'pointer' : 'default',
        label: {
          show: true,
          position: 'inside',
          formatter: (p: { dataIndex: number, name: string }) => {
            const pct = shares[p.dataIndex]
            return pct === null || pct === undefined ? p.name : `${p.name} · ${percentText(context, pct)}`
          }
        },
        data: steps.map(s => ({ name: s.name, value: s.value, ...(s.color ? { itemStyle: { color: s.color } } : {}) }))
      }]
    }
  }
}

// --- Treemap and sunburst (D18) ------------------------------------------------------

/**
 * A tree by levels (utils/dashboard-hierarchy.ts): a parent the sum of its children, a NULL level ending its branch.
 * Its first level in the palette (or its column's presentation colors), a leaf's `_color` on it. Without a click a
 * tap zooms (ECharts' own: TREEMAP drills down with a breadcrumb, SUNBURST makes the node its center); with one, any
 * node hands its card the row of its path - its levels filled down to it, the deeper ones empty.
 */
function hierarchy(kind: 'treemap' | 'sunburst'): Builder {
  return (context) => {
    const levels = context.roles.levels ?? []
    const value = first(context, 'value')
    const rows = context.result.rows
    const tree = value ? buildHierarchy(rows, levels, value, toNumber) : []
    const colors = seriesPalette(undefined)
    const topPresentation = presentationOf(context, levels[0])
    const rowColorKey = colorColumn(context.result, context.config)
    const nodes = new Map<string, HierarchyNode>()
    const toData = (node: HierarchyNode, index: number): Record<string, unknown> => {
      const id = `n${nodes.size}`
      nodes.set(id, node)
      const leafRow = node.children.length === 0 && node.rows.length ? rows[node.rows[node.rows.length - 1]!] : undefined
      const color = node.depth === 0
        ? (optionColor(topPresentation, node.raw) ?? colors[index % colors.length])
        : leafRow ? rowColor(leafRow, rowColorKey) : undefined
      return {
        id,
        name: categoryLabel(node.raw, context.dates, presentationOf(context, levels[node.depth])),
        value: node.value,
        ...(color ? { itemStyle: { color } } : {}),
        ...(node.children.length ? { children: node.children.map((child, i) => toData(child, i)) } : {})
      }
    }
    const data = tree.map((node, i) => toData(node, i))
    /** The row of a node's path: a leaf with one row is that row; else its levels down to it, the deeper ones empty. */
    const rowOf = (node: HierarchyNode | undefined): Record<string, unknown> | undefined => {
      if (!node) return undefined
      if (node.children.length === 0 && node.rows.length === 1) return rows[node.rows[0]!]
      return { ...Object.fromEntries(levels.map((level, i) => [level, i < node.path.length ? node.path[i] : null])), ...(value ? { [value]: node.value } : {}) }
    }
    const nodeOf = (data: unknown) => nodes.get(String((record(data) ?? {}).id ?? ''))
    const format = (raw: unknown) => numberText(context, raw, value)
    const showLabels = context.props.showLabels !== false
    const nodeClick = context.click ? false : kind === 'treemap' ? 'zoomToNode' : 'rootToNode'
    const hint = tooltipHint(context)
    const tooltip = {
      trigger: 'item',
      confine: true,
      formatter: (p: { data: unknown, marker: string }) => {
        const node = nodeOf(p.data)
        if (!node) return ''
        const path = node.path.map((raw, i) => categoryLabel(raw, context.dates, presentationOf(context, levels[i])))
        const row = node.children.length === 0 && node.rows.length === 1 ? rows[node.rows[0]!] : undefined
        return tooltipHead(path.join(' › ')) + tooltipLine(p.marker, value ? columnTitle(context.result, value) : '', format(node.value)) + (row ? tooltipExtras(context, row) : '') + hint
      }
    }
    const visible = Math.max(1, Math.round(finite(context.props.visibleLevels) ?? 2))
    const series = kind === 'treemap'
      ? {
          type: 'treemap',
          data,
          roam: false,
          nodeClick,
          left: 0,
          right: 0,
          top: 0,
          bottom: levels.length > 1 ? 30 : 0,
          ...(levels.length > visible ? { leafDepth: visible } : {}),
          breadcrumb: {
            show: levels.length > 1,
            bottom: 0,
            left: 0,
            height: 22,
            itemStyle: { color: withAlpha(context.theme.textMuted, 0.15), borderColor: 'transparent', shadowBlur: 0, textStyle: { color: context.theme.text } },
            emphasis: { itemStyle: { color: withAlpha(context.theme.textMuted, 0.3) } }
          },
          label: { show: showLabels, formatter: '{b}' },
          upperLabel: { show: showLabels && levels.length > 1, height: 18 },
          itemStyle: { borderColor: 'transparent', gapWidth: 2 },
          levels: [{ itemStyle: { gapWidth: 3, borderWidth: 0 } }, { itemStyle: { gapWidth: 1, borderWidth: 0 }, colorSaturation: [0.35, 0.6] }],
          cursor: 'pointer'
        }
      : {
          type: 'sunburst',
          data,
          nodeClick,
          radius: [levels.length > 1 ? '12%' : 0, '92%'],
          center: ['50%', '50%'],
          label: { show: showLabels, rotate: 'radial', minAngle: 10, fontSize: 10 },
          itemStyle: { borderColor: context.theme.border, borderWidth: 1 },
          cursor: 'pointer'
        }
    return {
      renderer: 'echarts',
      pick: { grid: false, horizontal: false, rowAt: (_, __, ___, item) => rowOf(nodeOf(item)) },
      option: { ...base(context, colors), tooltip, series: [series] }
    }
  }
}

// --- Scatter and bubbles (D16) ---------------------------------------------------------

/**
 * Points by X and Y - with Size, bubbles (area by value: the radius by its square root, 6 to 40 px); with Group, a
 * series per value colored by its presentation (or `config.series`). Axes by role (`axes.x`, `axes.y`) fitted to the
 * data unless set; references on either axis; zoom on both.
 */
const scatter: Builder = (context) => {
  const x = first(context, 'x')!
  const y = first(context, 'y')!
  const size = first(context, 'size')
  const label = first(context, 'label')
  const group = first(context, 'group')
  const rows = context.result.rows
  const theme = context.theme
  const xTime = columnOrder(context.result, x).kind === 'time'
  // One series per Group value - a CHECK list's in its order, else the query's.
  const groupPresentation = presentationOf(context, group)
  const groupOrder = group ? columnOrder(context.result, group) : null
  const groupValues = group ? orderedCategories(rows.map(row => row[group]), groupOrder?.kind === 'text' ? groupOrder : { kind: 'number' }) : [null]
  const palettes = palette(context, groupValues.length)
  const groups = groupValues.map((raw, i) => {
    const key = String(raw)
    const own = group ? seriesSettings(context, key) : {}
    return {
      name: group ? text(own.label) ?? categoryLabel(raw, context.dates, groupPresentation) : columnTitle(context.result, y),
      color: resolvePaletteColor(own.color) ?? (group ? optionColor(groupPresentation, raw) : undefined) ?? palettes[i % palettes.length]!,
      rowIndexes: rows.flatMap((row, index) => (!group || JSON.stringify(row[group] ?? null) === JSON.stringify(raw ?? null) ? [index] : []))
    }
  })
  const maxSize = size ? Math.max(0, ...rows.map(row => Math.abs(toNumber(row[size])))) : 0
  const symbolSize = (raw: number) => (size && maxSize > 0 ? Math.max(6, Math.min(40, 40 * Math.sqrt(Math.max(0, raw) / maxSize))) : 10)
  const axisSettings = (role: 'x' | 'y') => record(record(context.config.axes)?.[role]) ?? {}
  const formatFor = (role: 'x' | 'y', column: string) => {
    const pattern = text(axisSettings(role).displayFormat) ?? widgetNumberPattern(context.config, presentationOf(context, column))
    return (raw: unknown) => formatWidgetNumber(raw, { config: { ...context.config, ...(pattern ? { displayFormat: pattern } : {}) }, presentation: presentationOf(context, column), locale: context.dates.locale })
  }
  const xFormat = xTime ? (raw: unknown) => context.dates.date(new Date(Number(raw)).toISOString(), { dateStyle: 'medium' }) : formatFor('x', x)
  const yFormat = formatFor('y', y)
  const sizeFormat = (raw: unknown) => numberText(context, raw, size)
  const axisOf = (role: 'x' | 'y', format: (raw: unknown) => string, time: boolean) => {
    const settings = axisSettings(role)
    const title = text(settings.title)
    const min = finite(settings.min)
    const max = finite(settings.max)
    const log = settings.log === true && !time
    return {
      type: time ? 'time' : log ? 'log' : 'value',
      ...(min !== undefined ? { min } : !log ? { scale: true } : {}),
      ...(max !== undefined ? { max } : {}),
      // Room past the extreme points, so a bubble at either end isn't cut by the plot's edge.
      ...(min === undefined && max === undefined && !time ? { boundaryGap: ['8%', '8%'] } : {}),
      ...(title ? { name: title, nameLocation: 'middle', nameGap: role === 'x' ? 28 : 44, nameTextStyle: { color: theme.textMuted } } : {}),
      axisLabel: { color: theme.textMuted, hideOverlap: true, ...(time ? {} : { formatter: (v: number) => format(v) }) },
      splitLine: { lineStyle: { color: theme.border } }
    }
  }
  const xValue = (raw: unknown) => (xTime ? new Date(String(raw)).getTime() : toNumber(raw))
  const showLegend = context.props.showLegend === true && groups.length > 1
  const legend = showLegend ? legendLayout(groups.map(g => g.name), context.size) : null
  const zoom = context.props.zoom === true
  const references = referenceMarks(context, groups.map((g, i) => ({ key: String(groupValues[i]), column: y, name: g.name, axis: 0 })), false, [yFormat], xFormat)
  const titled = (role: 'x' | 'y') => Boolean(text(axisSettings(role).title))
  const hint = tooltipHint(context)
  return {
    renderer: 'echarts',
    pick: { grid: false, horizontal: false, rowAt: (seriesIndex, dataIndex) => rows[groups[seriesIndex ?? 0]?.rowIndexes[dataIndex] ?? -1] },
    option: {
      ...base(context, groups.map(g => g.color)),
      tooltip: {
        trigger: 'item',
        confine: true,
        formatter: (p: { seriesIndex: number, dataIndex: number, marker: string, seriesName: string }) => {
          const row = rows[groups[p.seriesIndex]?.rowIndexes[p.dataIndex] ?? -1]
          if (!row) return ''
          const head = label ? tooltipHead(categoryLabel(row[label], context.dates, presentationOf(context, label))) : ''
          return head
            + (group ? tooltipLine(p.marker, columnTitle(context.result, group), p.seriesName) : '')
            + tooltipLine(group ? '' : p.marker, columnTitle(context.result, x), xFormat(xValue(row[x])))
            + tooltipLine('', columnTitle(context.result, y), yFormat(row[y]))
            + (size ? tooltipLine('', columnTitle(context.result, size), sizeFormat(row[size])) : '')
            + tooltipExtras(context, row) + hint
        }
      },
      legend: { show: showLegend, type: legend?.scroll ? 'scroll' : 'plain', top: 0, textStyle: { color: theme.textMuted } },
      grid: {
        left: 8 + (titled('y') ? 24 : 0),
        right: 16 + (zoom ? 28 : 0),
        top: (legend ? legend.height : 12),
        bottom: 8 + (titled('x') ? 22 : 0) + (zoom ? 30 : 0),
        containLabel: true
      },
      xAxis: axisOf('x', xFormat, xTime),
      yAxis: axisOf('y', yFormat, false),
      ...(zoom
        ? {
            dataZoom: [
              { type: 'slider', xAxisIndex: 0, bottom: 4, height: 18, textStyle: { color: theme.textMuted }, borderColor: theme.border, filterMode: 'none' },
              { type: 'slider', yAxisIndex: 0, orient: 'vertical', right: 4, width: 14, textStyle: { color: theme.textMuted }, borderColor: theme.border, filterMode: 'none' },
              { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
              { type: 'inside', yAxisIndex: 0, filterMode: 'none' }
            ]
          }
        : {}),
      series: groups.map((g, index) => {
        const marks = references.get(index)
        return {
          type: 'scatter',
          name: g.name,
          cursor: context.click ? 'pointer' : 'default',
          itemStyle: { color: g.color, opacity: size ? 0.7 : 0.9 },
          symbolSize: (point: number[]) => symbolSize(point[2] ?? 0),
          data: g.rowIndexes.map((i) => {
            const row = rows[i]!
            return [xValue(row[x]), toNumber(row[y]), size ? toNumber(row[size]) : 0]
          }),
          ...(marks?.lines.length ? { markLine: { silent: true, symbol: 'none', data: marks.lines } } : {}),
          ...(marks?.bands.length ? { markArea: { silent: true, label: { show: true, position: 'insideTopLeft' }, data: marks.bands } } : {})
        }
      })
    }
  }
}

// --- Detail and pivot (D14, D17) ----------------------------------------------------------

/** The first row's fields (its Columns role, but its image's column) - drawn by DashboardWidgetDetail.vue. */
const detail: Builder = (context) => {
  const image = first(context, 'image') ?? null
  const layout = context.props.layout === 'ONE' || context.props.layout === 'TWO' ? context.props.layout : 'AUTO'
  return { renderer: 'detail', columns: (context.roles.columns ?? []).filter(c => c !== image), image, layout }
}

/** Its roles - DashboardWidgetPivot.vue places the aggregated rows (utils/dashboard-pivot.ts). */
const pivot: Builder = context => ({ renderer: 'pivot', rows: context.roles.rows ?? [], columns: context.roles.columns ?? [], values: context.roles.values ?? [] })

/** Every data widget's builder - one per catalog entry; a presentation widget (D3) is its page widget's component instead. */
export const DASHBOARD_BUILDERS: Partial<Record<DashboardWidgetType, Builder>> = {
  KPI: kpi,
  GAUGE: gauge,
  PROGRESS: progress,
  BAR: categorySeries('bar'),
  COMBO: categorySeries('combo'),
  WATERFALL: waterfall,
  BAR_HORIZONTAL: categorySeries('barHorizontal'),
  LEADERBOARD: ranking,
  LINE: categorySeries('line'),
  AREA: categorySeries('area'),
  PIE: proportion(false),
  DONUT: proportion(true),
  FUNNEL: funnel,
  TREEMAP: hierarchy('treemap'),
  SUNBURST: hierarchy('sunburst'),
  HEATMAP: heatmap,
  CALENDAR: calendar,
  SCATTER: scatter,
  MAP: map,
  TABLE: table,
  DETAIL: detail,
  PIVOT: pivot
}

/**
 * A widget drawn from its result: its roles resolved (assigned, else by kind and position), its props at their
 * defaults, then its builder. Role problems come back as `errors` - the server refuses them too.
 */
export function buildWidget(
  widget: { type: DashboardWidgetType, config: Record<string, unknown> },
  result: DashboardQueryResult,
  options: { theme: ChartTheme, dates?: DateDisplay, size: WidgetSize, click?: ClickDisplay | null }
): { built: BuiltWidget | null, errors: string[] } {
  const builder = DASHBOARD_BUILDERS[widget.type]
  if (!builder || dashboardWidgetDefinition(widget.type).page) return { built: null, errors: [] }
  const resolved = resolveDashboardRoles(widget.type, widget.config, result.columns)
  if (resolved.errors.length) return { built: null, errors: resolved.errors }
  // What its roles can't draw beyond each role's own check - a COMBO with one value (D11).
  const problem = dashboardRolesProblem(widget.type, widget.config, resolved.roles)
  if (problem) return { built: null, errors: [problem.message] }
  const roles = Object.fromEntries(Object.entries(resolved.roles).map(([id, r]) => [id, r.columns]))
  const context: BuildContext = {
    type: widget.type,
    config: widget.config,
    props: dashboardWidgetProps(widget.type, widget.config),
    result,
    roles,
    theme: canvasTheme(options.theme),
    dates: options.dates ?? BROWSER_DATES,
    size: options.size,
    click: options.click ?? null
  }
  return { built: builder(context), errors: [] }
}
