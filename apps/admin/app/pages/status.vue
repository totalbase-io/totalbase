<script setup lang="ts">
/**
 * Status, the administrator's home - GET /admin/api/dashboard. The header
 * carries what interrupts: a bell with what needs attention (its count, in
 * the color of the worst item; each one linking to where it's handled), the
 * latest configuration changes (a slideover) and the refresh, by hand or by
 * itself while the tab is seen. The page, top to bottom: the headline counts;
 * the last 7, 14 or 30 days in the viewer's zone as three charts - activity
 * per category (bars; a day opens in Logs), what went wrong or how the
 * workflows ran (lines), what takes a schema's space (a donut of its tables);
 * the system it runs on beside what the instance has turned on. Sober on purpose (AGENTS.md section 25):
 * each block answers a question nothing else on the page does.
 */
import { formatDistanceToNow } from 'date-fns'
import { getTimezoneOffset } from 'date-fns-tz'

interface DashboardData {
  instance: {
    version: string
    environment: string
    publicUrl: string
    uptimeSeconds: number
    lockdown: { active: boolean, readOnly: boolean, endsAt: string | null, startsAt: string | null }
  }
  kpis: {
    people: number
    usableTokens: number
    resources: { exposed: number, total: number }
    actions24h: { total: number, previous: number, denied: number, failed: number }
    sessionsActive: number
    workflowRuns24h: { succeeded: number, failed: number }
  }
  services: Array<{ key: ServiceKey, state: 'ON' | 'OFF' | 'NOT_CONFIGURED' }>
  attention: Array<{ key: AttentionKey, severity: 'error' | 'warning' | 'info', count: number, detail?: string[] }>
  activity: {
    timeZone: string
    data: Array<{ day: string } & Record<DataSeries, number>>
    admin: Array<{ day: string } & Record<AdminSeries, number>>
    problems: { data: number, admin: number }
  }
  trends: {
    workflowRuns: Array<{ day: string, succeeded: number, failed: number }>
  }
  topResources: Array<{ id: string, schema: string, name: string, type: string, count: number }>
  system: {
    postgres: { database: string, version: string, sizeBytes: number, connections: number, maxConnections: number, startedAt: string }
    pool: { max: number, total: number, idle: number, waiting: number }
    backups: { enabled: boolean, lastCompletedAt: string | null, nextAt: string | null, recent: RecentBackup[] }
    masterKey: { source: 'ENV' | 'FILE', path: string | null }
    outbox: { pending: number, oldestPendingSeconds: number | null }
    executions: { pending: number, running: number, failed: number }
    maintenance: { running: boolean }
    space: { schemas: Array<{ schema: string, bytes: number, tables: Array<{ table: string, bytes: number }> }> }
  }
}
const DATA_SERIES = ['create', 'update', 'delete', 'read', 'execute', 'bulk'] as const
type DataSeries = typeof DATA_SERIES[number]
const ADMIN_SERIES = ['access', 'config', 'schema', 'sql', 'other'] as const
type AdminSeries = typeof ADMIN_SERIES[number]
interface RecentBackup {
  id: string
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  trigger: 'SCHEDULED' | 'MANUAL'
  destination: 'LOCAL' | 'S3'
  sizeBytes: number | null
  error: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}
type ServiceKey = 'smtp' | 'backups' | 's3' | 'audit' | 'openapi' | 'graphql' | 'realtime' | 'mcp' | 'sql_console'
type AttentionKey = 'backup_failed' | 'outbox_failed' | 'workflow_runs_failed' | 'locked_accounts' | 'missing_resources'
  | 'pool_waiting' | 'outbox_backlog' | 'tokens_expiring' | 'failed_sign_ins' | 'tokens_refused'
  | 'smtp_not_configured' | 'backups_off' | 'connections_high' | 'invalid_indexes' | 'tables_with_dead_rows'
  | 'executions_failed' | 'master_key_file' | 'public_url_http' | 'rate_limit_off' | 'user_rate_limit_off' | 'untrusted_proxy' | 'certificate_invalid' | 'certificate_expiring'
  | 'security_headers_missing' | 'public_url_unreachable' | 'lockout_off' | 'mfa_not_required'
  | 'registration_unfiltered_writes' | 'definer_functions_exposed' | 'postgres_superuser' | 'postgres_role_privileges' | 'postgres_password_md5' | 'postgres_tls_off' | 'dashboards_query_role'

const api = useAdminApi()
const dates = useDateTimeFormat()
const { colors } = useChartTheme()
const { t } = useI18n()
const ui = useUiLocale()
const route = useRoute()
const compact = useCompactUi()
const router = useRouter()

// Days grouped in the viewer's zone (My account > Preferences, else the
// instance's, else the browser's), plus its offset in case PostgreSQL
// doesn't know the name.
const timeZone = dates.timezone.value ?? Intl.DateTimeFormat().resolvedOptions().timeZone
const offset = Math.round(getTimezoneOffset(timeZone, new Date()) / 60000)

// The charts' window, in the address like the Insights pages' - 30 days unless another is picked.
const WINDOW_DAYS = [7, 14, 30]
const WINDOWS = computed(() => WINDOW_DAYS.map(value => ({ label: t('users.insights.lastDays', { n: value }), value })))
const days = computed<number>({
  get: () => WINDOW_DAYS.find(value => String(value) === route.query.days) ?? 30,
  set: value => router.replace({ query: { ...route.query, days: value === 30 ? undefined : String(value) } })
})

const { data, pending, error, refresh } = await useAsyncData('status', () =>
  api.get<DashboardData>('/dashboard', { days: days.value, tz: timeZone, offset }).then(r => r.data),
{ watch: [days] }
)

