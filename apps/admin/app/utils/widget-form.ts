import { parsePgRange, rangeElement, rangeTimestampIso } from '~/utils/pg-range'
/**
 * The form widgets' logic (DataViews.md §9 and
 * Data_API.md §2.4): which fields a `UForm` holds, each
 * field's name in the form's data, the required and pattern checks, and
 * errors in the API's shape - `{ errors: [{ field, message }] }`.
 *
 * A form's data is built from its fields, not stored: each `UFormField`
 * contributes its value - the record's column it's bound to, or the Value
 * its input is bound to - under the field's Name, else its column, else the
 * variable's name. So `submit` hands a Call exactly the body the API takes:
 * `{ data }`.
 */
import { authorPattern, holdsBound, type ColumnBound, type ColumnPattern } from '@totalbase/tb-catalog'
import type { DataViewField } from '~/types/dataview'
import { areaWidgets, childWidgets, fieldById } from '~/utils/widget-layout'

interface FieldConfig {
  props?: Record<string, unknown>
  bindings?: Record<string, { kind: string, variable?: string }>
}

/** The `UFormField`s a form holds, at any depth - but not those of a form nested inside it. */
export function formFields(fields: readonly DataViewField[], formId: string): DataViewField[] {
  const out: DataViewField[] = []
  const visit = (parentId: string) => {
    for (const child of childWidgets(fields, parentId)) {
      if (child.widget === 'UForm') continue
      if (child.widget === 'UFormField') out.push(child)
      visit(child.id)
    }
  }
  visit(formId)
  return out
}

/** The input a form field contains - the first widget of its `default` slot. */
export function fieldInput(fields: readonly DataViewField[], fieldId: string): DataViewField | undefined {
  return areaWidgets(fields, fieldId, 'default')[0]
}

/** The Value a form field's input keeps its value in, or null. */
export function fieldVariable(fields: readonly DataViewField[], field: DataViewField): string | null {
  const binding = (fieldInput(fields, field.id)?.config as FieldConfig | undefined)?.bindings?.modelValue
  return binding?.kind === 'variable' && binding.variable ? binding.variable : null
}

/** The record's column a form field is bound to, or null. */
export function fieldColumn(field: DataViewField | undefined): string | null {
  const column = (field?.config as FieldConfig | undefined)?.props?.column
  return field?.widget === 'UFormField' && typeof column === 'string' && column ? column : null
}

/** The junction table a form field links the record through (its resource id, DataViews.md §8.5), or null. */
export function fieldJunction(field: DataViewField | undefined): string | null {
  const junction = (field?.config as FieldConfig | undefined)?.props?.junction
  return field?.widget === 'UFormField' && typeof junction === 'string' && junction ? junction : null
}

/** The record's column an input edits: its form field's, or null. */
export function inputColumn(fields: readonly DataViewField[], input: DataViewField): string | null {
  return fieldColumn(fieldById(fields, input.parent))
}

/** A field's key in its form's data: its Name, else its column, else its input's variable. */
export function fieldName(fields: readonly DataViewField[], field: DataViewField): string | null {
  const name = (field.config as FieldConfig).props?.name
  return typeof name === 'string' && name.trim() ? name.trim() : fieldColumn(field) ?? fieldVariable(fields, field)
}

export interface FieldError {
  field: string
  message: string
}

/** Nothing to submit: null, empty text, an empty list. */
export function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0)
}

/** The words of a form's own checks - English by default; the renderer passes them in the UI's language. */
export interface FormMessages {
  required: string
  invalidFormat: string
  /** A bound's own words when its CHECK has no message: "At least 0", "At most 10 characters". */
  bound: (bound: ColumnBound) => string
  /** A range whose From is past its To (M28). */
  rangeOrder?: string
}

/** "Required" for each required field whose value is empty. */
export function requiredErrors(required: readonly { name: string, required: boolean }[], data: Record<string, unknown>, messages: FormMessages = FORM_MESSAGES): FieldError[] {
  return required.filter(f => f.required && isEmptyValue(data[f.name])).map(f => ({ field: f.name, message: messages.required }))
}

/** A form field's patterns: the author's Pattern (the whole value) and its column's CHECKs (anywhere in it, as PostgreSQL's `~`). */
export interface FieldPatterns {
  name: string
  pattern?: string
  patternMessage?: string
  column: readonly ColumnPattern[]
  /** Its column's CHECK ranges - a number's, a text's length. */
  bounds?: readonly ColumnBound[]
}
/**
 * A text value that doesn't match its field's patterns - one error per
 * field, the first that fails. An empty value is Required's to judge; a
 * value that isn't text (a number, a date, a list) has no pattern to match.
 */
