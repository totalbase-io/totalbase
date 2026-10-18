import { format, isValid, parse } from 'date-fns'

/**
 * A search as the Data API reads it (Specification_Data_API.md §3.5): it finds a day only in ISO form
 * (`2026-10-13`), so a word typed in the viewer's own date format - `13/10/2026` with `dd/MM/yyyy`, as the grid
 * shows it - is sent as that day. Every other word goes as typed. No date format (the browser's): ISO only.
 */
export function searchForApi(search: string, datePattern: string | undefined): string {
  if (!datePattern) return search
  return search.trim().split(/\s+/).map((word) => {
    const day = parse(word, datePattern, new Date())
    // Exactly that pattern: `1/2` isn't read as a day of `dd/MM/yyyy`.
    return isValid(day) && format(day, datePattern) === word ? format(day, 'yyyy-MM-dd') : word
  }).join(' ')
}
