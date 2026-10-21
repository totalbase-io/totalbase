/**
 * Reactive grid state (search/sort/pagination) -> query params ready for
 * the REST Data API (`GET /api/:schema/table/:resource`). Ported from
 * operadores-portal-v3's `useGridState` composable, studied before
 * building this: same shape (page/pageSize/search/sort -> a computed
 * params object, toggleSort/sortDirection helpers), adapted to
 * TotalBase's actual query grammar instead of that project's
 * Directus-flavored one - confirmed against
 * packages/query-engine/src/parser.ts (Data_API.md §3):
 *   - `order_by` uses the same `field` / `-field` (DESC) convention the
 *     other project's `sort` string already used - no translation needed.
 *   - pagination is `limit`/`offset`, not `page`/`page_size` - this
 *     composable still exposes `page` for the UI (UPagination wants a
 *     1-based page number) and converts to `offset` only in `params`.
 *   - `count=true` is required to get a total back at all; always set.
 */
export interface GridStateOptions {
  pageSize?: number
  /** Initial order, e.g. 'name' or '-created_at'. */
  sort?: string
}

export interface DataApiListParams {
  limit: number
  offset: number
  count: true
  order_by?: string
  search?: string
}

export function useGridState(options: GridStateOptions = {}) {
  const page = ref(1)
  const pageSize = ref(options.pageSize ?? 25)
  const search = ref('')
  const sort = ref(options.sort ?? '')
  // What the search box holds is `search`; what reaches the Data API is its
  // debounced, trimmed value - one request per pause in typing, not one per
  // keystroke (useDebouncedRef). The page resets on the request's own value.
  const debouncedSearch = useDebouncedRef(() => search.value.trim())

  watch([debouncedSearch, sort, pageSize], () => {
    page.value = 1
  })

  /** Toggles a column's order: asc -> desc -> none. */
  function toggleSort(field: string) {
    if (sort.value === field) {
      sort.value = `-${field}`
    } else if (sort.value === `-${field}`) {
      sort.value = ''
    } else {
      sort.value = field
    }
  }

  function sortDirection(field: string): 'asc' | 'desc' | false {
    if (sort.value === field) return 'asc'
    if (sort.value === `-${field}`) return 'desc'
    return false
  }

  const params = computed<DataApiListParams>(() => ({
    limit: pageSize.value,
    offset: (page.value - 1) * pageSize.value,
    count: true,
    ...(sort.value ? { order_by: sort.value } : {}),
    ...(debouncedSearch.value ? { search: debouncedSearch.value } : {})
  }))

  return { page, pageSize, search, debouncedSearch, sort, params, toggleSort, sortDirection }
}
