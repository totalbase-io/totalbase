import type { ComputedRef, Ref } from 'vue'
import { isValueType, WIDGET_NAMES, widgetDefinition, type ValueType, type VariableDefinition, type WidgetName } from '@totalbase/tb-catalog'
import type { DataViewField } from '~/types/dataview'
import type { RelationDefinition, RelationDetail } from '~/types/schema'
import type { CanvasDropTarget } from '~/composables/useCustomCanvasContext'
import type { JunctionCandidate } from '~/utils/junction-links'
import { useDesignerCatalogText } from '~/utils/designer-catalog-text'

/** The inputs that pick from a list - a foreign key's options fill them. */
const OPTION_INPUTS: readonly WidgetName[] = ['USelectMenu', 'USelect', 'UInputMenu', 'URadioGroup']
/** The inputs that pick several - a junction's links (DataViews.md §8.5); the first is a new one's. */
export const JUNCTION_INPUTS: readonly WidgetName[] = ['USelectMenu', 'UCheckboxGroup', 'UInputMenu', 'USelect', 'UListbox']

/**
 * Placing a form field on a designed page (CustomDesigner.vue): a UFormField
 * and its input, bound to a record column (a foreign key's select fed by a
 * Resource of its target table), to a new Value, or to nothing. Saved as it
 * goes; a field is never left without its input.
 */
