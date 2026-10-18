/**
 * How an audit log entry reads - the cells of AuditLogGrid and the labels
 * of AuditLogEntrySlideover, so every place that shows the audit log (the
 * Logs page, a user's Activity tab, Insights, My account) shows an entry
 * the same way. Everything comes from the entry itself plus lists already
 * loaded (users directory, roles, resources) - no request per row. Its
 * texts are the eager `audit` area (shell.json): My account reads them too.
 */
import type { AuditLog, AuditStatus } from '~/types/audit'
import { regionalLocale } from '~/utils/regional-locale'
import { clockOptions } from '~/utils/datetime-local'

const STATUS_COLOR: Record<AuditStatus, 'success' | 'warning' | 'error'> = {
  EXECUTED: 'success',
  DENIED: 'warning',
  FAILED: 'error'
}

const SOURCE_LABEL: Record<string, string> = { api: 'API', admin: 'Admin', auth: 'Auth', workflow: 'Workflow' }

/** The locale an entry's time is formatted in - the browser's regional settings (utils/regional-locale.ts). */
function uiBcp47(): string | undefined {
  return regionalLocale()
}

type Json = Record<string, unknown>
function obj(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
function shortId(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value)
  const id = text(value)
  return id && id.length > 12 ? id.slice(0, 8) : id
}

/** Access events all share action AUTH - the event name says what actually happened. */
export function auditEventName(log: AuditLog): string | null {
  if (log.event) return log.event
  const event = (log.metadata as { event?: unknown } | null)?.event
  return typeof event === 'string' ? event : null
}

/** "auth.portal_login" -> "authPortalLogin", the key of its label. */
const camel = (name: string) => name.replace(/[._](\w)/g, (_, c: string) => c.toUpperCase())

export function auditStatusColor(status: string) {
  return STATUS_COLOR[status as AuditStatus] ?? 'neutral'
}

/**
 * Absolute, to the second: an audit log is read to correlate events. The
 * year only when it isn't this one. Compact on purpose, so it keeps this
 * shape rather than the user's date format - but in their zone
 * (`timeZone`, useDateTimeFormat().timezone; undefined = the browser's):
 * "today" is today there.
 */
export function formatAuditTime(iso: string, timeZone?: string): string {
  const date = new Date(iso)
  const now = new Date()
  const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone })
  const yearOf = (d: Date) => d.toLocaleDateString('en-CA', { timeZone, year: 'numeric' })
  const locale = uiBcp47()
  const time = date.toLocaleTimeString(locale, { ...clockOptions(), hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone })
  if (dayKey(date) === dayKey(now)) return time
  const day = date.toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone, ...(yearOf(date) !== yearOf(now) && { year: 'numeric' }) })
  return `${day} ${time}`
}

function targetUserId(log: AuditLog): string | undefined {
  const meta = obj(log.metadata)
  return text(obj(meta.params).id) ?? text(meta.user_id)
}

