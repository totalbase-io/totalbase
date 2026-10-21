/**
 * A dashboard widget's data as a file (Dashboards.md §9.2, D8): the columns its roles use, in their
 * order - a TABLE's shown columns - titled and formatted as the widget shows them, never a `_` column. CSV and
 * Excel as a DataView exports them (DataViewExportSlideover.vue): the text on screen, `xlsx` loaded on demand.
 */
import { dashboardWidgetDefinition, resolveDashboardRoles, type DashboardWidgetType } from '@totalbase/tb-catalog'
import type { DashboardQueryResult } from '~/types/dashboard'
import { BROWSER_DATES, categoryLabel, columnTitle, fileLink, formatTableCell, formatWidgetNumber, isFileColumn, isNumericColumn, pivotSpec, pivotTexts, resultColumn, tableColumns, type DateDisplay } from '~/utils/dashboard-widget-render'
import { buildPivot, pivotRowLabels } from '~/utils/dashboard-pivot'

export interface DashboardExportTable {
  headers: string[]
  rows: string[][]
}

/** The widget's columns as text - what CSV and Excel write. */
export function dashboardExportTable(type: DashboardWidgetType, config: Record<string, unknown>, result: DashboardQueryResult, dates: DateDisplay = BROWSER_DATES): DashboardExportTable {
  const { roles } = resolveDashboardRoles(type, config, result.columns)
  // A file's cell is its name, never its id.
  const cell = (name: string, raw: unknown, text: () => string) => (isFileColumn(result, name) ? fileLink(result, raw)?.name ?? (raw === null || raw === undefined ? '' : String(raw)) : text())
  if (type === 'TABLE') {
    const columns = tableColumns(result, config, roles.columns?.columns).filter(c => !c.settings.hidden)
    return {
      headers: columns.map(c => c.header),
      rows: result.rows.map(row => columns.map(c => cell(c.name, row[c.name], () => formatTableCell(row[c.name], c, dates))))
    }
  }
  // As it shows: the first row's fields, a pair per line (D14).
  if (type === 'DETAIL') {
    const columns = tableColumns(result, config, roles.columns?.columns).filter(c => !c.settings.hidden)
    const row = result.rows[0] ?? {}
    return {
      headers: [dates.text?.field ?? 'Field', dates.text?.value ?? 'Value'],
      rows: columns.map(c => [c.header, cell(c.name, row[c.name], () => formatTableCell(row[c.name], c, dates))])
    }
  }
  // As it shows (D17): its row levels and its value columns - Columns values (and Total) with each value - and its
  // subtotal and total rows, PostgreSQL's.
  if (type === 'PIVOT') {
    const pivotRoles = { rows: roles.rows?.columns ?? [], columns: roles.columns?.columns ?? [], values: roles.values?.columns ?? [] }
    const model = buildPivot(result.rows, pivotSpec(result, config, pivotRoles))
    const texts = pivotTexts(result, config, pivotRoles, dates)
    return {
      headers: [...pivotRoles.rows.map(texts.title), ...model.leaves.map(texts.leafTitle)],
      rows: model.rows.map(row => [
        ...pivotRowLabels(row, pivotRoles.rows.length, (i, raw) => texts.dimension(pivotRoles.rows[i]!, raw), texts.total),
        ...model.leaves.map((leaf, i) => texts.value(leaf.value, row.cells[i]?.[leaf.value]))
      ])
    }
  }
  // In the order of its contract's roles (Category, then Values...).
  const names = [...new Set(Object.keys(dashboardWidgetDefinition(type).roles).flatMap(id => roles[id]?.columns ?? []))].filter(name => !name.startsWith('_'))
  const series = (config.series ?? {}) as Record<string, { label?: string, displayFormat?: string }>
  return {
    headers: names.map(name => series[name]?.label ?? columnTitle(result, name)),
    rows: result.rows.map(row => names.map((name) => {
      const presentation = resultColumn(result, name)?.presentation
      if (!isNumericColumn(result, name)) return cell(name, row[name], () => categoryLabel(row[name], dates, presentation))
      if (row[name] === null || row[name] === undefined) return ''
      // As the widget reads it, never compact in a file: its series' format, else the widget's, else its column's.
      const displayFormat = series[name]?.displayFormat ?? (typeof config.displayFormat === 'string' ? config.displayFormat : undefined)
      return formatWidgetNumber(row[name], { config: { compact: false, ...(displayFormat && { displayFormat }) }, presentation, locale: dates.locale })
    }))
  }
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/** A file name from the widget's title - its letters and digits, else "widget". */
export function exportFileName(title: string, extension: string): string {
  const base = title.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return `${base || 'widget'}.${extension}`
}

export async function downloadDashboardTable(table: DashboardExportTable, format: 'csv' | 'xlsx', title: string): Promise<void> {
  if (format === 'csv') {
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
    const lines = [table.headers.map(escape).join(','), ...table.rows.map(line => line.map(escape).join(','))]
    download(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' }), exportFileName(title, 'csv'))
    return
  }
  const XLSX = await import('xlsx')
  const sheet = XLSX.utils.aoa_to_sheet([table.headers, ...table.rows])
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1')
  XLSX.writeFile(workbook, exportFileName(title, 'xlsx'))
}

/** A chart's image (its data URL) as a PNG file named after the widget. */
export function downloadImage(dataUrl: string, title: string): void {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = exportFileName(title, 'png')
  link.click()
}
