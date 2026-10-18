/**
 * How a foreign key's target row reads where a value is picked (Specification_DataViews.md §4.4): its row
 * presentation's template (`{{codigo}} · {{nombre}}`), else its display field, else its key - the columns to read
 * and search, and the text.
 */
import type { DataViewField } from '~/types/dataview'

export interface ForeignKeyDisplay {
  columns: string[]
  text: (row: Record<string, unknown>) => string
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g

export function foreignKeyDisplay(field: Pick<DataViewField, 'config'> | undefined, key: string): ForeignKeyDisplay {
  const config = field?.config as { display_field?: string, display_template?: string } | undefined
  const template = config?.display_template
  const columns = template ? [...new Set([...template.matchAll(PLACEHOLDER)].map(m => m[1]!))] : []
  if (template && columns.length) {
    return { columns, text: row => template.replace(PLACEHOLDER, (_, c: string) => (row[c] === null || row[c] === undefined ? '' : String(row[c]))).trim() || String(row[key] ?? '') }
  }
  const shown = config?.display_field ?? key
  return { columns: [shown], text: row => String(row[shown] ?? row[key] ?? '') }
}

/** A search over every column it shows - the Data API's `where`, `_or` of `_ilike`. */
export function foreignKeySearch(display: ForeignKeyDisplay, term: string): Record<string, unknown> | null {
  return term.trim() ? { _or: display.columns.map(c => ({ [c]: { _ilike: `%${term.trim()}%` } })) } : null
}
