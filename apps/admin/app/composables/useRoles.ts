/**
 * Every role, reserved/system ones included - the Roles panel's list
 * (RolesTree.vue) and role-name lookups for display (the Users table's
 * Roles column). Assignment pickers use useRoleOptions() instead, which
 * leaves out the system-only Workflows role. Refresh after a role is
 * created, renamed, or deleted: `refreshNuxtData('roles-all')`. Read through
 * the Data API (useRolesApi) - a delegated user gets the roles they may read.
 */
export function useRoles() {
  const roles = useRolesApi()
  return useAsyncData(
    'roles-all',
    () => roles.list(),
    { default: () => [] }
  )
}
