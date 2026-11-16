import { apiHeaders } from '~/utils/api-headers'
import { toApiError } from '~/utils/api-request'

/**
 * A file's content - the original, or a transformed rendition (`?width=...`) - fetched with the viewer's session and
 * every API request's headers: the time zone, and a view-as preview's role or user, so a previewed App reads files
 * with the previewed grants, not the administrator's (Security.md §10). `_data` is the Blob, or the text. A failure
 * is an AdminApiError, so it reads in the UI's language (`notifyError`) - its envelope arrives as the Blob or text.
 */
export async function fetchFileContent(path: string, responseType: 'blob' | 'text' = 'blob') {
  try {
    return await $fetch.raw(path, { baseURL: '', responseType, headers: apiHeaders() })
  } catch (error) {
    const data = (error as { data?: unknown })?.data
    if (data instanceof Blob || typeof data === 'string') {
      try {
        (error as { data?: unknown }).data = JSON.parse(typeof data === 'string' ? data : await data.text())
      } catch {
        // Not JSON - toApiError falls back to its generic error.
      }
    }
    throw toApiError(error)
  }
}
