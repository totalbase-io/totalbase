import type { LocationQuery, LocationQueryRaw } from 'vue-router'
import { addDays } from 'date-fns'
import { fromZonedTime } from 'date-fns-tz'
import type { AuditStatus } from '~/types/audit'

/**
 * The Logs page's filters, shared by LogsPanel.vue (sets them) and
 * pages/logs.vue (reads them). All of them live in the route query, so a
 * filtered view - "failed sign-ins in the last 24 hours" - is a shareable
 * URL, same as UsersPanel.vue's `?status=` / `?role=`.
 *
 * Unlike Users, filters combine (AND): picking a status keeps the chosen
 * time range and principal. Clicking an active entry clears just that one.
 */

export type LogsRange = '15m' | '1h' | '24h' | '7d' | '30d' | 'all' | 'custom'

/**
 * Relative presets, in minutes. The default (no `?range=`) is 24 hours -
 * a bounded window keeps both the page and its count(*) on the
 * created_at index instead of scanning the whole log.
 */
export const LOGS_RANGE_PRESETS: Array<{ value: Exclude<LogsRange, 'custom'>, labelKey: string, minutes: number | null }> = [
  { value: '15m', labelKey: 'content.logs.ranges.last15m', minutes: 15 },
  { value: '1h', labelKey: 'content.logs.ranges.last1h', minutes: 60 },
  { value: '24h', labelKey: 'content.logs.ranges.last24h', minutes: 60 * 24 },
  { value: '7d', labelKey: 'content.logs.ranges.last7d', minutes: 60 * 24 * 7 },
  { value: '30d', labelKey: 'content.logs.ranges.last30d', minutes: 60 * 24 * 30 },
  { value: 'all', labelKey: 'content.logs.ranges.all', minutes: null }
]
export const LOGS_DEFAULT_RANGE: LogsRange = '24h'

export const LOGS_STATUSES: Array<{ value: AuditStatus, labelKey: string, dot: string }> = [
  { value: 'EXECUTED', labelKey: 'audit.statuses.EXECUTED', dot: 'bg-success' },
  { value: 'DENIED', labelKey: 'audit.statuses.DENIED', dot: 'bg-warning' },
  { value: 'FAILED', labelKey: 'audit.statuses.FAILED', dot: 'bg-error' }
]

export const LOGS_PRINCIPAL_TYPES: Array<{ value: string, labelKey: string, icon: string }> = [
  { value: 'ADMIN', labelKey: 'audit.principals.ADMIN', icon: 'i-lucide-shield-check' },
  { value: 'USER', labelKey: 'audit.principals.USER', icon: 'i-lucide-user' },
  { value: 'API_KEY', labelKey: 'audit.principals.API_KEY', icon: 'i-lucide-key-round' },
  { value: 'SYSTEM', labelKey: 'audit.principals.SYSTEM', icon: 'i-lucide-cpu' }
]

/** AuditAction (packages/audit/src/audit-service.ts), grouped the way an operator looks for them. */
export interface LogsActionCategory {
  key: string
  /** An i18n key - translated where it's shown. */
  labelKey: string
  icon: string
  actions: Array<{ value: string, labelKey: string, icon: string }>
}

export const LOGS_CATEGORIES: LogsActionCategory[] = [
  {
    key: 'data',
    labelKey: 'content.logs.categories.data',
    icon: 'i-lucide-table',
    actions: [
      { value: 'CREATE', labelKey: 'content.logs.actions.CREATE', icon: 'i-lucide-plus' },
      { value: 'UPDATE', labelKey: 'content.logs.actions.UPDATE', icon: 'i-lucide-pencil' },
      { value: 'DELETE', labelKey: 'content.logs.actions.DELETE', icon: 'i-lucide-trash-2' },
      { value: 'READ', labelKey: 'content.logs.actions.READ', icon: 'i-lucide-eye' },
      { value: 'EXECUTE', labelKey: 'content.logs.actions.EXECUTE', icon: 'i-lucide-square-function' }
    ]
  },
  { key: 'access', labelKey: 'content.logs.categories.access', icon: 'i-lucide-lock-keyhole', actions: [{ value: 'AUTH', labelKey: 'content.logs.actions.AUTH', icon: 'i-lucide-lock-keyhole' }] },
  {
    key: 'sql',
    labelKey: 'content.logs.categories.sql',
    icon: 'i-lucide-terminal',
    actions: [
      { value: 'SQL_EXECUTE', labelKey: 'content.logs.actions.SQL_EXECUTE', icon: 'i-lucide-play' },
      { value: 'SQL_HISTORY_PURGE', labelKey: 'content.logs.actions.SQL_HISTORY_PURGE', icon: 'i-lucide-eraser' }
    ]
  },
  {
    key: 'database',
    labelKey: 'content.logs.categories.database',
    icon: 'i-lucide-database',
    actions: [
      { value: 'DDL', labelKey: 'content.logs.actions.DDL', icon: 'i-lucide-table-properties' },
      { value: 'MAINTENANCE', labelKey: 'content.logs.actions.MAINTENANCE', icon: 'i-lucide-wrench' },
      { value: 'BACKUP', labelKey: 'content.logs.actions.BACKUP', icon: 'i-lucide-archive' }
    ]
  },
  {
    key: 'system',
    labelKey: 'content.logs.categories.system',
    icon: 'i-lucide-cpu',
    actions: [{ value: 'AUDIT_PURGE', labelKey: 'content.logs.actions.AUDIT_PURGE', icon: 'i-lucide-eraser' }]
  },
  {
    key: 'bulk',
    labelKey: 'content.logs.categories.bulk',
    icon: 'i-lucide-arrow-down-up',
    actions: [
      { value: 'IMPORT', labelKey: 'content.logs.actions.IMPORT', icon: 'i-lucide-upload' },
      { value: 'EXPORT', labelKey: 'content.logs.actions.EXPORT', icon: 'i-lucide-download' },
      { value: 'PRINT', labelKey: 'content.logs.actions.PRINT', icon: 'i-lucide-printer' }
    ]
  }
]

