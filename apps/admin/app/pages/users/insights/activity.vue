<script setup lang="ts">
/**
 * Users → Insights → Activity: what's being done through TotalBase, for
 * everyone or one user (`?user=` - their own entries plus those made
 * through their API tokens). Per day by category, when work happens (day ×
 * hour), data changes by kind, where it comes from, who is most active,
 * what fails, how many rows leave by Export / Print, the most touched
 * resources and most frequent actions - all counted by PostgreSQL (GET
 * /audit/insights/activity) in the viewer's time zone - and the latest
 * entries, drawn like the Logs page. Period and user live in the URL.
 */
import { getTimezoneOffset } from 'date-fns-tz'
// Absolute dates/times in the user's zone and format (My account > Preferences).
const dates = useDateTimeFormat()

const api = useAdminApi()
const route = useRoute()
const router = useRouter()
const { colors } = useChartTheme()
const { resources } = useResourcesList()
const { t } = useI18n()
const ui = useUiLocale()

interface ActivityInsights {
  timeZone: string
  totals: { actions: number, writes: number, denied: number, failed: number }
  perDay: Array<{ day: string, data: number, access: number, sql: number, bulk: number, other: number }>
  writesPerDay: Array<{ day: string, create: number, update: number, delete: number }>
  heatmap: number[][]
  bySource: Array<{ source: string, count: number }>
  topUsers: Array<{ user: string, count: number }>
  failures: Array<{ code: string, count: number, sample: string | null }>
  dataOut: Array<{ resource: string | null, exported: number, imported: number, printed: number, operations: number }>
  topResources: Array<{ resource: string, count: number }>
  topActions: Array<{ action: string, count: number }>
}

const PERIOD_DAYS = [7, 30, 90]
const PERIODS = computed(() => PERIOD_DAYS.map(value => ({ label: t('users.insights.lastDays', { n: value }), value })))
const days = computed<number>({
  get: () => PERIOD_DAYS.find(value => String(value) === route.query.days) ?? 30,
  set: value => router.replace({ query: { ...route.query, days: value === 30 ? undefined : String(value) } })
})
const user = computed<string | null>({
  get: () => typeof route.query.user === 'string' && route.query.user ? route.query.user : null,
  set: value => router.replace({ query: { ...route.query, user: value ?? undefined } })
})
// The viewer's zone (My account > Preferences, else the instance's, else
// the browser's), plus its current offset in case PostgreSQL doesn't know
// the name (browsers report legacy aliases like America/Buenos_Aires).
const timeZone = dates.timezone.value ?? Intl.DateTimeFormat().resolvedOptions().timeZone
const offset = Math.round(getTimezoneOffset(timeZone, new Date()) / 60000)

const { data, pending, error, refresh } = await useAsyncData(
  'insights-activity',
  () => api.get<ActivityInsights>('/audit/insights/activity', { days: days.value, tz: timeZone, offset, ...(user.value && { user: user.value }) }).then(r => r.data),
  { watch: [days, user] }
)

// The latest entries - the audit log's own grid, for this user (their
// session actions; token entries are in the charts above).
const latestQuery = computed(() => ({ principal: user.value || undefined }))
const latest = useTemplateRef('latest')

const numberFormat = computed(() => new Intl.NumberFormat(ui.intlLocale.value))
const kpis = computed(() => [
  { label: t('users.insights.activity.kpi.actions'), value: data.value?.totals.actions ?? 0, icon: 'i-lucide-activity', tone: 'text-primary' },
  { label: t('users.insights.activity.kpi.writes'), value: data.value?.totals.writes ?? 0, icon: 'i-lucide-pencil', tone: 'text-success' },
  { label: t('users.insights.activity.kpi.denied'), value: data.value?.totals.denied ?? 0, icon: 'i-lucide-shield-x', tone: 'text-warning' },
  { label: t('users.insights.activity.kpi.failed'), value: data.value?.totals.failed ?? 0, icon: 'i-lucide-circle-x', tone: 'text-error' }
])

const CATEGORIES = ['data', 'access', 'sql', 'bulk', 'other'] as const
const perDaySeries = computed(() => {
  const palette = [colors.value.primary, colors.value.warning, colors.value.secondary, colors.value.success, colors.value.textMuted]
  return CATEGORIES
    .map((key, i) => ({ name: t(`users.insights.activity.categories.${key}`), data: data.value?.perDay.map(d => d[key]) ?? [], color: palette[i]! }))
    .filter(s => s.data.some(v => v > 0))
})

