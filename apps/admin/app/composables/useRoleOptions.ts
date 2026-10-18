import { WORKFLOWS_ROLE_NAME, type RoleSummary } from '~/types/security'

// The Workflows role is kept out of every human role-assignment picker
// this composable feeds - it's a system-only role, locked at both the app
// and DB layer (packages/permissions' RoleAssignmentsService, migration
// 000075) to the one seeded Workflows account. Showing it here would just
// be an option that always rejects on save.

/**
 * Shared, cached list of roles for assignment selects (Users, API Keys).
 * Small, rarely-changing list (most Admin API lists are small) — one
 * fetch per session is enough, no need for a dedicated store.
 */
export function useRoleOptions() {
  const roles = useRolesApi()
  return useAsyncData<RoleSummary[]>(
    'role-options',
    () => roles.list().then(list => list.filter(role => role.name !== WORKFLOWS_ROLE_NAME)),
    { default: () => [] }
  )
}
