<script setup lang="ts">
/**
 * Draws one placed widget (a `WIDGET` field) - its widget catalog entry's
 * component with the props, bindings and emits its config holds - and,
 * recursively, the widgets its slots hold, each slot a 12-column area
 * (utils/widget-layout.ts). An empty slot keeps the component's own
 * content (a Button's label).
 *
 * Everything page-wide comes from the runtime `provide`d by the page
 * (useWidgetRuntime.ts): variables, Code, controls. In `design` mode - a
 * canvas card - only literal props apply: no data, no events.
 */
import { COLUMN_INPUTS, COMMON_STYLE_PROPS, commonWidgetProps, isColumnInputKey, isNumericDataType, itemSlot, widgetDefinition, widgetState, type TableAction, type TableColumnSettings, type TableComputedColumn, type WidgetName, type WidgetPropBinding } from '@totalbase/tb-catalog'
import type { TableColumn } from '@nuxt/ui'
import { UIcon } from '#components'
import { formBusInjectionKey, formFieldInjectionKey } from '#ui/composables/useFormField'
import { humanizeColumnName } from '~/utils/humanize-column-name'
import type { DataViewField, EditSize } from '~/types/dataview'
import { isRoleColor, roleColorShade } from '~/types/permission'
import { FULLSCREEN_WHEN_COMPACT, OVERLAY_CONTENT_WIDTH } from '~/utils/overlay-size'
import { WIDGET_RUNTIME_KEY, type WidgetControl } from '~/composables/useWidgetRuntime'
import { areaWidgets, fieldById, sizableHeight, slotHasWidgets, widgetCellStyle } from '~/utils/widget-layout'
import { OVERLAY_WIDGETS, WIDGET_COMPONENTS } from '~/utils/widget-components'
import { evaluateWidgetFormula, formulaReturnType } from '~/utils/widget-formula'
import { resolveFrameUrlTemplate } from '~/utils/frame-url'
import { resolveWidgetItems } from '~/utils/widget-items'
import { isReservedAttrKey } from '~/utils/field-config'
import type { ResourceHandle, ValueHandle } from '~/utils/variables-engine'
import { boundErrors, rangeErrors, type FormMessages, columnDecimals, fieldColumn, fieldJunction, fieldName, fieldVariable, formFields, inputColumn, patternErrors, requiredErrors, toFieldErrors } from '~/utils/widget-form'
import { fromDateTimeLocal, toDateTimeLocal } from '~/utils/datetime-local'
import { commitDecimalInput, numberFieldAccepts, numberFieldText, numberFieldValue } from '~/utils/number-input'
import { regionalLocale } from '~/utils/regional-locale'
import { computedRows, designOptions, designTable, OPTION_LIST_WIDGETS, resourceTableColumns, searchEnterPayload, type RowFormula } from '~/utils/widget-table'
import { tableActionsColumn } from '~/utils/widget-table-actions'
import { optionGridClass, optionIconColor, optionIconSizeClass, widgetStyleClasses } from '~/utils/widget-style'

const props = defineProps<{
  field: DataViewField
  /** The props of the slot this widget lives in, as `{{slot.*}}`. */
  slotProps?: Record<string, unknown>
}>()

const runtime = inject(WIDGET_RUNTIME_KEY)!
const { t } = useI18n()
const apiErrorText = useApiErrorText()
const ui = useUiLocale()
const cat = useDesignerCatalogText()
const apiErrorMessage = useApiErrorMessage()
/** The form's own checks' words, in the UI's language. */
const formMessages: FormMessages = {
  get required() { return t('common.required') },
  get rangeOrder() { return t('dataviews.rangeInput.order') },
  get invalidFormat() { return t('dataviews.widgetForm.invalidFormat') },
  bound: (bound) => {
    const length = bound.kind === 'length'
    const params = { value: bound.value }
    switch (bound.op) {
      case '>=': return length ? t('dataviews.widgetForm.atLeastChars', params, bound.value) : t('dataviews.widgetForm.atLeast', params)
      case '>': return length ? t('dataviews.widgetForm.moreThanChars', params, bound.value) : t('dataviews.widgetForm.moreThan', params)
      case '<=': return length ? t('dataviews.widgetForm.atMostChars', params, bound.value) : t('dataviews.widgetForm.atMost', params)
      case '<': return length ? t('dataviews.widgetForm.lessThanChars', params, bound.value) : t('dataviews.widgetForm.lessThan', params)
    }
  }
}
/** The viewer's time zone - a timestamptz shows and is entered in it. */
const { timezone } = useDateTimeFormat()
const live = computed(() => runtime.mode === 'live')
const name = computed(() => props.field.widget as WidgetName)
const definition = computed(() => widgetDefinition(name.value))
const component = computed(() => WIDGET_COMPONENTS[name.value])

interface StoredConfig {
  props?: Record<string, unknown>
  bindings?: Record<string, WidgetPropBinding>
  emits?: Record<string, string>
}
const config = computed(() => props.field.config as StoredConfig)
const bindings = computed(() => config.value.bindings ?? {})

function variableHandle(binding: WidgetPropBinding | undefined) {
  return binding?.kind === 'variable' ? runtime.vars[binding.variable] : undefined
}

// --- Forms (UForm, UFormField) ----------------------------------------------------

const isForm = computed(() => name.value === 'UForm')
/** The UForm instance - its submit/validate/clear back `dataview.controls.<name>`. */
const componentRef = ref<{ submit?: () => Promise<void>, validate?: () => Promise<unknown>, clear?: () => void, open?: () => void, close?: () => void, focus?: () => void, show?: (options?: Record<string, unknown> | string) => void, reset?: () => void, locate?: () => Promise<void> } | null>(null)

/** A form's data: each of its fields' value - its record column's, or its Value's - under the field's name: the body a Call takes as is. */
const formData = computed<Record<string, unknown>>(() => {
  if (!isForm.value) return {}
  const data: Record<string, unknown> = {}
  for (const field of formFields(runtime.fields.value, props.field.id)) {
    const key = fieldName(runtime.fields.value, field)
    if (!key) continue
    const column = fieldColumn(field)
    if (column) {
      data[key] = runtime.record?.data[column] ?? null
      continue
    }
    if (fieldJunction(field)) {
      data[key] = runtime.junctions?.[field.id]?.values ?? []
      continue
    }
    const variable = fieldVariable(runtime.fields.value, field)
    const handle = variable ? runtime.vars[variable] : undefined
    if (variable) data[key] = handle?.kind === 'VALUE' ? handle.value : null
  }
  return data
})
/** Required by the author, or - for a field bound to a column - by PostgreSQL (NOT NULL, no default). */
function fieldRequired(field: DataViewField): boolean {
  const column = fieldColumn(field)
  if (column && runtime.record?.columns[column]?.required && runtime.record.canEdit(column)) return true
  const stored = field.config as StoredConfig
  const binding = stored.bindings?.required
  if (binding?.kind === 'formula') return evaluateWidgetFormula(binding.formula, { vars: runtime.vars, controls: runtime.controls }, 'boolean') === true
  return stored.props?.required === true
}
/** A form field's Pattern message - its formula's text when bound, else its own. */
function fieldPatternMessage(field: DataViewField): string | undefined {
  const stored = field.config as StoredConfig
  const binding = stored.bindings?.patternMessage
  const message = binding?.kind === 'formula' ? evaluateWidgetFormula(binding.formula, { vars: runtime.vars, controls: runtime.controls }, 'string') : stored.props?.patternMessage
  return typeof message === 'string' && message ? message : undefined
}

// --- The record: a form field bound to a column, and its input ------------------------

/** The record column this input edits - its form field's. */
const boundColumn = computed(() => inputColumn(runtime.fields.value, props.field))
/** A UInput of type datetime-local bound to a column. */
const isDateTimeLocal = computed(() => name.value === 'UInput' && config.value.props?.type === 'datetime-local' && Boolean(boundColumn.value))
/**
 * A number column's text input (its number field, DataViews.md §16.1): typed with a numeric keyboard, shown with
 * the locale's decimal point, written as text PostgreSQL reads - null for anything else; else whether it has decimals.
 */
