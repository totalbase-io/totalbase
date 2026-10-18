import { isExposureFixed } from '@totalbase/shared'
import type { Resource, ResourceType } from '~/types/resource'

/** A resources row as the Data API returns it. */
function resourceFromRow(row: Record<string, unknown>): Resource {
  return {
    id: row.id as string,
    postgresOid: row.postgres_oid as number,
    schema: row.schema as string,
    name: row.name as string,
    type: row.type as Resource['type'],
    status: row.status as Resource['status'],
    exposedMethods: (row.exposed_methods ?? []) as Resource['exposedMethods'],
    exposureFixed: isExposureFixed(row.schema as string),
    description: (row.description ?? null) as string | null,
    functionClass: (row.function_class ?? null) as Resource['functionClass'],
    auditRead: row.audit_read === true,
    requireIdempotencyKey: row.require_idempotency_key === true,
    rowPresentation: (row.row_presentation ?? {}) as Resource['rowPresentation'],
    defaultSort: (row.default_sort ?? []) as Resource['defaultSort'],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

/**
 * TotalBase's resource registry (resources) through the Data API
 * (Specification_Security.md §10) - an administrator reads every row;
 * anyone else, what their permissions allow. Changing a resource
 * (description, exposure, audit) still goes through the Admin API.
 */
export function useResourcesApi() {
  const dataApi = useDataApi()
  const path = dataApi.resourcePath('totalbase', 'resources')

  return {
    list: async (filter: { schema?: string, type?: ResourceType } = {}): Promise<Resource[]> =>
      (await dataApi.getAll<Record<string, unknown>>(path, {
        order_by: 'schema,name',
        ...(filter.schema && { 'where[schema][_eq]': filter.schema }),
        ...(filter.type && { 'where[type][_eq]': filter.type })
      })).map(resourceFromRow),
    get: async (id: string): Promise<Resource> => {
      const row = (await dataApi.get<Array<Record<string, unknown>>>(path, { 'where[id][_eq]': id, 'limit': 1 })).data[0]
      if (!row) throw new AdminApiError(404, [{ source: 'TOTALBASE', code: 'RESOURCE_NOT_FOUND', message: 'Resource not found.' }])
      return resourceFromRow(row)
    },
    /** The resource of a PostgreSQL OID - what the old `/database/<kind>/<oid>` links carry. */
    getByOid: async (oid: string): Promise<Resource> => {
      const row = /^\d+$/.test(oid)
        ? (await dataApi.get<Array<Record<string, unknown>>>(path, { 'where[postgres_oid][_eq]': oid, 'limit': 1 })).data[0]
        : undefined
      if (!row) throw new AdminApiError(404, [{ source: 'TOTALBASE', code: 'RESOURCE_NOT_FOUND', message: 'Resource not found.' }])
      return resourceFromRow(row)
    }
  }
}
