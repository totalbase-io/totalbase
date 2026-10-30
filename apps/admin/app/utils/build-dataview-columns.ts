import { h, type VNode, type VNodeChild } from 'vue'
import { FileCell, UButton, UDropdownMenu, UIcon } from '#components'
import type { DropdownMenuItem, TableColumn } from '@nuxt/ui'
import type { DataViewField } from '~/types/dataview'
import { formatNumberLocale, formatNumberValue, formatTemporalLocale, formatTemporalValue, uiIntlLocale } from '~/utils/format-pattern'
import { inclusiveUpper, parsePgRange, rangeElement, rangeTimestampIso } from '~/utils/pg-range'
import type { DisplayFormatDefaults } from '~/composables/useDisplayFormatDefaults'
import { effectiveText, formulaReturnTypeFor, type FieldConfig } from '~/utils/field-config'
import { orderValueBindings } from '~/utils/formula-dependency-graph'
import { evaluateFormula, formulaDependencies } from '~/utils/formula-engine'
import { applyRelationFieldValues, collectRelationFieldRefs } from '~/utils/relation-field-refs'
import { temporalColumnKinds } from '~/utils/formula-column-kinds'
import { sortableHeader } from '~/utils/sortable-header'
import { backgroundTint, optionBadge, setCellStyleClass } from '~/utils/table-column-style'
import { gridColumnWidths, type CellAlign, type CellStyle, type ColumnOptionPresentation, type ConditionStyle, type GridCellConfig, type GridCellTextWrap } from '@totalbase/tb-catalog'
import { conditionStyleAttrs } from '~/utils/column-conditions'
import { FILE_VALUE_WIDGETS } from '@totalbase/tb-catalog'
import { displayFieldAlias, displayText, sortKey, type DisplayConfig } from '~/utils/display-field'

export interface BuildDataViewColumnsOpts {
  sortDirection: (field: string) => 'asc' | 'desc' | false
  onToggleSort: (field: string) => void
  /** A row's "⋮" menu (utils/record-menu.ts) - no actions column without it. */
  rowMenu?: (row: Record<string, unknown>) => DropdownMenuItem[][]
  /** `config.copyable` (field-config.ts)'s own clipboard button - the caller does the actual `navigator.clipboard` write + any toast, this just hands back the exact text a cell is showing. */
  onCopy?: (text: string) => void
  /** The viewer's zone a `timestamptz` reads in - see useDisplayFormatDefaults.ts. Omitted (e.g. in a test): the browser's. */
  displayFormatDefaults?: DisplayFormatDefaults
  /** A palette color's shade in the viewer's mode - a column's text color (its cell style). */
  shade?: (color: string) => string | undefined
  /** The condition a cell meets, if any (DataViews.md §15.7) - its look, over the column's. */
  cellLook?: (row: Record<string, unknown>, column: string) => ConditionStyle | undefined
  /** A column header's menu (DataViews.md §5.2) - sort, hide, move, its text; without it, the header only sorts. */
  headerMenu?: (field: DataViewField) => DropdownMenuItem[][]
  /** The viewer's own choice of how a column's text fits and aligns (their columnPrefs), over the column's. */
  cellPrefFor?: (field: DataViewField) => { textWrap?: GridCellTextWrap, align?: CellAlign }
  /** Its header's right edge drags its width (a mouse, not a finger): pointer down there, with the column's key. Double click: back to the DataView's. */
  onResizeStart?: (key: string, event: PointerEvent) => void
  onResizeReset?: (key: string) => void
  /** Its header drags the column to another place (a mouse, not a finger): pointer down on it, with the column's key. */
  onReorderStart?: (key: string, event: PointerEvent) => void
  /** Every column title so aligned (`view_config.header_align`, DataViews.md §5.2) - unset: each as its column. */
  headerAlign?: CellAlign | null
}

/**
 * A column's width as the viewer dragged it (their columnPrefs, DataViews.md §5.9) - a CSS variable the grid sets on
 * the table, read by the column's header and cells over the DataView's widths: a drag moves it without drawing a cell.
 */
