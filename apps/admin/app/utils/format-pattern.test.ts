import { describe, expect, it } from 'vitest'
import { formatNumberLocale, formatNumberValue } from './format-pattern'

describe('formatNumberLocale()', () => {
  const locale = (n: number, decimals: number) => new Intl.NumberFormat(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n)

  it('keeps the decimals PostgreSQL sent and groups in the locale', () => {
    expect(formatNumberLocale('2480.00')).toBe(locale(2480, 2))
    expect(formatNumberLocale('1.000')).toBe(locale(1, 3))
    expect(formatNumberLocale(1500)).toBe(locale(1500, 0))
    // A float keeps every digit it has - a coordinate isn't rounded.
    expect(formatNumberLocale(-32.938580404905956)).toBe(locale(-32.938580404905956, 15))
  })

  it('leaves what isn\'t a number alone', () => {
    expect(formatNumberLocale('Aceite')).toBeNull()
    expect(formatNumberLocale('')).toBeNull()
    expect(formatNumberLocale(null)).toBeNull()
  })
})

describe('formatNumberValue()', () => {
  const locale = (n: number, decimals: number) => new Intl.NumberFormat(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n)

  it('puts plain text around the digits, keeping its inner spaces (D4)', () => {
    expect(formatNumberValue(1234.5, '$#,##0.00')).toBe(`$${locale(1234.5, 2)}`)
    expect(formatNumberValue(12, '0 kg')).toBe('12 kg')
    expect(formatNumberValue(1250, '$ #,##0', { locale: 'en' })).toBe('$ 1,250')
    expect(formatNumberValue(1250000, '$ #,##0', { locale: 'es' })).toBe('$ 1.250.000')
    expect(formatNumberValue(85, '0.0 %', { locale: 'es' })).toBe('85,0 %')
    // Only the outer spaces go.
    expect(formatNumberValue(12, '  0 kg  ')).toBe('12 kg')
  })

  it('abbreviates with Compact, keeping the pattern\'s text and its fixed decimals, else one (D4)', () => {
    expect(formatNumberValue(1250000, '$ #,##0', { locale: 'es', compact: true }).replace(/\s/g, ' ')).toBe('$ 1,3 M')
    expect(formatNumberValue(1250000, '$ #,##0', { locale: 'en', compact: true })).toBe('$ 1.3M')
    expect(formatNumberValue(1234567, '#,##0.00', { locale: 'en', compact: true })).toBe('1.23M')
    expect(formatNumberValue(1250000, 'CURRENCY:USD', { locale: 'en', compact: true })).toBe('$1.3M')
  })

  it('shows a # decimal only when the value has it - a 0 always', () => {
    expect(formatNumberValue(12, '#,##0.##" u"')).toBe(`${locale(12, 0)} u`)
    expect(formatNumberValue(12.5, '#,##0.##" u"')).toBe(`${locale(12.5, 1)} u`)
    expect(formatNumberValue(12.5, '0.0#')).toBe(locale(12.5, 1))
    expect(formatNumberValue(12, '0.00')).toBe(locale(12, 2))
  })

  it('keeps quoted text exactly, spaces included', () => {
    expect(formatNumberValue(1234.5, '"$ "#,##0.00" kg"')).toBe(`$ ${locale(1234.5, 2)} kg`)
    expect(formatNumberValue(-3, '"$ "#,##0.00;"($ "#,##0.00")"')).toBe(`($ ${locale(3, 2)})`)
    // A space outside the quotes, between them and the digits, stays (DB39).
    expect(formatNumberValue(499, '#,##0 "pers."')).toBe(`${locale(499, 0)} pers.`)
    expect(formatNumberValue(499, '"US$" #,##0')).toBe(`US$ ${locale(499, 0)}`)
  })
})
