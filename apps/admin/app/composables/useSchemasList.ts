import type { CatalogSchemaSummary } from '~/types/schema'

export const SCHEMAS_LIST_KEY = 'catalog-schemas'

/**
 * The database's schemas (`GET /catalog/schemas`), one request shared by the
 * database tree, the resources browser's filter, SQL Console and the table
 * drawers' schema pickers (useResourcesList's shared-data convention).
 */
export function useSchemasList() {
  const api = useAdminApi()
  const { data: schemas, pending, error, refresh } = useAsyncData(
    SCHEMAS_LIST_KEY,
    () => api.get<CatalogSchemaSummary[]>('/catalog/schemas').then(r => r.data),
    { default: (): CatalogSchemaSummary[] => [] }
  )
  /** The schema names, sorted - `public` alone until they load, so a picker never offers nothing. */
  const schemaNames = computed(() => {
    const names = schemas.value.map(s => s.schema).sort((a, b) => a.localeCompare(b))
    return names.length ? names : ['public']
  })
  return { schemas, schemaNames, pending, error, refresh }
}

/** Rereads the shared schema list after a schema was created or dropped - for a place that doesn't hold it. */
export function refreshSchemasList(): Promise<void> {
  return refreshNuxtData(SCHEMAS_LIST_KEY)
}
