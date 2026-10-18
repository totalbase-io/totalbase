import type { ComputedRef, Ref } from 'vue'

/** One Data API page of an "all matching rows" read. */
const EXPORT_ALL_BATCH_SIZE = 500

/**
 * What Export, Print and Import share with the grid (DataViewGrid.vue): the
 * "all matching rows" read Export/Print scope to, and the one summary audit
 * row each of the three reports.
 */
export function useGridExport(options: {
  /** The source's own Data API path (a view is `/view/`). */
  path: () => string
  whereParams: ComputedRef<Record<string, unknown>>
  forcedWhereParams: ComputedRef<Record<string, unknown>>
  fieldsParam: ComputedRef<string>
  sort: Ref<string>
  debouncedSearch: Ref<string>
  /** The Filter box's JSON - recorded with EXPORT/PRINT, never with IMPORT. */
  whereText: Ref<string>
  /** The DataView's `sourceResource` (the catalog id, matched against `audit_logs.resource`) - no audit without it. */
  sourceResourceId: () => string | null | undefined
}) {
  const dataApi = useDataApi()
  const appApi = useAppApi()

  /**
   * Fetches every row the CURRENT search/sort/filter matches, not just the
   * visible page, batching through the Data API's own limit/offset (the same
   * params the grid's own fetch builds) rather than one giant request. `cap`
   * is `dataviews.export_max_rows`/`print_max_rows` (Settings > DataViews,
   * useDisplayFormatDefaults.ts) depending on the caller, so a huge,
   * unfiltered table can't hang the browser either way - the caller is told
   * when its own cap was hit.
   */
  async function fetchAllMatchingRows(cap: number): Promise<{ rows: Record<string, unknown>[], truncated: boolean }> {
    const collected: Record<string, unknown>[] = []
    let offset = 0
    let truncated = false
    for (;;) {
      const batchSize = Math.min(EXPORT_ALL_BATCH_SIZE, cap - collected.length)
      const res = await dataApi.get<Record<string, unknown>[]>(
        options.path(),
        {
          ...options.whereParams.value,
          ...options.forcedWhereParams.value,
          fields: options.fieldsParam.value,
          ...(options.sort.value ? { order_by: options.sort.value } : {}),
          ...(options.debouncedSearch.value ? { search: options.debouncedSearch.value } : {}),
          limit: batchSize,
          offset,
          count: true
        } as unknown as Record<string, unknown>
      )
      const batchRows = res.data ?? []
      collected.push(...batchRows)
      const total = (res as unknown as { meta?: { count?: number } }).meta?.count
      offset += batchRows.length
      // The server clamps `limit` to api.max_limit: a page shorter than asked isn't the last one - the total is.
      if (batchRows.length === 0 || (total !== undefined && collected.length >= total)) break
      if (collected.length >= cap) {
        truncated = total !== undefined && total > collected.length
        break
      }
    }
    return { rows: collected, truncated }
  }

  /**
   * One summary audit_logs row per Import/Export/Print click - the action
   * itself, never the rows it touched (no `payload`, unlike CREATE/UPDATE/
   * DELETE's own `auditAndEnqueue`): the action is recorded, not the records
   * it affected. The active filter/search (if any) DOES get recorded, in
   * `where_clause` - that's metadata about the operation, not the data it
   * returned. Best-effort: a logging failure never blocks the export/print/
   * import itself from completing.
   */
  async function logBulkAuditEvent(action: 'IMPORT' | 'EXPORT' | 'PRINT', rowCount: number, format?: string) {
    const resource = options.sourceResourceId()
    if (!resource) return
    try {
      await appApi.post('/audit/events', {
        data: {
          resource,
          action,
          rowCount,
          format,
          // IMPORT creates rows from an uploaded file - it isn't scoped by
          // the grid's own filter/search at all, unlike EXPORT/PRINT (which
          // export/print whatever the filter+search currently narrows the
          // grid down to) - recording them for IMPORT would misleadingly
          // imply the import itself was filtered.
          search: action === 'IMPORT' ? undefined : (options.debouncedSearch.value || undefined),
          where: action === 'IMPORT' || !options.whereText.value.trim() ? undefined : JSON.parse(options.whereText.value)
        }
      })
    } catch {
      // Best-effort - see doc comment above.
    }
  }

  return { fetchAllMatchingRows, logBulkAuditEvent }
}
