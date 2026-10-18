import { useApiErrorMessage } from '~/utils/api-error-message'
import type { AuditLog } from '~/types/audit'

/**
 * Audit history behind RecordHistoryPanel.vue - either ONE row's own
 * (the record form's "Activity", `pkValue` given) or a WHOLE
 * resource's (DataViewGrid's own toolbar "History", `pkValue` omitted -
 * every row, including ones already deleted, since there's nowhere left
 * to open a per-row panel for those, paginated 15 at a time). `resourceId`
 * is the DataView's own `sourceResource` (the `totalbase.resources`
 * catalog UUID `GET /audit/logs`'s own `resource` filter already expects -
 * NOT the schema/table name); with `pkValue` given, it's also joined
 * server-side against `payload ->> pk_column = pk_value` (packages/
 * audit's own AuditLogFilter doc comment) - `payload` always carries the
 * row's resulting primary key regardless of action (mutation-service.ts's
 * own `payload: newRow ?? oldRow ?? {}`), so this finds the row's CREATE
 * too, even with a server-generated id.
 *
 * Lazy: `load()` only fetches when actually called (RecordHistoryPanel.vue's
 * own `watch(open, ...)`), not on every record form/grid mount - most
 * sessions never open it.
 */
export function useRecordAudit() {
  const api = useAdminApi()
  const directory = useUserDirectory()
  const { t } = useI18n()
  const errorMessage = useApiErrorMessage()
  const logs = ref<AuditLog[]>([])
  const total = ref(0)
  const pending = ref(false)
  const error = ref<string | null>(null)
  // principalId -> a display name, resolved best-effort below - only
  // USER/ADMIN ids point at `totalbase.users` at all (API_KEY's own id
  // is a DIFFERENT table, `users_apis`; SYSTEM has none) - the timeline
  // just shows the raw principalType/id for those instead, same as the
  // Settings > Audit Logs page's own table already does for everyone.
  const principalNames = ref<Record<string, string>>({})

  // One batched lookup through the shared user directory instead of a
  // GET per principal.
  async function resolvePrincipalNames(entries: AuditLog[]) {
    const ids = [...new Set(
      entries
        .filter(e => (e.principalType === 'USER' || e.principalType === 'ADMIN') && e.principalId)
        .map(e => e.principalId!)
    )]
    await directory.ensure(ids)
    const next = { ...principalNames.value }
    for (const id of ids) {
      if (directory.entries.value[id]) next[id] = directory.label(id)
    }
    principalNames.value = next
  }

  async function load(resourceId: string | null | undefined, primaryKey: string | undefined, pkValue: string | undefined, options?: { limit?: number, offset?: number }) {
    if (!resourceId || !primaryKey) {
      logs.value = []
      total.value = 0
      return
    }
    pending.value = true
    error.value = null
    try {
      const query: Record<string, unknown> = {
        resource: resourceId,
        limit: options?.limit ?? (pkValue ? 50 : 15),
        offset: options?.offset ?? 0
      }
      if (pkValue) {
        query.pk_column = primaryKey
        query.pk_value = pkValue
      }
      const res = await api.get<AuditLog[]>('/audit/logs', query)
      logs.value = res.data
      total.value = (res.meta as { total?: number } | undefined)?.total ?? res.data.length
      await resolvePrincipalNames(res.data)
    } catch (err) {
      error.value = errorMessage(err, t('dataviews.history.loadError'))
      logs.value = []
      total.value = 0
    } finally {
      pending.value = false
    }
  }

  /**
   * ONE record's nearest earlier entry - queried directly from the
   * server rather than relying on whatever page happens to be loaded, so
   * the diff stays exact regardless of pagination. `limit: 5` is a small
   * buffer to skip past a FAILED entry or one with no full-row payload
   * that might otherwise sit closest chronologically - the first
   * EXECUTED one with an actual row wins.
   */
  async function findPreviousPayload(resourceId: string, primaryKey: string, recordId: string, beforeIso: string): Promise<Record<string, unknown> | undefined> {
    try {
      const res = await api.get<AuditLog[]>('/audit/logs', {
        resource: resourceId,
        pk_column: primaryKey,
        pk_value: recordId,
        before: beforeIso,
        limit: 5
      })
      const match = res.data.find(l => l.status === 'EXECUTED' && l.payload && typeof l.payload === 'object' && !Array.isArray(l.payload))
      return match?.payload as Record<string, unknown> | undefined
    } catch {
      return undefined
    }
  }

  return { logs, total, pending, error, principalNames, load, findPreviousPayload }
}
