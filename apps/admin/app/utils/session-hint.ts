/**
 * Whether this browser signed in to the portal (Security.md §2.18) - a hint, not the session: the session is an
 * HttpOnly cookie no script reads. With it, a page asks GET /auth/me at boot; without it, a signed-out visit asks
 * nothing - no 401 to log. A stale hint costs one 401, which clears it. Kept in localStorage, guarded: private
 * windows and blocked storage just ask every time.
 */
const KEY = 'totalbase_signed_in'

export function hasSignedInHint(): boolean {
  try {
    return localStorage.getItem(KEY) !== null
  } catch {
    return true
  }
}

export function rememberSignedIn(signedIn: boolean): void {
  try {
    if (signedIn) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {
    // Storage unavailable: hasSignedInHint answers true.
  }
}
