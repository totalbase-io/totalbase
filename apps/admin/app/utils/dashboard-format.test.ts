import { describe, expect, it } from 'vitest'
import { formatWidgetNumber } from '~/utils/dashboard-widget-render'

// One format for every data widget (Dashboards.md §5, D4): displayFormat, and Compact on top of it.
describe('formatWidgetNumber()', () => {
  it('abbreviates by default when no format applies (Compact number)', () => {
    expect(formatWidgetNumber(11644148, { config: {}, locale: 'en' })).toBe('11.6M')
    expect(formatWidgetNumber(1234.5, { config: { compact: false }, locale: 'en' })).toBe('1,234.5')
  })

  it('uses the widget\'s Format over its column\'s - compact then starts off', () => {
    expect(formatWidgetNumber(1250001, { config: { displayFormat: '$ #,##0' }, locale: 'es' })).toBe('$ 1.250.001')
    expect(formatWidgetNumber(85.5, { config: { displayFormat: '0.0 %' }, presentation: { displayFormat: '#,##0' }, locale: 'es' })).toBe('85,5 %')
    expect(formatWidgetNumber(1234.5, { config: {}, presentation: { displayFormat: '#,##0.00' }, locale: 'en' })).toBe('1,234.50')
    expect(formatWidgetNumber(12.5, { config: { displayFormat: '0.0 h' }, locale: 'en' })).toBe('12.5 h')
  })

  it('keeps the format\'s text and fixed decimals with Compact on, else one decimal', () => {
    expect(formatWidgetNumber(1250000, { config: { displayFormat: '$ #,##0', compact: true }, locale: 'es' }).replace(/\s/g, ' ')).toBe('$ 1,3 M')
    expect(formatWidgetNumber(1234.5, { config: { compact: true }, presentation: { displayFormat: '#,##0.00' }, locale: 'en' })).toBe('1.23K')
    expect(formatWidgetNumber(1250000, { config: { displayFormat: 'CURRENCY:USD', compact: true }, locale: 'en' })).toBe('$1.3M')
  })

  it('shows a lossy value\'s exact decimal text, never rounded through a number', () => {
    expect(formatWidgetNumber('9007199254740993', { config: { compact: false }, locale: 'en' })).toBe('9,007,199,254,740,993')
  })
})
