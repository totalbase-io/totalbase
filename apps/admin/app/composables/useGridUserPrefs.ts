import type { WatchSource } from 'vue'
import type { ColPref, DataViewType, Density } from '~/types/dataview'

/** The grid's toolbar: every action its own button, or Search/Actions/New with the rest in a "⋮". */
export type ToolbarMode = 'full' | 'compact'

export const isToolbarMode = (value: unknown): value is ToolbarMode => value === 'full' || value === 'compact'

/**
 * A viewer's own DEFAULT grid state for one DataView (DataViewGrid.vue):
 * columns/order, sort, density, toolbar mode, page size, a Kanban's
 * collapsed lanes, the open view and the open saved view. Auto-saved
 * server-side per (dataview, user) rather than in a browser's localStorage,
 * so it follows the user across devices. Distinct from a named saved view
 * (`dataviews_saved_views`): this is just "whatever it was last left at".
 */
export interface UserPrefsConfig {
  columnPrefs?: Record<string, ColPref>
  sort?: string
  density?: Density
  toolbarMode?: ToolbarMode
  pageSize?: number
  collapsedLanes?: string[]
  layout?: DataViewType
  savedView?: string | null
}

/**
 * The viewer's prefs for a DataView, fetched once up front so the first
 * render already reflects them (no flash of every column visible before
 * they land). Falls back to `fallback` - the DataView's own `default_state`
 * ("Set as default for everyone") - when nothing was ever saved for this
 * viewer, or when the read fails (same as a first-time viewer).
 */
export async function loadGridUserPrefs(dataviewId: string, fallback: Record<string, unknown> | undefined): Promise<UserPrefsConfig> {
  const appApi = useAppApi()
  try {
    const res = await appApi.get<{ config: UserPrefsConfig } | null>(`/dataviews/${dataviewId}/user-prefs`)
    if (res.data) return res.data.config
  } catch {
    // Best-effort - falls back to defaults, same as a first-time viewer.
  }
  return (fallback ?? {}) as UserPrefsConfig
}

/**
 * Debounced auto-save of the prefs back to the server - not on every
 * keystroke/click, one PUT ~600ms after the last change in any of
 * `sources`. Never fires from the initial seeding (that happens before this
 * watch exists), only from a real later change. A failed save just means
 * the next visit falls back to whatever was last successfully saved.
 */
export function useGridUserPrefsAutosave(dataviewId: () => string, sources: WatchSource[], build: () => UserPrefsConfig) {
  const appApi = useAppApi()
  let timer: ReturnType<typeof setTimeout> | undefined
  function schedule() {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      appApi.put(`/dataviews/${dataviewId()}/user-prefs`, { data: { config: build() } }).catch(() => {
        // Best-effort - see the doc comment above.
      })
    }, 600)
  }
  watch(sources, schedule, { deep: true })
  onUnmounted(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}
