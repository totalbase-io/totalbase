/**
 * A Table widget's columns from its Resource (Specification_DataViews.md §9.6, §15):
 * one per field the Resource reads, in its order,
 * each with its settings - the Table's own (`columnSettings`) over what its
 * resource's column sets (`inherited`); its title, else its name humanized.
 * A value reads by its PostgreSQL type (the page's `variableResources`) and
 * its Format: numbers in the viewer's locale and right-aligned, dates and
 * times in their patterns (`dataview.format`). Its computed columns follow
 * its Resource's, each a formula per row typed by its Type; a column's Color
 * formula colors each of its cells from its row. On the design canvas, the
 * same columns over three placeholder rows - its shape, never its data.
 */
import type { TableColumn } from '@nuxt/ui'
import { TABLE_COLUMN_PRESENTATION_KEYS, type ColumnPresentation, type TableColumnSettings, type TableComputedColumn } from '@totalbase/tb-catalog'
import type { FormulaReturnType } from '~/utils/formula-engine'
import { h, type VNode } from 'vue'
import { humanizeColumnName } from '~/utils/humanize-column-name'
import type { PageFormat } from '~/utils/page-format'
import { backgroundTint, columnStyleClass, optionBadge, TABLE_ALIGN_CLASS, valueLinkHref, type TableAlign } from '~/utils/table-column-style'

type Kind = 'number' | 'date' | 'time' | 'datetime' | 'boolean'

function kindOf(dataType: string | undefined): Kind | null {
  if (!dataType) return null
  if (/^(smallint|integer|bigint|numeric|decimal|real|double precision|money)\b/.test(dataType)) return 'number'
  if (/^timestamp\b/.test(dataType)) return 'datetime'
  if (/^time\b/.test(dataType)) return 'time'
  if (dataType === 'date') return 'date'
  if (dataType === 'boolean') return 'boolean'
  return null
}

/** A numeric(p,s)'s scale; an integer's 0; otherwise the digits the value itself carries. */
function decimalsOf(dataType: string, value: unknown): number {
  const scale = /^numeric\(\d+,\s*(\d+)\)/.exec(dataType)
  if (scale) return Number(scale[1])
  if (/^(smallint|integer|bigint)\b/.test(dataType) || /^numeric\(\d+\)/.test(dataType)) return 0
  const fraction = /\.(\d+)/.exec(String(value))
  return fraction ? Math.min(fraction[1]!.length, 10) : 0
}

/** A column's settings: the Table's own over its resource column's - only what a table shows (a form's help or placeholder stay out). */
export function effectiveColumnSettings(own: TableColumnSettings | undefined, inherited: ColumnPresentation | undefined): TableColumnSettings {
  const base: Record<string, unknown> = {}
  for (const key of TABLE_COLUMN_PRESENTATION_KEYS) {
    if (inherited?.[key] !== undefined) base[key] = inherited[key]
  }
  // A title of its own is its header - over the column's short label too.
  if (own?.label) delete base.shortLabel
  return { ...base, ...own } as TableColumnSettings
}

/** Only what a table shows of each column's presentation - what a Table's Columns editor names as inherited. */
export function inheritedTableSettings(presentation: Record<string, ColumnPresentation> | undefined): Record<string, TableColumnSettings> {
  return Object.fromEntries(Object.entries(presentation ?? {}).map(([column, p]) => [column, effectiveColumnSettings(undefined, p)]))
}

/**
 * A Resource's presentation with its related columns' too (`cliente.razon_social`, Specification_DataViews.md §9.8):
 * each titled "<its foreign key's title> › <the target column's title>" and formatted as the target column - read
 * from `relations` (foreign key → target resource) and every resource's presentation (`all`). One hop.
 */
export function withRelatedPresentation(
  own: Record<string, ColumnPresentation> | undefined,
  fields: readonly string[],
  relations: Record<string, string> | undefined,
  all: Record<string, Record<string, ColumnPresentation>> | undefined
): Record<string, ColumnPresentation> | undefined {
  const related = fields.filter(f => f.split('.').length === 2)
  if (related.length === 0) return own
  const out: Record<string, ColumnPresentation> = { ...own }
  for (const field of related) {
    const [fk, column] = field.split('.') as [string, string]
    const target = relations?.[fk] ? all?.[relations[fk]]?.[column] : undefined
    out[field] = { ...target, label: `${own?.[fk]?.label ?? humanizeColumnName(fk)} › ${target?.label ?? humanizeColumnName(column)}` }
  }
  return out
}

