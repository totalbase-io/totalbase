import ReauthenticateModal from '~/components/ReauthenticateModal.vue'
import { AdminApiError } from '~/utils/admin-api-error'

/**
 * Re-authentication (Security.md §2.19): a sensitive action - issuing an administrator token, assigning
 * Administrators, another account's email, password or two-factor authentication - answers
 * REAUTHENTICATION_REQUIRED when the session hasn't confirmed its identity lately. `retrying` asks for it
 * (ReauthenticateModal) and runs the action once more; cancelled, the original error goes on to the caller.
 */
export function useReauthentication() {
  const overlay = useOverlay()

  async function retrying<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (!(error instanceof AdminApiError) || error.code !== 'REAUTHENTICATION_REQUIRED') throw error
      const confirmed = await overlay.create(ReauthenticateModal, { destroyOnClose: true }).open().result
      if (confirmed !== true) throw error
      return run()
    }
  }

  return { retrying }
}
