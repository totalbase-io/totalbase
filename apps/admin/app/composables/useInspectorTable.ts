import type { Ref } from 'vue'
import { widgetDefinition, type ColumnPresentation, type TableComputedColumn, type WidgetControlConfig } from '@totalbase/tb-catalog'
import type { CatalogColumn } from '~/types/permission'
import { COMPUTED_DATA_TYPES, inheritedTableSettings } from '~/utils/widget-table'

/**
 * What a Table's (and an option list's) inspector fields read from the
 * Resource its Rows are bound to (WidgetInspector.vue): its fields in order
 * with their types - a field picker's choices, Columns' list, what a formula
 * per row reads as {{campo}} - and what each column inherits from its
 * resource's presentation.
 */
export function useInspectorTable(options: {
  config: Ref<WidgetControlConfig>
  /** A Resource variable's fields, in order. */
  resourceFields: () => ((variable: string) => string[] | undefined) | undefined
  /** A Resource variable's columns, name → PostgreSQL type. */
  resourceColumns: () => ((variable: string) => Record<string, string> | undefined) | undefined
  /** What a Resource variable's resource columns set. */
  resourcePresentation: () => ((variable: string) => Record<string, ColumnPresentation> | undefined) | undefined
}) {
  const { t } = useI18n()
  const asCatalogColumns = (list: { name: string, dataType: string }[]): CatalogColumn[] => list.map((c, index) => ({
    attnum: index + 1, name: c.name, dataType: c.dataType, nullable: true, isIdentity: false, isGenerated: false, defaultExpression: null
  }))

  /** The Resource variable a Table's Rows are bound to. */
  const boundVariable = computed(() => {
    const rows = Object.entries(widgetDefinition(options.config.value.widget).props).find(([, p]) => p.binding === 'resource')?.[0]
    const binding = rows ? options.config.value.bindings[rows] : undefined
    return binding?.kind === 'variable' ? binding.variable : undefined
  })
  /** A Table's Columns: the fields its Resource reads, in order, each with its type. */
  const boundColumns = computed(() => {
    const variable = boundVariable.value
    if (!variable) return []
    const types = options.resourceColumns()?.(variable) ?? {}
    return (options.resourceFields()?.(variable) ?? []).map(name => ({ name, dataType: types[name] ?? 'text' }))
  })
  /** A field picker's choices: the bound Resource's fields, each with its type. */
  const fieldItems = computed(() => boundColumns.value.map(c => ({ label: c.name, description: c.dataType, value: c.name })))
  /** A field named that its Resource doesn't read - every option would show nothing (T64). A formula is a binding, not this. */
  function unknownField(name: string): string | undefined {
    const value = options.config.value.props[name]
    const field = typeof value === 'string' ? value : undefined
    if (!field || !boundColumns.value.length || fieldItems.value.some(i => i.value === field)) return undefined
    return t('designer.inspector.unknownField', { field })
  }
  /** The same fields for the Bind modal's Fields - a per-option formula reads them as {{campo}}. */
  const boundFieldColumns = computed<CatalogColumn[]>(() => asCatalogColumns(boundColumns.value))
  /** A Table's computed columns - after its Rows' fields in Columns, and fields of its formulas per row. */
  const computedColumns = computed(() => (Array.isArray(options.config.value.props.computedColumns) ? options.config.value.props.computedColumns as TableComputedColumn[] : []))
  /** Its Rows' fields and its computed columns, each with its type - what Columns lists. */
  const tableColumnList = computed(() => [...boundColumns.value, ...computedColumns.value.map(c => ({ name: c.key, dataType: COMPUTED_DATA_TYPES[c.type] }))])
  /** What a formula per row reads as {{campo}}: its Rows' fields, then its computed columns. */
  const rowFieldColumns = computed<CatalogColumn[]>(() => asCatalogColumns(tableColumnList.value))
  /** What each of them inherits from its resource's column. */
  const boundInherited = computed(() => (boundVariable.value ? inheritedTableSettings(options.resourcePresentation()?.(boundVariable.value)) : undefined))

  return { boundVariable, boundColumns, fieldItems, unknownField, boundFieldColumns, computedColumns, tableColumnList, rowFieldColumns, boundInherited }
}
