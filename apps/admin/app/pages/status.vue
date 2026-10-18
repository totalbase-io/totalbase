<script setup lang="ts">
/**
 * Status, the administrator's home - GET /admin/api/dashboard. Answers, top to bottom:
 * does anything need me (only what has a count, each linking to where
 * it's handled), the headline counts, 14 days of activity in the
 * viewer's zone (a day opens in Logs), then is anything going wrong
 * (denied/failed actions or workflow runs per day) and what takes the
 * database's space (by schema or TotalBase table), the application's
 * busiest resources and the database/pool state. Sober on purpose
 * (AGENTS.md section 25): one list, four counts, three charts, two panels -
 * each chart answering a question nothing else on the page does.
 */
import { getTimezoneOffset } from 'date-fns-tz'
import type { ResourceType } from '~/types/resource'

interface DashboardData {
  kpis: {
    people: number
    usableTokens: number
    resources: { exposed: number, total: number }
    actions24h: { total: number, denied: number, failed: number }
  }
  attention: Array<{ key: AttentionKey, severity: 'error' | 'warning' | 'info', count: number }>
  activity: {
    timeZone: string
    days: Array<{ day: string, data: number, access: number, sql: number, bulk: number, other: number }>
  }
  trends: {
    problems: Array<{ day: string, denied: number, failed: number }>
    workflowRuns: Array<{ day: string, succeeded: number, failed: number }>
  }
  topResources: Array<{ id: string, schema: string, name: string, type: string, count: number }>
  system: {
    postgres: { database: string, version: string, sizeBytes: number, connections: number, maxConnections: number }
    pool: { max: number, total: number, idle: number, waiting: number }
    sessionsActive: number
    masterKey: { source: 'ENV' | 'FILE', path: string | null }
    outbox: { pending: number, oldestPendingSeconds: number | null }
    space: { schemas: Array<{ schema: string, bytes: number }>, totalbase: Array<{ table: string, bytes: number }> }
  }
}
type AttentionKey = 'outbox_failed' | 'workflow_runs_failed' | 'locked_accounts' | 'missing_resources'
  | 'pool_waiting' | 'outbox_backlog' | 'tokens_expiring' | 'failed_sign_ins'

const api = useAdminApi()
const dates = useDateTimeFormat()
const { colors } = useChartTheme()
const { t } = useI18n()
const ui = useUiLocale()

// Days grouped in the viewer's zone (My account > Preferences, else the
// instance's, else the browser's), plus its offset in case PostgreSQL
// doesn't know the name.
const timeZone = dates.timezone.value ?? Intl.DateTimeFormat().resolvedOptions().timeZone
const offset = Math.round(getTimezoneOffset(timeZone, new Date()) / 60000)

const { data, pending, error, refresh } = await useAsyncData('status', () =>
  api.get<DashboardData>('/dashboard', { tz: timeZone, offset }).then(r => r.data)
)

// --- Needs attention: how each item reads, and where it's handled. ---
// The text of each is `shell.status.attention.<key>` (plural forms, {n}).
const ATTENTION: Record<AttentionKey, { icon: string, to?: string }> = {
  outbox_failed: { icon: 'i-lucide-inbox', to: '/workflows' },
  workflow_runs_failed: { icon: 'i-lucide-workflow', to: '/workflows' },
  locked_accounts: { icon: 'i-lucide-lock', to: '/users/insights/sign-ins' },
  missing_resources: { icon: 'i-lucide-database-backup', to: '/resources' },
  pool_waiting: { icon: 'i-lucide-hourglass', to: '/settings/connector' },
  outbox_backlog: { icon: 'i-lucide-clock-alert' },
  tokens_expiring: { icon: 'i-lucide-key-round', to: '/tokens?status=expiring' },
  failed_sign_ins: { icon: 'i-lucide-log-in', to: '/logs?event=auth.login,auth.portal_login,auth.oauth_login&status=DENIED' }
}
const ATTENTION_KEYS: Record<AttentionKey, string> = {
  outbox_failed: 'outboxFailed',
  workflow_runs_failed: 'workflowRunsFailed',
  locked_accounts: 'lockedAccounts',
  missing_resources: 'missingResources',
  pool_waiting: 'poolWaiting',
  outbox_backlog: 'outboxBacklog',
  tokens_expiring: 'tokensExpiring',
  failed_sign_ins: 'failedSignIns'
}
// A linked item is a NuxtLink, one with nowhere to go (outbox backlog) a plain row.
const NuxtLink = resolveComponent('NuxtLink')
const SEVERITY_TONE = { error: 'text-error', warning: 'text-warning', info: 'text-muted' } as const
const attention = computed(() => (data.value?.attention ?? []).map(item => ({
  ...item,
  ...ATTENTION[item.key],
  text: t(`shell.status.attention.${ATTENTION_KEYS[item.key]}`, { n: item.count }, item.count)
})))

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
    { label: t('shell.status.kpis.actions24h'), hint: problems.length ? problems.join(' · ') : t('shell.status.kpis.noProblems'), value: format(k.actions24h.total), to: '/logs', icon: 'i-lucide-activity' }
  ]
})

