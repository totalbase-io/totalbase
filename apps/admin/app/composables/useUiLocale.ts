import { en as uiEn, es as uiEs } from '@nuxt/ui/locale'
import { UI_LANGUAGES, type UiLanguage } from '@totalbase/shared'
import { DATE_FNS_LOCALES } from '~/utils/date-fns-locales'
import { regionalLocale } from '~/utils/regional-locale'

/**
 * The UI's current language as each library wants it (Specification_Admin_UI.md
 * §14): date-fns (month and day names in a format) and Nuxt UI's own texts;
 * numbers and browser-formatted dates keep the browser's regional settings. Adding a language adds
 * its line in each map below.
 */
const NUXT_UI = { en: uiEn, es: uiEs }

export function useUiLocale() {
  const { locale } = useI18n()
  const code = computed<UiLanguage>(() => (UI_LANGUAGES.some(l => l.code === locale.value) ? locale.value as UiLanguage : 'en'))
  return {
    code,
    /** For `Intl` and `toLocaleString`: the browser's regional settings, not the language (utils/regional-locale.ts). */
    intlLocale: computed(() => regionalLocale()),
    /** The language's BCP 47 tag - for `Intl` producing words (weekday and month names), which are text, not format. */
    languageTag: computed(() => UI_LANGUAGES.find(l => l.code === code.value)!.bcp47),
    dateFns: computed(() => DATE_FNS_LOCALES[code.value]),
    nuxtUi: computed(() => NUXT_UI[code.value])
  }
}
