import { regionalClockOptions, regionalHourCycle } from '@totalbase/shared'
import { format as formatDateFns, isValid, parseISO } from 'date-fns'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { regionalLocale } from '~/utils/regional-locale'

/**
 * A timestamp column in a native `<input type="datetime-local">` (UInput's
 * `type`), which reads and writes a wall-clock time with no zone
 * ("2026-09-30T17:51:00"). A `timestamptz` is an instant: shown in the
 * viewer's time zone (Settings / My account; the browser's when unset) and
 * written back as that instant in UTC. A plain `timestamp` has no zone:
 * its text passes through as it is.
 */
const LOCAL_PATTERN = 'yyyy-MM-dd\'T\'HH:mm:ss'

/** The column's value as the input shows it - empty for none or an unreadable one. */
export function toDateTimeLocal(value: unknown, zoned: boolean, timezone?: string): string {
  if (typeof value !== 'string' || !value) return ''
  if (!zoned) return value.slice(0, 19)
  const date = parseISO(value)
  if (!isValid(date)) return ''
  return timezone ? formatInTimeZone(date, timezone, LOCAL_PATTERN) : formatDateFns(date, LOCAL_PATTERN)
}

/** What the input holds, as the column's value - null when cleared. */
export function fromDateTimeLocal(value: unknown, zoned: boolean, timezone?: string): string | null {
  if (typeof value !== 'string' || !value) return null
  if (!zoned) return value
  const local = parseISO(value)
  if (!isValid(local)) return null
  return (timezone ? fromZonedTime(value, timezone) : local).toISOString()
}

/**
 * A column's value for a wall-clock time on a calendar or a timeline (the
 * viewer's, as useLayoutFormula's dateValue places rows): a date column its
 * day; a timestamp that local time; a timestamptz the instant it is in the
 * viewer's zone (the browser's when unset) - never a UTC date swapped.
 */
export function wallClockColumnValue(wallClock: Date, column: { displayFormatKind?: string, displayFormatTzAware?: boolean }, timezone?: string): string {
  if (column.displayFormatKind !== 'datetime') return formatDateFns(wallClock, 'yyyy-MM-dd')
  const local = formatDateFns(wallClock, LOCAL_PATTERN)
  if (!column.displayFormatTzAware) return local
  return (timezone ? fromZonedTime(local, timezone) : wallClock).toISOString()
}

/**
 * The hour cycle a date/time picker (reka's DateField, UInputDate/UInputTime)
 * shows in `locale` - its 12-hour clock only where the afternoon reads "PM"
 * (regionalHourCycle).
 */
export function pickerHourCycle(locale: string | undefined): 12 | 24 {
  return regionalHourCycle(locale)
}

/**
 * How a date, a time and a date-time read when the screen asks for no style
 * of its own: the regional format's short form, at a fixed width -
 * 30/09/2026, 09/30/2026, 2026/09/30, 30.09.2026; 17:51 or 5:51 PM.
 */
export const SHORT_DATE: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric' }
export const SHORT_TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }

/**
 * The clock every time TotalBase shows without a pattern uses: the regional
 * format's own (regionalHourCycle). Spread into toLocaleString /
 * toLocaleTimeString's options.
 */
export function clockOptions(): Intl.DateTimeFormatOptions {
  return regionalClockOptions(regionalLocale())
}
