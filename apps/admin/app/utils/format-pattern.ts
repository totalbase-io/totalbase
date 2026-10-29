import { format as formatDateFns, isValid as isValidDate, parse as parseDateFns, parseISO } from 'date-fns'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import type { UiLanguage } from '@totalbase/shared'
import { DATE_FNS_LOCALES } from '~/utils/date-fns-locales'
import { regionalLocale } from '~/utils/regional-locale'
import { clockOptions, SHORT_DATE, SHORT_TIME } from '~/utils/datetime-local'

/**
 * Excel/JasperReports-style DISPLAY format patterns -
 * decoupled from the widget/editing concern entirely. FieldConfig's own
 * `decimals`/`step`/etc govern EDITING (what a widget accepts while
 * typing); `displayFormat` governs how the SAME committed value reads,
 * in the grid and - on blur - in the form. Two independent engines,
 * neither reinventing what already exists:
 *
 * - Numbers: parsed into a small options object fed straight to
 *   `Intl.NumberFormat` - grouping/decimal separators come from the
 *   UI LANGUAGE's locale (Admin_UI.md §14, `uiIntlLocale`
 *   below), never hardcoded here, so `"#,##0.00"` reads "1,234.57" in
 *   English and "1.234,57" in Spanish automatically, exactly matching
 *   Excel's own locale-aware behavior.
 * - Dates/times: no custom token engine of our own - `date-fns`'s
 *   `format`/`parse` tokens (`dd/MM/yyyy`) are already what a builder
 *   would type, reused as-is.
 *
 * Two extensions past the original scope (still deliberately NOT the
 * full Excel spec - no `[Red]` colors, no fractions, no scientific
 * notation):
 *
 * - Up to 3 `;`-separated sections, Excel-style
 *   (`positive;negative;zero`) - e.g. `#,##0.00;(#,##0.00);"-"`. A
 *   missing negative section falls back to `Intl.NumberFormat`'s own
 *   default ("-" prefix, same digits/prefix/suffix as positive) exactly
 *   like before this existed; a missing zero section falls back to the
 *   positive section too. The zero section may be a real digit pattern
 *   of its own, or a bare/quoted literal (`"-"`, `n/a`) shown verbatim.
 * - `CURRENCY:<ISO 4217 code>` (e.g. `CURRENCY:ARS`) as the WHOLE
 *   pattern, instead of `0`/`#` placeholders - hands off entirely to
 *   `Intl.NumberFormat`'s own `style: 'currency'`, which already knows
 *   each currency's real symbol, position, and native decimal count far
 *   better than a hand-rolled prefix ever could (a literal `"$"` prefix
 *   is still supported too, for a plain non-ISO "looks like money"
 *   need). Grid AND the live `UInputNumber` form widget both understand
 *   this - `formatOptions` takes `style: 'currency'` natively, unlike
 *   the `;`-sections above (Intl has no concept of a literal
 *   prefix/suffix or parens-for-negative while typing, so those stay
 *   grid-only, same disclosed limitation `decimals`/prefix/suffix
 *   already have).
 */

/**
 * The UI language's locale for `Intl` (Admin_UI.md §14 - never
 * the browser's), read at call time from the Nuxt app's i18n. Undefined (the
 * runtime's own) where there is no Nuxt app, as in a unit test.
 */
/** The UI language's date-fns locale - undefined (English) without a Nuxt app, as in a unit test. */
export function uiDateFnsLocale() {
  try {
    return DATE_FNS_LOCALES[useNuxtApp().$i18n.locale.value as UiLanguage]
  } catch {
    return undefined
  }
}

export function uiIntlLocale(): string | undefined {
  return regionalLocale()
}

/** A preset's label in the UI's language, read at call time - its English where there is no Nuxt app. */
function presetText(key: string, english: string): string {
  try {
    return useNuxtApp().$i18n.t(key)
  } catch {
    return english
  }
}

