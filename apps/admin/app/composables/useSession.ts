import type { DelegatedModule, PortalAccess } from '~/utils/role-access'
import { isAppPath, viewAsState } from '~/utils/view-as'

/**
 * The caller's effective date/time display settings - their My account
 * preferences over Settings > General (GET /admin/api/auth/me's
 * `display`). Empty timezone = the browser's zone; empty pattern = the
 * caller's own default. See useDateTimeFormat().
 */
export interface DisplayPreferences {
  timezone: string
  dateFormat: string
  timeFormat: string
  datetimeFormat: string
  /** The UI's language - the user's, else the instance's (Admin_UI.md §14). */
  language?: string
}

export interface AdminAccount {
  id: string
  email: string
  name?: string | null
  avatarUrl?: string | null
  /** ADMIN or APP (an API-only user never gets a portal session) - a routing hint only: the server re-checks access on every request. */
  access?: PortalAccess
  /** The delegated modules the rail shows (users, roles, files, templates, logs) - every one for an administrator. */
  modules?: DelegatedModule[]
  /** Per delegated module, the actions the user may take on its table (READ/CREATE/UPDATE/DELETE). */
  moduleActions?: Partial<Record<DelegatedModule | 'folders' | 'assignments', Array<'READ' | 'CREATE' | 'UPDATE' | 'DELETE'>>>
  /** A non-administrator's roles they may assign or remove - created by them, or managed by one of their roles. */
  assignableRoles?: string[] | null
  /** The roles below a role of theirs with MANAGE_ROLES (Security.md §9.5) - whose grants and objects they edit; null = none, or an administrator. */
  managedRoles?: string[] | null
  /** Where a role they create may go: their managing roles and the roles below them; null = none, or an administrator. */
  placeableRoles?: string[] | null
  /** Present once GET /auth/me has answered (the login response doesn't carry it). */
  display?: DisplayPreferences
  [key: string]: unknown
}

/**
 * Session state: the signed-in user's profile, from GET
 * /admin/api/auth/me. The session itself is an HttpOnly cookie the
 * browser sends with every same-origin request (Security.md §2.18) - no
 * script here ever holds its token, so a page reload asks the server
 * whether a session is open (plugins/session.client.ts).
 */
export function useSession() {
  const admin = useState<AdminAccount | null>('admin-session-account', () => null)
  // The current route's path, for See as - a plugin with no router yet reads none.
  const router = (() => {
    try {
      return useRouter()
    } catch {
      return null
    }
  })()
  const currentPath = () => router?.currentRoute.value.path ?? ''

  /** Forgets the signed-in user - after sign-out, or once the server says the session ended. */
  function clear() {
    admin.value = null
  }

  /** Re-reads the profile from GET /admin/api/auth/me - after sign-in, and after My account changes it (name, avatar, preferences). */
  async function refreshProfile() {
    const { data } = await $fetch<{ data: AdminAccount }>('/admin/api/auth/me')
    admin.value = data
  }

  return {
    admin,
    isAuthenticated: computed(() => admin.value !== null),
    // Previewing the App as someone (view-as.ts): its pages behave as for them - no administrator's controls.
    access: computed(() => admin.value?.access === 'ADMIN' && viewAsState.value && isAppPath(currentPath()) ? 'APP' : admin.value?.access),
    modules: computed(() => admin.value?.modules ?? []),
    /** Whether the user may take `action` in a delegated module - screens show only what they may do. */
    can: (module: DelegatedModule | 'folders' | 'assignments', action: 'READ' | 'CREATE' | 'UPDATE' | 'DELETE') => admin.value?.access === 'ADMIN' || (admin.value?.moduleActions?.[module] ?? []).includes(action),
    /** Whether the user may give (CREATE) or take away (DELETE) role `roleId` - the assignments grant and the role guardrail. */
    canAssign: (roleId: string, action: 'CREATE' | 'DELETE') => admin.value?.access === 'ADMIN'
      || ((admin.value?.moduleActions?.assignments ?? []).includes(action) && (admin.value?.assignableRoles ?? []).includes(roleId)),
    clear,
    refreshProfile
  }
}
