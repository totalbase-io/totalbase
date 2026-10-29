import { isValid, parseISO } from 'date-fns'
import { clockOptions, SHORT_DATE, SHORT_TIME } from '~/utils/datetime-local'

type Instant = string | number | Date

function toDate(value: Instant): Date | null {
  const date = value instanceof Date ? value : typeof value === 'number' ? new Date(value) : parseISO(value)
  return isValid(date) ? date : null
}

/**
 * The one formatter for absolute dates/times in the portal
 * (Security.md §4.2): the signed-in user's effective display settings
 * (GET /admin/api/auth/me's `display` - their My account preferences, else
 * Settings > General, else the browser) - the regional format's own way of
 * writing them (useUiLocale's `intlLocale`), in the effective zone.
 *
 * - `dateTime` / `date` / `time`: full displays (details, tooltips,
 *   columns) - the short form (SHORT_DATE, SHORT_TIME), or `fallback`
 *   (Intl options), a screen's own style.
 * - `day`: a calendar date with no time or zone (a PostgreSQL `date`,
 *   "YYYY-MM-DD") - formatted as is, never shifted by a zone.
 * - `compact`: a deliberately short display ("12 Mar", "14:05:09") -
 *   keeps the caller's own Intl options, only moved into the effective
 *   zone.
 *
 * Relative displays ("3 min ago") need nothing from here - they don't
 * depend on a zone. DataView columns with their own Format keep using
 * format-pattern.ts, with `timezone` from here (useDisplayFormatDefaults).
 */
export function useDateTimeFormat() {
  const session = useSession()
  const ui = useUiLocale()
  const display = computed(() => session.admin.value?.display)
  /** The effective IANA zone, or undefined = the browser's own. */
  const timezone = computed(() => display.value?.timezone || undefined)

  function dateTime(value: Instant, fallback?: Intl.DateTimeFormatOptions): string {
    const date = toDate(value)
    if (!date) return String(value)
    return date.toLocaleString(ui.intlLocale.value, { ...clockOptions(), ...(fallback ?? { ...SHORT_DATE, ...SHORT_TIME }), timeZone: timezone.value })
  }

  function date(value: Instant, fallback?: Intl.DateTimeFormatOptions): string {
    const parsed = toDate(value)
    if (!parsed) return String(value)
    return parsed.toLocaleDateString(ui.intlLocale.value, { ...(fallback ?? SHORT_DATE), timeZone: timezone.value })
  }

  function time(value: Instant): string {
    const parsed = toDate(value)
    if (!parsed) return String(value)
    return parsed.toLocaleTimeString(ui.intlLocale.value, { ...clockOptions(), ...SHORT_TIME, timeZone: timezone.value })
  }

  function day(value: string, fallback?: Intl.DateTimeFormatOptions): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
    if (!match) return value
    const local = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    return local.toLocaleDateString(ui.intlLocale.value, fallback ?? SHORT_DATE)
  }

  function compact(value: Instant, options: Intl.DateTimeFormatOptions): string {
    const parsed = toDate(value)
    if (!parsed) return String(value)
    return parsed.toLocaleString(ui.intlLocale.value, { ...clockOptions(), ...options, timeZone: options.timeZone ?? timezone.value })
  }

  return { timezone, dateTime, date, time, day, compact }
}
