import { regionalLocale } from '~/utils/regional-locale'
import type { DataViewField } from '~/types/dataview'
import type { CatalogColumn } from '~/types/permission'
import { resolveFieldPresentation } from '~/utils/field-presentation'

/** One pickable column in a layout setting's select. */
export interface ColumnOption { name: string, label: string }

/** COLUMN fields as select options - each titled as it shows, its table column's (Specification_DataViews.md §15). */
export function columnOptions(fields: DataViewField[]): ColumnOption[] {
  return fields.filter(f => f.columnName).map(f => ({ name: f.columnName!, label: resolveFieldPresentation(f).label || f.columnName! }))
}

/** A DataView COLUMN field that points at a real source column. */
export type DataViewColumnField = DataViewField & { columnAttnum: number }

/**
 * The column fields whose PostgreSQL type passes `test` - a
 * `DataViewField` carries only `columnAttnum`, so the type comes from the
 * source table's catalog.
 */
export function columnFieldsOfType(fields: DataViewColumnField[], catalog: CatalogColumn[], test: (dataType: string) => boolean): DataViewColumnField[] {
  const dataTypeByAttnum = new Map(catalog.map(c => [c.attnum, c.dataType]))
  return fields.filter(f => test(dataTypeByAttnum.get(f.columnAttnum) ?? ''))
}

/** The field for one column name, or null. */
export function columnField(fields: DataViewField[], columnName: string | null | undefined): DataViewField | null {
  return columnName ? fields.find(f => f.kind === 'COLUMN' && f.columnName === columnName) ?? null : null
}

/** "Showing the first N of M ..." - the layouts without a pager fetch one capped page, and say so when rows were left out. */
export function cappedNotice(total: number, limit: number, where: string): string | null {
  if (total <= limit) return null
  const i18n = useNuxtApp().$i18n
  const bcp47 = regionalLocale()
  return i18n.t('database.dataviewColumns.cappedNotice', { limit: limit.toLocaleString(bcp47), total: total.toLocaleString(bcp47), where })
}