// --- Refresh: by hand, or by itself while the tab is seen - the viewer's choice, kept in this browser. ---
const REFRESH_KEY = 'totalbase.status.refresh'
const REFRESH_SECONDS = [30, 60, 300]
const refreshSeconds = ref(0)
const updatedAt = ref(Date.now())
const now = ref(Date.now())
async function reload() {
  await Promise.all([refresh(), changes.value?.refresh(), signIns.value?.refresh()])
  updatedAt.value = Date.now()
}
function shortInterval(seconds: number) {
  return seconds < 60 ? t('dashboards.viewer.shortSeconds', { n: seconds }) : t('dashboards.viewer.shortMinutes', { n: seconds / 60 })
}
function setRefresh(seconds: number) {
  refreshSeconds.value = seconds
  try {
    localStorage.setItem(REFRESH_KEY, String(seconds))
  } catch {
    // A browser that keeps nothing: the choice lasts the visit.
  }
}
let timer: ReturnType<typeof setInterval> | undefined
let clock: ReturnType<typeof setInterval> | undefined
watch(refreshSeconds, (seconds) => {
  clearInterval(timer)
  // A hidden tab asks for nothing; it catches up on its next tick once seen again.
  if (seconds > 0) timer = setInterval(() => document.visibilityState === 'visible' && reload(), seconds * 1000)
})
onMounted(() => {
  try {
    const kept = Number(localStorage.getItem(REFRESH_KEY))
    if (REFRESH_SECONDS.includes(kept)) refreshSeconds.value = kept
  } catch {
    // No storage: off, as by default.
  }
  clock = setInterval(() => {
    now.value = Date.now()
  }, 30_000)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  clearInterval(clock)
})
const updatedAgo = computed(() => {
  void now.value
  return t('dashboards.view.updatedAgo', { ago: formatDistanceToNow(updatedAt.value, { addSuffix: true, locale: ui.dateFns.value }) })
})
// One button for it: the timer alone while off, the interval while on; its menu names it and says when the page was last loaded.
const headerActions = computed(() => [
  {
    // Off: the timer alone, like Refresh beside it. On: the interval, as a dashboard's badge reads ("1 min").
    label: refreshSeconds.value > 0 ? shortInterval(refreshSeconds.value) : t('shell.status.refresh.auto'),
    icon: 'i-lucide-timer',
    iconOnly: refreshSeconds.value === 0,
    tooltip: t('shell.status.refresh.auto'),
    children: [
      { label: `${t('shell.status.refresh.auto')} · ${updatedAgo.value}`, type: 'label' as const },
      { label: t('shell.status.refresh.off'), type: 'checkbox' as const, checked: refreshSeconds.value === 0, onSelect: () => setRefresh(0) },
      ...REFRESH_SECONDS.map(seconds => ({ label: shortInterval(seconds), type: 'checkbox' as const, checked: refreshSeconds.value === seconds, onSelect: () => setRefresh(seconds) }))
    ]
  },
  { label: t('common.refresh'), icon: 'i-lucide-refresh-cw', iconOnly: true, loading: pending.value, onSelect: () => reload() }
])