const numberField = computed<{ decimals: boolean } | null>(() => {
  if (name.value !== 'UInput' || !boundColumn.value) return null
  const dataType = runtime.record?.columns[boundColumn.value]?.dataType
  if (!dataType || !isNumericDataType(dataType)) return null
  const type = config.value.props?.type ?? columnInputType(runtime.recordPresentation?.(boundColumn.value)?.input) ?? 'text'
  return type === 'text' ? { decimals: columnDecimals(dataType) > 0 } : null
})
/** Its column holds an instant (timestamptz), not a wall-clock time. */
const isZonedColumn = computed(() => /with time zone/.test(runtime.record?.columns[boundColumn.value ?? '']?.dataType ?? ''))
/** This form field's column. */
const ownColumn = computed(() => fieldColumn(props.field))
/**
 * The links this input edits - its form field's junction table (DataViews.md §8.5): undefined while they load
 * or when it isn't such an input, null when the viewer may not read them.
 */
const boundJunctionField = computed(() => {
  const parent = fieldById(runtime.fields.value, props.field.parent)
  return parent && fieldJunction(parent) ? parent.id : null
})
const boundLinks = computed(() => (boundJunctionField.value ? runtime.junctions?.[boundJunctionField.value] : undefined))
/**
 * A select menu's accessible name: its form field's label - else reka-ui's own
 * trigger names it "Show popup", in English, over the field's visible label (B51).
 */
const selectMenuLabel = computed(() => {
  const parent = fieldById(runtime.fields.value, props.field.parent)
  const label = (parent?.config as StoredConfig | undefined)?.props?.label
  if (typeof label === 'string' && label.trim()) return label
  if (boundColumn.value) return runtime.recordPresentation?.(boundColumn.value)?.label ?? humanizeColumnName(boundColumn.value)
  return t('common.showOptions')
})
/** An input in a form field set to Full width (the default) fills it - its width follows the field's. */
const fillsField = computed(() => {
  const parent = fieldById(runtime.fields.value, props.field.parent)
  return parent?.widget === 'UFormField' && (parent.config as StoredConfig).props?.block !== false
})
/** Required fields first, then their patterns (the author's and the column's CHECKs), then the Code's Validate function - errors under each field's name, as UForm shows them. */
async function validateForm(): Promise<{ name?: string, message: string }[]> {
  const fields = formFields(runtime.fields.value, props.field.id)
    .map((field) => {
      const stored = (field.config as StoredConfig).props ?? {}
      const column = fieldColumn(field)
      return {
        name: fieldName(runtime.fields.value, field) ?? '',
        required: fieldRequired(field),
        pattern: typeof stored.pattern === 'string' ? stored.pattern : undefined,
        patternMessage: fieldPatternMessage(field),
        column: column ? runtime.record?.columns[column]?.patterns ?? [] : [],
        bounds: column ? runtime.record?.columns[column]?.bounds ?? [] : [],
        dataType: column ? runtime.record?.columns[column]?.dataType : undefined
      }
    })
    .filter(field => field.name)
  const errors = [...requiredErrors(fields, formData.value, formMessages), ...patternErrors(fields, formData.value, formMessages), ...boundErrors(fields, formData.value, formMessages), ...rangeErrors(fields, formData.value, formMessages)]
  const validate = config.value.props?.validate
  if (typeof validate === 'string' && validate) errors.push(...toFieldErrors(await runtime.emit(validate, { data: { ...formData.value } })))
  return errors.map(e => ({ name: e.field || undefined, message: e.message }))
}

/** An Input's `type` its column's chosen control gives it (an email's, a number field's) - none for another control. */
function columnInputType(input: string | undefined): string | undefined {
  if (!isColumnInputKey(input) || COLUMN_INPUTS[input].widget !== 'UInput') return undefined
  const type = COLUMN_INPUTS[input].props?.type
  return typeof type === 'string' ? type : undefined
}

// --- A select fed by a Resource: searched on the server, its value always shown ---

/**
 * A Select menu or an Input menu whose options are a Resource's rows (a
 * foreign key's select): the Resource holds one page (100 rows), so typing
 * searches the server (the Resource's `search`, over its text fields) instead
 * of filtering that page, and the selected row is read on its own when it
 * isn't among them - a value never shows blank.
 */
