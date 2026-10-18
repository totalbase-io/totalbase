import { describe, expect, it } from 'vitest'
import { createPageFormat } from '~/utils/page-format'

const format = createPageFormat(() => ({ timezone: 'UTC', date: 'dd/MM/yyyy', time: 'HH:mm', datetime: 'dd/MM/yyyy HH:mm' }))

describe('createPageFormat()', () => {
  it('formats numbers with decimals or a pattern, in the browser locale', () => {
    const grouped = (1234.5).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    expect(format.number(1234.5, 2)).toBe(grouped)
    expect(format.number('1234.5', 2)).toBe(grouped)
    expect(format.number(-5, '#,##0;(#,##0)')).toBe('(5)')
    expect(format.number(null)).toBe('')
    expect(format.number('abc')).toBe('abc')
  })

  it('formats a currency in its own decimals', () => {
    expect(format.currency(10, 'USD')).toBe((10).toLocaleString(undefined, { style: 'currency', currency: 'USD' }))
  })

  it('formats dates and instants with the viewer\'s patterns and zone, or a given pattern', () => {
    expect(format.date('2026-09-30')).toBe('30/09/2026')
    expect(format.datetime('2026-09-30T15:04:00Z')).toBe('30/09/2026 15:04')
    expect(format.date('2026-09-30', 'yyyy')).toBe('2026')
    expect(format.date(undefined)).toBe('')
  })

  it('falls back to the locale when the viewer has no pattern', () => {
    const plain = createPageFormat(() => ({ timezone: '', date: '', time: '', datetime: '' }))
    expect(plain.date('2026-09-30')).toBe(new Date(2026, 8, 30).toLocaleDateString())
  })
})
