import { isUiLanguage } from '@totalbase/shared'
import { storedPublicLanguage } from '~/utils/public-language'

/**
 * The UI's language (Admin_UI.md §14): the signed-in user's
 * (`display.language` from /auth/me - their choice in My account, else the
 * instance's), following it when it changes; with nobody signed in - the
 * sign-in and the other public pages - the visitor's choice in this browser (LanguageButton.vue), else the
 * instance's (GET /api/instance, read at boot by instance.client.ts).
 * An embed page sets its own (its embed's instance language, or `?locale=`).
 */
export default defineNuxtPlugin({
  name: 'i18n-language',
  dependsOn: ['i18n:plugin', 'session', 'instance'],
  async setup(nuxtApp) {
    const session = useSession()
    const i18n = nuxtApp.$i18n as { locale: { value: string }, setLocale: (code: string) => Promise<void> }
    /** The last switch asked for - what a page waits on before it renders (middleware/i18n-areas.global.ts). */
    let pending: Promise<void> = Promise.resolve()
    const apply = (code: unknown): Promise<void> => {
      if (isUiLanguage(code) && code !== i18n.locale.value) pending = i18n.setLocale(code).catch(() => undefined) // a failed fetch (offline) leaves the old language, never a broken navigation.
      return pending
    }

    // flush 'sync': a sign-in sets the profile and navigates right after - the
    // switch has started by the time the next page's middleware waits on it.
    watch(() => session.admin.value?.display?.language, language => void apply(language), { flush: 'sync' })

    // Awaited: the language's files are loaded before the first page paints,
    // instead of the keys showing until they arrive - the signed-in user's
    // (the session plugin has read /auth/me), else the visitor's.
    const route = useRoute()
    if (session.admin.value) await apply(session.admin.value.display?.language)
    else if (!route.path.startsWith('/embed/')) await apply(storedPublicLanguage() ?? useInstance().instance.value.language)

    return { provide: { uiLanguage: { settled: () => pending } } }
  }
})
