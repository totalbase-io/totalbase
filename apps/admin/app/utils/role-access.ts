/**
 * Mirrors packages/permissions' RoleAccessFlags: three
 * independent flags on a role, each OR-ed across a user's active roles.
 * adminAccess is reserved to the seeded roles (Administrators, Workflows)
 * and never settable - the Roles form shows it locked.
 */
export type RoleAccessFlag = 'adminAccess' | 'appAccess' | 'apiAccess'

export interface RoleAccessFlags {
  adminAccess: boolean
  appAccess: boolean
  apiAccess: boolean
}

export const ROLE_ACCESS_FLAGS: RoleAccessFlag[] = ['adminAccess', 'appAccess', 'apiAccess']

/** Labels and descriptions are locale keys (`users.roleAccess.*`), translated where shown. */
export const ROLE_ACCESS_META: Record<RoleAccessFlag, { labelKey: string, descriptionKey: string, icon: string, color: 'error' | 'primary' | 'neutral' }> = {
  adminAccess: {
    labelKey: 'users.roleAccess.adminAccess.label',
    descriptionKey: 'users.roleAccess.adminAccess.description',
    icon: 'i-lucide-shield-check',
    color: 'error'
  },
  appAccess: {
    labelKey: 'users.roleAccess.appAccess.label',
    descriptionKey: 'users.roleAccess.appAccess.description',
    icon: 'i-lucide-app-window',
    color: 'primary'
  },
  apiAccess: {
    labelKey: 'users.roleAccess.apiAccess.label',
    descriptionKey: 'users.roleAccess.apiAccess.description',
    icon: 'i-lucide-webhook',
    color: 'neutral'
  }
}

/** The flags a role grants, in display order. */
export function grantedAccessFlags(role: RoleAccessFlags): RoleAccessFlag[] {
  return ROLE_ACCESS_FLAGS.filter(flag => role[flag])
}

/** Which portal a signed-in user opens - derived server-side from their flags (admin wins over app). */
export type PortalAccess = 'ADMIN' | 'APP'

/**
 * Where a portal user lands - after signing in, at `/` and from the rail's mark (Admin_UI.md §3.4):
 * an administrator on Status, the instance's state; everyone else in the App, what the instance is built for.
 */
export function portalHomeFor(access: PortalAccess | undefined): string {
  return access === 'ADMIN' ? '/status' : '/app'
}

/** A portal module a non-administrator can be delegated - visible when their roles may read its table (Security.md §9.2). */
export type DelegatedModule = 'users' | 'roles' | 'files' | 'templates' | 'logs'

/** The pages each delegated module opens - never its administrator-only parts (sign-in insights, system emails). */
const MODULE_PATHS: Record<DelegatedModule, { allow: RegExp, deny?: RegExp }> = {
  users: { allow: /^\/users(\/|\?|$)/, deny: /^\/users\/insights(\/|\?|$)/ },
  roles: { allow: /^\/roles(\/|\?|$)/ },
  files: { allow: /^\/files(\/|\?|$)/ },
  templates: { allow: /^\/templates(\/|\?|$)/, deny: /^\/templates\/system(\/|\?|$)/ },
  logs: { allow: /^\/logs(\/|\?|$)/ }
}

/**
 * Whether a portal path is inside what the user may open: an administrator
 * reaches everything; an APP user the App, their own account, and the
 * delegated modules their permissions open. Only a routing decision - the
 * server checks every request on its own.
 */
export function isPortalPathAllowed(path: string, access: PortalAccess | undefined, modules: readonly DelegatedModule[] = []): boolean {
  if (access !== 'APP') return true
  if ([/^\/app(\/|\?|$)/, /^\/account(\?|$)/].some(pattern => pattern.test(path))) return true
  return modules.some((module) => {
    const rule = MODULE_PATHS[module]
    return rule.allow.test(path) && !rule.deny?.test(path)
  })
}
