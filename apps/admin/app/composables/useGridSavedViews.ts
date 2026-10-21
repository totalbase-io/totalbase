import type { Ref } from 'vue'
import type { DataViewType, SavedView, SavedViewConfig } from '~/types/dataview'
import { AdminApiError } from '~/utils/admin-api-error'

/**
 * A grid's saved views (features.savedViews, DataViews.md §5.9): named snapshots of the view, filter,
 * columns/order, sort and density, never changed once saved - what's on screen is saved as a new one, or replaces one
 * of one's own by its name. The views menu (DataViewSavedViewsMenu) opens, saves, shares and deletes them; the grid
 * captures and applies the state through `capture`/`apply` - this owns the open view and the writes with their toasts.
 */
export function useGridSavedViews(options: {
  dataviewId: () => string
  /** The DataView offers saved views - the list loads up front. */
  enabled: boolean
  /** The view the viewer had open last time (their prefs' `savedView`). */
  initialViewId: string | null | undefined
  /** The grid's Filter box - a reopened view's filter isn't kept in the prefs, it comes from the view. */
  whereText: Ref<string>
  /** The grid's current state as a view's config - or why it can't be captured (an invalid filter). */
  capture: () => SavedViewConfig | { error: string }
  /** Applies a view's whole config to the grid - filter, columns, sort, density and layout. */
  apply: (config: SavedViewConfig) => void
  /** `view_config.default_state` (the prop) - what Default opens with, and the Columns panel's "Default". */
  defaultState: () => Record<string, unknown> | undefined
  /** The DataView's own type - what the selector's Default opens in. */
  viewType: () => DataViewType
}) {
  const appApi = useAppApi()
  const toast = useToast()
  const { t } = useI18n()
  const notifyError = useErrorToast()

  const savedViews = useSavedViews(options.dataviewId)
  if (options.enabled) void savedViews.load()
  /** The open saved view (the selector's) - null: Default. Kept with the viewer's prefs. */
  const activeViewId = ref<string | null>(null)
  // The view the viewer had open last time: the rest of its state is already their prefs', its filter isn't kept there.
  watch(() => savedViews.loaded.value, (loaded) => {
    const view = loaded && options.initialViewId ? savedViews.views.value.find(v => v.id === options.initialViewId) : undefined
    if (!view || activeViewId.value) return
    activeViewId.value = view.id
    if (view.config.where) options.whereText.value = JSON.stringify(view.config.where, null, 2)
  })

  /** The selector: a saved view, or Default - the author's: their default state, no filter, the view it opens with. */
  function selectSavedView(id: string | null) {
    const view = id ? savedViews.views.value.find(v => v.id === id) : null
    if (view) {
      options.apply(view.config)
    } else {
      const config = (effectiveDefaultState.value ?? {}) as SavedViewConfig
      options.apply({ ...config, where: null, layout: options.viewType() })
    }
    activeViewId.value = view?.id ?? null
  }
  /** A save in flight - the views menu closes once it lands. */
  const savingView = ref(false)
  async function saveNewView(name: string) {
    const config = options.capture()
    if ('error' in config) {
      toast.add({ title: t('dataviews.savedViews.captureError'), description: config.error, color: 'error' })
      return
    }
    savingView.value = true
    try {
      activeViewId.value = (await savedViews.create(name, config)).id
      toast.add({ title: t('dataviews.savedViews.saved'), color: 'success' })
    } catch (err) {
      notifyError(err, t('dataviews.savedViews.saveError'))
    } finally {
      savingView.value = false
    }
  }
  /** One of one's own views, replaced by what's on screen - saving under its name, asked first (SaveViewForm). */
  async function replaceSavedView(id: string) {
    const config = options.capture()
    if ('error' in config) {
      toast.add({ title: t('dataviews.savedViews.captureError'), description: config.error, color: 'error' })
      return
    }
    savingView.value = true
    try {
      await savedViews.update(id, { config })
      activeViewId.value = id
      toast.add({ title: t('dataviews.savedViews.saved'), color: 'success' })
    } catch (err) {
      notifyError(err, t('dataviews.savedViews.saveError'))
    } finally {
      savingView.value = false
    }
  }
  async function removeSavedView(id: string) {
    try {
      await savedViews.remove(id)
    } catch (err) {
      notifyError(err, t('dataviews.savedViews.deleteError'))
    }
  }
  // A view deleted while open: back to Default's label, the state stays.
  watch(() => savedViews.views.value, (views) => {
    if (activeViewId.value && !views.some(v => v.id === activeViewId.value)) activeViewId.value = null
  })

  /**
   * A saved view applied via link ("Copy link" in the Share modal) - `?view=<id>`
   * in the URL, fetched through the ownership-agnostic /link endpoint and
   * applied once, right on this load. Never added to the opener's own "Saved
   * views" list - its host drops the param right after (`onDone`), so a reload
   * doesn't keep reapplying it.
   */
  function applySharedView(viewId: string, onDone: () => void) {
    appApi.get<SavedView>(`/dataviews/${options.dataviewId()}/saved-views/${viewId}/link`).then((res) => {
      options.apply(res.data.config)
      // One of the viewer's own or shared with them: it's the open view; anyone else's applies once.
      activeViewId.value = savedViews.views.value.some(v => v.id === res.data.id) ? res.data.id : null
      toast.add({ title: t('dataviews.grid.viewApplied', { name: res.data.name }), color: 'success' })
    }).catch((err) => {
      // 404: the view was deleted since the link was copied.
      const stale = err instanceof AdminApiError && err.status === 404
      toast.add({ title: stale ? t('dataviews.grid.viewLinkStale') : t('dataviews.grid.viewLinkError'), color: 'error' })
    }).finally(onDone)
  }

  const effectiveDefaultState = computed(() => options.defaultState())

  return {
    savedViews,
    activeViewId,
    savingView,
    selectSavedView,
    saveNewView,
    replaceSavedView,
    removeSavedView,
    applySharedView,
    effectiveDefaultState
  }
}
