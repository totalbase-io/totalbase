import type { UserStatus } from '~/types/security'

export interface UsersSummary {
  total: number
  byStatus: Record<UserStatus, number>
  byRole: Record<string, number>
  /** Tokens that still authenticate, sessions still signed in. */
  credentials: { tokens: number, sessions: number }
}

/**
 * The users' counts (GET /users/summary), never the rows - the Users panel's, a role's Hierarchy's member
 * counts. One key (USERS_DATA_KEYS refreshes it after a change), one handler.
 */
export function useUsersSummary() {
  const api = useAdminApi()
  return useAsyncData('users-summary', () => api.get<UsersSummary>('/users/summary').then(r => r.data))
}