export interface NumberSectionFormat {
  /** At most this many decimals - every `0` and `#` after the point. */
  decimals: number
  /** At least this many - the `0`s; a `#` is shown only when the value has it (Excel's `0.##`). */
  minDecimals: number
  useGrouping: boolean
  /** A literal string emitted before the number, e.g. "$". */
  prefix?: string
  /** A literal string emitted after the number, e.g. "%". */
  suffix?: string
}

export interface NumberFormatOptions extends NumberSectionFormat {
  /** Excel-style negative section (2nd `;`-separated part) - absent means Intl's own default ("-" + the positive section). */
  negative?: NumberSectionFormat
  /** Excel-style zero section, when it's itself a digit pattern (rare - usually `zeroText` is what's set). */
  zero?: NumberSectionFormat
  /** Excel-style zero section, when it's a literal/quoted string (e.g. `"-"`) rather than a digit pattern - shown verbatim for exactly 0. */
  zeroText?: string
}

const NUMBER_PATTERN_SHAPE = /^([^0#]*)([0#,.]+)([^0#]*)$/
const CURRENCY_PATTERN_SHAPE = /^CURRENCY:([A-Za-z]{3})$/

/** `null` for anything else - a plain `0`/`#` pattern, handled by `parseNumberPattern` instead. */
export function currencyCodeFor(pattern: string): string | null {
  const match = CURRENCY_PATTERN_SHAPE.exec(pattern.trim())
  return match ? match[1]!.toUpperCase() : null
}

/**
 * The text around the digits: as typed, but for the spaces on its outer
 * side - `"$ #,##0"` reads "$ 1,250", `"0.0 h"` "12.5 h" (a prefix loses
 * only its leading spaces, a suffix only its trailing ones) - or, quoted,
 * Excel-style, exactly what is inside the quotes, spaces included
 * (`"$ "#,##0.00" kg"` reads "$ 1,234.00 kg").
 */
function literal(text: string, side: 'prefix' | 'suffix'): string {
  // A `%` after the quotes stays a `%` ("0.0"%"); a space between the digits and the quotes stays too (DB39:
  // `#,##0 "pers."` reads "499 pers.").
  const quoted = /^(\s*)"(.*)"(%?)(\s*)$/.exec(text)
  if (quoted) return side === 'prefix' ? quoted[2]! + quoted[3]! + quoted[4]! : quoted[1]! + quoted[2]! + quoted[3]!
  return side === 'prefix' ? text.trimStart() : text.trimEnd()
}

function parseNumberSection(section: string): NumberSectionFormat {
  // A `%` is text like any other (it never multiplies): "0.0 %" reads "85.0 %".
  const match = NUMBER_PATTERN_SHAPE.exec(section)
  if (!match) return { decimals: 0, minDecimals: 0, useGrouping: false }
  const [, rawPrefix, digits, rawSuffix] = match
  const decimalIndex = digits!.indexOf('.')
  const fraction = decimalIndex === -1 ? '' : digits!.slice(decimalIndex + 1)
  const decimals = fraction.replace(/[^0#]/g, '').length
  const minDecimals = fraction.replace(/[^0]/g, '').length
  const useGrouping = digits!.includes(',')
  const prefix = literal(rawPrefix!, 'prefix') || undefined
  const suffix = literal(rawSuffix!, 'suffix') || undefined
  return { decimals, minDecimals, useGrouping, prefix, suffix }
}

export function parseNumberPattern(pattern: string): NumberFormatOptions {
  const sections = pattern.split(';')
  const result: NumberFormatOptions = parseNumberSection(sections[0] ?? '')
  const negativeSection = sections[1]?.trim()
  if (negativeSection) result.negative = parseNumberSection(negativeSection)
  const zeroSection = sections[2]?.trim()
  if (zeroSection) {
    if (NUMBER_PATTERN_SHAPE.test(zeroSection)) {
      result.zero = parseNumberSection(zeroSection)
    } else {
      result.zeroText = zeroSection.replace(/^"(.*)"$/, '$1')
    }
  }
  return result
}

/** How `formatNumberValue` reads a pattern beyond the pattern itself. */
export interface NumberValueOptions {
  /** The `Intl` locale - the UI language's when absent. */
  locale?: string
  /**
   * Abbreviated (1.3M), keeping the pattern's text around the digits and
   * at most its fixed decimals, else one (`"$ #,##0"` reads "$ 1.3M");
   * a `CURRENCY:` pattern takes `Intl`'s own compact currency notation.
   */
  compact?: boolean
}

/** `value` is the raw stored number, unscaled - a `%` pattern only appends the literal suffix, see this file's own doc comment. `CURRENCY:<code>` bypasses the whole section engine in favor of `Intl.NumberFormat`'s own currency formatting. */
export function formatNumberValue(value: number, pattern: string, options: NumberValueOptions = {}): string {
  const locale = options.locale ?? uiIntlLocale()
  const currency = currencyCodeFor(pattern)
  if (currency) {
    try {
      return new Intl.NumberFormat(locale, { style: 'currency', currency, ...(options.compact ? { notation: 'compact' } : {}) }).format(value)
    } catch {
      return String(value)
    }
  }
  const opts = parseNumberPattern(pattern)
  if (value === 0 && opts.zeroText !== undefined) return opts.zeroText
  const section = value === 0 && opts.zero ? opts.zero : (value < 0 && opts.negative) ? opts.negative : opts
  // A negative section's own pattern (e.g. the parens in "(#,##0.00)")
  // already carries the "this is negative" signal - format the
  // magnitude through it, not Intl's own "-" prefix on top of that.
  const magnitude = (value < 0 && opts.negative) ? Math.abs(value) : value
  const formatted = new Intl.NumberFormat(locale, options.compact
    ? { notation: 'compact', maximumFractionDigits: section.minDecimals || 1 }
    : { minimumFractionDigits: section.minDecimals, maximumFractionDigits: section.decimals, useGrouping: section.useGrouping }
  ).format(magnitude)
  return `${section.prefix ?? ''}${formatted}${section.suffix ?? ''}`
}

/**
 * A number with no pattern: the UI language's grouping and decimal
 * separator, keeping exactly the decimals the value came with - PostgreSQL's
 * numeric arrives as text with its scale ("2480.00"), a float as the number
 * it is. Null when it isn't a number.
 */
export function formatNumberLocale(value: unknown): string | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const text = typeof value === 'string' ? value.trim() : String(value)
  const decimals = /^-?\d+\.(\d+)$/.exec(text)?.[1]?.length ?? 0
  return new Intl.NumberFormat(uiIntlLocale(), { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n)
}

/** A number preset whose `label` is read in the UI's language each time it's shown (`designer.formatPattern.*`). */
function numberPreset(name: string, english: string, pattern: string): { label: string, pattern: string } {
  return {
    get label() {
      return presetText(`designer.formatPattern.${name}`, english)
    },
    pattern
  }
}

export const NUMBER_FORMAT_PRESETS: { label: string, pattern: string }[] = [
  numberPreset('presetNumber', 'Number (1,234.57)', '#,##0.00'),
  numberPreset('presetInteger', 'Integer (1,234)', '#,##0'),
  numberPreset('presetCurrency', 'Currency ($1,234.57)', '$#,##0.00'),
  numberPreset('presetPercentage', 'Percentage (12.34%)', '0.00%'),
  numberPreset('presetAccounting', 'Accounting ((1,234.57))', '#,##0.00;(#,##0.00);"-"')
]

export const CURRENCY_CODE_PRESETS: { label: string, code: string }[] = [
  { label: 'USD', code: 'USD' },
  { label: 'EUR', code: 'EUR' },
  { label: 'ARS', code: 'ARS' },
  { label: 'BRL', code: 'BRL' },
  { label: 'GBP', code: 'GBP' }
]

// --- Dates/times - real date-fns tokens, no reinvention. ---

export type TemporalKind = 'date' | 'time' | 'datetime'

/** The raw value's own shape per Postgres type, straight off the Data API - never what's displayed. */
function parseRawTemporal(raw: string, kind: TemporalKind): Date | null {
  try {
    if (kind === 'time') {
      const parsed = parseDateFns(raw, 'HH:mm:ss', new Date())
      return isValidDate(parsed) ? parsed : null
    }
    const parsed = parseISO(raw)
    return isValidDate(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Grid/read-only rendering - falls back to the raw value untouched if it
 * doesn't parse (never hides a real value behind a formatting failure).
 *
 * `timezone` (an IANA zone, e.g. "America/Argentina/Buenos_Aires") is
 * the Settings > General `system.timezone` value - only
 * ever passed for a column the Design form marked
 * `displayFormatTzAware` (a real `timestamptz`); a naive
 * date/time/timestamp has no offset to convert, so the caller never
 * passes it there. Omitted/empty = today's behavior, the viewer's own
 * browser-local time, via plain `date-fns` `format`.
 */
/**
 * A temporal value with no Format of its own: the regional format's short
 * form, in the given zone - never the raw ISO string. Same as
 * useDateTimeFormat.
 */
export function formatTemporalLocale(raw: string, kind: TemporalKind, timezone?: string): string {
  const date = parseRawTemporal(raw, kind)
  if (!date) return raw
  const zone = kind === 'datetime' && timezone ? { timeZone: timezone } : {}
  try {
    const locale = uiIntlLocale()
    if (kind === 'date') return date.toLocaleDateString(locale, SHORT_DATE)
    if (kind === 'time') return date.toLocaleTimeString(locale, { ...clockOptions(), ...SHORT_TIME })
    return date.toLocaleString(locale, { ...clockOptions(), ...SHORT_DATE, ...SHORT_TIME, ...zone })
  } catch {
    return raw
  }
}

export function formatTemporalValue(raw: string, pattern: string, kind: TemporalKind, timezone?: string): string {
  const date = parseRawTemporal(raw, kind)
  if (!date) return raw
  try {
    // Month and day names in the UI's language.
    const options = { locale: uiDateFnsLocale() }
    return timezone ? formatInTimeZone(date, timezone, pattern, options) : formatDateFns(date, pattern, options)
  } catch {
    return raw
  }
}

/**
 * Form roundtrip - reparses a user-typed, pattern-formatted string back
 * to the raw shape the column/API expects. `null` when it doesn't parse
 * as a valid value for the given pattern (caller keeps the typed text
 * and shows an error, never silently discards it).
 *
 * `timezone` mirrors `formatTemporalValue`'s own: the typed text is the
 * WALL-CLOCK value in that zone (what the viewer is looking at), so it's
 * converted back to the real UTC instant (`fromZonedTime`) before being
 * sent as ISO - never sent as if it were already UTC.
 */
export function parseTemporalInput(text: string, pattern: string, kind: TemporalKind, timezone?: string): string | null {
  try {
    const parsed = parseDateFns(text, pattern, new Date())
    if (!isValidDate(parsed)) return null
    if (kind === 'time') return formatDateFns(parsed, 'HH:mm:ss')
    if (kind === 'date') return formatDateFns(parsed, 'yyyy-MM-dd')
    return (timezone ? fromZonedTime(parsed, timezone) : parsed).toISOString()
  } catch {
    return null
  }
}

export const DATE_FORMAT_PRESETS: Record<TemporalKind, { label: string, pattern: string }[]> = {
  date: [
    { label: 'dd/MM/yyyy', pattern: 'dd/MM/yyyy' },
    { label: 'MM/dd/yyyy', pattern: 'MM/dd/yyyy' },
    { label: 'yyyy-MM-dd', pattern: 'yyyy-MM-dd' },
    { label: 'd MMM yyyy', pattern: 'd MMM yyyy' }
  ],
  time: [
    { label: 'HH:mm', pattern: 'HH:mm' },
    { label: 'HH:mm:ss', pattern: 'HH:mm:ss' },
    { label: 'hh:mm a', pattern: 'hh:mm a' }
  ],
  datetime: [
    { label: 'dd/MM/yyyy HH:mm', pattern: 'dd/MM/yyyy HH:mm' },
    { label: 'yyyy-MM-dd HH:mm:ss', pattern: 'yyyy-MM-dd HH:mm:ss' },
    { label: 'MM/dd/yyyy hh:mm a', pattern: 'MM/dd/yyyy hh:mm a' }
  ]
}
