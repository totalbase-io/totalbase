import type { Resource } from '~/types/resource'

/**
 * The shared-data convention of the admin: one `useAsyncData` key per
 * endpoint, reached through a small composable (this one, `useSchemasList`,
 * `useCatalogTablesList`, `useRelationDetail`). Nuxt dedupes same-key calls
 * - every consumer on the screen shares one request and one reactive copy -
 * and the composable's `refresh()` (or `refreshNuxtData(KEY)` from a place
 * that doesn't hold it) updates every consumer at once. Never fetch one of
 * these endpoints under a key of your own.
 */
export const RESOURCES_LIST_KEY = 'resources-list'

/**
 * Every resource of the registry (useResourcesApi), shared by the database
 * tree, the pickers (a workflow's step, a DataView's source, a binding's
 * relation), the role and user permission editors and SQL Console - each
 * filters the one list for what it offers. A Design form can mount MANY
 * BindingButton instances at once, each resolving a Foreign Key's target
 * resource - with its own request each, that would be one per instance.
 */
export function useResourcesList() {
  const resourcesApi = useResourcesApi()
  const { data: resources, pending, error, refresh } = useAsyncData(
    RESOURCES_LIST_KEY,
    () => resourcesApi.list(),
    { default: (): Resource[] => [] }
  )
  return { resources, pending, error, refresh }
}

/** Rereads the shared registry after something changed it (a catalog sync, a table created or dropped, an exposure change) - for a place that doesn't hold the list itself. */
export function refreshResourcesList(): Promise<void> {
  return refreshNuxtData(RESOURCES_LIST_KEY)
}