export function columnWidthVar(key: string): string {
  return `--tb-w-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

/** The grid's minimum for a column with none of its own - `GRID_COLUMN_EMPTY_MIN_WIDTH` while it has no rows, else none. */
export const EMPTY_MIN_WIDTH_VAR = '--tb-w-empty-min'

/** The column's width bounds as CSS - the viewer's width (its variable) when set, else the DataView's. */
function widthStyle(cell: GridCellConfig, key: string): Record<string, string> {
  const { width, minWidth, maxWidth } = gridColumnWidths(cell)
  const own = columnWidthVar(key)
  return {
    maxWidth: `var(${own}, ${maxWidth}px)`,
    width: `var(${own}, ${width !== undefined ? `${width}px` : 'auto'})`,
    minWidth: `var(${own}, ${minWidth !== undefined ? `${minWidth}px` : `var(${EMPTY_MIN_WIDTH_VAR}, 0px)`})`
  }
}

/**
 * A column's alignment when nothing says one (DataViews.md §4.3) - its type's, as spreadsheets do: a number, a date or
 * a time right (figures compared by their end), a yes/no centered, anything else left - a foreign key too, which shows
 * its row's text whatever its key is. Read live from the type, never stored; the column's presentation and the
 * viewer's own choice win over it.
 */
export function defaultColumnAlign(field: DataViewField): CellAlign {
  if (field.widget === 'USwitch' || field.widget === 'UCheckbox') return 'center'
  if (field.widget === 'USelectMenu' || (field.config as { display_field?: string }).display_field) return 'left'
  return (field.config as { displayFormatKind?: string }).displayFormatKind ? 'right' : 'left'
}

/** A tooltip's text is the value, not a document - a long one is cut. */
const TITLE_MAX = 2000

/**
 * A cell's box (DataViews.md §4.3): the column's width bounds, its text on one line cut with "…" or on several,
 * the whole value on hover. The td itself can't be bounded - a table cell ignores max-width - so its content is.
 */
function cellBox(content: unknown, title: string, cell: GridCellConfig, wrap: GridCellTextWrap, key: string) {
  const lines = wrap === 'wrap' ? cell.maxLines : undefined
  return h('div', {
    class: wrap === 'wrap' ? 'whitespace-normal break-words' : 'truncate',
    style: {
      ...widthStyle(cell, key),
      ...(lines && { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: String(lines), overflow: 'hidden' })
    },
    title: title ? title.slice(0, TITLE_MAX) : undefined
  }, [content as VNodeChild])
}

/** A json/jsonb document in a cell: what it is and how big, never the document - the record form shows it. */
function jsonSummary(raw: unknown): string | null {
  if (Array.isArray(raw)) return useNuxtApp().$i18n.t('dataviews.grid.jsonItems', { n: raw.length }, raw.length)
  if (raw && typeof raw === 'object') {
    const n = Object.keys(raw).length
    return useNuxtApp().$i18n.t('dataviews.grid.jsonKeys', { n }, n)
  }
  return null
}

/**
 * A grid column's header (DataViews.md §5.2): its title opens its menu; an arrow only on the sorted column, so a
 * header is never wider than its title needs. Bounded like its cells, its title cut with "…".
 */
function columnHeader(label: string, direction: 'asc' | 'desc' | false, items: DropdownMenuItem[][], align: 'left' | 'center' | 'right', cell: GridCellConfig, key: string, opts: BuildDataViewColumnsOpts) {
  const icon = direction === 'asc' ? 'i-lucide-arrow-up-narrow-wide' : direction === 'desc' ? 'i-lucide-arrow-down-wide-narrow' : undefined
  const menu = h(UDropdownMenu, { items, content: { align: align === 'right' ? 'end' : 'start' } }, {
    default: () => h(UButton, {
      'color': 'neutral',
      'variant': 'ghost',
      'size': 'xs',
      label,
      'title': label,
      'aria-label': useNuxtApp().$i18n.t('dataviews.grid.columnMenu', { name: label }),
      ...(icon && (align === 'right' ? { leadingIcon: icon } : { trailingIcon: icon })),
      'ui': { base: 'font-semibold text-default hover:text-highlighted max-w-full' },
      'class': align === 'right' ? '-mx-2 ml-auto flex' : align === 'center' ? 'mx-auto flex' : '-mx-2'
    })
  })
  // Its right edge: a hairline in the border color between headers - primary on hover - over a wider strip that
  // drags its width (the th is `relative`).
  const edge = opts.onResizeStart
    ? h('span', {
        'class': 'group/edge absolute inset-y-0 -right-1 z-10 flex w-2 cursor-col-resize justify-center',
        'aria-hidden': 'true',
        'data-col-resize': key,
        'onPointerdown': (event: PointerEvent) => {
          event.stopPropagation()
          opts.onResizeStart!(key, event)
        },
        'onDblclick': (event: MouseEvent) => {
          event.stopPropagation()
          opts.onResizeReset?.(key)
        },
        'onClick': (event: MouseEvent) => event.stopPropagation()
      }, [h('span', { class: 'my-2.5 w-px bg-(--ui-border-accented) transition-colors group-hover/edge:bg-primary group-data-[resizing]/edge:bg-primary' })])
    : null
  // Pressed, it may become a drag (no text selected meanwhile); its menu still opens on the click a release makes.
  // Its width's edge, a finger and other buttons keep their own way.
  const onPointerdownCapture = opts.onReorderStart
    ? (event: PointerEvent) => {
        if (event.button !== 0 || event.pointerType === 'touch' || (event.target as Element | null)?.closest('[data-col-resize]')) return
        event.stopPropagation()
        event.preventDefault()
        opts.onReorderStart!(key, event)
      }
    : undefined
  return h('div', { 'class': 'flex min-w-0', 'style': widthStyle(cell, key), 'data-col-box': key, onPointerdownCapture }, [menu, edge])
}

/**
 * `value` bindings (field-config.ts's `BindableKey` doc comment) in the
 * GRID - unlike the record form (record-engine.ts's own
 * `recomputeValueBindings`), there's no live widget here to recompute
 * reactively; every row is already a plain fetched object with every
 * OTHER column's own raw value already on it, so a computed column's
 * cell just evaluates its formula against that same row instead of
 * reading the (possibly stale, possibly never-written) raw value the
 * query actually returned for it.
 *
 * Computed once per row, not once per CELL - `buildDataViewColumns`
 * calls `renderCell` independently for every visible column of every
 * row, so without this a row with 2 computed columns would redo the
 * WHOLE dependency chain twice. Cached on the row object's own
 * identity (`WeakMap`) - stable for as long as the fetched page's data
 * doesn't change, which is exactly the lifetime this needs.
 */
export function computedValueResolver(fields: DataViewField[], displayFormatDefaults?: DisplayFormatDefaults) {
  const bindings: Record<string, string> = {}
  const columnKinds = temporalColumnKinds(fields)
  const fieldsByColumn = new Map<string, DataViewField>()
  for (const field of fields) {
    if (field.kind !== 'COLUMN' || !field.columnName) continue
    fieldsByColumn.set(field.columnName, field)
    const config = field.config as FieldConfig
    if (config.bindings?.value) bindings[field.columnName] = config.bindings.value
  }
  const { order, cycle } = orderValueBindings(bindings, formulaDependencies)
  // Every {{fk.related}} a `value` binding formula references (formula-
  // engine.ts's own `TEMPLATE_TOKEN` doc comment) - computed once per
  // resolver instance (fields don't change per row), applied per row
  // below via `applyRelationFieldValues` so `evaluateFormula` sees it
  // under its own mangled lookup key. Requesting the actual JOIN this
  // depends on is DataViewGrid.vue's own `fieldsParam`'s job, not this
  // function's - this just reads back whatever was already fetched.
  const relationRefs = collectRelationFieldRefs(fields)
  const cache = new WeakMap<Record<string, unknown>, Record<string, unknown>>()

  function computedRow(row: Record<string, unknown>): Record<string, unknown> {
    const cached = cache.get(row)
    if (cached) return cached
    const values = applyRelationFieldValues({ ...row }, relationRefs, row)
    if (!cycle) {
      for (const columnName of order) {
        const field = fieldsByColumn.get(columnName)
        if (!field) continue
        const result = evaluateFormula(bindings[columnName]!, {
          values,
          columnKinds,
          timezone: displayFormatDefaults?.timezone || undefined,
          returnType: formulaReturnTypeFor(field)
        })
        if (result.ok) values[columnName] = result.value
      }
    }
    cache.set(row, values)
    return values
  }

  return (row: Record<string, unknown>, columnName: string): unknown =>
    order.includes(columnName) ? computedRow(row)[columnName] : row[columnName]
}

/**
 * Converts a DataView's `COLUMN` fields into `TableColumn[]` for the
 * grid - the dynamic-config counterpart of operadores-portal-v3's
 * `buildTableColumns()` (studied before writing this): same shape
 * (sortable header, an actions column appended last), but the input is
 * `dataviews_fields` rows fetched from the API instead of a compile-time
 * `ColDef[]`.
 *
 * Cell rendering stayed intentionally simple (no date-vs-text
 * formatting) for a while: a column's real Postgres type isn't carried
 * on `dataviews_fields` (only used once, at creation, to pick a default
 * `widget`), and `widget: 'UInput'` covers both text AND date/
 * timestamp columns, so it can't tell them apart at render time on its
 * own. `config.displayFormat`/`displayFormatKind` (utils/format-
 * pattern.ts) is that promised future `config` hint - persisted once,
 * at configure time, when the real type IS known - so this stays a
 * pure render-time read, no catalog lookup needed here either. Every
 * OTHER column (no format configured) still gets the raw, honest
 * value - never a bug to route around silently.
 */
export function buildDataViewColumns(
  fields: DataViewField[],
  opts: BuildDataViewColumnsOpts
): TableColumn<Record<string, unknown>>[] {
  const resolveCellValue = computedValueResolver(fields, opts.displayFormatDefaults)
  const dataCols: TableColumn<Record<string, unknown>>[] = fields
    .filter(f => (f.kind === 'COLUMN' || f.kind === 'RELATED') && f.visible && f.columnName)
    .map((field) => {
      const key = field.columnName!
      // Its header, where room is short: its short label first (DataViews.md §15).
      const label = (field.config as { shortLabel?: string } | undefined)?.shortLabel ?? field.label ?? key
      const sortBy = sortKey(field)
      // Its cells' look (DataViews.md §15) - only what it sets; the grid's own defaults otherwise.
      // Aligned by the viewer, else by its presentation, else by its type (defaultColumnAlign).
      const own = opts.cellPrefFor?.(field) ?? {}
      const style = { ...(field.config as CellStyle), align: own.align ?? (field.config as CellStyle).align ?? defaultColumnAlign(field) }
      // Figures of one width - a number's, a date's, a time's - so they line up row under row.
      const figures = !!(field.config as { displayFormatKind?: string }).displayFormatKind && defaultColumnAlign(field) === 'right'
      const cell = field.config as GridCellConfig
      const wrap = own.textWrap ?? cell.textWrap ?? 'truncate'
      const styleClass = [setCellStyleClass(style), cell.verticalAlign ? `align-${cell.verticalAlign}` : '', figures ? 'tabular-nums' : ''].filter(Boolean).join(' ')
      const color = style.color ? opts.shade?.(style.color) : undefined
      const background = style.background ? backgroundTint(opts.shade?.(style.background)) : undefined
      return {
        // A related column's key is its dotted path, a flat key in the row - not a nested accessor path.
        ...(field.kind === 'RELATED' ? { id: key, accessorFn: (row: Record<string, unknown>) => row[key] } : { accessorKey: key }),
        header: () => opts.headerMenu
          ? columnHeader(label, opts.sortDirection(sortBy), opts.headerMenu(field), opts.headerAlign ?? style.align, cell, key, opts)
          : sortableHeader(label, opts.sortDirection(sortBy), () => opts.onToggleSort(sortBy), opts.headerAlign ?? style.align),
        ...(styleClass || color || background || opts.onResizeStart
          ? { meta: { class: { td: styleClass, ...(opts.onResizeStart && { th: 'relative' }) }, ...(color || background ? { style: { td: { ...(color ? { color } : {}), ...(background ? { backgroundColor: background } : {}) } } } : {}) } }
          : {}),
        cell: ({ row }) => {
          const raw = resolveCellValue(row.original, key)
          const { content, title } = renderCell(field, raw, row.original, wrap, opts.displayFormatDefaults, opts.onCopy)
          const look = opts.cellLook?.(row.original, key)
          return cellBox(look ? conditionedCell(content, look, opts.shade) : content, title, cell, wrap, key)
        }
      }
    })

  if (!opts.rowMenu) return dataCols

  // The row's "⋮" - the record's own menu (utils/record-menu.ts); clicking the row itself opens it. It takes the room
  // the columns leave (`w-full`): each of them as wide as its title and content - or its width - the rest at the end.
  const actionsCol: TableColumn<Record<string, unknown>> = {
    id: 'actions',
    meta: { class: { th: 'w-full', td: 'w-full' } },
    header: () => h('span', { class: 'sr-only' }, useNuxtApp().$i18n.t('common.actions')),
    cell: ({ row }) => {
      const items = opts.rowMenu!(row.original)
      if (!items.length) return null
      return h('div', { class: 'flex justify-end', onClick: (e: MouseEvent) => e.stopPropagation() }, [
        h(UDropdownMenu, { items, content: { align: 'end' } }, {
          default: () => h(UButton, {
            'icon': 'i-lucide-ellipsis-vertical',
            'color': 'neutral',
            'variant': 'ghost',
            'size': 'xs',
            'aria-label': useNuxtApp().$i18n.t('database.buildDataviewColumns.recordActions')
          })
        })
      ])
    }
  }

  return [...dataCols, actionsCol]
}

/**
 * A cell a condition holds for (DataViews.md §15.7): its content in the condition's look - an icon
 * before it, as a badge, dimmed.
 */
function conditionedCell(content: unknown, look: ConditionStyle, shade?: (color: string) => string | undefined): VNode {
  const attrs = conditionStyleAttrs(look, color => shade?.(color))
  const badgeTint = look.badge && look.color && !look.background ? backgroundTint(shade?.(look.color)) : undefined
  return h('span', {
    class: [look.badge ? 'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium' : 'inline-flex items-center gap-1', attrs.class],
    style: { ...attrs.style, ...(badgeTint ? { backgroundColor: badgeTint } : {}) }
  }, [look.icon ? h(UIcon, { name: look.icon, class: 'size-3.5 shrink-0' }) : null, content as VNodeChild])
}

/**
 * A key - the row's own (an identity) or another's (a foreign key) - reads
 * as its plain digits, never grouped. A read-only integer is an identity; a
 * read-only amount (a generated `cantidad * precio`) is a number like any
 * other, grouped and with its decimals.
 */
function isKeyColumn(field: DataViewField): boolean {
  if (field.widget === 'USelectMenu') return true
  const readOnly = (field.config as { disabled?: boolean }).disabled === true
  return readOnly && (field.dataType === undefined || /^(smallint|integer|bigint)\b/.test(field.dataType))
}

/**
 * The cell's value as PLAIN TEXT, no icons/links/tooltips - the single
 * source of truth both `renderCell` (wraps it in whatever visual
 * treatment the field's widget/config call for) and CSV export
 * (DataViewGrid.vue's `exportCsv`) read from, so a value never reads
 * differently in the two - the exact bug that shipped before this
 * existed (export used the raw, unformatted value while the grid
 * showed `displayFormat`/`emptyText`/`booleanLabels`).
 */
export function formatCellPlainText(field: DataViewField, raw: unknown, row: Record<string, unknown>, displayFormatDefaults?: DisplayFormatDefaults): string {
  if (raw === null || raw === undefined) {
    const config = field.config as FieldConfig
    return effectiveText(config, 'emptyText', config.emptyText ?? '', row)
  }

  // Excel/JasperReports-style DISPLAY pattern (utils/format-pattern.ts,
  // FieldConfig's own doc comment) - the SAME `config.displayFormat`
  // the record form applies (when its widget supports live-applying
  // one), read here for the grid's own read-only rendering. Gated by
  // `displayFormatKind` alone, deliberately NOT by `field.widget` - the
  // whole point of this being column-type-driven rather than widget-
  // driven: a numeric/temporal column
  // keeps its formatted grid cell regardless of which widget the
  // builder picked for the FORM (USlider, UInputDate, whatever).
  //
  // `displayFormatKind`/`displayFormatTzAware` are auto-persisted for
  // EVERY numeric/date/time/timestamp COLUMN field (creation/sync time,
  // display-format.ts), whether or not the field has its own
  // `displayFormat` - so a field with none still resolves a kind here,
  // and reads in the regional format instead of showing raw.
  const config = field.config as { displayFormat?: string, displayFormatKind?: 'number' | 'date' | 'time' | 'datetime', displayFormatTzAware?: boolean }
  if (config.displayFormatKind) {
    const pattern = config.displayFormat
    if (pattern) {
      if (config.displayFormatKind === 'number') {
        const num = typeof raw === 'number' ? raw : Number(raw)
        if (!Number.isNaN(num)) return formatNumberValue(num, pattern)
      } else if (typeof raw === 'string') {
        const timezone = config.displayFormatTzAware ? displayFormatDefaults?.timezone : undefined
        return formatTemporalValue(raw, pattern, config.displayFormatKind, timezone || undefined)
      }
    } else if (config.displayFormatKind !== 'number' && typeof raw === 'string') {
      // No Format: the regional format's own, not the raw ISO text.
      const timezone = config.displayFormatTzAware ? displayFormatDefaults?.timezone : undefined
      return formatTemporalLocale(raw, config.displayFormatKind, timezone || undefined)
    } else if (config.displayFormatKind === 'number' && (field.config as CellStyle).mono && /^-?\d+$/.test(String(raw))) {
      // A monospaced whole number is a code - an invoice's 3000, never "3.000" (T63).
      return String(raw)
    } else if (config.displayFormatKind === 'number' && !isKeyColumn(field)) {
      // No Format: the regional format's grouping, with the decimals PostgreSQL sent ("2480.00" keeps its two).
      const formatted = formatNumberLocale(raw)
      if (formatted !== null) return formatted
    }
  }

  if (field.widget === 'USwitch' || field.widget === 'UCheckbox') {
    // `config.booleanLabels` (field-config.ts) - custom text instead of
    // the plain icon `renderCell` shows visually, per side (either side
    // may be set alone; the other still falls back to a plain
    // "true"/"false" - there's no icon to fall back to in plain text).
    const booleanLabels = (field.config as { booleanLabels?: { true?: string, false?: string } }).booleanLabels
    return raw ? (booleanLabels?.true ?? 'true') : (booleanLabels?.false ?? 'false')
  }

  if ((field.widget === 'UInputTags' || field.widget === 'UCheckboxGroup') && Array.isArray(raw)) {
    return raw.join(', ')
  }

  if (field.widget === 'USelectMenu') {
    // FK column - DataViewGrid.vue requests the related row's own
    // `display_field` alongside every plain column whenever any field
    // has one configured (see its own doc comment), landing here under
    // `displayFieldAlias`'s dotted key - not nested under `raw` itself
    // (the query-engine returns a flat row, never a nested object, see
    // packages/query-engine/src/compiler.ts's own field-path aliasing).
    const shown = displayText(field.config as DisplayConfig, column => row[displayFieldAlias(field.columnName!, column)])
    return shown ?? String(raw)
  }

  // A CHECK value's label (its column's `options`, DataViews.md §15).
  const optionLabel = (field.config as { options?: Record<string, ColumnOptionPresentation> }).options?.[String(raw)]?.label
  if (optionLabel) return optionLabel

  // A point (T75): its coordinates, latitude first, rounded to 4 decimals (about 10 m) - never its JSON.
  const point = pointValue(field, raw)
  if (point) return pointText(point)
  // A range (T2): "from – to" as its inputs read it, an open side "…" - never its PostgreSQL text.
  const range = rangeText(field, raw, displayFormatDefaults)
  if (range !== null) return range

  const plain = typeof raw === 'object' ? JSON.stringify(raw) : String(raw)

  // `config.prefix`/`config.suffix` (field-config.ts) - offered by the
  // inspector for UInput/UInputNumber since before `displayFormat`
  // existed, but never actually READ anywhere until now (a real dead-
  // config bug, found writing this - `displayFormat`'s own pattern
  // already carries its own prefix/suffix, so this only ever applies
  // when a column has NEITHER a pattern nor a global default one,
  // guaranteed by the `displayFormatKind` branch above always
  // returning first when either produces something).
  if (field.widget === 'UInput' || field.widget === 'UInputNumber') {
    const config = field.config as FieldConfig
    const prefix = effectiveText(config, 'prefix', config.prefix ?? '', row)
    const suffix = effectiveText(config, 'suffix', config.suffix ?? '', row)
    if (prefix || suffix) return `${prefix}${plain}${suffix}`
  }
  return plain
}

/** A `point` column's value (`{ lng, lat }`, as the Data API reads it) - null for anything else. */
function pointValue(field: DataViewField, raw: unknown): { lng: number, lat: number } | null {
  if (field.dataType !== 'point' || !raw || typeof raw !== 'object') return null
  const { lng, lat } = raw as { lng?: unknown, lat?: unknown }
  return typeof lng === 'number' && typeof lat === 'number' ? { lng, lat } : null
}
function pointText(point: { lng: number, lat: number }): string {
  const format = new Intl.NumberFormat(uiIntlLocale(), { minimumFractionDigits: 4, maximumFractionDigits: 4 })
  return `${format.format(point.lat)}, ${format.format(point.lng)}`
}
function rangeText(field: DataViewField, raw: unknown, defaults?: DisplayFormatDefaults): string | null {
  if (!/(?<!multi)range$/.test(field.dataType ?? '')) return null
  const range = parsePgRange(raw)
  if (!range) return null
  if (range.empty) return '∅'
  const element = rangeElement(field.dataType)
  const read = (value: string | null): string => {
    if (value === null) return '…'
    if (element.kind === 'date') return formatTemporalLocale(value, 'date')
    if (element.kind === 'timestamp') return formatTemporalLocale(rangeTimestampIso(value), 'datetime', element.columnType.includes('with time zone') ? defaults?.timezone || undefined : undefined)
    return formatNumberLocale(value) ?? value
  }
  const upper = range.upper !== null && element.discrete && !range.upperInclusive && element.kind !== 'timestamp'
    ? inclusiveUpper(range.upper, element.kind === 'date' ? 'date' : 'number')
    : range.upper
  return `${read(range.lower)} – ${read(upper)}`
}

/** Where a point opens: a street map centered on it, in a new tab (a phone hands it to its maps app). */
export function pointMapHref(point: { lng: number, lat: number }): string {
  return `https://www.openstreetmap.org/?mlat=${point.lat}&mlon=${point.lng}#map=17/${point.lat}/${point.lng}`
}

