import { describe, expect, it } from 'vitest'
import { createPageFormat } from '~/utils/page-format'
import { setRegionalLocale } from '~/utils/regional-locale'

const format = createPageFormat(() => ({ timezone: 'UTC' }))

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

  it('formats dates and instants in the viewer\'s regional format and zone, or a given pattern', () => {
    setRegionalLocale('es-AR')
    try {
      expect(format.date('2026-09-30')).toBe('30/09/2026')
      expect(format.datetime('2026-09-30T15:04:00Z')).toBe('30/09/2026, 15:04')
      expect(format.time('15:04:00')).toBe('15:04')
      setRegionalLocale('en-US')
      expect(format.date('2026-09-30')).toBe('09/30/2026')
      expect(format.time('15:04:00')).toBe('03:04 PM')
      setRegionalLocale('ja-JP')
      expect(format.date('2026-09-30')).toBe('2026/09/30')
      expect(format.date('2026-09-30', 'yyyy')).toBe('2026')
      expect(format.date(undefined)).toBe('')
    } finally {
      setRegionalLocale(undefined)
    }
  })
})