// --- Needs attention: how each item reads, and where it's handled. ---
// The text of each is `shell.status.attention.<key>` (plural forms, {n}).
const ATTENTION: Record<AttentionKey, { icon: string, to?: string }> = {
  backup_failed: { icon: 'i-lucide-archive', to: '/settings/backups' },
  backups_off: { icon: 'i-lucide-archive-x', to: '/settings/backups' },
  smtp_not_configured: { icon: 'i-lucide-mail-x', to: '/settings/smtp' },
  connections_high: { icon: 'i-lucide-plug', to: '/settings/connector' },
  invalid_indexes: { icon: 'i-lucide-list-x', to: '/settings/maintenance' },
  tables_with_dead_rows: { icon: 'i-lucide-brush-cleaning', to: '/settings/maintenance' },
  // Nowhere to go: executions have no list of their own, and the key's file is on the server's disk.
  executions_failed: { icon: 'i-lucide-list-restart' },
  master_key_file: { icon: 'i-lucide-key-square' },
  public_url_http: { icon: 'i-lucide-lock-open', to: '/settings/system' },
  rate_limit_off: { icon: 'i-lucide-gauge', to: '/settings/network' },
  user_rate_limit_off: { icon: 'i-lucide-gauge', to: '/settings/network' },
  untrusted_proxy: { icon: 'i-lucide-network', to: '/settings/network' },
  // Nowhere to go: the certificate and the reverse proxy are set up outside TotalBase.
  certificate_invalid: { icon: 'i-lucide-shield-x' },
  certificate_expiring: { icon: 'i-lucide-shield-alert' },
  security_headers_missing: { icon: 'i-lucide-shield-minus' },
  public_url_unreachable: { icon: 'i-lucide-globe-lock', to: '/settings/system' },
  lockout_off: { icon: 'i-lucide-lock-open', to: '/settings/auth' },
  mfa_not_required: { icon: 'i-lucide-smartphone', to: '/settings/mfa' },
  registration_unfiltered_writes: { icon: 'i-lucide-user-plus', to: '/settings/auth' },
  definer_functions_exposed: { icon: 'i-lucide-square-function', to: '/resources' },
  // Nowhere to go: each is the PostgreSQL server's or its connection's, set outside TotalBase.
  postgres_superuser: { icon: 'i-lucide-shield-alert' },
  postgres_role_privileges: { icon: 'i-lucide-shield-alert' },
  postgres_password_md5: { icon: 'i-lucide-key-round' },
  postgres_tls_off: { icon: 'i-lucide-lock-open' },
  dashboards_query_role: { icon: 'i-lucide-layout-dashboard', to: '/settings/dashboards' },
  outbox_failed: { icon: 'i-lucide-inbox', to: '/workflows' },
  workflow_runs_failed: { icon: 'i-lucide-workflow', to: '/workflows' },
  locked_accounts: { icon: 'i-lucide-lock', to: '/users/insights/sign-ins' },
  missing_resources: { icon: 'i-lucide-database-backup', to: '/resources' },
  pool_waiting: { icon: 'i-lucide-hourglass', to: '/settings/connector' },
  outbox_backlog: { icon: 'i-lucide-clock-alert' },
  tokens_refused: { icon: 'i-lucide-shield-alert', to: '/logs?event=auth.token_refused' },
  tokens_expiring: { icon: 'i-lucide-key-round', to: '/tokens?status=expiring' },
  failed_sign_ins: { icon: 'i-lucide-log-in', to: '/logs?event=auth.login,auth.portal_login,auth.oauth_login,auth.mfa_verify,auth.portal_mfa_verify,auth.password_renew,auth.portal_password_renew&status=DENIED' }
}
const ATTENTION_KEYS: Record<AttentionKey, string> = {
  backup_failed: 'backupFailed',
  backups_off: 'backupsOff',
  smtp_not_configured: 'smtpNotConfigured',
  connections_high: 'connectionsHigh',
  invalid_indexes: 'invalidIndexes',
  tables_with_dead_rows: 'tablesWithDeadRows',
  executions_failed: 'executionsFailed',
  master_key_file: 'masterKeyFile',
  public_url_http: 'publicUrlHttp',
  rate_limit_off: 'rateLimitOff',
  user_rate_limit_off: 'userRateLimitOff',
  untrusted_proxy: 'untrustedProxy',
  certificate_invalid: 'certificateInvalid',
  certificate_expiring: 'certificateExpiring',
  security_headers_missing: 'securityHeadersMissing',
  public_url_unreachable: 'publicUrlUnreachable',
  lockout_off: 'lockoutOff',
  mfa_not_required: 'mfaNotRequired',
  registration_unfiltered_writes: 'registrationUnfilteredWrites',
  definer_functions_exposed: 'definerFunctionsExposed',
  postgres_superuser: 'postgresSuperuser',
  postgres_role_privileges: 'postgresRolePrivileges',
  postgres_password_md5: 'postgresPasswordMd5',
  postgres_tls_off: 'postgresTlsOff',
  dashboards_query_role: 'dashboardsQueryRole',
  outbox_failed: 'outboxFailed',
  workflow_runs_failed: 'workflowRunsFailed',
  locked_accounts: 'lockedAccounts',
  missing_resources: 'missingResources',
  pool_waiting: 'poolWaiting',
  outbox_backlog: 'outboxBacklog',
  tokens_expiring: 'tokensExpiring',
  failed_sign_ins: 'failedSignIns',
  tokens_refused: 'tokensRefused'
}
/** A backup's moment, in the viewer's locale. */
const backupTime = (value: string) => new Intl.DateTimeFormat(ui.intlLocale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
// A linked item is a NuxtLink, one with nowhere to go (outbox backlog) a plain row.
const NuxtLink = resolveComponent('NuxtLink')
const SEVERITY_TONE = { error: 'text-error', warning: 'text-warning', info: 'text-muted' } as const
type Severity = keyof typeof SEVERITY_TONE
// The public URL is what every link TotalBase sends is built on (Foundations.md §4.2): worth a word when this page came from another origin.
const origin = useRequestURL().origin
const publicUrlMismatch = computed(() => {
  const url = data.value?.instance.publicUrl
  if (!url) return false
  try {
    return new URL(url).origin !== origin
  } catch {
    return true
  }
})
const attention = computed(() => {
  const items: Array<{ key: string, severity: Severity, icon: string, to?: string, text: string }> = (data.value?.attention ?? []).map(item => ({
    ...item,
    ...ATTENTION[item.key],
    // The names an item carries (the headers missing) follow its sentence.
    text: t(`shell.status.attention.${ATTENTION_KEYS[item.key]}`, { n: item.count }, item.count) + (item.detail?.length ? `: ${item.detail.join(', ')}` : '')
  }))
  // What only this page knows: where it was opened from, and a lockdown that hasn't started.
  if (publicUrlMismatch.value) items.push({ key: 'public_url', severity: 'warning', icon: 'i-lucide-globe', to: '/settings/system', text: t('shell.status.instance.publicUrlMismatch', { origin }) })
  const lockdown = data.value?.instance.lockdown
  if (lockdown?.startsAt) {
    items.push({
      key: 'lockdown_scheduled',
      severity: 'info',
      icon: 'i-lucide-calendar-clock',
      to: '/settings/lockdown',
      text: t(lockdown.readOnly ? 'shell.status.instance.readOnlyScheduled' : 'shell.status.instance.lockdownScheduled', { when: backupTime(lockdown.startsAt) })
    })
  }
  return items
})
// The bell's count takes the color of the worst item; notes alone stay neutral.
const attentionColor = computed(() => {
  const severities = attention.value.map(item => item.severity)
  return severities.includes('error') ? 'error' as const : severities.includes('warning') ? 'warning' as const : 'neutral' as const
})

// --- Headline counts ---
const numberFormat = computed(() => new Intl.NumberFormat(ui.intlLocale.value))
const kpis = computed(() => {
  const k = data.value?.kpis
  if (!k) return []
  const format = numberFormat.value.format
  const problems = [k.actions24h.denied && t('shell.status.kpis.denied', { n: format(k.actions24h.denied) }), k.actions24h.failed && t('shell.status.kpis.failed', { n: format(k.actions24h.failed) })].filter(Boolean)
  return [
    { label: t('shell.status.kpis.people'), hint: t('shell.status.kpis.peopleHint'), value: format(k.people), to: '/users', icon: 'i-lucide-users' },
    { label: t('shell.status.kpis.apiTokens'), hint: t('shell.status.kpis.apiTokensHint'), value: format(k.usableTokens), to: '/tokens', icon: 'i-lucide-key-round' },
    { label: t('shell.status.kpis.exposedResources'), hint: t('shell.status.kpis.exposedResourcesHint', { total: format(k.resources.total) }), value: format(k.resources.exposed), to: '/resources', icon: 'i-lucide-database' },
    { label: t('shell.status.kpis.activeSessions'), hint: t('shell.status.kpis.activeSessionsHint'), value: format(k.sessionsActive), to: '/sessions', icon: 'i-lucide-monitor-smartphone' },
    {
      label: t('shell.status.kpis.actions24h'),
      hint: problems.length ? problems.join(' · ') : t('shell.status.kpis.noProblems'),
      value: format(k.actions24h.total),
      to: '/logs',
      icon: 'i-lucide-activity',
      delta: delta(k.actions24h.total, k.actions24h.previous),
      trend: (data.value?.activity.data ?? []).map((d, i) => DATA_SERIES.reduce((sum, key) => sum + d[key], 0) + ADMIN_SERIES.reduce((sum, key) => sum + (data.value?.activity.admin[i]?.[key] ?? 0), 0))
    },
    {
      label: t('shell.status.kpis.workflowRuns24h'),
      hint: k.workflowRuns24h.failed ? t('shell.status.kpis.workflowRunsFailed', { n: format(k.workflowRuns24h.failed) }) : t('shell.status.kpis.workflowRunsNoneFailed'),
      value: format(k.workflowRuns24h.succeeded + k.workflowRuns24h.failed),
      to: '/workflows',
      icon: 'i-lucide-workflow',
      trend: (data.value?.trends.workflowRuns ?? []).map(d => d.succeeded + d.failed)
    }
  ] as Array<{ label: string, hint: string, value: string, to: string, icon: string, delta?: string | null, trend?: number[] }>
})
/** A count against the one before it, as a signed percentage - nothing to compare with, nothing said. */
function delta(now: number, before: number): string | null {
  if (before === 0) return null
  const change = (now - before) / before
  return new Intl.NumberFormat(ui.intlLocale.value, { style: 'percent', maximumFractionDigits: 0, signDisplay: 'exceptZero' }).format(change)
}

// --- The window's days, by the API that did it: the Data API's entries by what was done, the administration's by area. ---
// Each series knows the Logs filter that lists it, so a day's column opens what it counts.
const chartDays = computed(() => (data.value?.activity.data ?? []).map(d => d.day))
const CONFIG_EVENTS = 'settings.*,secret.*,auth_provider.*,system_email.*'
const DATA_LOGS: Record<DataSeries, { label: string, action: string }> = {
  create: { label: 'content.logs.actions.CREATE', action: 'CREATE' },
  update: { label: 'content.logs.actions.UPDATE', action: 'UPDATE' },
  delete: { label: 'content.logs.actions.DELETE', action: 'DELETE' },
  read: { label: 'content.logs.actions.READ', action: 'READ' },
  execute: { label: 'content.logs.actions.EXECUTE', action: 'EXECUTE' },
  bulk: { label: 'shell.status.categories.bulk', action: 'IMPORT,EXPORT,PRINT' }
}
const ADMIN_LOGS: Record<AdminSeries, { label: string, action: string, event?: string }> = {
  access: { label: 'shell.status.categories.access', action: 'AUTH' },
  config: { label: 'shell.status.categories.config', action: 'AUTH', event: CONFIG_EVENTS },
  schema: { label: 'content.logs.actions.DDL', action: 'DDL' },
  sql: { label: 'shell.status.categories.sql', action: 'SQL_EXECUTE,SQL_HISTORY_PURGE' },
  other: { label: 'shell.status.categories.other', action: 'MAINTENANCE,BACKUP,AUDIT_PURGE' }
}
// A series nothing happened in is left out of its chart.
const dataSeries = computed(() => {
  const palette: Record<DataSeries, string> = { create: colors.value.success, update: colors.value.primary, delete: colors.value.error, read: colors.value.textMuted, execute: colors.value.secondary, bulk: colors.value.warning }
  const list = data.value?.activity.data ?? []
  return DATA_SERIES
    .map(key => ({ key, name: t(DATA_LOGS[key].label), data: list.map(d => d[key]), color: palette[key] }))
    .filter(series => series.data.some(v => v > 0))
})
const adminSeries = computed(() => {
  const palette: Record<AdminSeries, string> = { access: colors.value.warning, config: colors.value.primary, schema: colors.value.success, sql: colors.value.secondary, other: colors.value.textMuted }
  const list = data.value?.activity.admin ?? []
  return ADMIN_SERIES
    .map(key => ({ key, name: t(ADMIN_LOGS[key].label), data: list.map(d => d[key]), color: palette[key] }))
    .filter(series => series.data.some(v => v > 0))
})
function openDataDay(day: string, seriesIndex: number) {
  const key = dataSeries.value[seriesIndex]?.key
  return navigateTo({ path: '/logs', query: { range: 'custom', from: day, to: day, ...(key && { action: DATA_LOGS[key].action }) } })
}
function openAdminDay(day: string, seriesIndex: number) {
  const key = adminSeries.value[seriesIndex]?.key
  const filter = key ? ADMIN_LOGS[key] : undefined
  return navigateTo({ path: '/logs', query: { range: 'custom', from: day, to: day, ...(filter && { action: filter.action }), ...(filter?.event && { event: filter.event }) } })
}
/** What was denied or failed on one side over the window, in Logs. */
function problemsLink(side: 'data' | 'admin') {
  const actions = Object.values(side === 'data' ? DATA_LOGS : ADMIN_LOGS).map(series => series.action)
  return { path: '/logs', query: { range: 'custom', from: chartDays.value[0], to: chartDays.value.at(-1), status: 'DENIED,FAILED', action: [...new Set(actions.join(',').split(','))].join(',') } }
}

// --- The third card, a tab per question: what takes the space, how the workflows ran, the backups made. ---
type SideTab = 'space' | 'workflows' | 'backups'
const sideTab = ref<SideTab>('space')
const SIDE_TABS = computed(() => [
  { label: t('shell.status.activity.tabs.space'), value: 'space', icon: 'i-lucide-hard-drive' },
  { label: t('shell.status.activity.tabs.workflows'), value: 'workflows', icon: 'i-lucide-workflow' },
  { label: t('shell.status.activity.tabs.backups'), value: 'backups', icon: 'i-lucide-archive' }
])
const workflowSeries = computed(() => {
  const runs = data.value?.trends.workflowRuns ?? []
  return [
    { name: t('shell.status.trends.succeeded'), data: runs.map(d => d.succeeded), color: colors.value.success },
    { name: t('shell.status.trends.failedRuns'), data: runs.map(d => d.failed), color: colors.value.error }
  ]
})
const workflowsEmpty = computed(() => workflowSeries.value.every(series => series.data.every(v => v === 0)))
// A backup as its page shows it (Settings > Backups): the same words, the same colors.
const BACKUP_COLOR = { PENDING: 'neutral', RUNNING: 'info', COMPLETED: 'success', FAILED: 'error' } as const
const recentBackups = computed(() => (data.value?.system.backups.recent ?? []).map(backup => ({
  ...backup,
  when: backupTime(backup.createdAt),
  origin: `${backup.trigger === 'SCHEDULED' ? t('settings.backups.scheduled') : t('settings.backups.manual')} · ${backup.destination === 'S3' ? t('settings.backups.s3') : t('settings.backups.local')}`,
  // What it weighs and how long it took, once it has finished.
  result: [
    backup.sizeBytes === null ? null : formatBytes(backup.sizeBytes),
    backup.startedAt && backup.completedAt ? formatAge(Math.max(1, Math.round((new Date(backup.completedAt).getTime() - new Date(backup.startedAt).getTime()) / 1000))) : null
  ].filter(Boolean).join(' · ')
})))

// --- What takes a schema's space: its largest tables, the rest as Other. `public` first - the application's - else the largest. ---
const SPACE_SLICES = 8
/** A lighter shade of a theme color (useChartTheme reads them as `rgb(r, g, b)`) - the slices past the palette's five. */
function tint(color: string): string {
  return color.startsWith('rgb(') ? color.replace('rgb(', 'rgba(').replace(')', ', 0.5)') : color
}
const spaceSchemas = computed(() => data.value?.system.space.schemas ?? [])
const spacePicked = ref<string>()
const spaceSchema = computed({
  get: () => (spaceSchemas.value.find(s => s.schema === spacePicked.value) ?? spaceSchemas.value.find(s => s.schema === 'public') ?? spaceSchemas.value[0])?.schema,
  set: (value) => { spacePicked.value = value }
})
const SPACE_SCHEMAS = computed(() => spaceSchemas.value.map(s => ({ label: `${s.schema} · ${formatBytes(s.bytes)}`, value: s.schema })))
const spaceItems = computed(() => {
  const schema = spaceSchemas.value.find(s => s.schema === spaceSchema.value)
  if (!schema) return []
  const shown = schema.tables.slice(0, SPACE_SLICES)
  const rest = schema.bytes - shown.reduce((sum, table) => sum + table.bytes, 0)
  const base = [colors.value.primary, colors.value.secondary, colors.value.success, colors.value.warning, colors.value.error]
  const palette = [...base, ...base.map(tint)]
  return [
    ...shown.map((table, i) => ({ name: table.table, value: table.bytes, color: palette[i]! })),
    ...(rest > 0 ? [{ name: t('shell.status.space.other'), value: rest, color: colors.value.textMuted }] : [])
  ].filter(item => item.value > 0)
})

// --- What it has turned on: each service as the settings name it, opening its page. ---
const SERVICES: Record<ServiceKey, { label: string, icon: string, to: string }> = {
  smtp: { label: 'shell.nav.items.emailSmtp', icon: 'i-lucide-send', to: '/settings/smtp' },
  backups: { label: 'shell.nav.items.backups', icon: 'i-lucide-archive', to: '/settings/backups' },
  s3: { label: 'shell.nav.items.s3Storage', icon: 'i-lucide-cloud', to: '/settings/s3' },
  audit: { label: 'shell.nav.items.audit', icon: 'i-lucide-scroll-text', to: '/settings/audit' },
  openapi: { label: 'shell.nav.items.openapi', icon: 'i-lucide-file-code', to: '/settings/openapi' },
  graphql: { label: 'shell.nav.items.graphql', icon: 'i-lucide-waypoints', to: '/settings/graphql' },
  realtime: { label: 'shell.nav.items.realtime', icon: 'i-lucide-radio', to: '/settings/realtime' },
  mcp: { label: 'shell.nav.items.mcp', icon: 'i-lucide-bot', to: '/settings/mcp' },
  sql_console: { label: 'shell.nav.items.sqlConsole', icon: 'i-lucide-terminal', to: '/settings/sql-console' }
}
const SERVICE_STATES = { ON: 'shell.status.services.on', OFF: 'shell.status.services.off', NOT_CONFIGURED: 'shell.status.services.notConfigured' } as const
const services = computed(() => (data.value?.services ?? []).map((service) => {
  // Backups say when the last one ran, once there is one - more use than what they are.
  const lastBackup = service.key === 'backups' && service.state === 'ON' ? data.value?.system.backups.lastCompletedAt : null
  return {
    ...service,
    ...SERVICES[service.key],
    description: lastBackup ? t('shell.status.system.backupsLast', { when: backupTime(lastBackup) }) : t(`shell.status.services.descriptions.${service.key}`),
    stateLabel: t(SERVICE_STATES[service.state])
  }
}))

// --- Latest configuration changes: the schema, who may do what and how the instance is set up - sign-ins and data left to Logs. ---
// StatusFeed.vue reads and tells them; a feed loads when opened, then with each refresh while it stays open.
const CHANGES_QUERY = { event: ['schema', 'permission', 'role', 'assignment', 'user', 'token', 'settings', 'secret', 'auth_provider', 'system_email', 'dataview', 'dashboard', 'dashboard_embed', 'workflow'].map(prefix => `${prefix}.*`).join(',') }
const changesOpen = ref(false)
const changes = useTemplateRef<{ refresh: () => Promise<void> }>('changes')
// --- Latest sign-ins: who came in, who was refused and why - the same events as Users > Insights > Sign-ins counts. ---
const SIGN_INS_QUERY = { event: 'auth.login,auth.portal_login,auth.oauth_login,auth.mfa_verify,auth.portal_mfa_verify,auth.password_renew,auth.portal_password_renew' }
const signInsOpen = ref(false)
const signIns = useTemplateRef<{ refresh: () => Promise<void> }>('signIns')

// --- System ---
function formatAge(seconds: number | null): string {
  if (seconds === null) return t('shell.status.age.noneWaiting')
  if (seconds < 60) return t('shell.status.age.underMinute')
  if (seconds < 3600) return t('shell.status.age.minutes', { n: Math.round(seconds / 60) })
  if (seconds < 172800) return t('shell.status.age.hours', { n: Math.round(seconds / 3600) })
  return t('shell.status.age.days', { n: Math.round(seconds / 86400) })
}
const serverUptime = computed(() => {
  void now.value
  return formatAge(data.value?.instance.uptimeSeconds ?? 0)
})
const postgresUptime = computed(() => data.value ? formatAge(Math.max(0, Math.round((Date.now() - new Date(data.value.system.postgres.startedAt).getTime()) / 1000))) : '')
/** A meter's tone: calm until the limit is near. */
function meterColor(value: number, max: number): 'primary' | 'warning' | 'error' {
  const share = max > 0 ? value / max : 0
  return share >= 0.95 ? 'error' : share >= 0.8 ? 'warning' : 'primary'
}
</script>

<template>
  <PageShell>
    <template #header>
      <PageHeader
        :title="t('shell.status.title')"
        :description="t('shell.status.description')"
        icon="i-lucide-activity"
        :actions="headerActions"
      >
        <!-- First among the actions (the slot a search takes elsewhere), then a gap before the refresh pair. -->
        <template #search>
          <!-- What needs attention: the bell with its count, in the color of the worst item. -->
          <UPopover :content="{ align: 'end' }">
            <UButton
              icon="i-lucide-bell"
              :label="attention.length ? String(attention.length) : undefined"
              :color="attentionColor"
              :variant="attentionColor === 'neutral' ? 'outline' : 'subtle'"
              :square="attention.length === 0"
              :aria-label="attention.length ? t('shell.status.attentionCount', { n: attention.length }, attention.length) : t('shell.status.allClear')"
            />
            <template #content>
              <div class="flex w-96 max-w-[calc(100vw-2rem)] flex-col">
                <p class="border-b border-default px-4 py-3 text-sm font-semibold text-highlighted">
                  {{ t('shell.status.needsAttention') }}
                </p>
                <div
                  v-if="attention.length === 0"
                  class="flex items-center gap-2 px-4 py-3 text-sm"
                >
                  <UIcon
                    name="i-lucide-circle-check"
                    class="size-4 shrink-0 text-success"
                  />
                  <span>{{ t('shell.status.allClear') }}</span>
                </div>
                <div
                  v-else
                  class="flex max-h-96 flex-col divide-y divide-default overflow-y-auto"
                >
                  <component
                    :is="item.to ? NuxtLink : 'div'"
                    v-for="item in attention"
                    :key="item.key"
                    :to="item.to"
                    class="flex items-start gap-3 px-4 py-3 text-sm"
                    :class="item.to ? 'hover:bg-elevated/50' : undefined"
                  >
                    <UIcon
                      :name="item.icon"
                      class="mt-0.5 size-4 shrink-0"
                      :class="SEVERITY_TONE[item.severity]"
                    />
                    <span class="flex-1 text-highlighted">{{ item.text }}</span>
                    <UIcon
                      v-if="item.to"
                      name="i-lucide-chevron-right"
                      class="mt-0.5 size-4 shrink-0 text-dimmed"
                    />
                  </component>
                </div>
              </div>
            </template>
          </UPopover>

          <!-- The latest configuration changes, in a slideover. -->
          <UTooltip :text="t('shell.status.changes.title')">
            <UButton
              icon="i-lucide-history"
              color="neutral"
              variant="outline"
              square
              :aria-label="t('shell.status.changes.title')"
              @click="changesOpen = true"
            />
          </UTooltip>
          <!-- The latest sign-ins, in a slideover. -->
          <UTooltip :text="t('shell.status.signIns.title')">
            <UButton
              icon="i-lucide-user-check"
              color="neutral"
              variant="outline"
              square
              :aria-label="t('shell.status.signIns.title')"
              @click="signInsOpen = true"
            />
          </UTooltip>
          <USeparator
            v-if="!compact"
            orientation="vertical"
            class="mx-1 h-6"
          />
        </template>

        <!-- After the actions: a gap before the docs. -->
        <USeparator
          v-if="!compact"
          orientation="vertical"
          class="mx-1 h-6"
        />
      </PageHeader>
    </template>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error.message"
    />
    <div
      v-else-if="data"
      class="flex flex-col gap-8"
    >
      <!-- Headline counts -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <NuxtLink
          v-for="kpi in kpis"
          :key="kpi.label"
          :to="kpi.to"
          class="flex items-start gap-3 rounded-lg border border-default px-4 py-3 transition hover:border-primary"
        >
          <UIcon
            :name="kpi.icon"
            class="mt-1 size-5 shrink-0 text-muted"
          />
          <div class="min-w-0 flex-1">
            <p class="flex items-baseline gap-2 text-2xl font-semibold text-highlighted tabular-nums">
              {{ kpi.value }}
              <span
                v-if="kpi.delta"
                class="text-xs font-normal text-muted"
                :title="t('shell.status.kpis.deltaHint')"
              >{{ kpi.delta }}</span>
            </p>
            <p class="truncate text-sm text-highlighted">
              {{ kpi.label }}
            </p>
            <p class="truncate text-xs text-muted">
              {{ kpi.hint }}
            </p>
            <TrendSparkline
              v-if="kpi.trend && kpi.trend.some(v => v > 0)"
              :values="kpi.trend"
              class="mt-2"
            />
          </div>
        </NuxtLink>
      </div>

      <!-- The window's days, a chart per question: bars, lines, a donut. -->
      <section class="flex flex-col gap-3">
        <div class="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 class="text-base font-semibold text-highlighted">
              {{ t('shell.status.activity.title') }}
            </h2>
            <p class="text-xs text-muted">
              {{ t('shell.status.activity.description', { timeZone }) }}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <USelect
              v-model="days"
              :items="WINDOWS"
              :aria-label="t('users.insights.period')"
              size="sm"
              class="w-36"
            />
            <UButton
              :label="t('shell.status.activity.insights')"
              icon="i-lucide-chart-column"
              color="neutral"
              variant="outline"
              size="sm"
              to="/users/insights/activity"
            />
          </div>
        </div>
        <div class="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
          <!-- The Data API: what was done to the rows -->
          <div class="flex flex-col rounded-lg border border-default px-4 pt-2 pb-2">
            <div class="flex h-10 items-center justify-between gap-2">
              <p class="truncate text-sm font-medium text-highlighted">
                {{ t('shell.status.activity.dataApi') }}
              </p>
              <NuxtLink
                v-if="data.activity.problems.data > 0"
                :to="problemsLink('data')"
                class="flex shrink-0 items-center gap-1 text-xs text-error hover:underline"
              >
                <UIcon
                  name="i-lucide-circle-alert"
                  class="size-3.5"
                />
                {{ t('shell.status.activity.problems', { n: numberFormat.format(data.activity.problems.data) }, data.activity.problems.data) }}
              </NuxtLink>
              <span
                v-else
                class="shrink-0 text-xs text-muted"
              >{{ t('shell.status.activity.noProblems') }}</span>
            </div>
            <DashboardActivityAreaChart
              v-if="dataSeries.length"
              :days="chartDays"
              :series="dataSeries"
              bars
              @select-day="openDataDay"
            />
            <p
              v-else
              class="flex flex-1 items-center justify-center py-12 text-center text-sm text-muted"
            >
              {{ t('shell.status.activity.emptyData', { n: days }) }}
            </p>
          </div>

          <!-- The administration: who may do what, and how the instance is set up -->
          <div class="flex flex-col rounded-lg border border-default px-4 pt-2 pb-2">
            <div class="flex h-10 items-center justify-between gap-2">
              <p class="truncate text-sm font-medium text-highlighted">
                {{ t('shell.status.activity.adminApi') }}
              </p>
              <NuxtLink
                v-if="data.activity.problems.admin > 0"
                :to="problemsLink('admin')"
                class="flex shrink-0 items-center gap-1 text-xs text-error hover:underline"
              >
                <UIcon
                  name="i-lucide-circle-alert"
                  class="size-3.5"
                />
                {{ t('shell.status.activity.problems', { n: numberFormat.format(data.activity.problems.admin) }, data.activity.problems.admin) }}
              </NuxtLink>
              <span
                v-else
                class="shrink-0 text-xs text-muted"
              >{{ t('shell.status.activity.noProblems') }}</span>
            </div>
            <DashboardActivityAreaChart
              v-if="adminSeries.length"
              :days="chartDays"
              :series="adminSeries"
              bars
              @select-day="openAdminDay"
            />
            <p
              v-else
              class="flex flex-1 items-center justify-center py-12 text-center text-sm text-muted"
            >
              {{ t('shell.status.activity.emptyAdmin', { n: days }) }}
            </p>
          </div>

          <!-- Space, workflow runs, backups: a tab each -->
          <div class="flex flex-col rounded-lg border border-default px-4 pt-2 pb-2 lg:max-xl:col-span-2">
            <UTabs
              v-model="sideTab"
              :items="SIDE_TABS"
              variant="link"
              size="sm"
              :content="false"
            />
            <!-- Siblings, not UTabs' own panels: ECharts measures a panel mid-transition as 0x0 and stays blank. -->
            <template v-if="sideTab === 'space'">
              <template v-if="spaceItems.length">
                <div class="flex h-9 items-end justify-end">
                  <USelect
                    v-model="spaceSchema"
                    :items="SPACE_SCHEMAS"
                    :aria-label="t('shell.status.space.schema')"
                    size="sm"
                    class="max-w-44 min-w-0"
                  />
                </div>
                <DashboardDonutChart
                  :items="spaceItems"
                  :format="formatBytes"
                  :height="220"
                  bare
                />
              </template>
              <p
                v-else
                class="flex flex-1 items-center justify-center py-12 text-center text-sm text-muted"
              >
                {{ t('shell.status.space.empty') }}
              </p>
            </template>
            <template v-else-if="sideTab === 'workflows'">
              <DashboardActivityAreaChart
                v-if="!workflowsEmpty"
                :days="chartDays"
                :series="workflowSeries"
                :stacked="false"
                lines
                @select-day="navigateTo('/workflows')"
              />
              <p
                v-else
                class="flex flex-1 items-center justify-center py-12 text-center text-sm text-muted"
              >
                {{ t('shell.status.trends.noRuns', { n: days }) }}
              </p>
            </template>
            <template v-else>
              <div
                v-if="recentBackups.length"
                class="flex flex-1 flex-col divide-y divide-default pt-1"
              >
                <NuxtLink
                  v-for="backup in recentBackups"
                  :key="backup.id"
                  to="/settings/backups"
                  class="flex flex-1 items-center gap-3 py-1.5 text-sm hover:bg-elevated/50"
                >
                  <UBadge
                    :color="BACKUP_COLOR[backup.status]"
                    variant="subtle"
                    size="sm"
                    :label="t(`settings.backups.status.${backup.status}`)"
                    class="w-24 shrink-0 justify-center"
                  />
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-highlighted">
                      {{ backup.when }}
                    </p>
                    <p
                      class="truncate text-xs"
                      :class="backup.error ? 'text-error' : 'text-muted'"
                    >
                      {{ backup.error ?? backup.origin }}
                    </p>
                  </div>
                  <span class="shrink-0 text-xs text-muted tabular-nums">{{ backup.result }}</span>
                </NuxtLink>
              </div>
              <p
                v-else
                class="flex flex-1 items-center justify-center py-12 text-center text-sm text-muted"
              >
                {{ data.system.backups.enabled ? t('shell.status.trends.noBackups', { n: days }) : t('shell.status.trends.backupsOff') }}
              </p>
            </template>
          </div>
        </div>
      </section>

      <div class="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <!-- The system it runs on -->
        <section class="flex flex-col gap-3">
          <h2 class="text-base font-semibold text-highlighted">
            {{ t('shell.status.system.title') }}
          </h2>
          <div class="flex flex-1 flex-col divide-y divide-default rounded-lg border border-default text-sm">
            <div class="flex flex-1 items-center gap-3 px-4 py-2.5">
              <UIcon
                name="i-lucide-box"
                class="size-5 shrink-0 text-muted"
              />
              <div class="min-w-0 flex-1">
                <p class="text-highlighted">
                  TotalBase
                </p>
                <p class="truncate text-xs text-muted">
                  {{ data.instance.environment }} · {{ t('shell.status.system.runningFor', { age: serverUptime }) }}
                </p>
              </div>
              <span class="shrink-0 font-medium text-highlighted">{{ data.instance.version }}</span>
            </div>
            <div class="flex flex-1 items-center gap-3 px-4 py-2.5">
              <UIcon
                name="i-lucide-database"
                class="size-5 shrink-0 text-muted"
              />
              <div class="min-w-0 flex-1">
                <p class="text-highlighted">
                  PostgreSQL
                </p>
                <p class="truncate text-xs text-muted">
                  {{ data.system.postgres.database }} · {{ t('shell.status.system.runningFor', { age: postgresUptime }) }}
                </p>
              </div>
              <span class="shrink-0 font-medium text-highlighted">{{ data.system.postgres.version }}</span>
            </div>
            <NuxtLink
              to="/settings/system"
              class="flex flex-1 items-center gap-3 px-4 py-2.5 hover:bg-elevated/50"
            >
              <UIcon
                name="i-lucide-globe"
                class="size-5 shrink-0 text-muted"
              />
              <div class="min-w-0 flex-1">
                <p class="text-highlighted">
                  {{ t('shell.status.system.publicUrl') }}
                </p>
                <p class="truncate text-xs text-muted">
                  {{ t('shell.status.system.publicUrlHelp') }}
                </p>
              </div>
              <span
                class="min-w-0 truncate"
                :class="publicUrlMismatch ? 'text-warning' : undefined"
              >{{ data.instance.publicUrl }}</span>
            </NuxtLink>
            <div class="flex flex-1 items-center gap-3 px-4 py-2.5">
              <UIcon
                name="i-lucide-plug"
                class="size-5 shrink-0 text-muted"
              />
              <div class="min-w-0 flex-1">
                <p class="text-highlighted">
                  {{ t('shell.status.system.connections') }}
                </p>
                <p class="truncate text-xs text-muted">
                  {{ t('shell.status.system.connectionsHelp') }}
                </p>
              </div>
              <UProgress
                :model-value="data.system.postgres.connections"
                :max="data.system.postgres.maxConnections"
                :color="meterColor(data.system.postgres.connections, data.system.postgres.maxConnections)"
                size="sm"
                class="w-24 shrink-0 max-sm:hidden"
              />
              <span class="shrink-0 tabular-nums">{{ t('shell.status.system.connectionsValue', { n: data.system.postgres.connections, max: data.system.postgres.maxConnections }) }}</span>
            </div>
            <NuxtLink
              to="/settings/connector"
              class="flex flex-1 items-center gap-3 px-4 py-2.5 hover:bg-elevated/50"
            >
              <UIcon
                name="i-lucide-layers"
                class="size-5 shrink-0 text-muted"
              />
              <div class="min-w-0 flex-1">
                <p class="text-highlighted">
                  {{ t('shell.status.system.pool') }}
                </p>
                <p class="truncate text-xs text-muted">
                  {{ t('shell.status.system.poolHelp') }}
                </p>
              </div>
              <UProgress
                :model-value="data.system.pool.total - data.system.pool.idle"
                :max="data.system.pool.max"
                :color="data.system.pool.waiting > 0 ? 'warning' : meterColor(data.system.pool.total - data.system.pool.idle, data.system.pool.max)"
                size="sm"
                class="w-24 shrink-0 max-sm:hidden"
              />
              <span
                class="shrink-0 text-right tabular-nums"
                :class="data.system.pool.waiting > 0 ? 'text-warning' : undefined"
              >
                {{ t('shell.status.system.poolBusy', { busy: data.system.pool.total - data.system.pool.idle, max: data.system.pool.max }) }}<template v-if="data.system.pool.waiting > 0">
                  · {{ t('shell.status.system.poolWaiting', { n: data.system.pool.waiting }) }}
                </template>
              </span>
            </NuxtLink>
            <NuxtLink
              to="/settings/maintenance"
              class="flex flex-1 items-center gap-3 px-4 py-2.5 hover:bg-elevated/50"
            >
              <UIcon
                name="i-lucide-hard-drive"
                class="size-5 shrink-0 text-muted"
              />
              <div class="min-w-0 flex-1">
                <p class="text-highlighted">
                  {{ t('shell.status.system.databaseSize') }}
                </p>
                <p class="truncate text-xs text-muted">
                  {{ data.system.maintenance.running ? t('shell.status.system.maintenanceRunning') : t('shell.status.system.maintenanceIdle') }}
                </p>
              </div>
              <span class="shrink-0 tabular-nums">{{ formatBytes(data.system.postgres.sizeBytes) }}</span>
            </NuxtLink>
            <!-- Where the master key comes from (Foundations.md §15) - never the key. A file must be backed up apart from the database. -->
            <div class="flex flex-1 items-center gap-3 px-4 py-2.5">
              <UIcon
                name="i-lucide-key-round"
                class="size-5 shrink-0 text-muted"
              />
              <div class="min-w-0 flex-1">
                <p class="text-highlighted">
                  {{ t('shell.status.system.masterKey') }}
                </p>
                <p
                  class="text-xs"
                  :class="data.system.masterKey.source === 'FILE' ? 'text-warning' : 'truncate text-muted'"
                >
                  {{ data.system.masterKey.source === 'FILE' ? t('shell.status.system.masterKeyFile') : t('shell.status.system.masterKeyHelp') }}
                </p>
              </div>
              <span
                v-if="data.system.masterKey.source === 'ENV'"
                class="min-w-0 truncate text-right"
              >{{ t('shell.status.system.masterKeyEnv') }}</span>
              <span
                v-else
                class="min-w-0 truncate font-mono text-xs"
              >{{ data.system.masterKey.path }}</span>
            </div>
            <div class="flex flex-1 items-center gap-3 px-4 py-2.5">
              <UIcon
                name="i-lucide-inbox"
                class="size-5 shrink-0 text-muted"
              />
              <div class="min-w-0 flex-1">
                <p class="text-highlighted">
                  {{ t('shell.status.system.eventsWaiting') }}
                </p>
                <p class="truncate text-xs text-muted">
                  {{ data.system.outbox.pending > 0 ? t('shell.status.system.oldest', { age: formatAge(data.system.outbox.oldestPendingSeconds) }) : t('shell.status.system.eventsHelp') }}
                </p>
              </div>
              <span class="shrink-0 tabular-nums">{{ numberFormat.format(data.system.outbox.pending) }}</span>
            </div>
            <div class="flex flex-1 items-center gap-3 px-4 py-2.5">
              <UIcon
                name="i-lucide-list-restart"
                class="size-5 shrink-0 text-muted"
              />
              <div class="min-w-0 flex-1">
                <p class="text-highlighted">
                  {{ t('shell.status.system.executions') }}
                </p>
                <p
                  class="truncate text-xs"
                  :class="data.system.executions.failed > 0 ? 'text-error' : 'text-muted'"
                >
                  {{ data.system.executions.failed > 0 ? t('shell.status.system.executionsFailed', { n: numberFormat.format(data.system.executions.failed) }) : t('shell.status.system.executionsHelp') }}
                </p>
              </div>
              <span class="shrink-0 text-right tabular-nums">{{ t('shell.status.system.executionsValue', { pending: numberFormat.format(data.system.executions.pending), running: numberFormat.format(data.system.executions.running) }) }}</span>
            </div>
          </div>
        </section>

        <!-- What it has turned on: a row opens the service's settings; the switch only says. -->
        <section class="flex flex-col gap-3">
          <h2 class="text-base font-semibold text-highlighted">
            {{ t('shell.status.services.title') }}
          </h2>
          <div class="flex flex-1 flex-col divide-y divide-default rounded-lg border border-default">
            <NuxtLink
              v-for="service in services"
              :key="service.key"
              :to="service.to"
              class="flex flex-1 items-center gap-3 px-4 py-2.5 text-sm hover:bg-elevated/50"
            >
              <UIcon
                :name="service.icon"
                class="size-5 shrink-0 text-muted"
              />
              <div class="min-w-0 flex-1">
                <p class="truncate text-highlighted">
                  {{ t(service.label) }}
                </p>
                <p class="truncate text-xs text-muted">
                  {{ service.description }}
                </p>
              </div>
              <span
                class="shrink-0 text-xs"
                :class="service.state === 'NOT_CONFIGURED' ? 'text-warning' : service.state === 'ON' ? 'text-highlighted' : 'text-muted'"
              >{{ service.stateLabel }}</span>
              <USwitch
                :model-value="service.state === 'ON'"
                tabindex="-1"
                aria-hidden="true"
                class="pointer-events-none shrink-0"
              />
            </NuxtLink>
          </div>
        </section>
      </div>
    </div>

    <!-- The latest configuration changes and sign-ins: looked up, not worked on - a slideover each. -->
    <StatusFeed
      ref="changes"
      v-model:open="changesOpen"
      kind="changes"
      :query="CHANGES_QUERY"
      :title="t('shell.status.changes.title')"
      :description="t('shell.status.changes.description')"
      :empty-title="t('shell.status.changes.empty')"
      :more="{ label: t('shell.status.changes.all'), icon: 'i-lucide-scroll-text', to: { path: '/logs', query: { range: 'all', ...CHANGES_QUERY } } }"
    />
    <StatusFeed
      ref="signIns"
      v-model:open="signInsOpen"
      kind="sign-ins"
      :query="SIGN_INS_QUERY"
      :title="t('shell.status.signIns.title')"
      :description="t('shell.status.signIns.description')"
      :empty-title="t('shell.status.signIns.empty')"
      :more="{ label: t('shell.status.signIns.all'), icon: 'i-lucide-chart-column', to: '/users/insights/sign-ins' }"
    />
  </PageShell>
</template>