/** `config.linkType` (field-config.ts) - turns plain text into a real `mailto:`/`tel:`/`http(s)` link. */
const hrefForLink = valueLinkHref

/** An `<a>` that never also triggers whatever the row itself does. */
function anchor(href: string, text: string) {
  const external = /^https?:\/\//i.test(href)
  return h('a', {
    href,
    target: external ? '_blank' : undefined,
    rel: external ? 'noopener noreferrer' : undefined,
    class: 'text-primary underline underline-offset-2',
    onClick: (e: MouseEvent) => e.stopPropagation()
  }, text)
}

/** A cell's content and the text its box shows on hover - the whole value. */
function renderCell(
  field: DataViewField,
  raw: unknown,
  row: Record<string, unknown>,
  wrap: GridCellTextWrap,
  displayFormatDefaults?: DisplayFormatDefaults,
  onCopy?: (text: string) => void
): { content: unknown, title: string } {
  const text = formatCellPlainText(field, raw, row, displayFormatDefaults)
  const config = field.config as { copyable?: boolean, isJsonColumn?: boolean, linkType?: 'url' | 'email' | 'tel', booleanLabels?: { true?: string, false?: string } }
  const json = config.isJsonColumn && raw !== null && typeof raw === 'object' ? jsonSummary(raw) : null

  // A CHECK value with a color or an icon (its column's `options`, DataViews.md §15) - a badge.
  const badge = raw === null || raw === undefined ? null : optionBadge(text, (field.config as { options?: Record<string, ColumnOptionPresentation> }).options?.[String(raw)], name => h(UIcon, { name, class: 'size-3.5' }))

  let content: unknown
  if (raw === null || raw === undefined) {
    content = h('span', { class: 'text-muted' }, text || '—')
  } else if (pointValue(field, raw)) {
    // A point (T75): a map icon and its rounded coordinates - a tap opens it on a map.
    const point = pointValue(field, raw)!
    content = h('a', {
      'href': pointMapHref(point),
      'target': '_blank',
      'rel': 'noopener noreferrer',
      'class': 'inline-flex items-center gap-1 text-primary tabular-nums',
      'aria-label': useNuxtApp().$i18n.t('dataviews.grid.openPointOnMap', { point: text }),
      'onClick': (e: MouseEvent) => e.stopPropagation()
    }, [h(UIcon, { name: 'i-lucide-map-pin', class: 'size-3.5 shrink-0' }), text])
  } else if (field.widget && FILE_VALUE_WIDGETS.includes(field.widget) && typeof raw === 'string') {
    // A file column (a foreign key to files): its thumbnail, or its name to download - never the bare id.
    content = h(FileCell, { fileId: raw })
  } else if (field.widget === 'USwitch' || field.widget === 'UCheckbox') {
    const label = raw ? config.booleanLabels?.true : config.booleanLabels?.false
    content = label
      ? h('span', { class: raw ? 'text-success' : 'text-muted' }, label)
      : h(UIcon, { name: raw ? 'i-lucide-check' : 'i-lucide-x', class: raw ? 'size-4 text-success' : 'size-4 text-muted' })
  } else if (field.widget === 'USelectMenu' && !(field.config as { display_field?: string }).display_field) {
    content = h('span', { class: 'font-mono text-xs text-muted' }, text)
  } else if (json) {
    // A document reads as its size (DataViews.md §4.3) - the record form shows it whole.
    content = h('span', { class: 'text-muted' }, json)
  } else if (badge) {
    content = badge
  } else if (config.linkType) {
    // Text/UInput columns only in practice (applicableConfigKeys) - a
    // real clickable link instead of plain text.
    content = anchor(hrefForLink(config.linkType, text), text)
  } else {
    content = text
  }

  // `config.copyable` (field-config.ts) - a small clipboard button next
  // to ANY field's cell, offered for every widget (unlike `linkType`/
  // `textWrap` which only make sense for text-ish ones) - see the
  // chat's own framing ("switch que el usuario pueda habilitar para
  // cualquier columna"). Skipped entirely for a null/empty cell -
  // nothing useful to copy.
  if (config.copyable && raw !== null && raw !== undefined && onCopy) {
    content = h('div', { class: 'flex items-center gap-1 min-w-0' }, [
      h('span', { class: wrap === 'wrap' ? 'min-w-0 whitespace-normal break-words' : 'truncate min-w-0' }, [content as never]),
      h(UButton, {
        'icon': 'i-lucide-copy',
        'color': 'neutral',
        'variant': 'ghost',
        'size': 'xs',
        'class': 'shrink-0',
        'aria-label': useNuxtApp().$i18n.t('common.copy'),
        'onClick': (e: MouseEvent) => {
          e.stopPropagation()
          onCopy(text)
        }
      })
    ])
  }

  return { content, title: json ? JSON.stringify(raw, null, 2) : text }
}
