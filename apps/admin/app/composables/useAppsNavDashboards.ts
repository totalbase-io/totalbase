import type { Dashboard } from '~/types/dashboard'

/**
 * Dashboards list, shared across the admin (useState, not a per-component
 * fetch) - same pattern useAppsNavDataViews.ts already uses for DataViews,
 * so creating/deleting a dashboard from one page updates every other page
 * reading this state without a manual refresh wire-up.
 */
export function useAppsNavDashboards() {
  const api = useAdminApi()
  const dashboards = useState<Dashboard[]>('apps-nav-dashboards', () => [])
  const loaded = useState('apps-nav-dashboards-loaded', () => false)
  const loading = useState('apps-nav-dashboards-loading', () => false)
  const error = useState<unknown>('apps-nav-dashboards-error', () => null)

  // One request at a time: a refresh() while one is in flight waits for it,
  // so every caller's `await` resolves once the list is fresh.
  let inFlight: Promise<void> | null = null
  function refresh(): Promise<void> {
    if (!inFlight) {
      inFlight = load().finally(() => {
        inFlight = null
      })
    }
    return inFlight
  }

  async function load() {
    loading.value = true
    error.value = null
    try {
      const { data } = await api.get<Dashboard[]>('/dashboards')
      dashboards.value = data
    } catch (err) {
      error.value = err
    } finally {
      loaded.value = true
      loading.value = false
    }
  }

  if (import.meta.client && !loaded.value && !loading.value) {
    refresh()
  }

  /** An editor that just re-read a dashboard's versioning status writes it here, so the Dashboards sidebar's badge follows without refetching the list. */
  function patchStatus(id: string, status: Pick<Dashboard, 'liveVersion' | 'hasUnpublishedChanges'>) {
    const entry = dashboards.value.find(d => d.id === id)
    if (entry) Object.assign(entry, status)
  }

  return { dashboards, loading, error, refresh, patchStatus }
}
