/**
 * Saves a file in the browser: a Blob, or text with its type. The object URL is revoked a little later, not at once
 * - some browsers start the download only after the click returns.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadText(content: string, filename: string, type: string): void {
  downloadBlob(new Blob([content], { type }), filename)
}

/**
 * One CSV cell (RFC 4180): quoted when it holds a quote, a comma or a line break; an object as its JSON. Text that a
 * spreadsheet would read as a formula - starting with `=`, `+`, `-`, `@`, a tab or a carriage return - gets a leading
 * `'`, so a record's value (`=HYPERLINK(...)`) opens as the text it is, never as a formula (DataViews.md §5.10). A number
 * stays a number.
 */
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Rows as CSV text - the header first. */
export function toCsv(rows: unknown[][]): string {
  return rows.map(row => row.map(csvCell).join(',')).join('\n')
}

/** Saves rows as a UTF-8 CSV file. */
export function downloadCsv(rows: unknown[][], filename: string): void {
  downloadText(toCsv(rows), filename, 'text/csv;charset=utf-8;')
}
