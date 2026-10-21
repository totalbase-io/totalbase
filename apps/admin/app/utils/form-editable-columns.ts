/**
 * The columns a DataView's record form lets a viewer edit, as the form shows them (DataViews.md §5.15) -
 * what a bulk edit offers: its form fields bound to a column, in the form's order (row by row, into its containers),
 * titled as the form titles them - the field's own label, else its column's presentation, else the column's name
 * humanized. Not one hidden, read only or disabled, nor one PostgreSQL fills (shown only once the record exists).
 */
import type { ColumnPresentation } from '@totalbase/tb-catalog'
import type { DataViewField } from '~/types/dataview'
import { fieldColumn, fieldInput } from '~/utils/widget-form'
import { humanizeColumnName } from '~/utils/humanize-column-name'

export interface FormColumn {
  column: string
  label: string
}

interface WidgetConfig {
  props?: Record<string, unknown>
  bindings?: Record<string, unknown>
}

/** The form's widgets in reading order: each area row by row, a container's content where it sits. */
function inOrder(fields: readonly DataViewField[], parent: string | null): DataViewField[] {
  return fields
    .filter(f => f.kind === 'WIDGET' && f.parent === parent)
    .sort((a, b) => a.gridY - b.gridY || a.gridX - b.gridX)
    .flatMap(f => [f, ...inOrder(fields, f.id)])
}

/** A widget whose prop is on, or bound to a formula (it may be on). */
const turnedOn = (field: DataViewField | undefined, prop: string) => {
  const config = field?.config as WidgetConfig | undefined
  return config?.props?.[prop] === true || config?.bindings?.[prop] !== undefined
}

export function formEditableColumns(fields: readonly DataViewField[], presentation: Record<string, ColumnPresentation> | undefined): FormColumn[] {
  const seen = new Set<string>()
  return inOrder(fields, null).flatMap((field): FormColumn[] => {
    const column = fieldColumn(field)
    if (!column || seen.has(column)) return []
    const props = (field.config as WidgetConfig).props ?? {}
    // Hidden, or shown only on a saved record (a column PostgreSQL fills); read only or disabled, the field or its input.
    if (props.visible === false || turnedOn(field, 'visible') || turnedOn(field, 'readonly') || turnedOn(field, 'disabled')) return []
    const input = fieldInput(fields, field.id)
    if (turnedOn(input, 'readonly') || turnedOn(input, 'disabled')) return []
    seen.add(column)
    const own = typeof props.label === 'string' && props.label.trim() ? props.label : null
    return [{ column, label: own ?? presentation?.[column]?.label ?? humanizeColumnName(column) }]
  })
}
