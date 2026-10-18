import type { CatalogObjectSummary } from '~/types/schema'

export const CATALOG_TABLES_KEY = 'catalog-tables'

/**
 * Every table PostgreSQL has (`GET /catalog/tables`, the catalog - not the
 * registry), shared by the Foreign Key pickers of the table drawer, Add
 * Column and New Table (useResourcesList's shared-data convention).
 */
export function useCatalogTablesList() {
  const api = useAdminApi()
  const { data: tables, pending, error, refresh } = useAsyncData(
    CATALOG_TABLES_KEY,
    () => api.get<CatalogObjectSummary[]>('/catalog/tables').then(r => r.data),
    { default: (): CatalogObjectSummary[] => [] }
  )
  return { tables, pending, error, refresh }
}
