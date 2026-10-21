/**
 * The locale numbers and dates are formatted in (Admin_UI.md
 * §14): the browser's regional settings - `undefined` to `Intl` and
 * `toLocaleString`. Separate from the UI's language on purpose: someone in
 * Argentina with the UI in English still reads 1.234,50. Month and day names
 * inside a date-fns pattern follow the language (useUiLocale's `dateFns`).
 */
export function regionalLocale(): string | undefined {
  return undefined
}