/**
 * One-click security views - plain combinations of the `event` (".*" =
 * prefix, see AuditLogFilter.event) and `status` filters, so each is just
 * a URL. Event names come from apps/server/src/access-audit.ts.
 */
export const LOGS_SECURITY_VIEWS: Array<{ key: string, labelKey: string, icon: string, event: string, status?: AuditStatus }> = [
  { key: 'failed-sign-ins', labelKey: 'content.logs.securityViews.failed-sign-ins', icon: 'i-lucide-log-in', event: 'auth.login,auth.portal_login,auth.oauth_login,auth.mfa_verify,auth.portal_mfa_verify', status: 'DENIED' },
  { key: 'access-changes', labelKey: 'content.logs.securityViews.access-changes', icon: 'i-lucide-shield', event: 'role.*,permission.*,user.roles_set,assignment.*,role_manager.*,dataview_role.*,dashboard_role.*' },
  { key: 'config-changes', labelKey: 'content.logs.securityViews.config-changes', icon: 'i-lucide-settings', event: 'settings.*,secret.*,auth_provider.*,system_email.*' },
  { key: 'credential-changes', labelKey: 'content.logs.securityViews.credential-changes', icon: 'i-lucide-key-round', event: 'token.*,session.*,user.sessions_revoke,user.password_reset' }
]

/** Every query key this page owns - anything else in the query is left alone. */
const FILTER_KEYS = ['range', 'from', 'to', 'status', 'principal_type', 'principal', 'action', 'event', 'request_id', 'workflow_run', 'resource', 'resource_label'] as const
type FilterKey = typeof FILTER_KEYS[number]