const resourceName = (id: string) => {
  const r = resources.value.find(x => x.id === id)
  return r ? `${r.schema}.${r.name}` : id.slice(0, 8)
}
const resourceItems = computed(() => (data.value?.topResources ?? []).map(r => ({ name: resourceName(r.resource), value: r.count })))
const actionItems = computed(() => (data.value?.topActions ?? []).map(a => ({ name: a.action, value: a.count })))

// --- When work happens: day × hour, Monday first, in the viewer's language.
const WEEKDAYS = computed(() => Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(ui.languageTag.value, { weekday: 'short' })))
const WEEKDAYS_LONG = computed(() => Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(ui.languageTag.value, { weekday: 'long' })))
const busiestSlot = computed(() => {
  let best: { day: number, hour: number, count: number } | null = null
  data.value?.heatmap.forEach((hours, day) => hours.forEach((count, hour) => {
    if (count > 0 && (!best || count > best.count)) best = { day, hour, count }
  }))
  const slot = best as { day: number, hour: number, count: number } | null
  return slot ? `${WEEKDAYS_LONG.value[slot.day]} ${String(slot.hour).padStart(2, '0')}:00` : null
})

// --- Data changes by kind.
const writesSeries = computed(() => [
  { name: t('users.insights.activity.writes.create'), data: data.value?.writesPerDay.map(d => d.create) ?? [], color: colors.value.success },
  { name: t('users.insights.activity.writes.update'), data: data.value?.writesPerDay.map(d => d.update) ?? [], color: colors.value.primary },
  { name: t('users.insights.activity.writes.delete'), data: data.value?.writesPerDay.map(d => d.delete) ?? [], color: colors.value.error }
])
const hasWrites = computed(() => (data.value?.totals.writes ?? 0) > 0)

// --- Where it comes from.
const SOURCES = ['admin', 'api', 'auth', 'workflow']
const sourceItems = computed(() => {
  const palette = [colors.value.primary, colors.value.success, colors.value.warning, colors.value.secondary, colors.value.textMuted]
  return (data.value?.bySource ?? []).map((s, i) => ({ name: SOURCES.includes(s.source) ? t(`users.insights.activity.sources.${s.source}`) : s.source, value: s.count, color: palette[i % palette.length]! }))
})

// --- Who: resolved through the shared user directory (tokens already
// folded into their owners by the server).
const directory = useUserDirectory()
watch(data, value => void directory.ensure(value?.topUsers.map(u => u.user) ?? []), { immediate: true })

// --- Data out: rows moved by Export / Import / Print. A large export is
// what a data leak looks like - flagged from this many rows.
const LARGE_EXPORT_ROWS = 1000

const logsLink = computed(() => ({
  path: '/logs',
  query: { ...(user.value && { principal: user.value }), range: days.value === 7 ? '7d' : days.value === 30 ? '30d' : 'all' }
}))

async function refreshAll() {
  await Promise.all([refresh(), latest.value?.refresh()])
}
</script>

