import type { DataViewField } from '~/types/dataview'
import type { DisplayFormatDefaults } from '~/composables/useDisplayFormatDefaults'
import { format as formatDateFns } from 'date-fns'
import { formatInTimeZone } from 'date-fns-tz'
import { formatCellPlainText } from '~/utils/build-dataview-columns'
import { clockOptions } from '~/utils/datetime-local'

const PRINT_MARGIN = 40
const FONT_SIZE = 10

export interface RecordPrintOptions {
  /** The DataView's own name/description (DataViewGrid.vue's own printPdf() doc comment) - a blank one takes no line. */
  dataviewTitle: string
  dataviewDescription: string
  /** Replaces the grid Print's own "active filter" header line - a single record has no filter, just which one this is. */
  recordLabel: string
  fields: DataViewField[]
  values: Record<string, unknown>
  displayFormatDefaults?: DisplayFormatDefaults
  /** The UI's language (Admin_UI.md §14): the table's headers, the page footer and the Intl locale of the printed-at time. */
  labels: { field: string, value: string, page: (page: number, pages: number) => string, locale: string }
}

/**
 * A single record as a Field/Value PDF - deliberately NOT DataViewGrid.vue's
 * own printPdf() (built for MANY rows, few chosen columns); here it's the
 * opposite shape, one row's worth of EVERY field, laid out as two columns
 * instead of one row per record. No paper-size/orientation/scope options
 * dialog the way the grid's own Print has - a single record has no "how
 * many rows" question to ask, so this just generates and prints
 * immediately with sane fixed defaults (A4 portrait, 10pt).
 */
export async function printRecordPdf(options: RecordPrintOptions): Promise<Blob> {
  const cols = options.fields.filter(f => f.kind === 'COLUMN' && f.columnName)
  const [{ jsPDF }, autoTableModule] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const autoTable = autoTableModule.default
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const lineHeight = FONT_SIZE + 6
  // Only the lines that have text take room under the title - no blank gap for a missing description.
  const description = options.dataviewDescription.trim()
  const recordLabel = options.recordLabel.trim()
  const headerHeight = PRINT_MARGIN + lineHeight * ((description ? 1 : 0) + (recordLabel ? 1 : 0))
  const footerHeight = 30

  function drawHeader() {
    let y = PRINT_MARGIN - 10
    doc.setFontSize(FONT_SIZE + 4)
    doc.setFont('helvetica', 'bold')
    doc.text(options.dataviewTitle, PRINT_MARGIN, y)
    y += lineHeight
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(FONT_SIZE)
    if (description) {
      doc.text(description, PRINT_MARGIN, y)
      y += lineHeight
    }
    if (recordLabel) {
      doc.setFontSize(FONT_SIZE - 1)
      doc.setTextColor(120)
      doc.text(recordLabel, PRINT_MARGIN, y)
      doc.setTextColor(0)
      doc.setFontSize(FONT_SIZE)
    }
  }

  autoTable(doc, {
    startY: headerHeight,
    margin: { top: headerHeight, bottom: footerHeight },
    styles: { fontSize: FONT_SIZE },
    head: [[options.labels.field, options.labels.value]],
    body: cols.map(f => [
      f.label ?? f.columnName!,
      formatCellPlainText(f, options.values[f.columnName!], options.values, options.displayFormatDefaults)
    ]),
    didDrawPage: drawHeader
  })

  // In the viewer's zone and date-time format (My account), like every other date on the page.
  const now = new Date()
  const display = options.displayFormatDefaults
  const printedAt = display?.datetimeFormat
    ? (display.timezone ? formatInTimeZone(now, display.timezone, display.datetimeFormat) : formatDateFns(now, display.datetimeFormat))
    : now.toLocaleString(options.labels.locale, { ...clockOptions(), timeZone: display?.timezone || undefined })
  // `getNumberOfPages` is real at runtime (jsPDF's own `internal`) but missing from the installed version's own `.d.ts` - narrow cast instead of `any`, keeps the RESULT typed.
  const pageCount = (doc.internal as unknown as { getNumberOfPages: () => number }).getNumberOfPages()
  doc.setFontSize(8)
  doc.setTextColor(120)
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    doc.text(printedAt, PRINT_MARGIN, pageHeight - 15)
    doc.text(options.labels.page(i, pageCount), pageWidth - PRINT_MARGIN, pageHeight - 15, { align: 'right' })
  }
  doc.setTextColor(0)

  return doc.output('blob')
}
