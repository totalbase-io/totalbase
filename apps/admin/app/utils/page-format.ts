/**
 * `dataview.format` - how a CUSTOM page's Code turns values into text
 * (DataViews.md §11.1), with the viewer's
 * settings: numbers and currencies in the UI language's locale, dates and
 * times in the viewer's patterns and time zone (My account, else Settings
 * > General) - the same engines the grid uses (format-pattern.ts), so a
 * page never builds its own.
 */
import { formatNumberValue, formatTemporalLocale, formatTemporalValue, type TemporalKind } from '~/utils/format-pattern'

export interface PageFormatSettings {
  /** IANA zone, or empty for the browser's own. */
  timezone: string
  date: string
  time: string
  datetime: string
}

export interface PageFormat {
  /** `number(1234.5, 2)` → "1,234.50"; a pattern (`"#,##0.00;(#,##0.00)"`) instead of the decimals. */
  number: (value: unknown, decimals?: number | string) => string
  /** `currency(1234.5, 'ARS')` → "ARS 1,234.50", in the currency's own decimals. */
  currency: (value: unknown, code: string) => string
  /** A date, a time or a timestamp - in the viewer's pattern, or `pattern`. */
  date: (value: unknown, pattern?: string) => string
  time: (value: unknown, pattern?: string) => string
  datetime: (value: unknown, pattern?: string) => string
}

/** Empty text for no value; the value as is when it isn't a number. */
function numeric(value: unknown, format: (n: number) => string): string {
  if (value === null || value === undefined || value === '') return ''
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? format(n) : String(value)
}

export function createPageFormat(settings: () => PageFormatSettings): PageFormat {
  function temporal(kind: TemporalKind, value: unknown, pattern?: string): string {
    if (value === null || value === undefined || value === '') return ''
    const raw = value instanceof Date ? value.toISOString() : String(value)
    const { timezone, [kind]: own } = settings()
    // Only an instant has a zone to convert; a date or a time is what it says.
    const zone = kind === 'datetime' && timezone ? timezone : undefined
    const used = pattern ?? own
    return used ? formatTemporalValue(raw, used, kind, zone) : formatTemporalLocale(raw, kind, zone)
  }
  return {
    number: (value, decimals = 0) => numeric(value, n => formatNumberValue(n, typeof decimals === 'string' ? decimals : `#,##0${decimals > 0 ? `.${'0'.repeat(decimals)}` : ''}`)),
    currency: (value, code) => numeric(value, n => formatNumberValue(n, `CURRENCY:${code}`)),
    date: (value, pattern) => temporal('date', value, pattern),
    time: (value, pattern) => temporal('time', value, pattern),
    datetime: (value, pattern) => temporal('datetime', value, pattern)
  }
}
