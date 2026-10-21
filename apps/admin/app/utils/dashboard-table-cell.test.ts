import { describe, expect, it } from 'vitest'
import { formatTableCell } from './dashboard-widget-render'

const number = (settings = {}) => ({ dataType: 'numeric', numeric: true, settings })
const text = (settings = {}) => ({ dataType: 'text', numeric: false, settings })
const locale = (n: number, decimals: number) => new Intl.NumberFormat(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n)

// A Dashboard TABLE's cell, by its column's settings (DataViews.md §15).
describe('formatTableCell()', () => {
  it('formats a number with its Format - prefix, suffix and decimals in one pattern', () => {
    expect(formatTableCell('1234.5', number({ displayFormat: '"$ "#,##0.00" kg"' }))).toBe(`$ ${locale(1234.5, 2)} kg`)
    expect(formatTableCell(2, number())).toBe(locale(2, 0))
  })

  it('formats a date and a timestamp with their Format', () => {
    expect(formatTableCell('2026-10-02', { dataType: 'date', numeric: false, settings: { displayFormat: 'dd/MM/yyyy' } })).toBe('02/10/2026')
    expect(formatTableCell('2026-10-02T15:30:00Z', { dataType: 'timestamp with time zone', numeric: false, settings: { displayFormat: 'dd/MM/yyyy HH:mm' } }, undefined, 'UTC'))
      .toBe('02/10/2026 15:30')
  })

  it('shows its Empty text for NULL, its true/false labels and a value\'s label', () => {
    expect(formatTableCell(null, text({ emptyText: 'n/a' }))).toBe('n/a')
    expect(formatTableCell(null, text())).toBe('')
    expect(formatTableCell(true, { dataType: 'boolean', numeric: false, settings: { booleanLabels: { true: 'Activo' } } })).toBe('Activo')
    expect(formatTableCell(false, { dataType: 'boolean', numeric: false, settings: { booleanLabels: { true: 'Activo' } } })).toBe('No')
    expect(formatTableCell('A', text({ options: { A: { label: 'Abierto' } } }))).toBe('Abierto')
  })
})
