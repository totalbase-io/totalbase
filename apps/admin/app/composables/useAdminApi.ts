import type { AdminApiError } from '~/utils/admin-api-error'
import type { AdminAccount } from '~/composables/useSession'
import { apiHeaders } from '~/utils/api-headers'
import { isSignedOut } from '~/utils/api-request'
import { apiRequest, apiRequestBlob, type ApiMethod, type ApiResult } from '~/utils/api-request'

export type AdminApiResult<T> = ApiResult<T>

/**
 * A client for one of the session's route families: every call attaches
 * `Authorization: Bearer <token>` when a session exists, unwraps the
 * envelope (`apiRequest`), and on a 401 clears the session and goes to
 * /login (session expired or never existed - there is no refresh-token
 * flow, Admin_UI.md §2.3). `onForbidden` runs on a 403.
 */
export function createSessionApi(prefix: string, onForbidden?: (session: ReturnType<typeof useSession>) => void) {
  const session = useSession()
  const { retrying } = useReauthentication()

  async function request<T>(method: ApiMethod, path: string, options: { body?: unknown, query?: Record<string, unknown> } = {}): Promise<ApiResult<T>> {
    try {
      // A sensitive action asks to confirm the identity first, then goes again (Security.md §2.19).
      return await retrying(() => apiRequest<T>(`${prefix}${path}`, method, { ...options, headers: apiHeaders() }))
    } catch (error) {
      throw await afterError(error as AdminApiError)
    }
  }

  async function postBlob(path: string, body?: unknown): Promise<Blob> {
    try {
      return await apiRequestBlob(`${prefix}${path}`, body, apiHeaders())
    } catch (error) {
      throw await afterError(error as AdminApiError)
    }
  }

  async function afterError(error: AdminApiError): Promise<AdminApiError> {
    if (error.status === 401 && session.isAuthenticated.value) {
      session.clear()
      await navigateTo('/login')
    }
    // A re-authentication the user declined is no change of access.
    if (error.status === 403 && error.code !== 'REAUTHENTICATION_REQUIRED' && session.isAuthenticated.value) onForbidden?.(session)
    return error
  }

  return {
    get: <T>(path: string, query?: Record<string, unknown>) => request<T>('GET', path, { query }),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body }),
    patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
    put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
    del: <T>(path: string, query?: Record<string, unknown>) => request<T>('DELETE', path, { query }),
    postBlob
  }
}

/**
 * A 403 may mean the user's access changed mid-session (e.g. their role
 * went from ADMIN to APP): the server re-checks access on every request,
 * so re-read it from /auth/me and move the user to wherever it now
 * opens. A plain permission error leaves access unchanged - no-op. An
 * API-only user gets a 403 from /auth/me itself: back to login.
 */
async function recheckAccess(session: ReturnType<typeof useSession>) {
  const before = session.access.value
  try {
    const { data } = await $fetch<{ data: AdminAccount }>('/admin/api/auth/me')
    session.admin.value = data
    if (data.access !== before) navigateTo(portalHomeFor(data.access))
  } catch (error) {
    // Signed out only when the server says so - a 429 or a 5xx here leaves the session as it was.
    if (!isSignedOut(error)) return
    session.clear()
    navigateTo('/login')
  }
}

/** Typed Admin API client (Admin_UI.md §2): `/admin/api/*`, same-origin in prod, proxied in dev (nuxt.config.ts). */
export function useAdminApi() {
  return createSessionApi('/admin/api', recheckAccess)
}
