/**
 * The Auth settings (GET /admin/api/settings/auth), read-only, under one key for the Users screens that
 * show a value from them (the password minimum) - one handler, so Nuxt shares the result.
 */
export function useAuthSettings() {
  const api = useAdminApi()
  return useAsyncData(
    'users-auth-settings',
    () => api.get<Record<string, unknown>>('/settings/auth').then(r => r.data),
    { default: (): Record<string, unknown> => ({}) }
  )
}
