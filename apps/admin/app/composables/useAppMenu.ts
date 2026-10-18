import type { AppMenu } from '~/types/app-menu'

/**
 * The App menu as the signed-in user may see it (/app/api/menu, filtered
 * server-side through both access levels), shared across the portal -
 * the menu editor refreshes it after saving so the panel follows at once.
 */
export function useAppMenu() {
  const api = useAppApi()
  const menu = useState<AppMenu | null>('app-menu', () => null)
  const loading = useState('app-menu-loading', () => false)
  const error = useState<unknown>('app-menu-error', () => null)

  async function refresh() {
    loading.value = true
    error.value = null
    try {
      menu.value = (await api.get<AppMenu>('/menu')).data
    } catch (err) {
      error.value = err
    } finally {
      loading.value = false
    }
  }

  if (menu.value === null && !loading.value && import.meta.client) void refresh()
  return { menu, loading, error, refresh }
}
