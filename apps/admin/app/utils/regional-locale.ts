import { isRegionalFormat, regionalIntlTag } from '@totalbase/shared'
import { ref } from 'vue'

/** The session's regional format - set from `display.regionalFormat` (plugins/i18n-language.client.ts) or an embed's dashboard. */
const chosenFormat = ref<string | undefined>(undefined)

/** Sets the regional format: the user's, else the instance's; empty or unknown = the browser's. */
export function setRegionalLocale(format: unknown): void {
  chosenFormat.value = isRegionalFormat(format) ? format : undefined
}

/**
 * The locale numbers, dates and times are formatted in (Admin_UI.md
 * §14): the signed-in user's regional format (My account), else the
 * instance's (Settings › General), else the browser's regional settings -
 * always in Latin digits and the Gregorian calendar (regionalIntlTag).
 * Separate from the UI's language on purpose: someone in Argentina with the
 * UI in English still reads 1.234,50. Month and day names inside a date-fns
 * pattern follow the language (useUiLocale's `dateFns`). Reactive: a
 * `computed` reading it follows a change.
 */
export function regionalLocale(): string | undefined {
  return regionalIntlTag(chosenFormat.value ?? new Intl.DateTimeFormat().resolvedOptions().locale)
}
