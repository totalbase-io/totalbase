/**
 * What still names a column, a table or a view PostgreSQL no longer has (Specification_DataViews.md
 * §4.8, Specification_Dashboards.md §2.8) - `GET /admin/api/catalog/broken-references`: dashboard
 * widgets whose query PostgreSQL refuses, DataViews whose layouts or Filter name a lost column. One
 * read shared by the DataViews and Dashboards trees (their error icon); `refresh()` after a sync.
 */
export interface BrokenDashboardWidget {
  dashboard: { id: string, name: string, slug: string }
  widget: { id: string, label: string | null, type: string }
  version: number | null
  code: 'UNDEFINED_COLUMN' | 'UNDEFINED_TABLE' | 'UNDEFINED_FUNCTION'
  message: string
  query: string
}
export interface BrokenDataViewReference {
  dataview: { id: string, name: string, slug: string }
  resource: string | null
  version: number | null
  part: string
  column: string | null
}
export interface BrokenReferences {
  dashboards: BrokenDashboardWidget[]
  dataviews: BrokenDataViewReference[]
}

export function useBrokenReferences() {
  const api = useAdminApi()
  const state = useState<BrokenReferences | null>('broken-references', () => null)
  const loading = useState('broken-references-loading', () => false)
  async function refresh() {
    loading.value = true
    try {
      state.value = (await api.get<BrokenReferences>('/catalog/broken-references')).data
    } catch {
      // Best-effort: no icons rather than an error in a side tree.
    } finally {
      loading.value = false
    }
  }
  /** Loads it once - the trees call this on mount. */
  function ensure() {
    if (state.value === null && !loading.value) void refresh()
  }
  const dataviewProblems = computed(() => {
    const map = new Map<string, BrokenDataViewReference[]>()
    for (const reference of state.value?.dataviews ?? []) map.set(reference.dataview.id, [...(map.get(reference.dataview.id) ?? []), reference])
    return map
  })
  const dashboardProblems = computed(() => {
    const map = new Map<string, BrokenDashboardWidget[]>()
    for (const widget of state.value?.dashboards ?? []) map.set(widget.dashboard.id, [...(map.get(widget.dashboard.id) ?? []), widget])
    return map
  })
  return { state, loading, refresh, ensure, dataviewProblems, dashboardProblems }
}

/** What a DataView names that's gone, as a line: "card_layout.titleFormula: nombre" - or its source. */
export function brokenDataViewLine(reference: BrokenDataViewReference, sourceGone: string): string {
  return reference.column === null ? sourceGone : `${reference.part}: ${reference.column}`
}
