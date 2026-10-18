import { format as formatDateFns, isValid, parseISO } from 'date-fns'
import { formatInTimeZone } from 'date-fns-tz'
import { clockOptions } from '~/utils/datetime-local'

type Instant = string | number | Date

function toDate(value: Instant): Date | null {
  const date = value instanceof Date ? value : typeof value === 'number' ? new Date(value) : parseISO(value)
  return isValid(date) ? date : null
}

/**
 * The one formatter for absolute dates/times in the portal
 * (Specification_Security.md §4.2): the signed-in user's
 * effective display settings (GET /admin/api/auth/me's `display` - their
 * My account preferences, else Settings > General, else the browser).
 *
 * - `dateTime` / `date` / `time`: full displays (details, tooltips,
 *   columns) - the effective pattern in the effective zone; with no
 *   pattern set, the browser's own locale format - `fallback` (Intl
 *   options) keeps a screen's own style for that case - still in the
 *   effective zone.
 * - `day`: a calendar date with no time or zone (a PostgreSQL `date`,
 *   "YYYY-MM-DD") - formatted as is, never shifted by a zone.
 * - `compact`: a deliberately short display ("12 Mar", "14:05:09") -
 *   keeps the caller's own Intl options, only moved into the effective
 *   zone.
 *
 * Relative displays ("3 min ago") need nothing from here - they don't
 * depend on a zone. DataView columns with their own Format keep using
 * format-pattern.ts, with `timezone`/`patterns` from here as fallbacks
 * (useDisplayFormatDefaults).
 */
export function useDateTimeFormat() {
  const session = useSession()
  // Month and day names, and a browser-formatted value, in the UI's language (Specification_Admin_UI.md §14).
  const ui = useUiLocale()
  const display = computed(() => session.admin.value?.display)
  /** The effective IANA zone, or undefined = the browser's own. */
  const timezone = computed(() => display.value?.timezone || undefined)
  const patterns = computed(() => ({
    date: display.value?.dateFormat ?? '',
    time: display.value?.timeFormat ?? '',
    datetime: display.value?.datetimeFormat ?? ''
  }))

  function withPattern(date: Date, pattern: string): string {
    try {
      const options = { locale: ui.dateFns.value }
      return timezone.value ? formatInTimeZone(date, timezone.value, pattern, options) : formatDateFns(date, pattern, options)
    } catch {
      return date.toISOString()
    }
  }

  function dateTime(value: Instant, fallback?: Intl.DateTimeFormatOptions): string {
    const date = toDate(value)
    if (!date) return String(value)
    return patterns.value.datetime
      ? withPattern(date, patterns.value.datetime)
      : date.toLocaleString(ui.intlLocale.value, { ...clockOptions(), ...fallback, timeZone: timezone.value })
  }

  function date(value: Instant, fallback?: Intl.DateTimeFormatOptions): string {
    const parsed = toDate(value)
    if (!parsed) return String(value)
    return patterns.value.date
      ? withPattern(parsed, patterns.value.date)
      : parsed.toLocaleDateString(ui.intlLocale.value, { ...fallback, timeZone: timezone.value })
  }

  function time(value: Instant): string {
    const parsed = toDate(value)
    if (!parsed) return String(value)
    return patterns.value.time ? withPattern(parsed, patterns.value.time) : parsed.toLocaleTimeString(ui.intlLocale.value, { ...clockOptions(), timeZone: timezone.value })
  }

  function day(value: string, fallback?: Intl.DateTimeFormatOptions): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
    if (!match) return value
    const local = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    return patterns.value.date ? formatDateFns(local, patterns.value.date, { locale: ui.dateFns.value }) : local.toLocaleDateString(ui.intlLocale.value, fallback)
  }

  function compact(value: Instant, options: Intl.DateTimeFormatOptions): string {
    const parsed = toDate(value)
    if (!parsed) return String(value)
    return parsed.toLocaleString(ui.intlLocale.value, { ...clockOptions(), ...options, timeZone: options.timeZone ?? timezone.value })
  }

  return { timezone, patterns, dateTime, date, time, day, compact }
}
