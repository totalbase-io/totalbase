import type { DataViewField } from '~/types/dataview'
import type { DisplayFormatDefaults } from '~/composables/useDisplayFormatDefaults'
import { formatCellPlainText } from '~/utils/build-dataview-columns'

/**
 * A record's values as text, "Label: value" one per line - the shape to
 * paste into a message or an email. Only real columns (a page's widgets
 * have nothing of their own to copy), in the page's order and labels, each
 * value read the way the grid and Print show it. `values` are the ones on
 * screen, unsaved edits included.
 */
export function recordAsText(values: Record<string, unknown>, fields: DataViewField[], displayFormatDefaults?: DisplayFormatDefaults): string {
  return fields
    .filter(f => f.kind === 'COLUMN' && f.columnName)
    .map(f => `${f.label ?? f.columnName!}: ${formatCellPlainText(f, values[f.columnName!], values, displayFormatDefaults)}`)
    .join('\n')
}