function str(query: LocationQuery, key: string): string | undefined {
  const value = query[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** `YYYY-MM-DD` -> local midnight, or undefined when malformed. */
function parseDay(value: string | undefined): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(y, m - 1, d)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export function formatDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function useLogsFilters() {
  const route = useRoute()
  // A custom range's days are days in the viewer's zone (My account >
  // Preferences, else the instance's, else the browser's) - the same days
  // the dashboard's activity chart links here with.
  const { timezone } = useDateTimeFormat()
  const { t } = useI18n()
  const ui = useUiLocale()

  const range = computed<LogsRange>(() => {
    const value = str(route.query, 'range')
    if (value === 'custom') return parseDay(str(route.query, 'from')) ? 'custom' : LOGS_DEFAULT_RANGE
    return LOGS_RANGE_PRESETS.some(p => p.value === value) ? value as LogsRange : LOGS_DEFAULT_RANGE
  })
  const from = computed(() => range.value === 'custom' ? parseDay(str(route.query, 'from')) : undefined)
  const to = computed(() => range.value === 'custom' ? parseDay(str(route.query, 'to')) ?? from.value : undefined)

  const status = computed(() => str(route.query, 'status'))
  const principalType = computed(() => str(route.query, 'principal_type'))
  const principalId = computed(() => str(route.query, 'principal'))
  const action = computed(() => str(route.query, 'action'))
  const event = computed(() => str(route.query, 'event'))
  const requestId = computed(() => str(route.query, 'request_id'))
  /** The entries one workflow run's steps wrote (the workflow Logs' "Audit entries"). */
  const workflowRun = computed(() => str(route.query, 'workflow_run'))
  /** The security view whose event/status the query matches exactly, if any. */
  const securityView = computed(() => LOGS_SECURITY_VIEWS.find(v => v.event === event.value && (v.status ?? undefined) === status.value))
  const resource = computed(() => str(route.query, 'resource'))
  /** Cosmetic label for a deep-linked resource chip - never sent to the API. */
  const resourceLabel = computed(() => str(route.query, 'resource_label'))

  const rangeLabel = computed(() => {
    if (range.value !== 'custom') return t(LOGS_RANGE_PRESETS.find(p => p.value === range.value)!.labelKey)
    const a = from.value!
    const b = to.value!
    // The year only when the range isn't within the current one - keeps the label short enough for the panel.
    const thisYear = new Date().getFullYear()
    const withYear = a.getFullYear() !== thisYear || b.getFullYear() !== thisYear
    const fmt = (d: Date) => d.toLocaleDateString(ui.intlLocale.value, { day: 'numeric', month: 'short', ...(withYear && { year: 'numeric' }) })
    return a.getTime() === b.getTime() ? fmt(a) : `${fmt(a)} – ${fmt(b)}`
  })

  /** Changes whenever the result set would - the page's fetch/reset trigger. */
  const key = computed(() => FILTER_KEYS.filter(k => k !== 'resource_label').map(k => `${k}=${str(route.query, k) ?? ''}`).join('&'))

  /**
   * The GET /audit/logs params. A function, not a computed: a relative
   * range ("last 15 minutes") has to be measured from the moment of each
   * fetch, so Refresh really brings in the newest entries.
   */
  function apiParams(): Record<string, string> {
    const params: Record<string, string> = {}
    if (range.value === 'custom') {
      const zone = timezone.value ?? Intl.DateTimeFormat().resolvedOptions().timeZone
      const startOf = (day: Date) => fromZonedTime(`${formatDay(day)}T00:00:00`, zone)
      params.since = startOf(from.value!).toISOString()
      params.until = new Date(startOf(addDays(to.value!, 1)).getTime() - 1).toISOString()
    } else {
      const minutes = LOGS_RANGE_PRESETS.find(p => p.value === range.value)!.minutes
      if (minutes !== null) params.since = new Date(Date.now() - minutes * 60_000).toISOString()
    }
    if (status.value) params.status = status.value
    if (principalType.value) params.principal_type = principalType.value
    if (principalId.value) params.principal = principalId.value
    if (action.value) params.action = action.value
    if (event.value) params.event = event.value
    if (requestId.value) params.request_id = requestId.value
    if (workflowRun.value) params.workflow_run = workflowRun.value
    if (resource.value) params.resource = resource.value
    return params
  }

  /** A `to` for NuxtLink: the current query with `patch` applied (undefined removes a key). */
  function linkWith(patch: Partial<Record<FilterKey, string | undefined>>) {
    const merged: LocationQueryRaw = { ...route.query, ...patch }
    // Clearing a resource clears its cosmetic label with it.
    if ('resource' in patch && patch.resource === undefined) merged.resource_label = undefined
    const query = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)) as LocationQueryRaw
    return { path: '/logs', query }
  }

  /** Clicking the active entry clears it; any other entry selects it. */
  function toggle(filterKey: FilterKey, value: string) {
    return linkWith({ [filterKey]: str(route.query, filterKey) === value ? undefined : value })
  }

  function rangeLink(value: Exclude<LogsRange, 'custom'>) {
    return linkWith({ range: value === LOGS_DEFAULT_RANGE ? undefined : value, from: undefined, to: undefined })
  }

  function customRangeLink(start: Date, end: Date) {
    return linkWith({ range: 'custom', from: formatDay(start), to: formatDay(end) })
  }

  /**
   * A category selects all its actions; clicking the active category
   * clears it. Access events only exist on AUTH entries, so any other
   * category drops an event filter (a security view, an event pivot)
   * rather than leaving a combination that can never match.
   */
  function categoryLink(category: LogsActionCategory) {
    const value = category.actions.map(a => a.value).join(',')
    if (action.value === value) return linkWith({ action: undefined })
    return linkWith(category.key === 'access' ? { action: value } : { action: value, event: undefined })
  }

  function categoryState(category: LogsActionCategory): 'all' | 'one' | 'none' {
    if (!action.value) return 'none'
    if (action.value === category.actions.map(a => a.value).join(',')) return 'all'
    return category.actions.some(a => a.value === action.value) ? 'one' : 'none'
  }

  function securityViewLink(view: typeof LOGS_SECURITY_VIEWS[number]) {
    if (securityView.value?.key === view.key) return linkWith({ event: undefined, status: undefined })
    // A view is a preset over access events - any category/action filter would contradict it.
    return linkWith({ event: view.event, status: view.status, action: undefined })
  }

  const hasFilters = computed(() => FILTER_KEYS.some(k => str(route.query, k) !== undefined))

  return {
    range, from, to, rangeLabel,
    status, principalType, principalId, action, event, requestId, workflowRun, resource, resourceLabel, securityView,
    key, hasFilters,
    apiParams, linkWith, toggle, rangeLink, customRangeLink, categoryLink, categoryState, securityViewLink
  }
}
