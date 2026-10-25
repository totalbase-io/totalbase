import type { AdminApiError } from '~/utils/admin-api-error'
import { apiHeaders } from '~/utils/api-headers'
import { apiRequest, type ApiMethod, type ApiResult } from '~/utils/api-request'

export type DataApiResult<T> = ApiResult<T>

/**
 * Typed client for the public REST Data API - `/api/:schema/table/...`
 * and `/api/:schema/view/...` (Data_API.md §2.1,
 * confirmed against apps/server/src/routes/data-table.ts
 * / data-table-mutations.ts / data-view.ts - there is no `/api/v1/...`
 * prefix). Deliberately separate from useAdminApi() (`/admin/api/...`,
 * always admin-gated): a DataView's grid/Edit form reads and writes
 * through THIS path, gated by the viewer's actual resource permission,
 * never through the admin-management surface - same session
 * works for both (both resolve through the same
 * context.auth.sessions.validate), just a different route family with a
 * different authorization check.
 */
/** The Data API's default `api.max_limit` - getAll()'s page size. */
const PAGE_SIZE = 500

export function useDataApi() {
  const session = useSession()
  const { retrying } = useReauthentication()

  async function request<T>(
    method: ApiMethod,
    path: string,
    options: { body?: unknown, query?: Record<string, unknown>, idempotencyKey?: string, ifMatch?: string } = {}
  ): Promise<DataApiResult<T>> {
    try {
      // A sensitive action (an administrator's token) asks to confirm the identity first (Security.md §2.19).
      return await retrying(() => apiRequest<T>(`/api${path}`, method, {
        body: options.body,
        query: options.query,
        headers: {
          ...apiHeaders(),
          ...(options.idempotencyKey && { 'Idempotency-Key': options.idempotencyKey }),
          // The row's version the caller read - a write fails 409 if it changed since (Data_API.md §5.3).
          ...(options.ifMatch && { 'If-Match': `"${options.ifMatch}"` })
        }
      }))
    } catch (error) {
      const apiError = error as AdminApiError
      if (apiError.status === 401 && session.isAuthenticated.value) {
        session.clear()
        navigateTo('/login')
      }
      // A resource an administrator marked as requiring an Idempotency-Key
      // (Data_API.md §9.1) refuses a write without one before
      // running anything: this user action gets its own key and goes again.
      // Only those resources pay for the key's bookkeeping.
      if (method === 'POST' && !options.idempotencyKey && apiError.code === 'IDEMPOTENCY_KEY_REQUIRED') {
        return request<T>(method, path, { ...options, idempotencyKey: crypto.randomUUID() })
      }
      throw apiError
    }
  }

  /**
   * `/api/:schema/table/:name[/:pk]` or `/api/:schema/view/:name`, per
   * the resource's own type. `pk` addresses a single row for
   * PATCH/DELETE - only resources with a single-column primary key
   * support it (`data-table-mutations.ts`'s own `singlePrimaryKeyField`
   * limitation, not a new one).
   */
  function resourcePath(schema: string, name: string, kind: 'table' | 'view' = 'table', pk?: string): string {
    return pk !== undefined ? `/${schema}/${kind}/${name}/${pk}` : `/${schema}/${kind}/${name}`
  }

  /**
   * Every row matching `query`, a page at a time, until the total (`meta.count`) is reached or a page comes back
   * empty - for lists a screen holds whole (resources, a folder tree). The page asked for is 500; the server clamps
   * it to `api.max_limit`, so a shorter page is never taken as the last one.
   */
  async function getAll<T>(path: string, query: Record<string, unknown> = {}): Promise<T[]> {
    const rows: T[] = []
    let offset = 0
    for (;;) {
      const res = await request<T[]>('GET', path, { query: { ...query, limit: PAGE_SIZE, offset, count: true } })
      const page = res.data
      rows.push(...page)
      offset += page.length
      const total = (res as { meta?: { count?: number } }).meta?.count
      if (page.length === 0 || (total !== undefined && rows.length >= total)) return rows
    }
  }

  return {
    get: <T>(path: string, query?: Record<string, unknown>) => request<T>('GET', path, { query }),
    getAll,
    // `query` added for bulk create (`?bulk=true`, CSV import) - every
    // existing caller already only ever passed the first two args, so
    // this stays backward compatible.
    post: <T>(path: string, body?: unknown, query?: Record<string, unknown>) => request<T>('POST', path, { body, query }),
    // `query`: a collection update's `where` (every matching row).
    patch: <T>(path: string, body?: unknown, query?: Record<string, unknown>, options: { ifMatch?: string } = {}) => request<T>('PATCH', path, { body, query, ...options }),
    put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
    del: <T>(path: string, query?: Record<string, unknown>, body?: unknown, options: { ifMatch?: string } = {}) => request<T>('DELETE', path, { query, body, ...options }),
    resourcePath
  }
}