const optionSource = computed(() => {
  if (!live.value || (name.value !== 'USelectMenu' && name.value !== 'UInputMenu')) return undefined
  const handle = variableHandle(bindings.value.items)
  return handle?.kind === 'RESOURCE' && Array.isArray(handle.data) ? handle as ResourceHandle : undefined
})
const searchTerm = ref('')
let searched = ''
let searchTimer: ReturnType<typeof setTimeout> | undefined
function onSearchTerm(term: unknown) {
  searchTerm.value = typeof term === 'string' ? term : ''
  if (searchTimer !== undefined) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    const text = searchTerm.value.trim()
    if (text === searched) return
    searched = text
    optionSource.value?.setSearch(text)
  }, 250)
}
onBeforeUnmount(() => {
  if (searchTimer !== undefined) clearTimeout(searchTimer)
})
/** The selected row, read apart - shown first while it isn't on the page the Resource holds. */
const selectedRow = ref<Record<string, unknown> | null>(null)
/** A multiple select's picks read apart (a junction's links) - each shown while it isn't on that page. */
const selectedRows = ref<Record<string, unknown>[]>([])
function withSelected(items: unknown[], value: unknown, key: string): unknown[] {
  const values = Array.isArray(value) ? value : [value]
  const extra: Record<string, unknown>[] = []
  for (const row of [selectedRow.value, ...selectedRows.value]) {
    if (!row || !values.includes(row[key]) || items.some(i => isObject(i) && i[key] === row[key]) || extra.some(r => r[key] === row[key])) continue
    extra.push(row)
  }
  return extra.length ? [...extra, ...items] : items
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

// --- Props -----------------------------------------------------------------

/** An overlay's open state - `dataview.controls.<name>.open()`/`close()` and its own ✕ set it. Declared before the props that read it: a watcher evaluates them during setup. */
const open = ref(false)

/** The props that are a widget's visible text - on the canvas, a formula's stands in by the widget's name. */
const DESIGN_TEXT_PROPS = ['label', 'title', 'description', 'caption', 'emptyText']
const resolvedProps = computed(() => {
  const out: Record<string, unknown> = { ...config.value.props }
  for (const [prop, binding] of Object.entries(bindings.value)) {
    if (!live.value) {
      // Design: a data prop has no data yet - an empty list keeps a Table or a Select drawable;
      // a list showing every option (a Radio group) draws three samples instead of nothing.
      if (binding.kind === 'variable' && (prop === 'items' || prop === 'data')) {
        out[prop] = prop === 'items' && OPTION_LIST_WIDGETS.includes(name.value) ? designOptions(config.value.props ?? {}, { option: n => t('dataviews.widgetTable.sampleOption', { n }), description: t('dataviews.widgetTable.sampleDescription') }) : []
      }
      // A text a formula gives isn't known yet: the widget's name stands in for it, marked ƒ - never a blank strip.
      if (binding.kind === 'formula' && DESIGN_TEXT_PROPS.includes(prop) && !out[prop]) {
        out[prop] = `ƒ ${props.field.label || cat.widgetLabel(name.value, definition.value.label)}`
      }
      continue
    }
    if (binding.kind === 'formula') {
      const meta = definition.value.props[prop] ?? commonWidgetProps(name.value)[prop]
      // An option list's field bound to a formula is evaluated once per option (optionFormulas), never here.
      if (!meta || meta.binding === 'option') continue
      // A computed input (DataViews.md §9.2): its Value a formula - what it gives as it is, read only, written nowhere.
      if (prop === 'modelValue' && meta.binding === 'value') {
        const value = evaluateWidgetFormula(binding.formula, { vars: runtime.vars, slot: props.slotProps, controls: runtime.controls })
        out.modelValue = name.value === 'UInputNumber' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : value ?? null
        out.readonly = true
        continue
      }
      const value = evaluateWidgetFormula(binding.formula, { vars: runtime.vars, slot: props.slotProps, controls: runtime.controls }, formulaReturnType(meta))
      if (value !== undefined) out[prop] = value
    } else {
      const handle = runtime.vars[binding.variable]
      if (handle) out[prop] = handle.kind === 'VALUE' ? handle.value : handle.data
    }
  }
  // A widget reading a Resource shows it loading, unless its Loading prop is bound otherwise.
  const source = variableHandle(bindings.value.items ?? bindings.value.data)
  if (live.value && 'loading' in definition.value.props && !bindings.value.loading && source && source.kind !== 'VALUE') {
    out.loading = source.status === 'pending'
  }
  // A Frame's URL is a template (DataViews.md §9.7): each token a page value, encoded;
  // on the Design canvas, the template itself - an unfilled address is never loaded.
  if (name.value === 'TFrame') {
    const template = typeof out.url === 'string' ? out.url : ''
    if (live.value) {
      out.url = resolveFrameUrlTemplate(template, token => evaluateWidgetFormula(token, { vars: runtime.vars, slot: props.slotProps, controls: runtime.controls }))
    } else {
      out.url = null
      out.template = template
    }
  }
  if (OVERLAY_WIDGETS.includes(name.value)) out.open = open.value
  if (isForm.value) {
    // Validate names a Code function; UForm takes the function itself.
    delete out.validate
    if (live.value) {
      out.state = formData.value
      out.validate = validateForm
      // A Validate function may ask the server - on blur and change, not on every keystroke.
      out.validateOn = ['blur', 'change']
    }
  }
  // Nuxt UI opens tab "0" - an index; tabs with their own values open the first one - also while its Open tab Value is empty.
  if (name.value === 'UTabs' && Array.isArray(out.items)) {
    const first = out.items[0] as { value?: unknown } | undefined
    const firstValue = typeof first?.value === 'string' || typeof first?.value === 'number' ? first.value : undefined
    if (!bindings.value.modelValue && out.defaultValue === undefined) out.defaultValue = firstValue
    else if (bindings.value.modelValue && (out.modelValue === null || out.modelValue === undefined || out.modelValue === '')) out.modelValue = firstValue
  }
  // Column, Full width and Pattern are TotalBase's own props - they bind, size and check the input, they aren't UFormField's.
  if (name.value === 'UFormField') {
    delete out.column
    delete out.junction
    delete out.block
    delete out.pattern
    delete out.patternMessage
  }
  if (name.value === 'UFormField' && live.value) {
    out.name = fieldName(runtime.fields.value, props.field) ?? undefined
    if (ownColumn.value) {
      if (fieldRequired(props.field)) out.required = true
      // What PostgreSQL said about this column on the last save - until it's edited.
      const error = runtime.record?.error?.errors.find(e => e.field === ownColumn.value)
      if (error) out.error = error.code === 'NOT_NULL_VIOLATION' ? t('common.required') : apiErrorText(error)
    }
  }
  const record = runtime.record
  // An input of a form field linked through a junction table: the other table's keys it links to, picked several at once.
  if (live.value && boundJunctionField.value) {
    const links = boundLinks.value
    out.modelValue = links?.values ?? []
    if ('multiple' in definition.value.props) out.multiple = true
    if (!links || !record || record.mode === 'view' || links.status === 'pending' || (!links.canAdd && !links.canRemove)) out.disabled = true
    const variantOptions = (definition.value.props.variant as { options?: readonly string[] } | undefined)?.options
    if (out.disabled === true && out.variant === undefined && variantOptions?.includes('soft')) out.variant = 'soft'
  }
  if (live.value && boundColumn.value && record) {
    // The record's value; read-only where the viewer may not write it (their grants, its mode, PostgreSQL's own columns).
    out.modelValue = record.data[boundColumn.value] ?? null
    // A timestamp in a native datetime-local input: its wall-clock time, in the viewer's zone for a timestamptz.
    if (isDateTimeLocal.value) out.modelValue = toDateTimeLocal(out.modelValue, isZonedColumn.value, timezone.value)
    // A number field's text: the locale's decimal point.
    if (numberField.value) out.modelValue = numberFieldText(out.modelValue, regionalLocale())
    // PostgreSQL's numeric arrives as text ("30990.00", exact) - a number input shows it as the number it is.
    if (name.value === 'UInputNumber' && typeof out.modelValue === 'string' && out.modelValue.trim() !== '' && Number.isFinite(Number(out.modelValue))) out.modelValue = Number(out.modelValue)
    if (!record.canEdit(boundColumn.value)) out.disabled = true
    if (out.disabled === true) {
      // Reads as a value, not as an input - whether the record can't write it or its author made it read-only:
      // Nuxt UI's soft variant where the widget has one, a number without +/-.
      const variantOptions = (definition.value.props.variant as { options?: readonly string[] } | undefined)?.options
      if (out.variant === undefined && variantOptions?.includes('soft')) out.variant = 'soft'
      if (name.value === 'UInputNumber') {
        out.increment = false
        out.decrement = false
      }
    }
    // A number keeps the decimals its column holds - Nuxt UI's default rounds to whole numbers.
    const dataType = record.columns[boundColumn.value]?.dataType
    // The date picker's adapter (WidgetInputDate.vue) keeps a timestamp's time.
    if ((name.value === 'UInputDate' || name.value === 'TRangeInput') && dataType) out.columnType = dataType
    // Its column's CHECK days, where the page sets none: its calendar offers no day past them.
    if (name.value === 'UInputDate') {
      for (const bound of record.columns[boundColumn.value]?.dateBounds ?? []) {
        if (bound.op.startsWith('>') && out.minDate === undefined) out.minDate = `${bound.op === '>' ? 'after:' : ''}${bound.value}`
        if (bound.op.startsWith('<') && out.maxDate === undefined) out.maxDate = `${bound.op === '<' ? 'before:' : ''}${bound.value}`
      }
    }
    // Its column's CHECK range, where the page sets none: a number input won't step past it (`>=`/`<=` only - a `>` stays the form's check).
    if (name.value === 'UInputNumber') {
      for (const bound of record.columns[boundColumn.value]?.bounds ?? []) {
        if (bound.kind !== 'value') continue
        if (bound.op === '>=' && out.min === undefined) out.min = bound.value
        if (bound.op === '<=' && out.max === undefined) out.max = bound.value
      }
    }
    // A number column's plain input (DataViews.md §15.2): text with a numeric keyboard - a whole number's digits
    // alone, a decimal's with its separator (its CHECK range is the form's check and PostgreSQL's). A page that
    // sets a number input keeps its CHECK range and its scale's step (numeric(5,2): 0.01); what the page sets wins.
    if (name.value === 'UInput' && dataType && isNumericDataType(dataType)) {
      const chosen = boundColumn.value ? columnInputType(runtime.recordPresentation?.(boundColumn.value)?.input) : undefined
      if (out.type === undefined) out.type = chosen ?? 'text'
      if (numberField.value && out.inputmode === undefined) out.inputmode = numberField.value.decimals ? 'decimal' : 'numeric'
      if (out.type === 'number') {
        for (const bound of record.columns[boundColumn.value]?.bounds ?? []) {
          if (bound.kind !== 'value') continue
          if (bound.op === '>=' && out.min === undefined) out.min = bound.value
          if (bound.op === '<=' && out.max === undefined) out.max = bound.value
        }
        if (out.step === undefined) {
          const decimals = columnDecimals(dataType)
          out.step = decimals === 20 ? 'any' : decimals === 0 ? 1 : 10 ** -decimals
        }
      }
    }
    if (name.value === 'UInputNumber' && dataType) {
      const decimals = columnDecimals(dataType)
      // A column with a scale shows all of it (numeric(12,2): 30,990.00); an unbounded one, what it holds.
      const fixed = /^numeric\(\d+,\s*\d+\)/.test(dataType)
      if (out.formatOptions === undefined) out.formatOptions = { minimumFractionDigits: fixed ? decimals : 0, maximumFractionDigits: decimals }
      // reka snaps a value to the step (1) - 1234.5 would save as 1235.
      if (decimals > 0 && out.step === undefined) out.stepSnapping = false
    }
  }
  if (optionSource.value) {
    out.ignoreFilter = true
    out.searchTerm = searchTerm.value
    const key = out.valueKey
    if (typeof key === 'string' && Array.isArray(out.items)) out.items = withSelected(out.items, out.modelValue, key)
  }
  // A number input reads in the UI's language - not Nuxt UI's (en).
  if (name.value === 'UInputNumber' && out.locale === undefined) out.locale = ui.intlLocale.value
  Object.assign(out, inheritedFromColumn(out))
  if (name.value === 'USelectMenu' && out['aria-label'] === undefined) out['aria-label'] = selectMenuLabel.value
  if (!live.value) Object.assign(out, designOverrides())
  return out
})

/** A horizontal form field's Label width - written out in full, for Tailwind. */
const FORM_LABEL_WIDTHS: Record<string, string> = {
  '1/4': 'md:w-1/4 md:shrink-0',
  '1/3': 'md:w-1/3 md:shrink-0',
  '2/5': 'md:w-2/5 md:shrink-0',
  '1/2': 'md:w-1/2 md:shrink-0'
}

/** Option lists a column's CHECK list fills when they hold no items of their own. */
const SINGLE_OPTION_WIDGETS_RENDERED: readonly string[] = ['USelect', 'USelectMenu', 'UInputMenu', 'URadioGroup', 'UListbox']

/** The inputs that show a placeholder - the ones Nuxt UI gives one. */
const PLACEHOLDER_INPUTS: readonly string[] = ['UInput', 'UTextarea', 'UInputNumber', 'USelect', 'USelectMenu', 'UInputMenu', 'UInputTags']

/**
 * What a form field bound to a column, and its input, take from the column
 * (DataViews.md §15) where the page sets
 * nothing (an empty value is set - to none): the field's label (else the name humanized), description and
 * help; the input's placeholder and icon; a CHECK list's values with their
 * labels and icons. On the canvas too, so it reads as it will.
 */
function inheritedFromColumn(out: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (name.value === 'UFormField' && ownColumn.value) {
    const inherited = runtime.recordPresentation?.(ownColumn.value)
    // Unset inherits; an empty one is the page's "none" - a Card's title already naming the field, a row kept even.
    if (out.label === undefined) patch.label = inherited?.label ?? humanizeColumnName(ownColumn.value)
    if (out.description === undefined && inherited?.description) patch.description = inherited.description
    if (out.help === undefined && inherited?.help) patch.help = inherited.help
  }
  // An option list bound to a column with a CHECK list and no items of its own: the CHECK's values are its options.
  const boundRecordColumn = boundColumn.value ? runtime.record?.columns[boundColumn.value] : undefined
  const checkValues = boundRecordColumn?.values
  if (checkValues && out.items === undefined && SINGLE_OPTION_WIDGETS_RENDERED.includes(name.value)) {
    out.items = checkValues
    patch.items = checkValues
  } else if (checkValues && Array.isArray(out.items) && SINGLE_OPTION_WIDGETS_RENDERED.includes(name.value)
    && out.items.every(item => typeof item === 'string' || typeof item === 'number')) {
    // A generated form's stored list (text, as PostgreSQL wrote it): in the column's own shape - an integer a number,
    // a numeric(5,2) "21.00" - or the record's value never matches an option (T61).
    out.items = (out.items as (string | number)[]).map(item => checkValueShape(String(item), boundRecordColumn!.dataType))
    patch.items = out.items
  }
  const inherited = boundColumn.value ? runtime.recordPresentation?.(boundColumn.value) : undefined
  if (!inherited) return patch
  const props = definition.value.props
  // Not a catalog prop (a page's own hint is a help text); its column's example value is the one placeholder an input shows.
  if (out.placeholder === undefined && inherited.placeholder && PLACEHOLDER_INPUTS.includes(name.value)) patch.placeholder = inherited.placeholder
  // A column shown as an email, a phone or a URL is typed as one: a phone offers its keyboard (T57).
  // Its column's chosen Input type first (§15.2).
  const linkType = (inherited as { linkType?: string }).linkType
  const chosenType = columnInputType(inherited.input)
  if (name.value === 'UInput' && out.type === undefined && chosenType) patch.type = chosenType
  else if (name.value === 'UInput' && out.type === undefined && (linkType === 'email' || linkType === 'tel' || linkType === 'url')) patch.type = linkType
  const iconKey = inherited.iconPosition === 'trailing' ? 'trailingIcon' : 'icon'
  if (inherited.icon && out[iconKey] === undefined && iconKey in props) patch[iconKey] = inherited.icon
  // A CHECK list's plain values: each with its label and icon - only while the page names no keys of its own.
  const options = inherited.options
  if (options && Array.isArray(out.items) && out.valueKey === undefined && out.labelKey === undefined
    && out.items.every(item => typeof item === 'string' || typeof item === 'number')) {
    patch.items = (out.items as (string | number)[]).map((value) => {
      // Keyed as PostgreSQL wrote the list ("21"), however the column reads it ("21.00").
      const option = options[String(value)] ?? Object.entries(options).find(([key]) => typeof value !== 'string' || /^-?\d/.test(value) ? Number(key) === Number(value) : false)?.[1]
      return { value, label: option?.label ?? String(value), ...(option?.icon ? { icon: option.icon } : {}) }
    })
  }
  return patch
}

/** On the canvas, containers show what they hold: a Collapsible open, every Accordion section open. */
function designOverrides(): Record<string, unknown> {
  if (name.value === 'UCollapsible') return { open: true }
  if (name.value === 'UAccordion') {
    const items = Array.isArray(config.value.props?.items) ? config.value.props.items : []
    return { type: 'multiple', defaultValue: items.map((item, index) => itemSlot('', item, index).slice(1)) }
  }
  return {}
}

// The selected value missing from the options: read its row.
// Once the Resource has its page - a value on it needs no read.
watch(() => [optionSource.value, optionSource.value?.status, resolvedProps.value.modelValue, resolvedProps.value.items, resolvedProps.value.valueKey] as const, async ([source, status, value, items, key]) => {
  if (!source || status !== 'success' || typeof key !== 'string' || !Array.isArray(items)) return
  // Several picked (a junction's links): those on neither the page nor read already, in one read.
  if (Array.isArray(value)) {
    const missing = value.filter(v => !items.some(i => isObject(i) && i[key] === v) && !selectedRows.value.some(r => r[key] === v))
    if (missing.length === 0) return
    try {
      const rows = await source.findAll(key, missing)
      selectedRows.value = [...selectedRows.value, ...rows]
    } catch {
      // Best-effort - those picks show no label, as a single one.
    }
    return
  }
  if (value === null || value === undefined || isObject(value)) return
  if (items.some(i => isObject(i) && i[key] === value)) return
  try {
    const row = await source.find(key, value)
    if (row && resolvedProps.value.modelValue === value) selectedRow.value = row
  } catch {
    // Best-effort - the select shows no label, as before.
  }
}, { immediate: true })

// --- TotalBase's common props (commonWidgetProps): applied here, never passed to the component ---

/**
 * A form field bound to a column the viewer may not read: never drawn - as
 * the grid leaves that column out (DataViews.md §4). Known once the record's
 * catalog (the columns they may read) has arrived.
 */
const unreadableColumn = computed(() => {
  const columns = runtime.record?.columns
  if (live.value && fieldJunction(props.field) && runtime.junctions?.[props.field.id] === null) return true
  return Boolean(ownColumn.value && columns && Object.keys(columns).length > 0 && !columns[ownColumn.value])
})
/** Visible off (or its formula false) hides the widget - it takes no space. The canvas always shows it. */
const hidden = computed(() => live.value && (resolvedProps.value.visible === false || unreadableColumn.value))
/** Hidden by Visible, but Hidden, still active: on the page, unseen - its methods and listeners keep working. A column it may not read always leaves. */
const keptHidden = computed(() => hidden.value && config.value.props?.keepActive === true && !unreadableColumn.value)
const cssClass = computed(() => (typeof resolvedProps.value.cssClass === 'string' ? resolvedProps.value.cssClass : undefined))
const isMobile = useIsMobile()
const isCompact = useCompactUi()
/** The Style tab's box - spacing, border, background, shadow, alignment (utils/widget-style.ts). */
const styleClasses = computed(() => widgetStyleClasses(resolvedProps.value))
/** The component's props, plus its HTML attributes - never a reserved one (class, on*, v-model...). */
/**
 * A Table's columns (utils/widget-table.ts, DataViews.md §15):
 * its Resource's fields in order, each with its Columns
 * settings over what its resource's column sets - titled, formatted by type
 * and Format, styled; the hidden ones left out. On the canvas, its shape.
 * Live, its Search and Pager drive the Resource on the server.
 */
const colorMode = useColorMode()
/** The Resource a Table's Rows are bound to - its Search, Pager and Search Enter drive it. */
const tableResource = computed(() => {
  if (name.value !== 'UTable') return undefined
  const binding = bindings.value.data
  const handle = binding?.kind === 'variable' ? runtime.vars[binding.variable] : undefined
  return handle?.kind === 'RESOURCE' ? handle : undefined
})
/** Its foreign keys' texts for the rows on screen (DataViews.md §15.5) - read again whenever they change. */
const foreignLabels = shallowRef<Record<string, Record<string, string>>>({})
watch(() => [live.value, tableResource.value?.data] as const, async ([isLive, data]) => {
  const binding = bindings.value.data
  const variable = binding?.kind === 'variable' ? binding.variable : undefined
  if (!isLive || !variable || !runtime.foreignKeyLabels || !Array.isArray(data) || data.length === 0) {
    foreignLabels.value = {}
    return
  }
  foreignLabels.value = await runtime.foreignKeyLabels(variable, data as Record<string, unknown>[])
}, { immediate: true })
const tableColumns = computed(() => {
  if (name.value !== 'UTable') return {}
  const binding = bindings.value.data
  const variable = binding?.kind === 'variable' ? binding.variable : undefined
  const types = variable ? runtime.resourceColumns?.(variable) : undefined
  const fields = variable ? runtime.resourceFields?.(variable) ?? [] : []
  const settings = (resolvedProps.value.columnSettings ?? undefined) as Record<string, TableColumnSettings> | undefined
  const inherited = variable ? runtime.resourcePresentation?.(variable) : undefined
  const computedColumns = Array.isArray(resolvedProps.value.computedColumns) ? resolvedProps.value.computedColumns as TableComputedColumn[] : []
  // Its formulas per row - a computed column, a cell's or the row's color, an action's Disabled/Visible: the row as {{campo}}, the page as {{vars.*}}.
  const evaluate: RowFormula = (formula, row, returnType) => evaluateWidgetFormula(formula, { vars: runtime.vars, slot: props.slotProps, controls: runtime.controls, row }, returnType)
  // Its Row actions, a last column - a click runs Action clicked's function with which one.
  const actions = Array.isArray(resolvedProps.value.actions) ? resolvedProps.value.actions as TableAction[] : []
  const handler = config.value.emits?.action
  const onAction = live.value && handler
    ? (action: string, row: Record<string, unknown>) => runtime.emit(handler, { action, row })
    : undefined
  const check = live.value ? (formula: string, row: Record<string, unknown>) => evaluate(formula, row, 'boolean') as boolean | undefined : undefined
  const withActions = <T extends Record<string, unknown>>(columns: TableColumn<T>[]) => [...columns, ...(actions.length ? [tableActionsColumn<T>(actions, onAction, check)] : [])]
  // The canvas: its Resource's columns over placeholder rows - or, unbound, what's missing.
  if (!live.value) {
    if (!fields.length) return { data: [], empty: t('dataviews.widgetRenderer.chooseRows') }
    const table = designTable(fields, types, { settings, inherited, computed: computedColumns })
    return { ...table, columns: withActions(table.columns) }
  }
  if (!runtime.format) return {}
  const mode = colorMode.value === 'dark' ? 'dark' : 'light'
  const shade = (color: string) => (isRoleColor(color) ? roleColorShade(color, mode) : undefined)
  // Each row with its computed values, once - its cells and its Row color read the same.
  const rowOf = computedRows(computedColumns, evaluate)
  const columns = resourceTableColumns(fields, types, runtime.format, { settings, inherited, labels: foreignLabels.value, computed: computedColumns, evaluate, rowOf, shade, booleans: { true: t('common.yes'), false: t('common.no') }, icon: iconName => h(UIcon, { name: iconName, class: 'size-3.5' }) })
  // Its Row color: each row tinted from a field holding a palette color, or from a formula per row - as a Dashboard's `_color`.
  const rowColorField = typeof resolvedProps.value.rowColorKey === 'string' ? resolvedProps.value.rowColorKey : undefined
  const rowColorBinding = bindings.value.rowColorKey
  const rowColorFormula = rowColorBinding?.kind === 'formula' && rowColorBinding.formula.trim() ? rowColorBinding.formula : undefined
  const rowColor = rowColorFormula || rowColorField
    ? (row: Record<string, unknown>) => {
        const values = rowOf(row)
        const color = rowColorFormula ? evaluate(rowColorFormula, values, 'string') : values[rowColorField!]
        const tint = typeof color === 'string' && color ? shade(color) : undefined
        return tint ? { backgroundColor: `color-mix(in srgb, ${tint} 12%, transparent)` } : {}
      }
    : undefined
  // Its Search and Pager: the Resource's page, size and total - and what moves them.
  const resource = tableResource.value
  const paging = resource
    ? {
        page: resource.page,
        pageSize: resource.limit,
        total: resource.count,
        rowCount: Array.isArray(resource.data) ? resource.data.length : 0,
        searchText: resource.search,
        onSearch: (text: string) => resource.setSearch(text),
        onPage: (page: number) => resource.setPage(page)
      }
    : {}
  return {
    ...(columns ? { columns: withActions(columns) } : {}),
    ...(rowColor ? { meta: { style: { tr: (row: { original: Record<string, unknown> }) => rowColor(row.original) } } } : {}),
    ...paging
  }
})
/**
 * An option list's per-option fields (PropBinding "option"): each formula
 * evaluated once per option - its fields as `{{campo}}`, the page as
 * `{{vars.*}}` - into a field of its own on the option's row, which the
 * prop then names: `__label`, `__description`, `__icon`, `__color`,
 * `__disabled`. Live only: the canvas draws sample options.
 */
const OPTION_FORMULA_FIELDS: Record<string, string> = {
  labelKey: '__label',
  descriptionKey: '__description',
  iconKey: '__icon',
  colorKey: '__color',
  disabledKey: '__disabled'
}
function withOptionFormulas(items: unknown[]): { items: unknown[], keys: Record<string, string> } {
  const formulas = Object.entries(bindings.value)
    .filter(([prop, binding]) => binding.kind === 'formula' && prop in OPTION_FORMULA_FIELDS && definition.value.props[prop]?.binding === 'option')
    .map(([prop, binding]) => ({ prop, formula: (binding as { formula: string }).formula, field: OPTION_FORMULA_FIELDS[prop]! }))
  if (!live.value || formulas.length === 0) return { items, keys: {} }
  const mapped = items.map((item) => {
    if (item === null || typeof item !== 'object') return item
    const row = item as Record<string, unknown>
    const computed: Record<string, unknown> = {}
    for (const { prop, formula, field } of formulas) {
      computed[field] = evaluateWidgetFormula(formula, { vars: runtime.vars, slot: props.slotProps, controls: runtime.controls, row }, prop === 'disabledKey' ? 'boolean' : 'string')
    }
    return { ...row, ...computed }
  })
  return { items: mapped, keys: Object.fromEntries(formulas.map(f => [f.prop, f.field])) }
}

const componentProps = computed(() => {
  // A Table's Columns and Row actions are TotalBase's too - `tableColumns` - never Nuxt UI's.
  const { visible: _visible, keepActive: _keepActive, cssClass: _css, htmlAttrs, fillHeight: _fill, iconKey: iconField, colorKey: colorField, disabledKey: disabledField, iconSize, columns, columnSettings: _settings, actions: _actions, computedColumns: _computed, rowColorKey: _rowColor, searchWindow: _searchWindow, searchWindowAs: _searchWindowAs, searchWindowSize: _searchWindowSize, ...withStyle } = resolvedProps.value
  // The Style tab's values are the box's, never the component's.
  const rest = Object.fromEntries(Object.entries(withStyle).filter(([key]) => !(key in COMMON_STYLE_PROPS)))
  // An option list's fields bound to a formula: computed per option, then read as fields like any other.
  let iconKey = iconField
  let colorKey = colorField
  let disabledKey = disabledField
  if (Array.isArray(rest.items)) {
    const { items, keys } = withOptionFormulas(rest.items)
    rest.items = items
    if (keys.labelKey) rest.labelKey = keys.labelKey
    if (keys.descriptionKey) rest.descriptionKey = keys.descriptionKey
    if (keys.iconKey) iconKey = keys.iconKey
    if (keys.colorKey) colorKey = keys.colorKey
    if (keys.disabledKey) disabledKey = keys.disabledKey
  }
  // Its Disabled field: an option off when its row says so - Nuxt UI reads each item's `disabled`.
  if (typeof disabledKey === 'string' && disabledKey && Array.isArray(rest.items)) {
    const key = disabledKey
    rest.items = (rest.items as unknown[]).map(item => (item !== null && typeof item === 'object'
      ? { ...item as Record<string, unknown>, disabled: (item as Record<string, unknown>)[key] === true }
      : item))
  }
  // Its Icon field (and a Radio group's Color field): each option's icon - Nuxt UI reads `icon` - and its color, from its row.
  if ((typeof iconKey === 'string' || typeof colorKey === 'string') && Array.isArray(rest.items)) {
    rest.items = (rest.items as unknown[]).map((item) => {
      if (item === null || typeof item !== 'object') return item
      const row = item as Record<string, unknown>
      const icon = typeof iconKey === 'string' && iconKey ? row[iconKey] : undefined
      const color = optionIconColor(typeof colorKey === 'string' && colorKey ? row[colorKey] : undefined)
      return {
        ...row,
        ...(typeof icon === 'string' && icon ? { icon } : {}),
        ...(color ? { ui: { ...row.ui as Record<string, unknown> | undefined, icon: color } } : {})
      }
    })
  }
  // A Radio group's Icon size: every option's icon - Nuxt UI merges it with each one's color.
  const iconSizeClass = optionIconSizeClass(iconSize)
  if (iconSizeClass) rest.ui = { ...(rest.ui as Record<string, unknown> | undefined), icon: iconSizeClass }
  // An embedded DataView's Columns are its own prop - the columns it shows.
  if (name.value === 'TDataView') {
    if (columns !== undefined) rest.columns = columns
  } else {
    // A Radio group's Columns: its options' container a grid of that many - Nuxt UI's is one row or one column.
    const grid = optionGridClass(columns)
    if (grid) rest.ui = { ...(rest.ui as Record<string, unknown> | undefined), fieldset: grid }
  }
  const attrs = Object.fromEntries(Object.entries((htmlAttrs ?? {}) as Record<string, unknown>)
    .filter(([key, value]) => typeof value === 'string' && !isReservedAttrKey(key)))
  // A Tabs', an Accordion's or a Dropdown menu's items: their formulas over the page, a menu item's function (utils/widget-items.ts).
  if (definition.value.props.items?.editor === 'items' && Array.isArray(rest.items)) {
    rest.items = resolveWidgetItems(rest.items, { vars: runtime.vars, slot: props.slotProps, controls: runtime.controls }, live.value ? runtime.emit : undefined)
  }
  // A Splitter's panels all draw its one `panel` area (one per item, like a Tabs' content), each scrolling
  // on its own; on a phone they stack.
  if (name.value === 'USplitter' && Array.isArray(rest.items)) {
    rest.items = (rest.items as unknown[]).map(item => (item !== null && typeof item === 'object' ? { ...item as Record<string, unknown>, slot: 'panel' } : item))
    // items-start: the panel (a flex row) doesn't stretch its area to its height - its rows keep their own height,
    // and a Fill height widget in it finds the panel's slack (its frame is the panel, which scrolls).
    // overflow-auto!: Reka's panel sets `overflow: hidden` inline - only !important scrolls it.
    // On the canvas, its area stretches down the whole panel instead: a widget dropped below what it holds lands
    // in the panel, not on the page around the Splitter (no Fill height runs there).
    // p-px: a Card's border is a ring drawn just outside its box - one that fills the panel (Fill height) would have
    // it cut by the panel's scrolling edge; the pixel keeps it inside (Fill height takes the padding off).
    rest.ui = { panel: `overflow-auto! min-h-0 min-w-0 p-px ${live.value ? 'items-start' : 'items-stretch'}`, ...(rest.ui as Record<string, unknown> | undefined) }
    if (isMobile.value) rest.orientation = 'vertical'
  }
  // A Modal's or a Slideover's Size is TotalBase's: its content's width - a wide Modal is fullscreen on a phone or a tablet.
  if (name.value === 'UModal' || name.value === 'USlideover') {
    const size = rest.size as EditSize | undefined
    delete rest.size
    if (size && size in OVERLAY_CONTENT_WIDTH) {
      rest.ui = { ...(rest.ui as Record<string, unknown> | undefined), content: OVERLAY_CONTENT_WIDTH[size] }
      if (name.value === 'UModal' && isCompact.value && FULLSCREEN_WHEN_COMPACT.includes(size)) rest.fullscreen = true
    }
  }
  // A Card that fills (Fill height): its header and footer stay, its body takes the rest and scrolls - the frame a
  // widget in it with Fill height fills (useFillHeight's nearest scrolling ancestor).
  if (name.value === 'UCard' && fillsContainer.value) {
    rest.ui = { ...(rest.ui as Record<string, unknown> | undefined), root: 'flex flex-col', body: 'min-h-0 flex-1 overflow-auto' }
  }
  // A horizontal form field: its label a fixed share (Label width), so fields beside each other line their values up;
  // a phone stacks it, label above - there's no room for both in one line.
  if (name.value === 'UFormField') {
    const labelWidth = FORM_LABEL_WIDTHS[String(rest.labelWidth)]
    delete rest.labelWidth
    if (rest.orientation === 'horizontal') {
      const ui = (rest.ui as Record<string, unknown> | undefined) ?? {}
      rest.ui = {
        ...ui,
        root: 'max-md:flex-col max-md:items-stretch max-md:gap-0',
        ...(labelWidth ? { wrapper: labelWidth, container: 'min-w-0 flex-1 max-md:mt-1' } : { container: 'max-md:mt-1' })
      }
    }
  }
  // A User's Image is a URL: Nuxt UI takes its avatar as { src, alt } - none, its name's initials.
  if (name.value === 'UUser') {
    const src = typeof rest.avatar === 'string' ? rest.avatar.trim() : ''
    const alt = typeof rest.name === 'string' ? rest.name : undefined
    rest.avatar = src ? { src, alt } : alt ? { alt } : undefined
  }
  // A Textarea's box is inline-flex, centered: the textarea itself fills the height the widget is given.
  const fill = name.value === 'UTextarea' ? { ui: { root: 'h-full items-stretch', base: 'h-full' } } : {}
  return { ...attrs, ...rest, ...fill, ...tableColumns.value }
})

// --- State: what formulas read as {{controls.<name>.*}} (DataViews.md §9.1) ---

/** An option list's chosen row - derived from its value and its own options (the selected one read apart included), never stored. */
const selectedItem = computed(() => {
  if (!('item' in widgetState(name.value))) return undefined
  const { items, modelValue: value } = resolvedProps.value
  if (value === null || value === undefined || Array.isArray(value) || !Array.isArray(items)) return null
  const key = typeof resolvedProps.value.valueKey === 'string' ? resolvedProps.value.valueKey : 'value'
  return (items.find(item => isObject(item) && item[key] === value) as Record<string, unknown> | undefined) ?? null
})
/** A Table's last row clicked. */
const lastRow = shallowRef<Record<string, unknown> | null>(null)

// --- Events ----------------------------------------------------------------

/** What a handler receives as `event` - the catalog's `payload`, from the component's arguments. */
function eventPayload(event: string, args: unknown[]): Record<string, unknown> {
  if (name.value === 'UTable' && event === 'select') {
    const row = args[1] as { original?: unknown } | undefined
    return { row: row?.original ?? null }
  }
  if (event === 'update:modelValue') {
    const value = args[0]
    const items = resolvedProps.value.items
    if (Array.isArray(items)) {
      const key = (resolvedProps.value.valueKey as string | undefined) ?? 'value'
      const item = items.find(i => i !== null && typeof i === 'object' && (i as Record<string, unknown>)[key] === value) ?? null
      return { value, item }
    }
    return { value }
  }
  if (event === 'update:open') return { open: args[0] }
  // An embedded DataView: Rows changed's { action, rows }; the row clicked or opened.
  if (name.value === 'TDataView') return event === 'rowsChanged' ? { ...(args[0] as Record<string, unknown> | undefined) } : { row: args[0] ?? null }
  // The Scanner's own events carry their payload whole: { value, format, source } and { message }.
  if (name.value === 'TScanner' && (event === 'scan' || event === 'error')) return (args[0] as Record<string, unknown> | undefined) ?? {}
  // A form speaks the API's envelopes: { data } out, { errors: [{ field, message }] } on failure.
  if (isForm.value && event === 'submit') return { data: (args[0] as { data?: unknown } | undefined)?.data ?? {} }
  if (isForm.value && event === 'error') {
    const errors = ((args[0] as { errors?: { name?: string, message: string }[] } | undefined)?.errors ?? [])
    return { errors: errors.map(e => ({ field: e.name ?? '', message: e.message })) }
  }
  return { value: args[0] }
}

const listeners = computed(() => {
  const out: Record<string, (...args: unknown[]) => unknown> = {}
  if (!live.value) return out
  const record = runtime.record
  const column = boundColumn.value
  // A typed "1123.45" is 1123.45 even where the locale writes 1.123,45 - read just before the field does
  // (capture: ahead of its own blur and Enter), utils/number-input.ts.
  if (name.value === 'UInputNumber') {
    const locale = resolvedProps.value.locale as string | undefined
    const commit = (event: unknown) => {
      if (event instanceof Event) commitDecimalInput(event, locale)
    }
    out.blurCapture = commit
    out.keydownCapture = commit
  }
  if (optionSource.value) out['update:searchTerm'] = onSearchTerm
  // "Create from search" (DataViews.md §9.8): a row of the Resource's table named what was typed,
  // created as the viewer, then picked - its value written like a choice.
  if (optionSource.value && resolvedProps.value.createItem && typeof resolvedProps.value.labelKey === 'string') {
    out.create = async (label: unknown) => createOption(String(label ?? ''))
  }
  // A named Table keeps its last row clicked - `{{controls.<name>.row}}` - whether or not Row clicked runs a function.
  // Unnamed, nothing can read it: its rows stay plain rows unless Row clicked makes them clickable.
  if (name.value === 'UTable' && controlName.value) {
    out.select = (...args: unknown[]) => {
      lastRow.value = (args[1] as { original?: Record<string, unknown> } | undefined)?.original ?? null
    }
  }
  // A junction's links: a list replaces them; one row picked (Create from search, the search window) is added.
  const links = boundLinks.value
  if (links) out['update:modelValue'] = (value: unknown) => links.set(Array.isArray(value) ? value : [...links.values, value])
  if (record && column) {
    const number = numberField.value
    out['update:modelValue'] = isDateTimeLocal.value
      ? (value: unknown) => record.set(column, fromDateTimeLocal(value, isZonedColumn.value, timezone.value))
      : number
        ? (value: unknown) => record.set(column, numberFieldValue(String(value ?? ''), number.decimals))
        : (value: unknown) => record.set(column, value)
    // A letter never reaches a number field, whatever keyboard typed it.
    if (number) {
      out.beforeinput = (event: unknown) => {
        if (event instanceof InputEvent && event.data && !numberFieldAccepts(event.data, number.decimals)) event.preventDefault()
      }
    }
  }
  const model = variableHandle(bindings.value.modelValue)
  if (!column && model?.kind === 'VALUE') {
    out['update:modelValue'] = (value: unknown) => {
      try {
        (model as ValueHandle).set(value)
      } catch (error) {
        runtime.notify(apiErrorMessage(error, error instanceof Error ? error.message : String(error)), 'error')
      }
    }
  }
  for (const [event, handler] of Object.entries(config.value.emits ?? {})) {
    // A Table's Search Enter: its Resource searched for what was typed and read, then the function - with what it found.
    if (name.value === 'UTable' && event === 'searchEnter') {
      out.searchEnter = async (text: unknown) => runtime.emit(handler, await searchEnterPayload(tableResource.value, String(text ?? '')))
      continue
    }
    const previous = out[event]
    // Returned, not dropped: a form awaits its submit handler (Busy while submitting).
    out[event] = (...args: unknown[]) => {
      previous?.(...args)
      return runtime.emit(handler, eventPayload(event, args))
    }
  }
  if (OVERLAY_WIDGETS.includes(name.value)) {
    const previous = out['update:open']
    out['update:open'] = (...args: unknown[]) => {
      open.value = Boolean(args[0])
      previous?.(...args)
    }
  }
  return out
})

/** The select's "Create": the new row is shown at once (read apart, like a selected one) and chosen. */
async function createOption(label: string) {
  const source = optionSource.value
  const labelKey = resolvedProps.value.labelKey
  const valueKey = typeof resolvedProps.value.valueKey === 'string' ? resolvedProps.value.valueKey : 'id'
  if (!source || typeof labelKey !== 'string' || !label.trim()) return
  try {
    const row = await source.create({ [labelKey]: label.trim() })
    selectedRow.value = row
    if (boundLinks.value) selectedRows.value = [...selectedRows.value, row]
    listeners.value['update:modelValue']?.(row[valueKey])
    void source.refresh()
  } catch (error) {
    runtime.notify(apiErrorMessage(error, error instanceof Error ? error.message : String(error)), 'error')
  }
}

// --- A Select menu's search window (`searchWindow`, DataViews.md §9.8) ---------------------------

/** Its options' Resource, opened as a searchable, paged table - a 🔍 beside the select. */
const searchWindowOn = computed(() => name.value === 'USelectMenu' && resolvedProps.value.searchWindow === true && (!live.value || !!optionSource.value))
const searchWindowOpen = ref(false)
/** The Resource's fields as columns, titled and formatted as its columns present them - a uuid key left out. */
const searchWindowColumns = computed(() => {
  const binding = bindings.value.items
  const variable = binding?.kind === 'variable' ? binding.variable : undefined
  if (!searchWindowOpen.value || !variable || !runtime.format) return undefined
  const types = runtime.resourceColumns?.(variable)
  const valueKey = typeof resolvedProps.value.valueKey === 'string' ? resolvedProps.value.valueKey : undefined
  const settings = valueKey && types?.[valueKey] === 'uuid' ? { [valueKey]: { hidden: true } } : undefined
  return resourceTableColumns(runtime.resourceFields?.(variable) ?? [], types, runtime.format, { settings, inherited: runtime.resourcePresentation?.(variable), booleans: { true: t('common.yes'), false: t('common.no') }, icon: iconName => h(UIcon, { name: iconName, class: 'size-3.5' }) })
})
/** Opened, it searches nothing yet; closed, the select's options are its own again. */
watch(searchWindowOpen, (isOpen) => {
  const source = optionSource.value
  if (!source || isOpen || !source.search) return
  searched = ''
  searchTerm.value = ''
  void source.setSearch('')
})
/** A row picked: chosen like an option - read apart so its label shows, then written and announced. */
// The form field around it: a pick is a change it validates - as a choice in the dropdown, which tells it itself.
const formBus = inject(formBusInjectionKey, undefined)
const formField = inject(formFieldInjectionKey, undefined)
function pickFromSearch(row: Record<string, unknown>) {
  const valueKey = typeof resolvedProps.value.valueKey === 'string' ? resolvedProps.value.valueKey : 'id'
  selectedRow.value = row
  if (boundLinks.value) selectedRows.value = [...selectedRows.value, row]
  listeners.value['update:modelValue']?.(row[valueKey])
  searchWindowOpen.value = false
  const fieldName = formField?.value?.name
  if (formBus && fieldName) void nextTick(() => formBus.emit({ type: 'change', name: fieldName }))
}

// --- Expose: dataview.controls.<name> ------------------------------------------

const root = ref<HTMLElement | null>(null)
const controlName = computed(() => (props.field.label ?? '').trim())
if (live.value) {
  watch(controlName, (current, previous) => {
    if (previous) Reflect.deleteProperty(runtime.controls, previous)
    const state = widgetState(name.value)
    if (!current || (!definition.value.expose?.length && Object.keys(state).length === 0)) return
    const control: WidgetControl = {
      open: () => { open.value = true },
      close: () => { open.value = false },
      focus: () => root.value?.querySelector<HTMLElement>('input, textarea, button, [tabindex]')?.focus()
    }
    // The Scanner and the Camera open their own camera modal, a File upload its file picker - `dataview.controls.<name>.open()` opens that.
    if (name.value === 'TScanner' || name.value === 'TCamera' || name.value === 'UFileUpload') {
      control.open = () => componentRef.value?.open?.()
      control.close = () => componentRef.value?.close?.()
      if (name.value === 'TScanner') control.focus = () => componentRef.value?.focus?.()
    }
    // The Signature: Clear starts over; submit() stores what's drawn - a modal's Accept awaits it before closing.
    if (name.value === 'TSignature') {
      control.clear = () => componentRef.value?.clear?.()
      control.submit = () => componentRef.value?.submit?.()
    }
    // The map field and the Location: locate() pins the device's position.
    if (name.value === 'TLeafletMap' || name.value === 'TGeolocation') control.locate = () => componentRef.value?.locate?.()
    // The Result: show() an outcome from the Code, reset() back to waiting.
    if (name.value === 'TResult') {
      control.show = options => componentRef.value?.show?.(options)
      control.reset = () => componentRef.value?.reset?.()
    }
    if (isForm.value) {
      control.submit = () => componentRef.value?.submit?.()
      control.validate = () => componentRef.value?.validate?.()
      control.clear = () => componentRef.value?.clear?.()
      // `dataview.controls.form.data` - read when asked, in the API's envelope.
      Object.defineProperty(control, 'data', { get: () => ({ data: { ...formData.value } }), enumerable: true })
    }
    // Its state, read when asked - formulas reading it follow it.
    if ('value' in state) Object.defineProperty(control, 'value', { get: () => resolvedProps.value.modelValue ?? null, enumerable: true })
    if ('item' in state) Object.defineProperty(control, 'item', { get: () => selectedItem.value ?? null, enumerable: true })
    if ('row' in state) Object.defineProperty(control, 'row', { get: () => lastRow.value, enumerable: true })
    // Hidden by Visible (not Hidden, still active): off the page - a method called says so instead of doing nothing silently.
    for (const method of ['open', 'close', 'focus', 'submit', 'validate', 'clear', 'show', 'reset', 'locate'] as const) {
      const run = control[method] as ((...args: unknown[]) => unknown) | undefined
      if (!run) continue
      control[method] = ((...args: unknown[]) => {
        if (hidden.value && !keptHidden.value) {
          console.warn(`dataview.controls.${current}.${method}(): "${current}" is hidden (Visible) - off the page, so it does nothing. Turn on its "Hidden, still active" to keep it working unseen.`)
          return undefined
        }
        return run(...args)
      }) as never
    }
    runtime.controls[current] = control
  }, { immediate: true })
  onBeforeUnmount(() => {
    if (controlName.value) Reflect.deleteProperty(runtime.controls, controlName.value)
  })
}

// --- Slots -------------------------------------------------------------------

/**
 * The slots drawn: live, those that hold widgets - an empty one keeps the
 * component's own content; on the canvas, every inline slot, as an area to
 * drop into (an `own`-canvas slot is edited apart - DataViews.md §12.4.1).
 */
const drawnSlots = computed(() => Object.entries(definition.value.slots)
  .filter(([slot, meta]) => (runtime.designArea ? meta.canvas !== 'own' : slotHasWidgets(runtime.fields.value, props.field.id, slot, meta.perItem === true)))
  .map(([slot]) => slot))
/** The stored area of `slot` for this rendering - per item for a Tabs' content (`content:<value>`). */
function areaKey(slot: string, scope: unknown): string {
  if (!definition.value.slots[slot]?.perItem) return slot
  const { item, index } = (asSlotProps(scope) ?? {}) as { item?: unknown, index?: number }
  return itemSlot(slot, item, index ?? 0)
}
function slotWidgets(slot: string, scope: unknown) {
  return areaWidgets(runtime.fields.value, props.field.id, areaKey(slot, scope))
}
/**
 * A sizable widget (an editor, a map, a table) has its own height - everything else grows with its content. With
 * Fill height, live, the height its page has left: a sizable widget's never below its own; a fillable container's
 * (a Card, a Box) never below FILLABLE_MIN_HEIGHT - what it holds scrolls inside it then.
 */
const fills = computed(() => live.value && (definition.value.sizable === true || definition.value.fillable === true) && resolvedProps.value.fillHeight === true)
const FILLABLE_MIN_HEIGHT = 120
const filledHeight = useFillHeight(root, fills, computed(() => (definition.value.sizable ? sizableHeight(props.field) : FILLABLE_MIN_HEIGHT)))
/** A fillable container that fills: its own box the height, and its content scrolling inside it. */
const fillsContainer = computed(() => fills.value && definition.value.fillable === true)
/** A fillable container set to Vertical align stretch: its frame the height of its row (its box already is - a grid cell stretches). */
const stretchesToRow = computed(() => definition.value.fillable === true && resolvedProps.value.verticalAlign === 'stretch')
const heightStyle = computed(() => {
  if (fillsContainer.value) return filledHeight.value !== null ? { height: `${filledHeight.value}px` } : undefined
  if (!definition.value.sizable) return undefined
  return { height: `${fills.value && filledHeight.value !== null ? filledHeight.value : sizableHeight(props.field)}px` }
})
/** A per-item area's own name - a Splitter panel's label - for the canvas's "drop here in …". */
function itemLabelOf(scope: unknown): string | undefined {
  const item = (asSlotProps(scope) ?? {}).item as { label?: unknown } | undefined
  return typeof item?.label === 'string' && item.label.trim() ? item.label : undefined
}
/** A slot's props (`{ item, index }`), as `{{slot.*}}` reads them. */
function asSlotProps(scope: unknown): Record<string, unknown> | undefined {
  return scope !== null && typeof scope === 'object' ? scope as Record<string, unknown> : undefined
}
</script>

<template>
  <div
    v-if="!hidden || keptHidden"
    v-show="!keptHidden"
    ref="root"
    class="min-w-0"
    :class="[styleClasses, cssClass, definition.sizable ? 'overflow-auto' : undefined, searchWindowOn ? 'flex items-center gap-1' : undefined]"
    :style="heightStyle"
  >
    <component
      :is="component"
      ref="componentRef"
      v-bind="componentProps"
      :class="[definition.sizable || fillsContainer || stretchesToRow ? 'h-full' : undefined, fillsField || searchWindowOn ? 'w-full' : undefined, searchWindowOn ? 'min-w-0 flex-1' : undefined, fillsContainer && name !== 'UCard' ? 'overflow-auto' : undefined]"
      v-on="listeners"
    >
      <template
        v-for="slot in drawnSlots"
        :key="slot"
        #[slot]="scope"
      >
        <!-- The canvas: an area to drop into, drawn by the Design form. Every area fills the width its slot gives it -
        a Splitter's panel, a Modal's footer are flex rows, where a block would only take its content's width. -->
        <component
          :is="runtime.designArea"
          v-if="runtime.designArea"
          :parent="field.id"
          :slot-name="areaKey(slot, scope)"
          :label="itemLabelOf(scope) ?? cat.slotLabel(name, slot, definition.slots[slot]?.label ?? '')"
        />
        <div
          v-else
          class="widget-area grid w-full min-w-0 grid-cols-12 gap-3"
        >
          <WidgetRenderer
            v-for="child in slotWidgets(slot, scope)"
            :key="child.id"
            :field="child"
            :slot-props="asSlotProps(scope)"
            :style="widgetCellStyle(child)"
          />
        </div>
      </template>
    </component>
    <template v-if="searchWindowOn">
      <UButton
        icon="i-lucide-search"
        color="neutral"
        variant="outline"
        :size="(resolvedProps.size as 'xs' | 'sm' | 'md' | 'lg' | 'xl' | undefined)"
        :disabled="resolvedProps.disabled === true || (componentProps as Record<string, unknown>).disabled === true"
        :aria-label="t('dataviews.widgetSelectSearch.open', { name: selectMenuLabel })"
        @click="searchWindowOpen = live"
      />
      <LazyWidgetSelectSearch
        v-if="live && optionSource"
        v-model:open="searchWindowOpen"
        :title="selectMenuLabel"
        :as="resolvedProps.searchWindowAs === 'modal' ? 'modal' : 'sidebar'"
        :size="(resolvedProps.searchWindowSize as EditSize | undefined)"
        :columns="searchWindowColumns"
        :rows="Array.isArray(optionSource.data) ? (optionSource.data as Record<string, unknown>[]) : []"
        :page="optionSource.page"
        :page-size="optionSource.limit"
        :total="optionSource.count"
        :search-text="optionSource.search"
        :loading="optionSource.status === 'pending'"
        :search="(text: string) => optionSource!.setSearch(text.trim())"
        :set-page="(page: number) => optionSource!.setPage(page)"
        @pick="pickFromSearch"
      />
    </template>
  </div>
</template>
