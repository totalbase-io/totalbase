import { format, isValid, parse } from 'date-fns'
import { SHORT_DATE } from '~/utils/datetime-local'
import { regionalLocale } from '~/utils/regional-locale'

/**
 * A search as the Data API reads it (Data_API.md §3.5): it finds a day only in ISO form
 * (`2026-10-13`), so a word typed in the viewer's own date format - `13/10/2026` in es-AR, as the grid
 * shows it (regionalDatePattern) - is sent as that day. Every other word goes as typed. No pattern: ISO only.
 */
export function searchForApi(search: string, datePattern: string | undefined): string {
  if (!datePattern) return search
  return search.trim().split(/\s+/).map((word) => {
    const day = parse(word, datePattern, new Date())
    // Exactly that pattern: `1/2` isn't read as a day of `dd/MM/yyyy`.
    return isValid(day) && format(day, datePattern) === word ? format(day, 'yyyy-MM-dd') : word
  }).join(' ')
}

/**
 * The regional format's short date (SHORT_DATE) as a date-fns pattern - `dd/MM/yyyy` in es-AR, `MM/dd/yyyy` in
 * en-US, `yyyy/MM/dd` in ja-JP - so a typed day reads the way the grid writes it.
 */
export function regionalDatePattern(locale: string | undefined = regionalLocale()): string {
  const TOKENS: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = { day: 'dd', month: 'MM', year: 'yyyy' }
  return new Intl.DateTimeFormat(locale, SHORT_DATE).formatToParts(new Date(2026, 9, 13))
    .map(part => TOKENS[part.type] ?? `'${part.value.replaceAll('\'', '\'\'')}'`)
    .join('')
}
