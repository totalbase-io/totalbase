import type { DataView, DataViewField } from '~/types/dataview'
import { resolveEditPresentation, resolveEditSide, resolveEditSize } from '~/types/dataview'

/**
 * Fetches + resolves a DataView another DataView's own field points at
 * via `related_dataview` - shared by `WidgetDataView.vue` (mounts it
 * as a grid) and `DataViewNewRecordButton.vue` (opens it as a bare
 * create form). Both need the exact same resolution (definition, fields,
 * single-column primary key, write-eligibility, edit_presentation);
 * only what they DO with it differs, so extracting this out is what
 * keeps them from drifting into two slightly different copies.
 *
 * `targetId` is read once, at mount, not reactively - a Detail's/
 * NEW_RECORD's own target is immutable after creation (see
 * CustomDesigner.vue's own doc comment on why), so there's nothing
 * to re-fetch on.
 */
export function useLinkedDataview(targetId: string | null) {
  const api = useAppApi()

  const dataview = ref<DataView | null>(null)
  const fields = ref<DataViewField[]>([])
  /**
   * Distinct from "still loading" - any failure (permission denied on
   * the definition fetch, the target since deleted, a network error, or
   * no target at all) means "don't render" rather than showing an error
   * about a DataView the caller didn't even ask to see. Matches
   * Specification_DataViews.md §9.7: "independently gated by the viewer's own READ permission... if
   * absent, the panel doesn't render" - no new permission-checking
   * mechanism, just not surfacing what the fetch already refused.
   */
  const loadFailed = ref(false)
  const loading = ref(true)

  onMounted(async () => {
    if (!targetId) {
      loadFailed.value = true
      loading.value = false
      return
    }
    try {
      const [dataviewRes, fieldsRes] = await Promise.all([
        api.get<DataView>(`/dataviews/${targetId}`),
        api.get<DataViewField[]>(`/dataviews/${targetId}/fields`)
      ])
      dataview.value = dataviewRes.data
      fields.value = fieldsRes.data
    } catch {
      loadFailed.value = true
    } finally {
      loading.value = false
    }
  })

  const primaryKey = computed(() => {
    const pk = dataview.value?.sourceResourcePrimaryKey
    return pk && pk.length === 1 ? pk[0] : undefined
  })
  const writable = computed(() => dataview.value?.sourceResourceType === 'TABLE' && primaryKey.value !== undefined)
  // What the viewer's own grants allow (the App's `grantedActions`): editing, New, Delete each on its own. An embed
  // narrows them with its own Allow, not the DataView's - that one is for the DataView's own pages (§5.1).
  const actions = computed(() => dataview.value?.grantedActions ?? dataview.value?.viewerActions)
  const canWrite = computed(() => writable.value && actions.value?.update !== false)
  const canCreate = computed(() => writable.value && actions.value?.create !== false)
  const canDelete = computed(() => writable.value && actions.value?.delete !== false)
  const editPresentation = computed(() => resolveEditPresentation(dataview.value?.viewConfig ?? {}))
  const editSize = computed(() => resolveEditSize(dataview.value?.viewConfig ?? {}))
  const editSide = computed(() => resolveEditSide(dataview.value?.viewConfig ?? {}))

  return { dataview, fields, loadFailed, loading, primaryKey, canWrite, canCreate, canDelete, editPresentation, editSize, editSide }
}
