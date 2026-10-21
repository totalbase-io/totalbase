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
    const apply = async (code: unknown) => {
      if (isUiLanguage(code) && code !== i18n.locale.value) await i18n.setLocale(code)
    }

    watch(() => session.admin.value?.display?.language, language => void apply(language), { immediate: true })

    const route = useRoute()
    // Awaited: the instance's files are loaded before the first page paints,
    // instead of the keys showing until they arrive.
    if (!session.token.value && !route.path.startsWith('/embed/')) {
      await apply(storedPublicLanguage() ?? useInstance().instance.value.language)
    }
  }
})