<template>
  <PageShell>
    <template #header>
      <PageHeader
        icon="i-lucide-activity"
        :title="t('users.userEditor.tabs.activity')"
        :description="t('users.insights.activity.description', { zone: data?.timeZone ?? timeZone })"
        :actions="[{ label: t('common.refresh'), icon: 'i-lucide-refresh-cw', iconOnly: true, loading: pending, onSelect: refreshAll }]"
      />
    </template>
    <!-- Who and when (AGENTS.md section 25: filters in the toolbar). -->
    <template #toolbar>
      <div class="flex flex-wrap items-center gap-3">
        <div class="flex w-72 max-w-full items-center gap-1">
          <UserPicker
            v-model="user"
            class="flex-1"
          />
          <UTooltip
            v-if="user"
            :text="t('users.insights.activity.everyone')"
          >
            <UButton
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              square
              :aria-label="t('users.insights.activity.showEveryone')"
              @click="user = null"
            />
          </UTooltip>
        </div>
        <USelect
          v-model="days"
          :items="PERIODS"
          :aria-label="t('users.insights.period')"
          class="w-40"
        />
      </div>
    </template>

    <div class="flex flex-col gap-4">
      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        :title="error.message"
      />

      <p
        v-if="!user"
        class="text-sm text-muted"
      >
        {{ t('users.insights.activity.intro') }}
      </p>

      <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <UCard
          v-for="kpi in kpis"
          :key="kpi.label"
        >
          <div class="flex items-center gap-3">
            <UIcon
              :name="kpi.icon"
              class="size-6"
              :class="kpi.tone"
            />
            <div>
              <p class="text-2xl font-semibold tabular-nums">
                {{ numberFormat.format(kpi.value) }}
              </p>
              <p class="text-sm text-muted">
                {{ kpi.label }}
              </p>
            </div>
          </div>
        </UCard>
      </div>

      <UCard>
        <template #header>
          <h2 class="font-medium">
            {{ t('users.insights.activity.perDay') }}
          </h2>
        </template>
        <DashboardActivityAreaChart
          v-if="data && perDaySeries.length"
          :days="data.perDay.map(d => d.day)"
          :series="perDaySeries"
        />
        <UEmpty
          v-else-if="data"
          variant="naked"
          size="xs"
          icon="i-lucide-calendar-range"
          :title="t('users.insights.activity.noActivity')"
        />
      </UCard>

      <UCard>
        <template #header>
          <div class="flex items-baseline justify-between gap-2">
            <h2 class="font-medium">
              {{ t('users.insights.activity.when') }}
            </h2>
            <span
              v-if="busiestSlot"
              class="text-xs text-muted"
            ><i18n-t keypath="users.insights.busiest"><template #value><strong class="text-highlighted">{{ busiestSlot }}</strong></template></i18n-t></span>
          </div>
        </template>
        <DashboardHeatmapChart
          v-if="data && data.totals.actions > 0"
          :values="data.heatmap"
          :days="WEEKDAYS"
          :name="t('users.insights.activity.kpi.actions')"
        />
        <UEmpty
          v-else-if="data"
          variant="naked"
          size="xs"
          icon="i-lucide-calendar-range"
          :title="t('users.insights.activity.noActivity')"
        />
      </UCard>

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <UCard>
          <template #header>
            <h2 class="font-medium">
              {{ t('users.insights.activity.writesByType') }}
            </h2>
          </template>
          <DashboardActivityAreaChart
            v-if="data && hasWrites"
            :days="data.writesPerDay.map(d => d.day)"
            :series="writesSeries"
          />
          <UEmpty
            v-else-if="data"
            variant="naked"
            size="xs"
            icon="i-lucide-calendar-range"
            :title="t('users.insights.activity.noWrites')"
          />
        </UCard>
        <UCard>
          <template #header>
            <h2 class="font-medium">
              {{ t('users.insights.activity.whereFrom') }}
            </h2>
          </template>
          <DashboardDonutChart
            v-if="sourceItems.length"
            :items="sourceItems"
          />
          <UEmpty
            v-else-if="data"
            variant="naked"
            size="xs"
            icon="i-lucide-calendar-range"
            :title="t('users.insights.activity.noActivity')"
          />
        </UCard>
      </div>

      <div
        class="grid grid-cols-1 gap-4"
        :class="user ? undefined : 'lg:grid-cols-2'"
      >
        <UCard v-if="!user">
          <template #header>
            <h2 class="font-medium">
              {{ t('users.insights.activity.mostActive') }}
            </h2>
          </template>
          <div
            v-if="data?.topUsers.length"
            class="flex flex-col divide-y divide-default"
          >
            <NuxtLink
              v-for="u in data.topUsers"
              :key="u.user"
              :to="{ query: { ...route.query, user: u.user } }"
              class="flex items-center gap-3 py-2 text-sm hover:text-primary"
            >
              <UAvatar
                :src="directory.avatar(u.user) ?? undefined"
                :alt="directory.label(u.user)"
                size="xs"
              />
              <span class="min-w-0 flex-1 truncate">{{ directory.label(u.user) }}</span>
              <span class="tabular-nums text-muted">{{ numberFormat.format(u.count) }}</span>
            </NuxtLink>
          </div>
          <UEmpty
            v-else-if="data"
            variant="naked"
            size="xs"
            icon="i-lucide-calendar-range"
            :title="t('users.insights.activity.noActivity')"
          />
        </UCard>
        <UCard>
          <template #header>
            <h2 class="font-medium">
              {{ t('users.insights.activity.failing') }}
            </h2>
          </template>
          <div
            v-if="data?.failures.length"
            class="flex flex-col divide-y divide-default"
          >
            <div
              v-for="f in data.failures"
              :key="f.code"
              class="flex items-start gap-3 py-2 text-sm"
            >
              <div class="flex min-w-0 flex-1 flex-col">
                <span class="font-mono text-xs text-highlighted">{{ f.code }}</span>
                <span
                  v-if="f.sample"
                  class="truncate text-xs text-muted"
                  :title="f.sample"
                >{{ f.sample }}</span>
              </div>
              <span class="tabular-nums text-error">{{ numberFormat.format(f.count) }}</span>
            </div>
          </div>
          <UEmpty
            v-else-if="data"
            variant="naked"
            size="xs"
            icon="i-lucide-calendar-range"
            :title="t('users.insights.activity.noFailures')"
          />
        </UCard>
      </div>

      <UCard :ui="{ body: 'p-0 sm:p-0' }">
        <template #header>
          <div class="flex flex-col">
            <h2 class="font-medium">
              {{ t('users.insights.activity.dataOut') }}
            </h2>
            <span class="text-xs text-muted">{{ t('users.insights.activity.dataOutHelp') }}</span>
          </div>
        </template>
        <UTable
          sticky
          :data="data?.dataOut ?? []"
          :columns="[
            { accessorKey: 'resource', header: t('users.roleEditor.resource') },
            { accessorKey: 'exported', header: t('users.insights.activity.exported') },
            { accessorKey: 'printed', header: t('users.insights.activity.printed') },
            { accessorKey: 'imported', header: t('users.insights.activity.imported') },
            { accessorKey: 'operations', header: t('users.insights.activity.operations') }
          ]"
        >
          <template #empty>
            <UEmpty
              variant="naked"
              size="sm"
              icon="i-lucide-download"
              :title="t('users.insights.activity.noDataOut')"
            />
          </template>
          <template #resource-cell="{ row }">
            <span
              v-if="row.original.resource"
              class="font-mono text-xs"
            >{{ resourceName(row.original.resource) }}</span>
            <span
              v-else
              class="text-xs text-muted"
            >{{ t('users.insights.activity.deletedResource') }}</span>
          </template>
          <template #exported-cell="{ row }">
            <span class="inline-flex items-center gap-2 tabular-nums">
              {{ numberFormat.format(row.original.exported) }}
              <UBadge
                v-if="row.original.exported >= LARGE_EXPORT_ROWS"
                :label="t('users.insights.activity.large')"
                color="warning"
                variant="subtle"
                size="sm"
              />
            </span>
          </template>
          <template #printed-cell="{ row }">
            <span class="tabular-nums">{{ numberFormat.format(row.original.printed) }}</span>
          </template>
          <template #imported-cell="{ row }">
            <span class="tabular-nums text-muted">{{ numberFormat.format(row.original.imported) }}</span>
          </template>
          <template #operations-cell="{ row }">
            <span class="tabular-nums text-muted">{{ numberFormat.format(row.original.operations) }}</span>
          </template>
        </UTable>
      </UCard>

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <UCard>
          <template #header>
            <h2 class="font-medium">
              {{ t('users.insights.activity.topResources') }}
            </h2>
          </template>
          <DashboardHorizontalBarChart
            v-if="resourceItems.length"
            :items="resourceItems"
          />
          <UEmpty
            v-else-if="data"
            variant="naked"
            size="xs"
            icon="i-lucide-calendar-range"
            :title="t('users.insights.activity.noResources')"
          />
        </UCard>
        <UCard>
          <template #header>
            <h2 class="font-medium">
              {{ t('users.insights.activity.topActions') }}
            </h2>
          </template>
          <DashboardHorizontalBarChart
            v-if="actionItems.length"
            :items="actionItems"
            :color="colors.secondary"
          />
          <UEmpty
            v-else-if="data"
            variant="naked"
            size="xs"
            icon="i-lucide-calendar-range"
            :title="t('users.insights.activity.noActivity')"
          />
        </UCard>
      </div>

      <UCard :ui="{ body: 'p-0 sm:p-0' }">
        <template #header>
          <div class="flex items-center justify-between gap-2">
            <h2 class="font-medium">
              {{ t('users.insights.activity.latest') }}
            </h2>
            <UButton
              :label="t('users.activity.openInLogs')"
              icon="i-lucide-scroll-text"
              color="neutral"
              variant="ghost"
              size="sm"
              :to="logsLink"
            />
          </div>
        </template>
        <AuditLogGrid
          ref="latest"
          embedded
          :limit="10"
          :query="latestQuery"
          :empty-title="t('users.insights.activity.noEntries')"
        />
      </UCard>
    </div>
  </PageShell>
</template>