// --- Activity: the Logs page's categories, as on Users > Insights > Activity. ---
const CATEGORIES = ['data', 'access', 'sql', 'bulk', 'other'] as const
const activitySeries = computed(() => {
  const palette = [colors.value.primary, colors.value.warning, colors.value.secondary, colors.value.success, colors.value.textMuted]
  const days = data.value?.activity.days ?? []
  return CATEGORIES
    .map((c, i) => ({ name: t(`shell.status.categories.${c}`), data: days.map(d => d[c]), color: palette[i]! }))
    .filter(s => s.data.some(v => v > 0))
})
function openDay(day: string) {
  return navigateTo({ path: '/logs', query: { range: 'custom', from: day, to: day } })
}

// --- Is anything going wrong: a tab per question. ---
type TrendTab = 'problems' | 'workflows'
const trendTab = ref<TrendTab>('problems')
const TREND_TABS = computed(() => [
  { label: t('shell.status.trends.tabs.problems'), value: 'problems', icon: 'i-lucide-circle-alert' },
  { label: t('shell.status.trends.tabs.workflows'), value: 'workflows', icon: 'i-lucide-workflow' }
])
const trendDays = computed(() => (data.value?.trends.problems ?? []).map(d => d.day))
const trendSeries = computed(() => {
  const trends = data.value?.trends
  if (!trends) return []
  return trendTab.value === 'problems'
    ? [
        { name: t('shell.status.trends.failed'), data: trends.problems.map(d => d.failed), color: colors.value.error },
        { name: t('shell.status.trends.denied'), data: trends.problems.map(d => d.denied), color: colors.value.warning }
      ]
    : [
        { name: t('shell.status.trends.succeeded'), data: trends.workflowRuns.map(d => d.succeeded), color: colors.value.success },
        { name: t('shell.status.trends.failedRuns'), data: trends.workflowRuns.map(d => d.failed), color: colors.value.error }
      ]
})
const trendEmpty = computed(() => trendSeries.value.every(s => s.data.every(v => v === 0)))
/** A point opens that day in Logs, filtered to what it counts; a workflow point opens Workflows. */
function openTrend(day: string, seriesIndex: number) {
  if (trendTab.value === 'workflows') return navigateTo('/workflows')
  return navigateTo({ path: '/logs', query: { range: 'custom', from: day, to: day, status: seriesIndex === 0 ? 'FAILED' : 'DENIED' } })
}

// --- What takes the database's space: the largest few, the rest as Other. ---
type SpaceTab = 'schemas' | 'totalbase'
const spaceTab = ref<SpaceTab>('schemas')
const SPACE_TABS = computed(() => [
  { label: t('shell.status.space.tabs.schemas'), value: 'schemas', icon: 'i-lucide-database' },
  { label: t('shell.status.space.tabs.totalbase'), value: 'totalbase', icon: 'i-lucide-box' }
])
const SPACE_SLICES = 5
const spaceItems = computed(() => {
  const space = data.value?.system.space
  if (!space) return []
  const all = spaceTab.value === 'schemas'
    ? space.schemas.map(s => ({ name: s.schema, value: s.bytes }))
    : space.totalbase.map(s => ({ name: s.table, value: s.bytes }))
  const shown = all.slice(0, SPACE_SLICES)
  const rest = all.slice(SPACE_SLICES).reduce((sum, s) => sum + s.value, 0)
  const palette = [colors.value.primary, colors.value.secondary, colors.value.success, colors.value.warning, colors.value.error, colors.value.textMuted]
  return [...shown, ...(rest > 0 ? [{ name: t('shell.status.space.other'), value: rest }] : [])]
    .filter(s => s.value > 0)
    .map((s, i) => ({ ...s, color: palette[i]! }))
})

// --- System ---
function formatAge(seconds: number | null): string {
  if (seconds === null) return t('shell.status.age.noneWaiting')
  if (seconds < 60) return t('shell.status.age.underMinute')
  if (seconds < 3600) return t('shell.status.age.minutes', { n: Math.round(seconds / 60) })
  return t('shell.status.age.hours', { n: Math.round(seconds / 3600) })
}
</script>

