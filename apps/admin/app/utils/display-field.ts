/**
 * A foreign key column that shows a related column (`display_field`) or a
 * template over several (`display_template`, `{{name}} ({{country}})`, as
 * Directus's display templates): the keys its values come back under, the
 * text it shows, and what it sorts by. Plain functions -
 * the grid (build-dataview-columns.ts, DataViewGrid.vue) and Settings'
 * Columns both read them.
 */
import type { DataViewField } from '~/types/dataview'

/**
 * The dotted-path output alias an FK column's related `display_field`
 * comes back under (query-engine's own `fields=a.b` -> row key `"a.b"`
 * convention, packages/query-engine/src/compiler.ts's `field.path.length
 * > 1 ? dotted : field.path[0]`) - shared by DataViewGrid.vue (which
 * requests it) and `renderCell` below (which reads it back), so the two
 * can never drift on the literal string.
 */
export function displayFieldAlias(columnName: string, displayField: string): string {
  return `${columnName}.${displayField}`
}

/**
 * What a column sorts by: what it shows. An FK showing a related column
 * (`display_field`) sorts by that column (`brand.name`), not by its key -
 * unless this viewer may not read it (`display_field_denied`).
 */
export function sortKey(field: DataViewField): string {
  const config = field.config as DisplayConfig & { display_field_denied?: boolean }
  // A template sorts by its first column - the one it leads with.
  const first = displayColumns(config)[0]
  return first && !config.display_field_denied ? displayFieldAlias(field.columnName!, first) : field.columnName!
}

/** A stored sort (`-brand.name,id`) this viewer can run: an entry on a related column they may not read sorts by its key instead. */
export function sortForViewer(sort: string, fields: DataViewField[]): string {
  const denied = new Map(fields.flatMap((field) => {
    const config = field.config as { display_field?: string, display_field_denied?: boolean }
    return field.columnName && config.display_field && config.display_field_denied ? [[displayFieldAlias(field.columnName, config.display_field), field.columnName] as const] : []
  }))
  if (denied.size === 0) return sort
  return sort.split(',').map((entry) => {
    const desc = entry.startsWith('-')
    const key = desc ? entry.slice(1) : entry
    return denied.has(key) ? `${desc ? '-' : ''}${denied.get(key)}` : entry
  }).join(',')
}

/** What an FK column shows: one related column (`display_field`), or a template over them (`display_template`, `{{name}} ({{country}})`). */
export interface DisplayConfig {
  display_field?: string
  display_template?: string
}

const DISPLAY_TOKEN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

/** The related table's columns an FK column shows - its template's, in order, or its one `display_field`. */
export function displayColumns(config: DisplayConfig | undefined): string[] {
  const template = config?.display_template?.trim()
  if (template) {
    const columns = [...template.matchAll(DISPLAY_TOKEN)].map(m => m[1]!)
    if (columns.length) return [...new Set(columns)]
  }
  return config?.display_field ? [config.display_field] : []
}

/**
 * The text an FK column shows for one related row, `valueOf` reading each
 * related column - its template filled in (an empty value reads as empty),
 * or its `display_field`'s value. Null when there's nothing to show (no
 * related row): the caller shows the key instead.
 */
export function displayText(config: DisplayConfig | undefined, valueOf: (column: string) => unknown): string | null {
  const columns = displayColumns(config)
  if (columns.length === 0) return null
  const values = columns.map(valueOf)
  if (values.every(v => v === null || v === undefined || v === '')) return null
  const template = config?.display_template?.trim()
  if (!template || [...template.matchAll(DISPLAY_TOKEN)].length === 0) return String(values[0] ?? '')
  return template.replace(DISPLAY_TOKEN, (_, column: string) => {
    const value = valueOf(column)
    return value === null || value === undefined ? '' : String(value)
  }).trim()
}

/**
 * The foreign-key columns whose row this viewer sees as text - a select showing a related column or a template,
 * whose display they may read (not `display_field_denied`). The grid fetches what they show; a layout's formulas
 * show them by it.
 */
export function foreignKeyDisplayFields(fields: DataViewField[]): DataViewField[] {
  return fields.filter(f => f.kind === 'COLUMN' && f.columnName && f.widget === 'USelectMenu'
    && displayColumns(f.config as DisplayConfig).length > 0 && !(f.config as { display_field_denied?: boolean }).display_field_denied)
}

/** What each of those columns shows for one fetched row - for a formula's `foreignKeyText`; a key with no related row is left out (it shows as itself). */
export function foreignKeyTexts(fields: DataViewField[], row: Record<string, unknown>): Record<string, string> {
  const texts: Record<string, string> = {}
  for (const field of fields) {
    const text = displayText(field.config as DisplayConfig, column => row[displayFieldAlias(field.columnName!, column)])
    if (text !== null) texts[field.columnName!] = text
  }
  return texts
}