export function patternErrors(fields: readonly FieldPatterns[], data: Record<string, unknown>, messages: FormMessages = FORM_MESSAGES): FieldError[] {
  return fields.flatMap((field) => {
    const value = data[field.name]
    if (typeof value !== 'string' || isEmptyValue(value)) return []
    const own = field.pattern ? authorPattern(field.pattern) : null
    if (own && !own.test(value)) return [{ field: field.name, message: field.patternMessage || messages.invalidFormat }]
    const failed = field.column.find(p => !new RegExp(p.source, p.flags).test(value))
    return failed ? [{ field: field.name, message: failed.message || messages.invalidFormat }] : []
  })
}

/** "At least 0", "At most 10 characters" - a bound's own words when its CHECK has no message. */
function boundMessage(bound: ColumnBound): string {
  const unit = bound.kind === 'length' ? ` character${bound.value === 1 ? '' : 's'}` : ''
  switch (bound.op) {
    case '>=': return `At least ${bound.value}${unit}`
    case '>': return `More than ${bound.value}${unit}`
    case '<=': return `At most ${bound.value}${unit}`
    case '<': return `Less than ${bound.value}${unit}`
  }
}

/** The English words - the default. */
export const FORM_MESSAGES: FormMessages = { required: 'Required', invalidFormat: 'Invalid format', bound: boundMessage }

/**
 * A value out of its column's CHECK ranges (`price >= 0`, `length(code) <=
 * 10`) - one error per field, the first that fails. An empty value is
 * Required's to judge; PostgreSQL still decides the save.
 */
export function boundErrors(fields: readonly FieldPatterns[], data: Record<string, unknown>, messages: FormMessages = FORM_MESSAGES): FieldError[] {
  return fields.flatMap((field) => {
    const value = data[field.name]
    if (isEmptyValue(value)) return []
    const failed = (field.bounds ?? []).find((bound) => {
      if (bound.kind === 'length') return typeof value === 'string' && !holdsBound(bound, [...value].length)
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
      return Number.isFinite(n) && !holdsBound(bound, n)
    })
    return failed ? [{ field: field.name, message: failed.message || messages.bound(failed) }] : []
  })
}

/**
 * A range (T2) whose From is past its To - said in the field (M28), not PostgreSQL's "range lower bound must be less
 * than or equal to range upper bound". Dates and timestamps compare as instants, numbers as numbers.
 */
export function rangeErrors(fields: readonly { name: string, dataType?: string }[], data: Record<string, unknown>, messages: FormMessages = FORM_MESSAGES): FieldError[] {
  return fields.flatMap((field) => {
    if (!/(?<!multi)range$/.test(field.dataType ?? '')) return []
    const range = parsePgRange(data[field.name])
    if (!range || range.empty || range.lower === null || range.upper === null) return []
    const kind = rangeElement(field.dataType).kind
    const read = (value: string) => (kind === 'number' ? Number(value) : Date.parse(kind === 'timestamp' ? rangeTimestampIso(value) : `${value.slice(0, 10)}T00:00:00Z`))
    const [lower, upper] = [read(range.lower), read(range.upper)]
    return Number.isFinite(lower) && Number.isFinite(upper) && lower > upper ? [{ field: field.name, message: messages.rangeOrder ?? 'From is after To' }] : []
  })
}

/**
 * A Validate function's answer as errors: `{ errors: [{ field, message }] }`
 * (the API's envelope), or a bare list of them. Anything else is no error.
 */
export function toFieldErrors(result: unknown): FieldError[] {
  const list = Array.isArray(result) ? result : (result as { errors?: unknown } | null)?.errors
  if (!Array.isArray(list)) return []
  return list.flatMap((e) => {
    const entry = e as { field?: unknown, name?: unknown, message?: unknown }
    const field = typeof entry.field === 'string' ? entry.field : typeof entry.name === 'string' ? entry.name : ''
    return typeof entry.message === 'string' ? [{ field, message: entry.message }] : []
  })
}

/** The decimals a numeric column holds: its scale (`numeric(12,2)` → 2), none for an integer, as many as it has for an unbounded `numeric` or a float. */
export function columnDecimals(dataType: string): number {
  const scale = /^numeric\(\d+,\s*(\d+)\)/.exec(dataType)
  if (scale) return Number(scale[1])
  if (/^(smallint|integer|bigint)/.test(dataType) || /^numeric\(\d+\)/.test(dataType)) return 0
  return 20
}