/** A boolean's words when its column sets none - English by default; the renderer passes them in the UI's language. */
export interface BooleanWords {
  true: string
  false: string
}
const BOOLEAN_WORDS: BooleanWords = { true: 'Yes', false: 'No' }

/** A cell's text: its Empty text, its Format (else its type's), its true/false labels, a CHECK value's label. */
export function formatResourceCell(value: unknown, dataType: string | undefined, settings: TableColumnSettings, format: PageFormat, booleans: BooleanWords = BOOLEAN_WORDS): string {
  if (value === null || value === undefined) return settings.emptyText ?? ''
  const kind = kindOf(dataType)
  const pattern = settings.displayFormat
  // A monospaced whole number is a code - an invoice's 3002, never "3.002" (T63), as the grid shows it.
  if (kind === 'number' && settings.mono && !pattern && /^-?\d+$/.test(String(value))) return String(value)
  if (kind === 'number') return format.number(value, pattern || decimalsOf(dataType!, value))
  if (kind === 'boolean' || typeof value === 'boolean') return value ? (settings.booleanLabels?.true ?? booleans.true) : (settings.booleanLabels?.false ?? booleans.false)
  if (kind) return format[kind](value, pattern || undefined)
  const option = settings.options?.[String(value)]?.label
  if (option) return option
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/** A computed column's PostgreSQL-like type - how its cells format, as a field's would. */
export const COMPUTED_DATA_TYPES: Record<TableComputedColumn['type'], string> = {
  text: 'text',
  number: 'numeric',
  date: 'date',
  timestamp: 'timestamp with time zone',
  boolean: 'boolean'
}
const COMPUTED_RETURN_TYPES: Record<TableComputedColumn['type'], FormulaReturnType> = {
  text: 'string',
  number: 'number',
  date: 'date',
  timestamp: 'datetime',
  boolean: 'boolean'
}

/** A formula over one row and the page - the Table's renderer's (evaluateWidgetFormula); undefined when it doesn't evaluate. */
export type RowFormula = (formula: string, row: Record<string, unknown>, returnType: FormulaReturnType) => unknown

export interface ResourceTableOptions {
  /** The Table's `columnSettings`, by field. */
  settings?: Record<string, TableColumnSettings>
  /** Its resource's columns' presentation, by column. */
  inherited?: Record<string, ColumnPresentation>
  /** A palette color's shade in the viewer's mode - a cell's text color. */
  shade?: (color: string) => string | undefined
  /** Draws an icon by name (UIcon) - a CHECK value's badge. */
  icon?: (name: string) => VNode
  /** Its computed columns, after its Resource's fields. */
  computed?: readonly TableComputedColumn[]
  /** Evaluates a computed column's or a Color formula over a row - live only. */
  evaluate?: RowFormula
  /** Each row with its computed values (`computedRows`) - shared with what else reads them (a Row color); one of its own otherwise. */
  rowOf?: (row: Record<string, unknown>) => Record<string, unknown>
  /** A boolean's words when its column sets none - Yes/No by default. */
  booleans?: BooleanWords
  /** A foreign key's text by its value, per column - its table's row presentation (WidgetRuntime.foreignKeyLabels). */
  labels?: Record<string, Record<string, string>>
}

/**
 * Each row with its computed columns' values - once per row, not per cell,
 * cached on the row's identity while its Resource's data stays the same. A
 * computed column reads the ones before it, as `{{total}}`.
 */
export function computedRows(computed: readonly TableComputedColumn[], evaluate: RowFormula | undefined) {
  const cache = new WeakMap<Record<string, unknown>, Record<string, unknown>>()
  return (row: Record<string, unknown>): Record<string, unknown> => {
    if (!computed.length || !evaluate) return row
    const cached = cache.get(row)
    if (cached) return cached
    const values = { ...row }
    for (const column of computed) values[column.key] = evaluate(column.formula, values, COMPUTED_RETURN_TYPES[column.type]) ?? null
    cache.set(row, values)
    return values
  }
}

function alignOf(settings: TableColumnSettings, kind: Kind | null): TableAlign {
  return settings.align ?? (kind === 'number' ? 'right' : kind === 'boolean' ? 'center' : 'left')
}

/** The fields shown, then its computed columns - each with its settings (a computed one inherits nothing), the hidden ones left out. */
function shownColumns(fields: readonly string[], options: ResourceTableOptions) {
  const computed = (options.computed ?? []).filter(c => !fields.includes(c.key))
  return [
    ...fields.map(field => ({ field, settings: effectiveColumnSettings(options.settings?.[field], options.inherited?.[field]) })),
    ...computed.map(c => ({ field: c.key, settings: { ...(c.label ? { label: c.label } : {}), ...options.settings?.[c.key] } }))
  ].filter(({ settings }) => !settings.hidden)
}
/** A column's type - a field's from its Resource, a computed one's from its Type. */
function typeOf(field: string, types: Record<string, string> | undefined, options: ResourceTableOptions): string | undefined {
  const computed = options.computed?.find(c => c.key === field)
  return computed ? COMPUTED_DATA_TYPES[computed.type] : types?.[field]
}

/** One column: its header, its cells' text and look - a CHECK value with a color or an icon as a badge, a link as a link. */
function resourceColumn(field: string, dataType: string | undefined, settings: TableColumnSettings, format: PageFormat, options: ResourceTableOptions, rowOf: (row: Record<string, unknown>) => Record<string, unknown>): TableColumn<Record<string, unknown>> {
  const kind = kindOf(dataType)
  const align = alignOf(settings, kind)
  const color = settings.color ? options.shade?.(settings.color) : undefined
  const colorFormula = settings.colorFormula?.trim() && options.evaluate ? settings.colorFormula : undefined
  return {
    // A computed column isn't on the Resource's row - it reads the row with its computed values.
    ...(options.computed?.some(c => c.key === field) ? { id: field, accessorFn: (row: Record<string, unknown>) => rowOf(row)[field] } : { accessorKey: field }),
    header: settings.shortLabel || settings.label || humanizeColumnName(field),
    cell: ({ row }): string | VNode => {
      const values = rowOf(row.original)
      const value = values[field]
      const label = value === null || value === undefined ? undefined : options.labels?.[field]?.[String(value)]
      const text = label ?? formatResourceCell(value, dataType, settings, format, options.booleans)
      const badge = value === null || value === undefined ? null : optionBadge(text, settings.options?.[String(value)], options.icon)
      if (badge) return badge
      // Its Color formula: this cell's color from its row, over the column's own.
      const cellColor = colorFormula ? options.evaluate!(colorFormula, values, 'string') : undefined
      const shade = typeof cellColor === 'string' && cellColor ? options.shade?.(cellColor) : undefined
      if (shade) return h('span', { style: { color: shade } }, cellText(value, text, settings))
      return cellText(value, text, settings)
    },
    meta: {
      class: { th: TABLE_ALIGN_CLASS[align], td: `${TABLE_ALIGN_CLASS[align]} ${columnStyleClass(settings, kind === 'number')}` },
      ...(color || settings.background ? { style: { td: { ...(color ? { color } : {}), ...(settings.background ? { backgroundColor: backgroundTint(options.shade?.(settings.background)) } : {}) } } } : {})
    }
  }
}

/** A cell's content: its text, or a link when its column has a Link type - opening itself, never Row clicked. */
function cellText(value: unknown, text: string, settings: TableColumnSettings): string | VNode {
  if (!settings.linkType || value === null || value === undefined || !text) return text
  return h('a', {
    href: valueLinkHref(settings.linkType, text),
    target: settings.linkType === 'url' ? '_blank' : undefined,
    rel: 'noopener noreferrer',
    class: 'text-primary hover:underline',
    onClick: (event: MouseEvent) => event.stopPropagation()
  }, text)
}

/** The columns for `fields` (its Resource's, in order), minus the hidden ones - undefined without types, the Table's own columns then. */
export function resourceTableColumns(fields: readonly string[], types: Record<string, string> | undefined, format: PageFormat, options: ResourceTableOptions = {}): TableColumn<Record<string, unknown>>[] | undefined {
  if (!types || fields.length === 0) return undefined
  const rowOf = options.rowOf ?? computedRows(options.computed ?? [], options.evaluate)
  return shownColumns(fields, options).map(({ field, settings }) => resourceColumn(field, typeOf(field, types, options), settings, format, options, rowOf))
}

/** What a Table's Search Enter needs of its Resource (variables-engine.ts's ResourceHandle). */
export interface SearchableResource {
  search: string | null
  data: unknown
  setSearch: (text: string) => Promise<unknown>
}

/**
 * A Table's Search Enter (`{ search, rows, row }`): what `text` finds - its
 * Resource searched for it first, unless that's what it holds already, and
 * read before the rows are taken (the box waits a moment before searching;
 * Enter doesn't). `row` is the first of them, null when none.
 */
export async function searchEnterPayload(resource: SearchableResource | undefined, text: string): Promise<{ search: string, rows: Record<string, unknown>[], row: Record<string, unknown> | null }> {
  const search = text.trim()
  if (resource && resource.search !== (search || null)) await resource.setSearch(search)
  const rows = Array.isArray(resource?.data) ? resource.data as Record<string, unknown>[] : []
  return { search, rows, row: rows[0] ?? null }
}

/** Bar widths of the placeholder rows, so they read as text of different lengths. */
const PLACEHOLDER_WIDTHS = ['w-24', 'w-16', 'w-20']

/** The design canvas's Table: its columns - titled, aligned, the hidden ones left out - over three gray rows; no query runs while designing. */
export function designTable(fields: readonly string[], types: Record<string, string> | undefined, options: Omit<ResourceTableOptions, 'shade' | 'evaluate'> = {}): { data: Record<string, string>[], columns: TableColumn<Record<string, string>>[] } {
  const shown = shownColumns(fields, options)
  const data = PLACEHOLDER_WIDTHS.map(() => Object.fromEntries(shown.map(({ field }) => [field, ''])))
  const columns = shown.map(({ field, settings }): TableColumn<Record<string, string>> => {
    const kind = kindOf(typeOf(field, types, options))
    const align = alignOf(settings, kind)
    return {
      accessorKey: field,
      header: settings.shortLabel || settings.label || humanizeColumnName(field),
      cell: ({ row }) => h('span', { class: ['inline-block h-2 rounded-full bg-accented', kind === 'number' ? 'w-10' : PLACEHOLDER_WIDTHS[row.index % PLACEHOLDER_WIDTHS.length]] }),
      ...(align !== 'left' ? { meta: { class: { th: TABLE_ALIGN_CLASS[align], td: TABLE_ALIGN_CLASS[align] } } } : {})
    }
  })
  return { data, columns }
}

/** The widgets that draw every option at once - on the canvas, with no data, they'd draw nothing. */
export const OPTION_LIST_WIDGETS: readonly string[] = ['URadioGroup', 'UCheckboxGroup', 'UListbox']

/** The design canvas's sample options' words - English by default; the renderer passes them in the UI's language. */
export interface DesignOptionWords {
  option: (n: number) => string
  description: string
}
const DESIGN_OPTION_WORDS: DesignOptionWords = { option: n => `Option ${n}`, description: 'Its description' }

/**
 * The design canvas's options for a list bound to a Resource: three samples
 * under its own fields (value, label, description, icon, color) - its shape,
 * never its data, as `designTable` draws a Table.
 */
export function designOptions(props: Record<string, unknown>, words: DesignOptionWords = DESIGN_OPTION_WORDS): Record<string, unknown>[] {
  const key = (prop: string, fallback?: string) => (typeof props[prop] === 'string' && props[prop] ? props[prop] as string : fallback)
  const value = key('valueKey', 'value')!
  const label = key('labelKey', 'label')!
  const description = key('descriptionKey')
  const icon = key('iconKey')
  const color = key('colorKey')
  return [1, 2, 3].map(n => ({
    [value]: n,
    [label]: words.option(n),
    ...(description ? { [description]: words.description } : {}),
    ...(icon ? { [icon]: 'i-lucide-square-dashed' } : {}),
    ...(color ? { [color]: 'neutral' } : {})
  }))
}