export function useDesignerFormFields(options: {
  dataviewId: string
  /** Every write, tracked for the header's status. */
  track: <T>(write: Promise<T>) => Promise<T>
  fields: Ref<DataViewField[]>
  variables: Ref<VariableDefinition[]>
  recordRelations: ComputedRef<RelationDefinition[]>
  /** The record table's junction tables - a field linked through one picks the other table's rows. */
  recordJunctions: Ref<JunctionCandidate[]>
  /** `field`, already in `target`'s area, moved to `target.index`. */
  insertAt: (field: DataViewField, target: CanvasDropTarget) => Promise<void>
  /** A widget's starting props - without its sample label inside a form field. */
  startingProps: (name: WidgetName, parentId: string | null | undefined) => Record<string, unknown>
  /** The title a column's field shows with none of its own. */
  columnTitle: (column: string) => string
  /** The input a column is edited with (DataViews.md §15.2). */
  inputForColumn: (column: string) => WidgetName
}) {
  const api = useAdminApi()
  const cat = useDesignerCatalogText()
  // The shared registry (useResourcesList) - a foreign key's target must be readable through the Data API.
  const { resources } = useResourcesList()

  /** The widgets a form field can hold - the inputs. */
  const inputOptions = computed(() => WIDGET_NAMES
    .filter(name => widgetDefinition(name).formField)
    .map(name => ({ label: cat.widgetLabel(name, widgetDefinition(name).label), description: cat.widgetDescription(name, widgetDefinition(name).description), icon: widgetDefinition(name).icon, value: name })))

  /** The Value type an input keeps its value in - the first value kind it accepts. */
  function valueTypeFor(input: WidgetName): ValueType {
    return (widgetDefinition(input).accepts ?? []).find(isValueType) ?? 'text'
  }
  /** `Razón social` → `razonSocial`, unique among the variables. */
  function identifierFrom(label: string): string {
    const words = label.normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean)
    let base = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join('') || 'field'
    if (!/^[a-z]/.test(base)) base = `field${base}`
    let name = base
    for (let i = 2; options.variables.value.some(v => v.name === name); i++) name = `${base}${i}`
    return name
  }

  /**
   * A foreign key's options as a Resource of its target table (DataViews.md §9.2):
   * its key and first text column, ordered by it, 100 at a time - with the
   * select bound to it. Null when the target isn't readable through the
   * Data API: the select then takes its options from the author.
   */
  async function foreignKeyOptions(column: string): Promise<{ variable: VariableDefinition, props: Record<string, unknown>, existing: boolean } | null> {
    const fk = options.recordRelations.value.find(r => r.sourceColumn === column)
    return fk ? targetOptions(fk) : null
  }
  /** The rows of the table a key points at as a select's options - a foreign key's, or a junction's other table's (§8.5). */
  async function targetOptions(fk: { targetSchema: string, targetTable: string, targetColumn: string }): Promise<{ variable: VariableDefinition, props: Record<string, unknown>, existing: boolean } | null> {
    const target = resources.value.find(r => r.schema === fk.targetSchema && r.name === fk.targetTable && r.status === 'ACTIVE' && r.exposedMethods.includes('GET'))
    if (!target) return null
    // A Resource of that table already reading its key: the same options - reused, not copied.
    const reused = options.variables.value.find((v): v is Extract<VariableDefinition, { kind: 'RESOURCE' }> => v.kind === 'RESOURCE' && v.resource === target.id && String(v.query.fields).split(',').includes(fk.targetColumn))
    if (reused) {
      const fieldsRead = String(reused.query.fields).split(',')
      return { variable: reused, props: { valueKey: fk.targetColumn, labelKey: fieldsRead.find(f => f !== fk.targetColumn) ?? fk.targetColumn }, existing: true }
    }
    const { data } = await api.get<RelationDetail>(`/catalog/${target.type === 'VIEW' ? 'view' : 'table'}/${target.id}`)
    const label = data.columns.find(c => c.name !== fk.targetColumn && /^(text|character varying|character|citext)/.test(c.dataType))?.name ?? fk.targetColumn
    const fields = label === fk.targetColumn ? label : `${fk.targetColumn},${label}`
    return {
      variable: { name: identifierFrom(fk.targetTable), kind: 'RESOURCE', resource: target.id, query: { fields, order_by: label, limit: 100 }, mode: 'list', immediate: true, watch: false, count: false },
      props: { valueKey: fk.targetColumn, labelKey: label },
      existing: false
    }
  }

  /**
   * Places a form field and its input at `target`: bound to a record column
   * (a foreign key's select fed by a Resource of its target table), to a new
   * Value, or to nothing. Saved as it goes; a field is never left without its
   * input.
   */
  async function placeField(spec: { label: string, input: WidgetName, column?: string, junction?: string, variable?: string, target: CanvasDropTarget }): Promise<DataViewField> {
    const junction = spec.junction ? options.recordJunctions.value.find(j => j.resourceId === spec.junction) : undefined
    const fkOptions = junction && JUNCTION_INPUTS.includes(spec.input)
      ? await targetOptions({ targetSchema: junction.target.schema, targetTable: junction.target.table, targetColumn: junction.target.column })
      : spec.column && OPTION_INPUTS.includes(spec.input) ? await foreignKeyOptions(spec.column) : null
    if (fkOptions && !fkOptions.existing) {
      const next = [...options.variables.value, fkOptions.variable]
      await options.track(api.patch(`/dataviews/${options.dataviewId}`, { data: { viewConfig: { variables: next } } }))
      options.variables.value = next
    }
    if (spec.variable && !options.variables.value.some(v => v.name === spec.variable)) {
      // Saved now, not through the autosave: the server checks the input's binding against the saved variables.
      const next = [...options.variables.value, { name: spec.variable, kind: 'VALUE' as const, type: valueTypeFor(spec.input) }]
      await options.track(api.patch(`/dataviews/${options.dataviewId}`, { data: { viewConfig: { variables: next } } }))
      options.variables.value = next
    }
    const { target } = spec
    // Bound to a column, a title that is the one it inherits isn't stored - it follows its column (DataViews.md §15).
    const fieldProps = spec.column
      ? { column: spec.column, ...(spec.label.trim() && spec.label.trim() !== options.columnTitle(spec.column) ? { label: spec.label.trim() } : {}) }
      : junction ? { junction: junction.resourceId, label: spec.label } : { label: spec.label }
    // Its column's input follows the column (§15.2): a change there reaches this form too.
    const fromColumn = Boolean(spec.column) && spec.input === options.inputForColumn(spec.column!)
    const { data: field } = await options.track(api.post<DataViewField>(`/dataviews/${options.dataviewId}/widgets`, {
      data: {
        widget: 'UFormField',
        parent: target.parent,
        config: { props: fieldProps, ...(target.slot ? { slot: target.slot } : {}) }
      }
    }))
    const inputProps = options.startingProps(spec.input, field.id)
    const bindings = spec.variable
      ? { modelValue: { kind: 'variable', variable: spec.variable } }
      : fkOptions ? { items: { kind: 'variable', variable: fkOptions.variable.name } } : {}
    let inputField: DataViewField
    try {
      inputField = (await options.track(api.post<DataViewField>(`/dataviews/${options.dataviewId}/widgets`, {
        data: {
          widget: spec.input,
          parent: field.id,
          config: { slot: 'default', props: { ...inputProps, ...fkOptions?.props, ...(junction && 'multiple' in widgetDefinition(spec.input).props && { multiple: true }) }, bindings, emits: {}, ...(fromColumn && { fromColumn: true }) }
        }
      }))).data
    } catch (error) {
      // No field without its input.
      await api.del(`/dataviews/${options.dataviewId}/fields/${field.id}`).catch(() => {})
      throw error
    }
    options.fields.value = [...options.fields.value, field, inputField]
    await options.insertAt(field, target)
    return field
  }

  return { inputOptions, valueTypeFor, identifierFrom, placeField }
}
