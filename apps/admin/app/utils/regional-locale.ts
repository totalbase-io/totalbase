import { isRegionalFormat } from '@totalbase/shared'
import { ref } from 'vue'

/** The instance's `system.regional_format` - set from the session (plugins/i18n-language.client.ts) or an embed's dashboard. */
const instanceFormat = ref<string | undefined>(undefined)

/** Sets the instance's regional format; empty or unknown = the browser's. */
export function setRegionalLocale(format: unknown): void {
  instanceFormat.value = isRegionalFormat(format) ? format : undefined
}

/**
 * The locale numbers and dates are formatted in (Admin_UI.md
 * §14): the instance's regional format (Settings › General), else the
 * browser's regional settings - `undefined` to `Intl` and `toLocaleString`.
 * Separate from the UI's language on purpose: someone in Argentina with the
 * UI in English still reads 1.234,50. Month and day names inside a date-fns
 * pattern follow the language (useUiLocale's `dateFns`). Reactive: a
 * `computed` reading it follows a change.
 */
export function regionalLocale(): string | undefined {
  return instanceFormat.value
}
