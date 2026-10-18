import type { DataView } from '~/types/dataview'

/**
 * The "App" rail group's data source - every LISTED DataView, shared
 * across the whole admin (useState, not a per-component fetch) so
 * creating/deleting one from database/dataviews.vue updates the rail
 * immediately via `refresh()`, without every page re-fetching its own
 * copy. See navigation.ts's `buildAppsNavGroup` for how this becomes
 * (or stops being) a rail group.
 */
export function useAppsNavDataViews() {
  const api = useAdminApi()
  const dataviews = useState<DataView[]>('apps-nav-dataviews', () => [])
  const loaded = useState('apps-nav-dataviews-loaded', () => false)
  const loading = useState('apps-nav-dataviews-loading', () => false)
  const error = useState<unknown>('apps-nav-dataviews-error', () => null)

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
      const { data } = await api.get<DataView[]>('/dataviews')
      dataviews.value = data
    } catch (err) {
      error.value = err
    } finally {
      // A failed first request is still a completed attempt. Keeping this
      // false makes every remount issue another request and can turn a
      // redirecting landing page into a request loop.
      loaded.value = true
      loading.value = false
    }
  }

  if (import.meta.client && !loaded.value && !loading.value) {
    refresh()
  }

  /**
   * An editor that just re-read one DataView's versioning status (after an
   * autosave, a publish, a restore) writes it into the shared list, so the
   * DataViews sidebar's status colors follow without refetching the list.
   */
  function patchStatus(id: string, status: Pick<DataView, 'liveVersion' | 'hasUnpublishedChanges'>) {
    const entry = dataviews.value.find(d => d.id === id)
    if (entry) Object.assign(entry, status)
  }

  return { dataviews, loading, error, refresh, patchStatus }
}
