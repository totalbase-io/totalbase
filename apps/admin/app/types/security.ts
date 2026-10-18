/**
 * Users, Sessions, API Keys, Roles (Phase C/D) — shapes verified against
 * the running server, not guessed. `GET /users` (the list) and
 * `GET /users/{id}` both return camelCase; the list adds what the Users
 * screen filters on (role ids, whether a password is set yet).
 */
export interface AdminUser {
  id: string
  /** Every user has one. */
  email: string
  name: string | null
  active: boolean
  /** The single instance owner: cannot be deleted, cannot lose the Administrators role. */
  owner: boolean
  /** False for system/service accounts (e.g. the Workflows user) that never sign in directly. */
  canLogin: boolean
  avatarUrl: string | null
  emailVerifiedAt: string | null
  createdAt: string
}

export interface AdminUserListItem extends AdminUser {
  /** Role ids assigned to the user. */
  roles: string[]
  /** False for an invited account that hasn't set its password yet. */
  hasPassword: boolean
  lastLoginAt: string | null
  /** Sign-in refused until then (too many failed attempts); null when not locked. */
  lockedUntil: string | null
  /** Consecutive failed sign-ins since the last success/unlock/lockout. */
  failedLoginCount: number
  /** The picture of the user's most recently used sign-in provider, if any. */
  providerAvatar: { url: string, provider: string } | null
}

// Kept in sync with @totalbase/shared's WORKFLOWS_SYSTEM_USER_EMAIL - not
// imported directly since this app doesn't depend on that package; the
// server rejects deleting this account regardless (UsersService.delete()
// + a DB trigger backstop), this is just to not offer a button that
// always fails.
export const WORKFLOWS_SYSTEM_USER_EMAIL = 'workflows@system.totalbase.internal'

export function isSystemUser(user: Pick<AdminUser, 'email'>): boolean {
  return user.email === WORKFLOWS_SYSTEM_USER_EMAIL
}

// The seeded, system-only Workflows role - reserved and
// ADMIN-access like Administrators, so its name is what tells them apart
// (same check useRoleOptions() uses to keep it out of assignment pickers).
export const WORKFLOWS_ROLE_NAME = 'Workflows'

export function isWorkflowsRole(role: { name: string, reserved: boolean }): boolean {
  return role.reserved && role.name === WORKFLOWS_ROLE_NAME
}

/** How the Users screen classifies a user - see userStatus(). */
export type UserStatus = 'ACTIVE' | 'INVITED' | 'INACTIVE'

export function userStatus(user: Pick<AdminUserListItem, 'active' | 'hasPassword' | 'canLogin'>): UserStatus {
  if (!user.active) return 'INACTIVE'
  if (!user.hasPassword && user.canLogin) return 'INVITED'
  return 'ACTIVE'
}

/** `labelKey` is a locale key (`users.status.*`), translated where shown. */
export const USER_STATUS_META: Record<UserStatus, { labelKey: string, color: 'success' | 'warning' | 'neutral' }> = {
  ACTIVE: { labelKey: 'users.status.ACTIVE', color: 'success' },
  INVITED: { labelKey: 'users.status.INVITED', color: 'warning' },
  INACTIVE: { labelKey: 'users.status.INACTIVE', color: 'neutral' }
}

export interface Session {
  id: string
  user: string
  ip: string | null
  userAgent: string | null
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  revokedAt: string | null
  /** The owner's email and name. */
  userEmail?: string | null
  userName?: string | null
  /** The caller's own session. */
  current?: boolean
}

/** Personal access token (totalbase.tokens) - replaces the old standalone ApiKey. */
export interface UserApiToken {
  id: string
  user: string
  name: string
  description: string | null
  /** "API" inherits the owning user's data-plane roles live; "ADMIN" requires that user to hold Administrators. */
  plane: 'API' | 'ADMIN'
  keyPrefix: string
  active: boolean
  expiresAt: string | null
  lastUsedAt: string | null
  rotatedAt: string | null
  revokedAt: string | null
  createdAt: string
}

/** Only present once, right after POST .../rotate — never stored, never shown again. */
export interface UserApiTokenSecret {
  key: string
}

export interface RoleSummary {
  id: string
  name: string
  active: boolean
  /** Administrators or Workflows: cannot be renamed, deactivated, or deleted. */
  reserved: boolean
  /** adminAccess is the full-access bypass (EffectivePermissionService/WorkflowPermissionService's own `isAdministrators()`) - such a role already has implicit access to everything, workflow invocation included, so pickers that ask "which roles need an explicit grant" exclude it rather than list it as a redundant, always-on option. */
  adminAccess: boolean
  appAccess: boolean
  apiAccess: boolean
  createdAt: string
}

/** My account - GET /app/api/me (Specification_Security.md §4.1). */
export interface MyAccount {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
  emailVerifiedAt: string | null
  createdAt: string
  hasPassword: boolean
  lastLoginAt: string | null
  providerAvatar: { url: string, provider: string } | null
  passwordMinLength: number
  /** Which personal access tokens this account can hold. */
  tokens: { api: boolean, admin: boolean }
}

/** A user's own display preferences (users.preferences) - a missing key = the instance default. */
export interface MyPreferences {
  timezone?: string
  dateFormat?: string
  timeFormat?: string
  /** The UI's language (Specification_Admin_UI.md §14). */
  language?: string
}

/** GET/PATCH /app/api/me/preferences. */
export interface MyPreferencesState {
  preferences: MyPreferences
  instance: { timezone: string, dateFormat: string, timeFormat: string, datetimeFormat: string, language: string }
  effective: { timezone: string, dateFormat: string, timeFormat: string, datetimeFormat: string, language: string }
  /** The organization sets everyone's timezone (Settings > General) - a user's own is kept, not used. */
  timezoneLocked: boolean
}
