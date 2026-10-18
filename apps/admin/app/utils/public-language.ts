import { isUiLanguage } from '@totalbase/shared'

/** localStorage key of a visitor's language choice on the pages with no user (LanguageButton.vue). */
export const PUBLIC_LANGUAGE_KEY = 'totalbase.public-language'

/** The choice stored in this browser, if it is still one of the UI's languages. */
export function storedPublicLanguage(): string | undefined {
  try {
    const code = localStorage.getItem(PUBLIC_LANGUAGE_KEY)
    return isUiLanguage(code) ? code : undefined
  } catch {
    return undefined
  }
}
