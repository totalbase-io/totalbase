import type { DataViewField } from '~/types/dataview'
import type { ColumnValueSource } from '~/types/permission'

interface ValuesConfig {
  display_field?: string
  display_template?: string
  display_field_target?: { schema: string, table: string, column: string }
  display_field_denied?: boolean
  options?: Record<string, { label?: string }>
}

/**
 * Where a DataView column's possible values come from - for the filter's `=`, `≠` and `in`
 * (FilterValuePicker.vue) and its chips' labels: a foreign key the viewer may see shown, the rows of
 * the table it points at, by its row presentation; a CHECK list (`checkValues`, the catalog's), its
 * values labelled by the column's presentation. Neither: none - the value is typed.
 */
export function columnValueSource(field: DataViewField, checkValues?: readonly string[]): ColumnValueSource | undefined {
  const config = (field.config ?? {}) as ValuesConfig
  if (field.kind === 'COLUMN' && config.display_field_target && config.display_field && !config.display_field_denied) {
    const target = config.display_field_target
    return {
      kind: 'relation',
      schema: target.schema,
      table: target.table,
      column: target.column,
      display: { display_field: config.display_field, ...(config.display_template ? { display_template: config.display_template } : {}) }
    }
  }
  if (checkValues?.length) {
    return { kind: 'list', items: checkValues.map(value => ({ value, label: config.options?.[value]?.label || value })) }
  }
  return undefined
}
