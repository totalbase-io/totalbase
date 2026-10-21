import { apiRequest } from '~/utils/api-request'

/** The browser's IANA zone - the embed has no user, so this is the viewer's zone after the instance's. */
const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

/**
 * Client for a signed dashboard embed's routes (`/embed/api/*`,
 * Dashboards.md §9.5): the token the page read from its
 * URL's fragment goes in a header - never the session's, which an embed
 * doesn't use (its viewer has no TotalBase account). Same `get`/`post`
 * shape as useAppApi, so DashboardView and its cards use either.
 */
export function useEmbedApi(token: string) {
  const headers = { 'X-TotalBase-Embed-Token': token, 'X-TotalBase-Timezone': BROWSER_TIMEZONE }
  return {
    get: <T>(path: string) => apiRequest<T>(`/embed/api${path}`, 'GET', { headers }),
    post: <T>(path: string, body?: unknown) => apiRequest<T>(`/embed/api${path}`, 'POST', { body, headers })
  }
}
