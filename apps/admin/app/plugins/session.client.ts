import type { AdminAccount } from '~/composables/useSession'
import { isSignedOut } from '~/utils/api-request'
import { hasSignedInHint, rememberSignedIn } from '~/utils/session-hint'

// Asks the server whether a session is open before any page/middleware
// runs: the session is an HttpOnly cookie no script can see, so after a
// reload GET /auth/me is the only way to know - and it brings the profile.
// Only when this browser signed in (a hint kept beside the profile, no
// secret - utils/session-hint.ts): a signed-out visit never asks, so it
// never answers 401. Not on a dashboard embed: framed for visitors with no account.
export default defineNuxtPlugin({
  // Named: the UI's language follows the restored session (i18n-language.client.ts).
  name: 'session',
  async setup() {
    const session = useSession()
    watch(() => session.admin.value !== null, signedIn => rememberSignedIn(signedIn))

    if (!session.admin.value && hasSignedInHint() && !window.location.pathname.startsWith('/embed/')) {
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
            rememberSignedIn(false)
            return
          }
        }
      }
    }
  }
})
