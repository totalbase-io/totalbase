import { APPLICABLE_METHODS, type DataApiMethod, type Resource } from '~/types/resource'

export interface EndpointRow {
  method: DataApiMethod
  path: string
  /** Whether `method` is in the resource's `exposedMethods` - a disabled one answers 404 until an admin turns it on. */
  enabled: boolean
}

/**
 * Derived client-side from the real, implemented Data API routes
 * (apps/server's data-table*.ts / data-view.ts / data-function.ts,
 * Admin_UI.md §12), for the Resources grid's per-resource
 * "View Info" panel. Docs > Endpoints lists the same routes from the server
 * (GET /admin/api/endpoints, @totalbase/openapi's listApiEndpoints) - keep
 * the two in step.
 *
 * Lists every route the resource's type supports (APPLICABLE_METHODS),
 * flagged `enabled` by `exposedMethods`. A table's `{pk}` routes need a
 * single-column primary key; the client doesn't know the key shape, so
 * they're listed regardless (a composite key answers 400 there).
 */
export function allEndpointsForResource(resource: Resource): EndpointRow[] {
  const base = `/api/${resource.schema}/${resource.type.toLowerCase()}/${resource.name}`
  const byPk = `${base}/{pk}`
  const paths: Record<DataApiMethod, string[]> = resource.type === 'TABLE'
    ? { GET: [base, byPk], POST: [base], PATCH: [base, byPk], DELETE: [base, byPk] }
    : { GET: [base], POST: [base], PATCH: [], DELETE: [] }
  return APPLICABLE_METHODS[resource.type].flatMap(method =>
    paths[method].map(path => ({ method, path, enabled: resource.exposedMethods.includes(method) }))
  )
}

/** Only the routes that currently answer - the methods in `exposedMethods`. */
export function endpointsForResource(resource: Resource): EndpointRow[] {
  return allEndpointsForResource(resource).filter(endpoint => endpoint.enabled)
}