<template>
  <PageShell>
    <template #header>
      <PageHeader
        :title="t('shell.status.title')"
        :description="t('shell.status.description')"
        icon="i-lucide-activity"
        :actions="[{ label: t('common.refresh'), icon: 'i-lucide-refresh-cw', iconOnly: true, loading: pending, onSelect: () => refresh() }]"
      />
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
      <!-- Needs attention - a single line when there's nothing. -->
      <section class="flex flex-col gap-3">
        <h2 class="text-base font-semibold text-highlighted">
          {{ t('shell.status.needsAttention') }}
        </h2>
        <div
          v-if="attention.length === 0"
          class="flex items-center gap-2 rounded-lg border border-default px-4 py-3 text-sm"
        >
          <UIcon
            name="i-lucide-circle-check"
            class="size-4 text-success"
          />
          <span>{{ t('shell.status.allClear') }}</span>
        </div>
        <div
          v-else
          class="flex flex-1 flex-col divide-y divide-default rounded-lg border border-default"
        >
          <component
            :is="item.to ? NuxtLink : 'div'"
            v-for="item in attention"
            :key="item.key"
            :to="item.to"
            class="flex items-center gap-3 px-4 py-3 text-sm"
            :class="item.to ? 'hover:bg-elevated/50' : undefined"
          >
            <UIcon
              :name="item.icon"
              class="size-4 shrink-0"
              :class="SEVERITY_TONE[item.severity]"
            />
            <span class="flex-1 text-highlighted">{{ item.text }}</span>
            <UIcon
              v-if="item.to"
              name="i-lucide-chevron-right"
              class="size-4 text-dimmed"
            />
          </component>
        </div>
      </section>

      <!-- Headline counts -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
          <div class="min-w-0">
            <p class="text-2xl font-semibold text-highlighted tabular-nums">
              {{ kpi.value }}
            </p>
            <p class="text-sm text-highlighted">
              {{ kpi.label }}
            </p>
            <p class="truncate text-xs text-muted">
              {{ kpi.hint }}
            </p>
          </div>
        </NuxtLink>
      </div>

      <!-- Activity -->
      <section class="flex flex-col gap-3">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 class="text-base font-semibold text-highlighted">
              {{ t('shell.status.activity.title') }}
            </h2>
            <p class="text-xs text-muted">
              {{ t('shell.status.activity.description', { timeZone }) }}
            </p>
          </div>
          <UButton
            :label="t('shell.status.activity.insights')"
            icon="i-lucide-chart-column"
            color="neutral"
            variant="outline"
            size="sm"
            to="/users/insights/activity"
          />
        </div>
        <div class="rounded-lg border border-default px-4 pt-4 pb-2">
          <DashboardActivityAreaChart
            v-if="activitySeries.length"
            :days="data.activity.days.map(d => d.day)"
            :series="activitySeries"
            bars
            @select-day="openDay"
          />
          <p
            v-else
            class="py-12 text-center text-sm text-muted"
          >
            {{ t('shell.status.activity.empty') }}
          </p>
        </div>
      </section>

      <div class="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <!-- Is anything going wrong -->
        <section class="flex flex-col gap-3">
          <div>
            <h2 class="text-base font-semibold text-highlighted">
              {{ t('shell.status.trends.title') }}
            </h2>
            <p class="text-xs text-muted">
              {{ t('shell.status.trends.description') }}
            </p>
          </div>
          <div class="flex-1 rounded-lg border border-default px-4 pt-2 pb-2">
            <UTabs
              v-model="trendTab"
              :items="TREND_TABS"
              variant="link"
              size="sm"
              :content="false"
            />
            <!-- A sibling, not UTabs' own panel: ECharts measures a panel mid-transition as 0x0 and stays blank. -->
            <DashboardActivityAreaChart
              v-if="!trendEmpty"
              :days="trendDays"
              :series="trendSeries"
              :stacked="false"
              lines
              class="pt-2"
              @select-day="openTrend"
            />
            <p
              v-else
              class="py-12 text-center text-sm text-muted"
            >
              {{ trendTab === 'problems' ? t('shell.status.trends.noProblems') : t('shell.status.trends.noRuns') }}
            </p>
          </div>
        </section>

        <!-- What takes the database's space -->
        <section class="flex flex-col gap-3">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 class="text-base font-semibold text-highlighted">
                {{ t('shell.status.space.title') }}
              </h2>
              <p class="text-xs text-muted">
                {{ t('shell.status.space.description') }}
              </p>
            </div>
            <UButton
              :label="t('shell.status.space.maintenance')"
              icon="i-lucide-wrench"
              color="neutral"
              variant="outline"
              size="sm"
              to="/settings/maintenance"
            />
          </div>
          <div class="flex-1 rounded-lg border border-default px-4 pt-2 pb-2">
            <UTabs
              v-model="spaceTab"
              :items="SPACE_TABS"
              variant="link"
              size="sm"
              :content="false"
            />
            <DashboardDonutChart
              v-if="spaceItems.length"
              :items="spaceItems"
              :format="formatBytes"
              :height="256"
              class="pt-2"
            />
            <p
              v-else
              class="py-12 text-center text-sm text-muted"
            >
              {{ t('shell.status.space.empty') }}
            </p>
          </div>
        </section>

        <!-- Busiest resources -->
        <section class="flex flex-col gap-3">
          <h2 class="text-base font-semibold text-highlighted">
            {{ t('shell.status.busiest.title') }}
          </h2>
          <div
            v-if="data.topResources.length"
            class="flex flex-col divide-y divide-default rounded-lg border border-default"
          >
            <NuxtLink
              v-for="r in data.topResources"
              :key="r.id"
              :to="`/resources/${r.id}`"
              class="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-elevated/50"
            >
              <ResourceTypeIcon :type="r.type as ResourceType" />
              <span class="flex-1 truncate font-mono">{{ r.schema }}.{{ r.name }}</span>
              <span class="text-muted tabular-nums">{{ numberFormat.format(r.count) }}</span>
            </NuxtLink>
          </div>
          <p
            v-else
            class="flex-1 rounded-lg border border-default px-4 py-3 text-sm text-muted"
          >
            {{ t('shell.status.busiest.empty') }}
          </p>
        </section>

        <!-- System -->
        <section class="flex flex-col gap-3">
          <h2 class="text-base font-semibold text-highlighted">
            {{ t('shell.status.system.title') }}
          </h2>
          <dl class="grid flex-1 grid-cols-[12rem_1fr] content-start gap-x-4 gap-y-3 rounded-lg border border-default px-4 py-3 text-sm">
            <dt class="text-muted">
              PostgreSQL
            </dt>
            <dd>{{ data.system.postgres.version }} · {{ data.system.postgres.database }}</dd>
            <dt class="text-muted">
              {{ t('shell.status.system.databaseSize') }}
            </dt>
            <dd>
              <NuxtLink
                to="/settings/maintenance"
                class="hover:underline"
              >
                {{ formatBytes(data.system.postgres.sizeBytes) }}
              </NuxtLink>
            </dd>
            <dt class="text-muted">
              {{ t('shell.status.system.connections') }}
            </dt>
            <dd>{{ t('shell.status.system.connectionsValue', { n: data.system.postgres.connections, max: data.system.postgres.maxConnections }) }}</dd>
            <dt class="text-muted">
              {{ t('shell.status.system.pool') }}
            </dt>
            <dd :class="data.system.pool.waiting > 0 ? 'text-warning' : undefined">
              {{ t('shell.status.system.poolValue', { total: data.system.pool.total, max: data.system.pool.max, idle: data.system.pool.idle }) }}<template v-if="data.system.pool.waiting > 0">
                · {{ t('shell.status.system.poolWaiting', { n: data.system.pool.waiting }) }}
              </template>
            </dd>
            <dt class="text-muted">
              {{ t('shell.status.system.activeSessions') }}
            </dt>
            <dd>
              <NuxtLink
                to="/sessions"
                class="hover:underline"
              >
                {{ numberFormat.format(data.system.sessionsActive) }}
              </NuxtLink>
            </dd>
            <!-- Where the master key comes from (Specification.md §15) - never the key. A file must be backed up apart from the database. -->
            <dt class="text-muted">
              {{ t('shell.status.system.masterKey') }}
            </dt>
            <dd>
              <template v-if="data.system.masterKey.source === 'ENV'">
                {{ t('shell.status.system.masterKeyEnv') }}
              </template>
              <template v-else>
                <span class="font-mono text-xs">{{ data.system.masterKey.path }}</span>
                <p class="flex items-start gap-1 text-xs text-warning">
                  <UIcon
                    name="i-lucide-triangle-alert"
                    class="mt-0.5 size-3.5 shrink-0"
                  />
                  {{ t('shell.status.system.masterKeyFile') }}
                </p>
              </template>
            </dd>
            <dt class="text-muted">
              {{ t('shell.status.system.eventsWaiting') }}
            </dt>
            <dd>
              {{ numberFormat.format(data.system.outbox.pending) }}<template v-if="data.system.outbox.pending > 0">
                · {{ t('shell.status.system.oldest', { age: formatAge(data.system.outbox.oldestPendingSeconds) }) }}
              </template>
            </dd>
          </dl>
        </section>
      </div>
    </div>
  </PageShell>
</template>
