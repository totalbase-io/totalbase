/**
 * Every pair of roles no user may hold together (Security.md §1.9), under one key for the screens that turn
 * off what can't be held before PostgreSQL would refuse it: a user's Roles tab, a role's Members tab.
 */
export function useRoleIncompatibilities() {
  const api = useAdminApi()
  return useAsyncData(
    'roles-incompatibilities',
    () => api.get<{ role: string, other: string }[]>('/roles/incompatibilities').then(r => r.data),
    { default: (): { role: string, other: string }[] => [] }
  )
}

/** The roles in `held` that `roleId` can't be held with. */
export function incompatibleWith(pairs: { role: string, other: string }[], roleId: string, held: string[]): string[] {
  return pairs
    .map(pair => pair.role === roleId ? pair.other : pair.other === roleId ? pair.role : null)
    .filter((id): id is string => !!id && held.includes(id))
}
