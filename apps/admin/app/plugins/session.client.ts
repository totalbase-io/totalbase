import type { AdminAccount } from '~/composables/useSession'
import { isSignedOut } from '~/utils/api-request'

// Restores the persisted token before any page/middleware runs, and
// re-hydrates the admin profile after a reload (the token survives in
// localStorage but Nuxt's in-memory state does not).
export default defineNuxtPlugin({
  // Named: the UI's language follows the restored session (i18n-language.client.ts).
  name: 'session',
  async setup() {
    const session = useSession()
    session.restore()

    if (session.token.value && !session.admin.value) {
      const api = useAdminApi()
      // Only the server saying the session is gone (401, 403) signs out. A transient failure - a 429 while the
      // instance is busy, a 5xx, the network - is tried once more, then left to the next request: never a sign-out.
      for (const wait of [0, 2000]) {
        if (wait) await new Promise(resolve => setTimeout(resolve, wait))
        try {
          const { data } = await api.get<AdminAccount>('/auth/me')
          session.admin.value = data
          return
        } catch (error) {
          if (isSignedOut(error)) {
            session.clear()
            return
          }
        }
      }
    }
  }
})
