import type { DataViewField } from '~/types/dataview'
import type { TemporalKind } from '~/utils/format-pattern'

/**
 * `evaluateFormula`'s `columnKinds` option for a DataView's COLUMN fields -
 * only the TEMPORAL ones (`config.displayFormatKind` date/time/datetime).
 * The formula engine boxes every column listed here as a real `Date`;
 * `displayFormatKind` can also be `'number'`, and passing that through made
 * every numeric column resolve to nothing inside a layout formula (a Card
 * description `"$" + {{price}}` rendered just "$" - regression-tested in
 * formula-column-kinds.test.ts).
 */
export function temporalColumnKinds(fields: DataViewField[]): Record<string, TemporalKind> {
  const kinds: Record<string, TemporalKind> = {}
  for (const field of fields) {
    if (field.kind !== 'COLUMN' || !field.columnName) continue
    const kind = (field.config as { displayFormatKind?: string }).displayFormatKind
    if (kind === 'date' || kind === 'time' || kind === 'datetime') kinds[field.columnName] = kind
  }
  return kinds
}
