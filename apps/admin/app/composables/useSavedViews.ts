import type { SavedView, SavedViewConfig } from '~/types/dataview'

/**
 * A DataView's saved views as the viewer sees them (DataViews.md §5.9): their own and those
 * shared with them or one of their roles. One list
 * for the toolbar's views popover - each change lands in it.
 */
export function useSavedViews(dataviewId: () => string) {
  const appApi = useAppApi()
  const views = ref<SavedView[]>([])
  const loaded = ref(false)
  const base = () => `/dataviews/${dataviewId()}/saved-views`
  const byName = (a: SavedView, b: SavedView) => a.name.localeCompare(b.name)

  async function load() {
    try {
      views.value = (await appApi.get<SavedView[]>(base())).data
    } catch {
      // Best-effort - no saved views to pick from.
    } finally {
      loaded.value = true
    }
  }

  async function create(name: string, config: SavedViewConfig): Promise<SavedView> {
    const created = (await appApi.post<SavedView>(base(), { data: { name, config } })).data
    views.value = [...views.value, created].sort(byName)
    return created
  }

  /** Owner only: a new name, or the current state saved over it. */
  async function update(id: string, patch: { name?: string, config?: SavedViewConfig }): Promise<SavedView> {
    const updated = (await appApi.patch<SavedView>(`${base()}/${id}`, { data: patch })).data
    views.value = views.value.map(v => (v.id === id ? updated : v)).sort(byName)
    return updated
  }

  async function remove(id: string) {
    await appApi.del(`${base()}/${id}`)
    views.value = views.value.filter(v => v.id !== id)
  }

  function setSharedCount(id: string, delta: number) {
    const view = views.value.find(v => v.id === id)
    if (view) view.sharedCount = Math.max(0, view.sharedCount + delta)
  }

  return { views, loaded, load, create, update, remove, setSharedCount }
}
