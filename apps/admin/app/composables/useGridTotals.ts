import type { ComputedRef, Ref } from 'vue'
import type { DataViewField } from '~/types/dataview'
import type { DisplayFormatDefaults } from '~/composables/useDisplayFormatDefaults'
import { formatCellPlainText } from '~/utils/build-dataview-columns'
import { totalsParams, totalsPlan, type TotalEntry } from '~/utils/column-totals'

/**
 * A grid's totals (DataViews.md §4.9): each shown column's, over
 * every row its filters keep - PostgreSQL's aggregates in a read of their own,
 * read again with the rows; the TABLE's foot shows them. Read again when the
 * rows' filter or search changes, or when the rows are reread in place (a
 * save, Refresh) - not when only the page or the order changes: the totals are
 * over every page, the same whichever is shown.
 */
export function useGridTotals(options: {
  /** Only a TABLE has a foot to show them in. */
  active: () => boolean
  orderedFields: ComputedRef<DataViewField[]>
  /** The source's own Data API path (a view is `/view/`). */
  path: () => string
  /** What narrows the rows - the list's filter and search, every page. */
  listFilterParams: ComputedRef<Record<string, string>>
  /** The list's paging - a change in it alone is not a reason to reread. */
  fetchParams: ComputedRef<unknown>
  /** The rows' own fetch result - a reread in place rereads the totals. */
  data: Ref<unknown>
  displayFormatDefaults: Ref<DisplayFormatDefaults>
}) {
  const dataApi = useDataApi()
  const { t } = useI18n()
  const totalsPlanned = computed(() => (options.active() ? totalsPlan(options.orderedFields.value) : []))
  const totalsRow = ref<Record<string, unknown> | null>(null)
  // Only the latest read lands: a filter typed faster than the server answers must not leave an older total.
  const latestTotals = useLatest()
  async function loadTotals() {
    const load = latestTotals.next()
    if (totalsPlanned.value.length === 0) {
      totalsRow.value = null
      return
    }
    try {
      const { data: rows } = await dataApi.get<Record<string, unknown>[]>(options.path(), {
        ...options.listFilterParams.value,
        ...totalsParams(totalsPlanned.value)
      })
      if (load.isCurrent()) totalsRow.value = rows[0] ?? {}
    } catch {
      if (load.isCurrent()) totalsRow.value = null
    }
  }
  let totalsFilterKey = ''
  let totalsPagingKey = ''
  watch([() => JSON.stringify(totalsPlanned.value), () => options.data.value], () => {
    const filterKey = JSON.stringify([totalsPlanned.value, options.listFilterParams.value])
    const pagingKey = JSON.stringify(options.fetchParams.value)
    const pagingOnly = filterKey === totalsFilterKey && pagingKey !== totalsPagingKey
    totalsFilterKey = filterKey
    totalsPagingKey = pagingKey
    if (!pagingOnly) void loadTotals()
  }, { immediate: true })

  /** A total as its foot shows it - in its column's format, a count as a plain number. */
  function totalText(entry: TotalEntry): string | null {
    const value = totalsRow.value?.[entry.alias]
    if (value === undefined) return null
    const field = options.orderedFields.value.find(f => f.columnName === entry.column)
    const text = entry.kind === 'count' || !field ? String(value ?? 0) : formatCellPlainText(field, value, {}, options.displayFormatDefaults.value)
    return t(`dataviews.totals.${entry.kind}`, { value: text })
  }

  return { totalsPlanned, totalText }
}
