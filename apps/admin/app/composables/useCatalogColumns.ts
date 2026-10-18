import type { Resource } from '~/types/resource'
import type { CatalogColumn } from '~/types/permission'

/**
 * A table's or view's catalog columns, fetched on demand and cached per
 * caller by postgres oid - flipping between a resource's cells (or its
 * "Allow all") doesn't refetch the same columns. Imperative on purpose:
 * called from event handlers, where useAsyncData isn't safe.
 */
export function useCatalogColumns() {
  const api = useAdminApi()
  const cache = new Map<number, Promise<CatalogColumn[]>>()

  function loadColumns(resource: Resource): Promise<CatalogColumn[]> {
    let promise = cache.get(resource.postgresOid)
    if (!promise) {
      const path = resource.type === 'TABLE' ? `/catalog/table/${resource.id}` : `/catalog/view/${resource.id}`
      promise = api.get<{ columns: CatalogColumn[] }>(path).then(r => r.data.columns)
      promise.catch(() => cache.delete(resource.postgresOid))
      cache.set(resource.postgresOid, promise)
    }
    return promise
  }

  return { loadColumns }
}
