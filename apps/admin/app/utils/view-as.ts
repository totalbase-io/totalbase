/**
 * See as (Specification_Security.md §8.4): who the administrator is previewing the App as, kept for this browser
 * tab (sessionStorage) - the header the App and Data API requests carry while an App page is open
 * (api-headers.ts). The server decides everything with it; this only remembers the choice.
 */
export interface ViewAsState { kind: 'role' | 'user', id: string, name: string }

const KEY = 'totalbase-view-as'

function stored(): ViewAsState | null {
  try {
    const raw = import.meta.client ? sessionStorage.getItem(KEY) : null
    return raw ? JSON.parse(raw) as ViewAsState : null
  } catch {
    return null
  }
}

export const viewAsState = ref<ViewAsState | null>(stored())

export function setViewAs(value: ViewAsState | null) {
  viewAsState.value = value
  try {
    if (value) sessionStorage.setItem(KEY, JSON.stringify(value))
    else sessionStorage.removeItem(KEY)
  } catch {
    // Storage unavailable: the preview lasts until the page reloads.
  }
}

/** A path of the App (`/app/...`, the router's path - the admin's base left out). */
export function isAppPath(path: string): boolean {
  return path === '/app' || path.startsWith('/app/')
}

/** The header, while previewing and on an App page - never on an admin screen, which stays the administrator's. */
export function viewAsHeader(): Record<string, string> {
  if (!viewAsState.value || !import.meta.client) return {}
  const path = window.location.pathname.replace(/^\/admin(?=\/|$)/, '')
  return isAppPath(path) ? { 'X-TotalBase-View-As': `${viewAsState.value.kind}:${viewAsState.value.id}` } : {}
}
