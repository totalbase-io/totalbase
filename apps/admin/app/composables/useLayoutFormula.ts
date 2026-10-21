import { parseISO } from 'date-fns'
import { toZonedTime } from 'date-fns-tz'
import type { DataViewField } from '~/types/dataview'
import { FILE_VALUE_WIDGETS } from '@totalbase/tb-catalog'
import { computedValueResolver } from '~/utils/build-dataview-columns'
import { applyRelationFieldValues, collectRelationFieldRefs } from '~/utils/relation-field-refs'
import { evaluateFormula, type FormulaRichSegment } from '~/utils/formula-engine'
import { foreignKeyDisplayFields, foreignKeyTexts } from '~/utils/display-field'

/** A formula that's just one bare `{{column}}` - the only shape that can be a file id (`imageSrc`). */
const BARE_FORMULA_TOKEN = /^\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/
/** A card's or a kanban card's image: a scaled copy, not the original. */
const IMAGE_SLOT_WIDTH = 640

/**
 * Evaluates a DataView layout's formulas (card title, pin color, bar
 * label...) against its rows - shared by the CARDS/MAP/KANBAN/CALENDAR/
 * GANTT views. Each formula runs over one per-row lookup table: the
 * bindings-v2 RAW value per column (`computedValueResolver` - numbers and
 * dates stay typed, the formula engine coerces), plus every
 * `{{fk.related}}` value the layout's formulas reference (the grid's
 * `fieldsParam` requests those joins; this reads them back). Never
 * throws - a broken formula resolves to `''`.
 */
export function useLayoutFormula(fields: () => DataViewField[], formulas: () => (string | null | undefined)[]) {
  const { defaults } = useDisplayFormatDefaults()
  const { fileObjectUrl } = useFileObjectUrl()
  const cellValue = computed(() => computedValueResolver(fields(), defaults.value))
  const relationRefs = computed(() => collectRelationFieldRefs([], formulas()))
  /** Temporal kinds only, so a date column is boxed as a real `Date` for formula arithmetic - see `temporalColumnKinds`. */
  const columnKinds = computed(() => temporalColumnKinds(fields()))

  function rowValues(row: Record<string, unknown>): Record<string, unknown> {
    const values: Record<string, unknown> = {}
    for (const field of fields()) {
      if (field.kind === 'COLUMN' && field.columnName) values[field.columnName] = cellValue.value(row, field.columnName)
    }
    return applyRelationFieldValues(values, relationRefs.value, row)
  }

  /** The foreign keys a formula shows by their row (DataViews.md §15.5). */
  const foreignKeys = computed(() => foreignKeyDisplayFields(fields()))

  function run(source: string, row: Record<string, unknown>) {
    return evaluateFormula(source, {
      values: rowValues(row),
      foreignKeyText: foreignKeyTexts(foreignKeys.value, row),
      columnKinds: columnKinds.value,
      timezone: defaults.value.timezone || undefined,
      returnType: 'string'
    })
  }

  /** One formula against one row, as a string. */
  function evaluate(source: string | null | undefined, row: Record<string, unknown>): string {
    if (!source) return ''
    const result = run(source, row)
    return result.ok && result.value !== null && result.value !== undefined ? String(result.value) : ''
  }

  /** Same, plus `.rich` when the formula used a FORMAT function (BOLD/BADGE/ICON...) - only set when something styled is really there. */
  function evaluateRich(source: string | null | undefined, row: Record<string, unknown>): { text: string, rich?: FormulaRichSegment[] } {
    if (!source) return { text: '' }
    const result = run(source, row)
    if (!result.ok || result.value === null || result.value === undefined) return { text: '' }
    return { text: String(result.value), rich: result.rich }
  }

  /**
   * An image slot's URL. A bare `{{column}}` on a file column (a FK to
   * `files` - UFileUpload or TCamera) holds a file id: a PRIVATE
   * file answers only a request carrying the viewer's token, which an
   * <img src> can't send, so it is fetched with it and shown as a blob: URL
   * (useFileObjectUrl - undefined while it loads, then reactive), at `width` (an avatar asks for its own size,
   * not a card's). Any real
   * formula can't be a file id, so it's treated as an already-resolved URL.
   */
  function imageSrc(source: string | null | undefined, row: Record<string, unknown>, width = IMAGE_SLOT_WIDTH): string | undefined {
    if (!source) return undefined
    const bareColumn = source.trim().match(BARE_FORMULA_TOKEN)?.[1]
    const bareField = bareColumn ? fields().find(f => f.kind === 'COLUMN' && f.columnName === bareColumn) : undefined
    if (bareField?.widget && FILE_VALUE_WIDGETS.includes(bareField.widget)) {
      const raw = cellValue.value(row, bareColumn!)
      return raw ? fileObjectUrl(String(raw), width) : undefined
    }
    return evaluate(source, row) || undefined
  }

  /**
   * A date/timestamp column's value as a `Date` whose LOCAL getters read
   * the wall clock the calendar/timeline should place it at. A real
   * `timestamptz` (`displayFormatTzAware`) is converted to
   * `system.timezone` with `toZonedTime` - otherwise two viewers in
   * different zones would see an event on different days. A naive
   * `date`/`timestamp` has no zone to convert from; `parseISO` reads
   * 'YYYY-MM-DD' as local midnight (`new Date()` would take it as UTC, a
   * day early west of Greenwich).
   */
  function dateValue(field: DataViewField | null | undefined, row: Record<string, unknown>): Date | null {
    if (!field?.columnName) return null
    const raw = cellValue.value(row, field.columnName)
    if (!raw) return null
    const tzAware = (field.config as { displayFormatTzAware?: boolean }).displayFormatTzAware
    const timezone = tzAware ? defaults.value.timezone : ''
    const date = timezone ? toZonedTime(raw as string, timezone) : parseISO(raw as string)
    return Number.isNaN(date.getTime()) ? null : date
  }

  return { cellValue, evaluate, evaluateRich, imageSrc, dateValue }
}
