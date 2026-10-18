import { h, type VNode, type VNodeChild } from 'vue'
import { FileCell, UButton, UDropdownMenu, UIcon, UTooltip } from '#components'
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
import type { CellStyle, ColumnOptionPresentation, ConditionStyle } from '@totalbase/tb-catalog'
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
  /** Settings > General fallback patterns/timezone - see useDisplayFormatDefaults.ts. Omitted entirely (e.g. in a test) means every field falls back to the raw, unformatted value, same as before this existed. */
  displayFormatDefaults?: DisplayFormatDefaults
  /** A palette color's shade in the viewer's mode - a column's text color (its cell style). */
  shade?: (color: string) => string | undefined
  /** The condition a cell meets, if any (Specification_DataViews.md §15.7) - its look, over the column's. */
  cellLook?: (row: Record<string, unknown>, column: string) => ConditionStyle | undefined
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
      // Its header, where room is short: its short label first (Specification_DataViews.md §15).
      const label = (field.config as { shortLabel?: string } | undefined)?.shortLabel ?? field.label ?? key
      const sortBy = sortKey(field)
      // Its cells' look (Specification_DataViews.md §15) - only what it sets; the grid's own defaults otherwise.
      // A yes/no column (its check) sits centered unless its presentation aligns it.
      const isBoolean = field.widget === 'USwitch' || field.widget === 'UCheckbox'
      const style = { ...(field.config as CellStyle), ...(isBoolean && !(field.config as CellStyle).align ? { align: 'center' as const } : {}) }
      const styleClass = setCellStyleClass(style)
      const color = style.color ? opts.shade?.(style.color) : undefined
      const background = style.background ? backgroundTint(opts.shade?.(style.background)) : undefined
      return {
        // A related column's key is its dotted path, a flat key in the row - not a nested accessor path.
        ...(field.kind === 'RELATED' ? { id: key, accessorFn: (row: Record<string, unknown>) => row[key] } : { accessorKey: key }),
        header: () => sortableHeader(label, opts.sortDirection(sortBy), () => opts.onToggleSort(sortBy), style.align ?? 'left'),
        ...(styleClass || color || background ? { meta: { class: { td: styleClass }, ...(color || background ? { style: { td: { ...(color ? { color } : {}), ...(background ? { backgroundColor: background } : {}) } } } : {}) } } : {}),
        cell: ({ row }) => {
          const raw = resolveCellValue(row.original, key)
          const content = renderCell(field, raw, row.original, opts.displayFormatDefaults, opts.onCopy)
          const look = opts.cellLook?.(row.original, key)
          return look ? conditionedCell(content, look, opts.shade) : content
        }
      }
    })

  if (!opts.rowMenu) return dataCols

  // The row's "⋮" - the record's own menu (utils/record-menu.ts); clicking the row itself opens it.
  const actionsCol: TableColumn<Record<string, unknown>> = {
    id: 'actions',
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
 * A cell a condition holds for (Specification_DataViews.md §15.7): its content in the condition's look - an icon
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

function defaultPatternFor(kind: 'number' | 'date' | 'time' | 'datetime', defaults?: DisplayFormatDefaults): string {
  if (!defaults || kind === 'number') return '' // no global default for numbers - only timezone/date/time/datetime are settings
  if (kind === 'date') return defaults.dateFormat
  if (kind === 'time') return defaults.timeFormat
  return defaults.datetimeFormat
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
  // and falls back to Settings > General's own default pattern for
  // that kind (useDisplayFormatDefaults.ts) instead of showing raw.
  const config = field.config as { displayFormat?: string, displayFormatKind?: 'number' | 'date' | 'time' | 'datetime', displayFormatTzAware?: boolean }
  if (config.displayFormatKind) {
    const pattern = config.displayFormat || defaultPatternFor(config.displayFormatKind, displayFormatDefaults)
    if (pattern) {
      if (config.displayFormatKind === 'number') {
        const num = typeof raw === 'number' ? raw : Number(raw)
        if (!Number.isNaN(num)) return formatNumberValue(num, pattern)
      } else if (typeof raw === 'string') {
        const timezone = config.displayFormatTzAware ? displayFormatDefaults?.timezone : undefined
        return formatTemporalValue(raw, pattern, config.displayFormatKind, timezone || undefined)
      }
    } else if (config.displayFormatKind !== 'number' && typeof raw === 'string') {
      // No pattern anywhere: the locale's own format, not the raw ISO text.
      const timezone = config.displayFormatTzAware ? displayFormatDefaults?.timezone : undefined
      return formatTemporalLocale(raw, config.displayFormatKind, timezone || undefined)
    } else if (config.displayFormatKind === 'number' && (field.config as CellStyle).mono && /^-?\d+$/.test(String(raw))) {
      // A monospaced whole number is a code - an invoice's 3000, never "3.000" (T63).
      return String(raw)
    } else if (config.displayFormatKind === 'number' && !isKeyColumn(field)) {
      // No pattern anywhere: the locale's grouping, with the decimals PostgreSQL sent ("2480.00" keeps its two).
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

  // A CHECK value's label (its column's `options`, Specification_DataViews.md §15).
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

function renderCell(
  field: DataViewField,
  raw: unknown,
  row: Record<string, unknown>,
  displayFormatDefaults?: DisplayFormatDefaults,
  onCopy?: (text: string) => void
) {
  const text = formatCellPlainText(field, raw, row, displayFormatDefaults)
  const config = field.config as { truncate?: boolean, copyable?: boolean, linkType?: 'url' | 'email' | 'tel', booleanLabels?: { true?: string, false?: string } }

  // A CHECK value with a color or an icon (its column's `options`, Specification_DataViews.md §15) - a badge.
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
  } else if (badge) {
    content = badge
  } else if (config.linkType) {
    // Text/UInput columns only in practice (applicableConfigKeys) - a
    // real clickable link instead of plain text.
    content = anchor(hrefForLink(config.linkType, text), text)
  } else if (config.truncate) {
    // `config.truncate` (field-config.ts) - one line + "…" instead of
    // blowing out the row height/column width for a long text/jsonb
    // value, full value still available on hover.
    content = h(UTooltip, { text, class: 'block max-w-full' }, {
      default: () => h('span', { class: 'block truncate' }, text)
    })
  } else {
    content = text
  }

  // `config.copyable` (field-config.ts) - a small clipboard button next
  // to ANY field's cell, offered for every widget (unlike `linkType`/
  // `truncate` which only make sense for text-ish ones) - see the
  // chat's own framing ("switch que el usuario pueda habilitar para
  // cualquier columna"). Skipped entirely for a null/empty cell -
  // nothing useful to copy.
  if (config.copyable && raw !== null && raw !== undefined && onCopy) {
    content = h('div', { class: 'flex items-center gap-1 min-w-0' }, [
      h('span', { class: 'truncate min-w-0' }, [content as never]),
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

  return content
}
