/**
 * A grid column as it shows (DataViews.md §15):
 * its title, display options, look and conditions are its table's column's
 * (`field.inherited` - live on a draft, frozen on a published read) - a
 * DataView's column has none of its own, only what its list does with it
 * (truncate, copy, total). With no title, its name humanized (a related
 * column's "Fk · Column"). What the grid, its layouts, its export and its
 * print read.
 */
import { TABLE_COLUMN_PRESENTATION_KEYS, columnTitle, type ColumnCondition } from '@totalbase/tb-catalog'
import type { DataViewField } from '~/types/dataview'
import { humanizeColumnName } from '~/utils/humanize-column-name'

/** A column's name as its title, with none set: `precio_unitario` → "Precio Unitario"; a related `producto.codigo` → "Producto · Codigo". */
export function defaultColumnTitle(field: Pick<DataViewField, 'kind' | 'columnName'>): string {
  const name = field.columnName ?? ''
  if (field.kind !== 'RELATED') return humanizeColumnName(name)
  const [fk = '', column = ''] = name.split('.')
  return `${humanizeColumnName(fk)} · ${humanizeColumnName(column)}`
}

export function resolveFieldPresentation(field: DataViewField): DataViewField {
  if ((field.kind !== 'COLUMN' && field.kind !== 'RELATED') || !field.columnName) return field
  const inherited: Record<string, unknown> = {}
  for (const key of TABLE_COLUMN_PRESENTATION_KEYS) {
    if (key !== 'label' && field.inherited?.[key] !== undefined) inherited[key] = field.inherited[key]
  }
  const conditions = ((field.inherited as { conditions?: ColumnCondition[] } | undefined)?.conditions) ?? []
  return {
    ...field,
    label: columnTitle(field.inherited, defaultColumnTitle(field)),
    config: { ...inherited, ...field.config, ...(conditions.length ? { conditions } : {}) }
  }
}

/** Each column's title by its column name - what its grid header says - for a list that names columns (Activity's changes). */
export function columnTitles(fields: DataViewField[]): Record<string, string> {
  return Object.fromEntries(fields
    .filter(f => (f.kind === 'COLUMN' || f.kind === 'RELATED') && f.columnName)
    .map(f => [f.columnName!, resolveFieldPresentation(f).label ?? f.columnName!]))
}
