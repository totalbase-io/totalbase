import type { AuditLog } from '~/types/audit'
import { flattenQueryObject } from '~/utils/flatten-query-object'

/**
 * Filters on the audit log, in GET /audit/logs's own parameter names
 * (useLogsFilters().apiParams() builds them): `since`/`until` (ISO),
 * `status`, `principal_type`, `principal`, `action` and `event` (comma
 * lists; an event ending in ".*" is a prefix), `request_id`,
 * `workflow_run`, `resource`. An undefined value is no filter.
 */
export type AuditLogQuery = Partial<Record<'since' | 'until' | 'status' | 'principal_type' | 'principal' | 'action' | 'event' | 'request_id' | 'workflow_run' | 'resource', string>>

/**
 * One page of the audit log, newest first - the one loader behind
 * AuditLogGrid. An administrator reads GET /audit/logs (every column, the
 * SQL included, and a capped count over the whole log); anyone else reads
 * logs through the Data API (Specification_Security.md §9.3):
 * only the rows and columns their grants allow - a user with the default
 * grant (§10.5), their own entries. The query is the same either way;
 * only the source changes.
 */
export function useAuditLogs(query: () => AuditLogQuery, page: Ref<number>, pageSize: Ref<number>) {
  const api = useAdminApi()
  const dataApi = useDataApi()
  const session = useSession()

  const rows = ref<AuditLog[]>([])
  const total = ref(0)
  const totalCapped = ref(false)
  const pending = ref(false)
  const error = ref<unknown>(null)
  // A viewer whose grant has no `resource.name` path: stop asking (best-effort names).
  let namesDenied = false

  async function load() {
    pending.value = true
    error.value = null
    try {
      const offset = (page.value - 1) * pageSize.value
      if (session.access.value === 'ADMIN') {
        const res = await api.get<AuditLog[]>('/audit/logs', { ...definedOnly(query()), limit: String(pageSize.value), offset: String(offset) })
        rows.value = res.data
        total.value = (res.meta?.total as number | undefined) ?? res.data.length
        totalCapped.value = res.meta?.totalCapped === true
        return
      }
      const res = await dataApi.get<Record<string, unknown>[]>(dataApi.resourcePath('totalbase', 'logs'), {
        ...flattenQueryObject(dataApiWhere(query()), 'where'),
        order_by: '-created_at',
        limit: pageSize.value,
        offset,
        count: 'true'
      })
      const list = res.data.map(toAuditLog)
      await addResourceNames(list)
      rows.value = list
      total.value = (res.meta as { count?: number } | undefined)?.count ?? list.length
      totalCapped.value = false
    } catch (err) {
      error.value = err
    } finally {
      pending.value = false
    }
  }

  /** The table names of a page's entries, through the relation path - one request; none when the grant hasn't the path. */
  async function addResourceNames(list: AuditLog[]) {
    const ids = list.filter(log => log.resource).map(log => log.id)
    if (!ids.length || namesDenied) return
    try {
      const { data } = await dataApi.get<Record<string, unknown>[]>(dataApi.resourcePath('totalbase', 'logs'), {
        'fields': 'id,resource.schema,resource.name',
        'where[id][_in]': ids.join(','),
        'limit': ids.length
      })
      const names = new Map(data.map(row => [row.id as string, row['resource.name'] ? `${row['resource.schema']}.${row['resource.name']}` : null]))
      for (const log of list) log.resourceName = names.get(log.id) ?? null
    } catch {
      namesDenied = true
    }
  }

  return { rows, total, totalCapped, pending, error, load }
}

function definedOnly(query: AuditLogQuery): Record<string, string> {
  return Object.fromEntries(Object.entries(query).filter((entry): entry is [string, string] => !!entry[1]))
}

/** The same filters as the Data API's `where` - one column each; a comma list is `_in`, an event prefix a LIKE. */
function dataApiWhere(query: AuditLogQuery): Record<string, unknown> {
  const where: Record<string, unknown> = {}
  const createdAt: Record<string, string> = {}
  if (query.since) createdAt._gte = query.since
  if (query.until) createdAt._lte = query.until
  if (Object.keys(createdAt).length) where.created_at = createdAt
  for (const column of ['status', 'principal_type', 'principal', 'action', 'request_id', 'workflow_run', 'resource'] as const) {
    const value = query[column]
    if (value) where[column] = value.includes(',') ? { _in: value } : { _eq: value }
  }
  if (query.event) {
    const events = query.event.split(',').filter(Boolean)
    const exact = events.filter(e => !e.endsWith('.*'))
    // `_` and `%` are LIKE wildcards - an event prefix matches literally.
    const prefixes = events.filter(e => e.endsWith('.*')).map(e => `${e.slice(0, -1).replace(/[\\%_]/g, c => `\\${c}`)}%`)
    const parts: Record<string, unknown>[] = [
      ...(exact.length ? [{ event: { _in: exact.join(',') } }] : []),
      ...prefixes.map(prefix => ({ event: { _like: prefix } }))
    ]
    if (parts.length === 1) Object.assign(where, parts[0])
    else if (parts.length > 1) where._or = parts
  }
  return where
}

/** A logs row (snake_case columns) as an AuditLog - a column the viewer may not read is simply absent. */
function toAuditLog(row: Record<string, unknown>): AuditLog {
  const camel = Object.fromEntries(Object.entries(row).map(([key, value]) => [key === 'principal' ? 'principalId' : key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()), value]))
  return { sqlText: null, sqlParams: null, ...camel } as AuditLog
}
