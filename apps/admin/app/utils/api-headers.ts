import { viewAsHeader } from '~/utils/view-as'

/** The browser's IANA zone - resolved once. */
const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

/**
 * Every API request's headers: the browser's zone - the server's last
 * resort for this viewer's time zone (their profile's, then the
 * instance's, come first), Security.md §4.2. The session needs none: its
 * cookie goes with every same-origin request (Security.md §2.18).
 */
export function apiHeaders(): Record<string, string> {
  return {
    'X-TotalBase-Timezone': BROWSER_TIMEZONE,
    // Previewing the App as a role or a user (view-as.ts).
    ...viewAsHeader()
  }
}