export function useAuditLogDisplay() {
  const { t, te } = useI18n()
  const session = useSession()
  const directory = useUserDirectory()
  const tokens = useTokenDirectory()
  // The registry is an administrator's read; anyone else gets an entry's
  // table name with the entry itself (AuditLog.resourceName).
  const { resources } = session.access.value === 'ADMIN' ? useResourcesList() : { resources: ref([]) }
  const { data: roles } = useRoles()

  const resourceById = computed(() => new Map(resources.value.map(r => [r.id, r])))
  const roleById = computed(() => new Map((roles.value ?? []).map(r => [r.id, r.name])))
  const actionIcon = new Map(LOGS_CATEGORIES.flatMap(c => c.actions.map(a => [a.value, a.icon] as const)))

  function resourceName(id: string | null | undefined): string | null {
    if (!id) return null
    const resource = resourceById.value.get(id)
    return resource ? `${resource.schema}.${resource.name}` : null
  }

  /** The entry's table, `schema.name` - from the registry, or from the entry itself. */
  function resourceLabel(log: Pick<AuditLog, 'resource' | 'resourceName'>): string | null {
    return log.resourceName ?? resourceName(log.resource)
  }

  /**
   * What the entry did, in words: an access event's own label ("Signed in
   * to the portal"), "Created a role" for a write on an access table
   * ("role.create"), the event name in words for one with no label yet;
   * any other entry, its action ("Updated", "Ran SQL").
   */
  function actionLabel(log: AuditLog): string {
    const event = auditEventName(log)
    if (event) {
      if (te(`audit.events.${camel(event)}`)) return t(`audit.events.${camel(event)}`)
      const [entity = '', op = ''] = event.split('.')
      if (te(`audit.entities.${camel(entity)}`) && te(`audit.entityOps.${op}`)) return t(`audit.entityOps.${op}`, { entity: t(`audit.entities.${camel(entity)}`) })
      const words = (text: string) => text.replace(/_/g, ' ')
      return op ? `${words(entity).replace(/^./, c => c.toUpperCase())}: ${words(op)}` : words(event)
    }
    return te(`audit.did.${log.action}`) ? t(`audit.did.${log.action}`) : log.action
  }

  function principalLabel(log: Pick<AuditLog, 'principalType' | 'principalId'>): string {
    if (log.principalType === 'SYSTEM') return t('audit.principals.SYSTEM')
    if (!log.principalId) return log.principalType === 'USER' ? t('audit.anonymous') : '—'
    if (log.principalType === 'API_KEY') return tokens.label(log.principalId)
    return directory.label(log.principalId)
  }

  /**
   * Who's second line: where the request came from - the admin token it
   * was made through, when there was one (`metadata.token`) - and its IP
   * when there is one (never for workflows).
   */
  function origin(log: AuditLog): string {
    const token = text(obj(log.metadata).token)
    const via = token ? t('audit.viaToken', { name: tokens.name(token) }) : (SOURCE_LABEL[log.source] ?? log.source)
    return log.ip ? t('audit.viaIp', { via, ip: log.ip }) : t('audit.via', { via })
  }

  /** Resolves every user and token a page of entries names (principals, access events' target users) - one batched request each. */
  function ensureUsers(list: AuditLog[], extra: Array<string | null | undefined> = []) {
    const ids: Array<string | null | undefined> = list.filter(l => l.principalType === 'ADMIN' || l.principalType === 'USER').map(l => l.principalId)
    for (const log of list) if (auditEventName(log)?.startsWith('user.')) ids.push(targetUserId(log))
    void directory.ensure([...ids, ...extra].filter((id): id is string => !!id))
    void tokens.ensure([
      ...list.filter(l => l.principalType === 'API_KEY').map(l => l.principalId),
      ...list.map(l => text(obj(l.metadata).token)),
      ...list.filter(l => auditEventName(l)?.startsWith('token.')).map(l => text(obj(obj(l.metadata).params).id))
    ])
  }

  /**
   * What the entry acted on - the Target column. Data writes: the table
   * and the row's key; access events: the user / role / permission /
   * setting from the route params the access audit records; sign-ins: the
   * email tried (the principal is "Anonymous" on a failed one); SQL: its
   * first line; bulk actions: table, rows and format.
   */
  function target(log: AuditLog): { text: string, mono: boolean } | null {
    const meta = obj(log.metadata)
    const params = obj(meta.params)
    const payload = obj(log.payload)
    const table = resourceLabel(log) ?? shortId(log.resource)
    const event = auditEventName(log)

    if (event) {
      const [kind] = event.split('.')
      const roleName = (id: unknown) => roleById.value.get(text(id) ?? '') ?? shortId(id)
      switch (kind) {
        case 'permission': {
          const resource = resourceName(text(params.resource)) ?? shortId(params.resource)
          return { text: `${roleName(params.role) ?? '?'} → ${resource ?? '?'} · ${text(params.action) ?? ''}`, mono: false }
        }
        case 'user': {
          const id = targetUserId(log)
          return id ? { text: directory.label(id), mono: false } : null
        }
        case 'role': {
          const name = roleName(params.id) ?? text(payload.name)
          return name ? { text: name, mono: false } : null
        }
        case 'auth': {
          const email = text(meta.email) ?? text(payload.email)
          return email ? { text: email, mono: false } : null
        }
        case 'token': {
          const id = text(params.id)
          const name = text(payload.name) ?? (id && tokens.name(id))
          return name ? { text: name, mono: false } : null
        }
        case 'settings': return text(params.group) ? { text: text(params.group)!, mono: true } : null
        case 'system_email': return text(params.slot) ? { text: text(params.slot)!, mono: true } : null
        case 'secret': return text(params.key) ? { text: text(params.key)!, mono: true } : null
        default: {
          const id = shortId(params.id) ?? text(payload.name)
          return id ? { text: id, mono: true } : null
        }
      }
    }

    if (log.action === 'SQL_EXECUTE' && log.sqlText) {
      const firstLine = log.sqlText.split('\n').map(l => l.trim()).find(Boolean)
      return firstLine ? { text: firstLine, mono: true } : null
    }

    // Schema changes: the object (its resource may be gone - a drop) and the operation.
    if (log.action === 'DDL') {
      const object = table ?? [text(meta.schema), text(meta.table) ?? text(meta.name)].filter(Boolean).join('.')
      const operation = text(meta.operation)?.replaceAll('_', ' ')
      return { text: [object, operation].filter(Boolean).join(' · '), mono: false }
    }

    if (log.action === 'AUDIT_PURGE') {
      return typeof meta.deletedCount === 'number' ? { text: t('audit.purgeTarget', { count: meta.deletedCount, days: meta.retentionDays }, meta.deletedCount), mono: false } : null
    }

    if (['IMPORT', 'EXPORT', 'PRINT'].includes(log.action)) {
      const rows = typeof meta.rowCount === 'number' ? t('audit.rowCount', meta.rowCount) : undefined
      return { text: [table, rows, text(meta.format)].filter(Boolean).join(' · '), mono: false }
    }

    // Data writes: the row's key, when its payload has an `id` - the
    // primary key itself would need the table's catalog, one more request.
    const key = shortId(payload.id)
    if (table || key) return { text: [table, key].filter(Boolean).join(' · '), mono: true }
    return null
  }

  return { resourceById, resourceName, resourceLabel, actionLabel, principalLabel, origin, ensureUsers, target, actionIcon }
}
