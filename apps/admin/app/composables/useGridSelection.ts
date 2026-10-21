import type { ComputedRef, Ref } from 'vue'
import type { RowsChange } from '~/types/dataview'

/** How many DELETEs a bulk delete keeps in flight. */
const BULK_DELETE_CONCURRENCY = 4

/**
 * A grid's row selection (DataViewGrid.vue, standalone layout): the rows the
 * viewer picks, kept by their key across pages, sorts, searches and refreshes
 * - a bulk edit or a selection's action takes rows from several pages
 * (DataViews.md §5.15). TanStack's RowSelectionState for the
 * page on screen is derived from it (`rowSelection`, by the page's row
 * index). Without a primary key there's nothing to keep a row by: the
 * selection is the page's, cleared when it changes.
 *
 * Also the selection's bulk delete: its confirmation modal's state and the
 * DELETE itself - a few at a time, never every row at once; a failure doesn't
 * hide the others' success.
 */
export function useGridSelection(options: {
  rows: ComputedRef<Record<string, unknown>[]>
  primaryKey: () => string | undefined
  /** The most rows a viewer may choose - dataviews.bulk_edit_max_rows where they may be edited together. */
  selectionCap: () => number
  schema: () => string
  resourceName: () => string
  refresh: () => Promise<unknown>
  onRowsChanged: (change: RowsChange) => void
  /** The exposed count, declared by the grid before its first top-level await (see its `defineExpose`). */
  selectedCount: Ref<number>
}) {
  const dataApi = useDataApi()
  const toast = useToast()
  const { t } = useI18n()
  const notifyError = useErrorToast()

  const selectedByKey = ref<Record<string, Record<string, unknown>>>({})
  const keyOfRow = (row: Record<string, unknown>, index: number) => (options.primaryKey() ? `k:${String(row[options.primaryKey()!])}` : `#${index}`)
  watch(options.rows, () => {
    if (!options.primaryKey()) selectedByKey.value = {}
  })
  const rowSelection = computed<Record<string, boolean>>({
    get: () => Object.fromEntries(options.rows.value.map((row, index) => [String(index), keyOfRow(row, index) in selectedByKey.value])),
    set: (next) => {
      // This page's rows as `next` says, every other page's as they were - never past the cap (a select-all stops there).
      const page = new Map(options.rows.value.map((row, index) => [keyOfRow(row, index), { row, on: !!next[String(index)] }]))
      const kept = Object.entries(selectedByKey.value).filter(([key]) => !page.has(key))
      const room = Math.max(0, options.selectionCap() - kept.length)
      selectedByKey.value = Object.fromEntries([
        ...kept,
        ...[...page].filter(([, entry]) => entry.on).slice(0, room).map(([key, entry]) => [key, entry.row] as const)
      ])
    }
  })
  const selectedRows = computed(() => Object.values(selectedByKey.value))
  watch(selectedRows, (list) => {
    options.selectedCount.value = list.length
  }, { immediate: true })
  const atSelectionCap = computed(() => selectedRows.value.length >= options.selectionCap())

  /** A card's checkbox (the table's is TanStack's own). */
  function toggleRowSelected(index: number) {
    rowSelection.value = { ...rowSelection.value, [index]: !rowSelection.value[index] }
  }
  /** The hosting page's header "✕" / Clear selection (PageHeader's `selection`). */
  function clearSelection() {
    selectedByKey.value = {}
  }

  // --- Bulk delete ---
  const bulkDropConfirmOpen = ref(false)
  const bulkDeleting = ref(false)
  function requestBulkDelete() {
    if (!options.selectedCount.value) return
    bulkDropConfirmOpen.value = true
  }
  async function confirmBulkDrop() {
    const primaryKey = options.primaryKey()
    if (!primaryKey) return
    bulkDeleting.value = true
    try {
      const rows = selectedRows.value
      // A few at a time, never every row at once; a failure doesn't hide the others' success: the deleted rows
      // leave the selection, the failed ones stay in it with the first error shown.
      const deleted: Record<string, unknown>[] = []
      let firstError: unknown
      let next = 0
      const worker = async () => {
        while (next < rows.length) {
          const row = rows[next++]!
          try {
            await dataApi.del(dataApi.resourcePath(options.schema(), options.resourceName(), 'table', String(row[primaryKey])))
            deleted.push(row)
          } catch (err) {
            firstError ??= err
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(BULK_DELETE_CONCURRENCY, rows.length) }, worker))
      if (deleted.length) options.onRowsChanged({ action: 'delete', rows: deleted })
      const deletedKeys = new Set(deleted.map(row => String(row[primaryKey])))
      selectedByKey.value = Object.fromEntries(Object.entries(selectedByKey.value).filter(([key]) => !deletedKeys.has(key)))
      if (firstError === undefined) {
        toast.add({ title: t('dataviews.grid.rowsDeleted', { count: deleted.length }), color: 'success' })
        bulkDropConfirmOpen.value = false
      } else {
        notifyError(firstError, t('dataviews.grid.rowsDeletedPartial', { deleted: deleted.length, total: rows.length }))
      }
      await options.refresh()
    } finally {
      bulkDeleting.value = false
    }
  }

  return {
    rowSelection,
    selectedRows,
    atSelectionCap,
    toggleRowSelected,
    clearSelection,
    bulkDropConfirmOpen,
    bulkDeleting,
    requestBulkDelete,
    confirmBulkDrop
  }
}
