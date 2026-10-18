import { viewAsHeader } from '~/utils/view-as'

/** The browser's IANA zone - resolved once. */
const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

/**
 * Every API request's headers: the session's bearer token, and the
 * browser's zone - the server's last resort for this viewer's time zone
 * (their profile's, then the instance's, come first), Specification_Security.md §4.2.
 */
export function apiHeaders(token: string | null | undefined): Record<string, string> {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'X-TotalBase-Timezone': BROWSER_TIMEZONE,
    // Previewing the App as a role or a user (view-as.ts).
    ...viewAsHeader()
  }
}
