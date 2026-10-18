import type { AdminApiSuccessEnvelope } from '~/types/api'
import { isErrorEnvelope } from '~/types/api'
import { AdminApiError } from '~/utils/admin-api-error'

export interface ApiResult<T> {
  data: T
  meta?: AdminApiSuccessEnvelope<T>['meta']
}

export type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export interface ApiRequestOptions {
  body?: unknown
  query?: Record<string, unknown>
  headers?: Record<string, string>
}

const NETWORK_ERROR = { source: 'TOTALBASE' as const, code: 'NETWORK_ERROR', message: 'Could not reach the server.' }

/**
 * One request against any of TotalBase's route families (`/admin/api`,
 * `/app/api`, `/api`, `/embed/api`): sends it, unwraps the `{data, meta?}`
 * envelope (a 204 has none), and throws an `AdminApiError` for an error
 * envelope, a non-2xx response or a network failure - the request core
 * every API client composable shares; each adds its own prefix, headers
 * and session handling.
 *
 * `baseURL: ''` on every call: Nuxt's global $fetch carries the app's own
 * `/admin` baseURL as its default, and ofetch only skips prepending it when
 * the URL already starts with it - true for `/admin/api/...`, not for the
 * other families, which would silently become `/admin/api/...` and 404.
 */
export async function apiRequest<T>(url: string, method: ApiMethod, options: ApiRequestOptions = {}): Promise<ApiResult<T>> {
  try {
    const response = await $fetch.raw<unknown>(url, {
      method,
      body: options.body as BodyInit | Record<string, unknown> | null | undefined,
      query: options.query,
      headers: options.headers,
      baseURL: ''
    })
    const body = response._data
    if (body === null || body === undefined) return { data: undefined as T }
    if (isErrorEnvelope(body)) throw new AdminApiError(response.status, body.errors)
    // Anything but the JSON envelope (an HTML page from a misrouted request) is an error, not an empty result.
    if (typeof body !== 'object' || !('data' in body)) {
      throw new AdminApiError(response.status, [{ source: 'TOTALBASE', code: 'INVALID_RESPONSE', message: 'The server answered with something other than the API response.' }])
    }
    const envelope = body as AdminApiSuccessEnvelope<T>
    return { data: envelope.data, meta: envelope.meta }
  } catch (error) {
    throw toApiError(error)
  }
}

/**
 * A POST answered with a file (a generated PDF) instead of the envelope. An
 * error response still carries the JSON envelope, as a Blob under
 * responseType 'blob' - parsed back so the caller gets the same AdminApiError.
 */
export async function apiRequestBlob(url: string, body: unknown, headers: Record<string, string>): Promise<Blob> {
  try {
    return await $fetch<Blob>(url, {
      method: 'POST',
      body: body as Record<string, unknown> | undefined,
      responseType: 'blob',
      headers,
      baseURL: ''
    })
  } catch (error) {
    const data = (error as { data?: unknown })?.data
    if (data instanceof Blob) {
      try {
        (error as { data?: unknown }).data = JSON.parse(await data.text())
      } catch {
        // Not JSON - toApiError falls back to its generic error.
      }
    }
    throw toApiError(error)
  }
}

/** Whatever $fetch threw (its FetchError carries the envelope on `data`), as an AdminApiError. */
export function toApiError(error: unknown): AdminApiError {
  if (error instanceof AdminApiError) return error
  const status = (error as { response?: { status?: number } })?.response?.status ?? 0
  const data = (error as { data?: unknown })?.data
  return isErrorEnvelope(data) ? new AdminApiError(status, data.errors) : new AdminApiError(status, [NETWORK_ERROR])
}

/** Whether a failed request means the session is gone (401, 403) - not a transient failure (429, 5xx, the network). */
export function isSignedOut(error: unknown): boolean {
  const status = (error as { status?: number, statusCode?: number } | null)?.status ?? (error as { statusCode?: number } | null)?.statusCode
  return status === 401 || status === 403
}
