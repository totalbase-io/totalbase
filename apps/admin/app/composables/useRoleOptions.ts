import { WORKFLOWS_ROLE_NAME, type RoleSummary } from '~/types/security'

// The Workflows role is kept out of every human role-assignment picker
// this composable feeds - it's a system-only role, locked at both the app
// and DB layer (packages/permissions' RoleAssignmentsService, migration
// 000075) to the one seeded Workflows account. Showing it here would just
// be an option that always rejects on save.

/**
 * The roles for assignment selects (Users, API Keys, invitations...) - useRoles()' one list (`roles-all`) without
 * the Workflows role, so a role created, renamed or deleted shows here with one refresh. Awaitable like the
 * `useAsyncData` it reads.
 */
export function useRoleOptions() {
  const all = useRoles()
  const result = {
    data: computed<RoleSummary[]>(() => (all.data.value ?? []).filter(role => role.name !== WORKFLOWS_ROLE_NAME)),
    pending: all.pending,
    refresh: all.refresh
  }
  return Object.assign(all.then(() => result), result)
}
