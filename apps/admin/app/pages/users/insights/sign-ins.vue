<script setup lang="ts">
/**
 * Users → Insights → Sign-ins: how people sign in - per day, which day of
 * the week and hour of the day are busiest, why attempts fail, from which
 * browsers, who signs in (and fails) most. Every count comes from
 * PostgreSQL (GET /audit/insights/sign-ins), grouped in the viewer's own
 * time zone; this page only draws it. The period lives in the URL.
 */
import { getTimezoneOffset } from 'date-fns-tz'
// Absolute dates/times in the user's zone and format (My account > Preferences).
const dates = useDateTimeFormat()
const api = useAdminApi()
const route = useRoute()
const router = useRouter()
const directory = useUserDirectory()
const { colors } = useChartTheme()
const { t } = useI18n()
const ui = useUiLocale()
// Resolved explicitly - `:is` needs the component itself, not its tag name.
const NuxtLink = resolveComponent('NuxtLink')

interface SignInInsights {
  timeZone: string
  totals: { succeeded: number, failed: number }
  perDay: Array<{ day: string, succeeded: number, failed: number }>
  byWeekday: number[]
  byHour: number[]
  failuresByReason: Array<{ reason: string, count: number }>
  topUsers: Array<{ user: string, count: number }>
  topFailures: Array<{ user: string | null, email: string | null, count: number }>
  recentFailures: Array<{ at: string, email: string | null, user: string | null, reason: string | null, ip: string | null, event: string }>
  lockedNow: number
  activeSessions: number
  userAgents: Array<{ userAgent: string | null, count: number }>
}

const PERIOD_DAYS = [7, 30, 90]
const PERIODS = computed(() => PERIOD_DAYS.map(value => ({ label: t('users.insights.lastDays', { n: value }), value })))
const days = computed<number>({
  get: () => PERIOD_DAYS.find(value => String(value) === route.query.days) ?? 30,
  set: value => router.replace({ query: { ...route.query, days: value === 30 ? undefined : String(value) } })
})
// The viewer's zone (My account > Preferences, else the instance's, else
// the browser's), plus its current offset in case PostgreSQL doesn't know
// the name (browsers report legacy aliases like America/Buenos_Aires).
const timeZone = dates.timezone.value ?? Intl.DateTimeFormat().resolvedOptions().timeZone
const offset = Math.round(getTimezoneOffset(timeZone, new Date()) / 60000)

const { data, pending, error, refresh } = await useAsyncData(
  'insights-sign-ins',
  () => api.get<SignInInsights>('/audit/insights/sign-ins', { days: days.value, tz: timeZone, offset }).then(r => r.data),
  { watch: [days] }
)

watch(data, (value) => {
  if (!value) return
  void directory.ensure([...value.topUsers.map(u => u.user), ...value.topFailures.map(f => f.user), ...value.recentFailures.map(f => f.user)])
}, { immediate: true })

const numberFormat = computed(() => new Intl.NumberFormat(ui.intlLocale.value))
const kpis = computed(() => [
  { label: t('users.insights.signIns.kpi.succeeded'), value: data.value?.totals.succeeded ?? 0, icon: 'i-lucide-log-in', tone: 'text-success' },
  { label: t('users.insights.signIns.kpi.failed'), value: data.value?.totals.failed ?? 0, icon: 'i-lucide-shield-x', tone: 'text-error' },
  { label: t('users.insights.signIns.kpi.locked'), value: data.value?.lockedNow ?? 0, icon: 'i-lucide-lock', tone: 'text-warning' },
  { label: t('users.insights.signIns.kpi.sessions'), value: data.value?.activeSessions ?? 0, icon: 'i-lucide-monitor-smartphone', tone: 'text-primary' }
])

const perDaySeries = computed(() => [
  { name: t('users.insights.signIns.successful'), data: data.value?.perDay.map(d => d.succeeded) ?? [], color: colors.value.success },
  { name: t('users.insights.signIns.failed'), data: data.value?.perDay.map(d => d.failed) ?? [], color: colors.value.error }
])

// Monday first (ISO), in the viewer's language - 2024-01-01 was a Monday.
const WEEKDAYS = computed(() => Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(ui.languageTag.value, { weekday: 'short' })))
const WEEKDAYS_LONG = computed(() => Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(ui.languageTag.value, { weekday: 'long' })))
const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'))

function busiest(values: number[] | undefined): number | null {
  if (!values?.length || Math.max(...values) === 0) return null
  return values.indexOf(Math.max(...values))
}
const busiestWeekday = computed(() => {
  const i = busiest(data.value?.byWeekday)
  return i === null ? null : WEEKDAYS_LONG.value[i]
})
const busiestHour = computed(() => {
  const h = busiest(data.value?.byHour)
  return h === null ? null : `${HOURS[h]}:00–${HOURS[(h + 1) % 24]}:00`
})

const REASONS = ['wrong_password', 'locked', 'unknown_email', 'no_password', 'inactive', 'cannot_login', 'no_portal_access', 'no_api_access', 'other']
const reasonLabel = (reason: string | null) => {
  const key = reason ?? 'other'
  return REASONS.includes(key) ? t(`users.insights.signIns.reasons.${key}`) : key
}
const reasonItems = computed(() => {
  const palette = [colors.value.warning, colors.value.error, colors.value.secondary, colors.value.primary, colors.value.textMuted, colors.value.success]
  return (data.value?.failuresByReason ?? []).map((r, i) => ({ name: reasonLabel(r.reason), value: r.count, color: palette[i % palette.length]! }))
})

// Browsers and systems, named from each session's user agent.
const deviceItems = computed(() => {
  const byLabel = new Map<string, number>()
  for (const ua of data.value?.userAgents ?? []) {
    const label = describeUserAgent(ua.userAgent, t).label
    byLabel.set(label, (byLabel.get(label) ?? 0) + ua.count)
  }
  return [...byLabel.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 8)
})

const failuresLink = computed(() => ({
  path: '/logs',
  query: { event: 'auth.login,auth.portal_login,auth.oauth_login,auth.mfa_verify,auth.portal_mfa_verify', status: 'DENIED', range: days.value === 7 ? '7d' : days.value === 30 ? '30d' : 'all' }
}))

const recentColumns = computed(() => [
  { accessorKey: 'at', header: t('users.insights.signIns.when') },
  { id: 'account', header: t('users.insights.signIns.account') },
  { accessorKey: 'reason', header: t('users.insights.signIns.reason') },
  { accessorKey: 'ip', header: 'IP' }
])
</script>

<template>
  <PageShell>
    <template #header>
      <PageHeader
        icon="i-lucide-log-in"
        :title="t('users.usersPanel.signIns')"
        :description="t('users.insights.signIns.description', { zone: data?.timeZone ?? timeZone })"
        :actions="[{ label: t('common.refresh'), icon: 'i-lucide-refresh-cw', iconOnly: true, loading: pending, onSelect: () => refresh() }]"
      />
    </template>
    <!-- The period filter (AGENTS.md section 25: filters in the toolbar). -->
    <template #toolbar>
      <USelect
        v-model="days"
        :items="PERIODS"
        :aria-label="t('users.insights.period')"
        class="w-40"
      />
    </template>

    <div class="flex flex-col gap-4">
      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        :title="error.message"
      />

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
            {{ t('users.insights.signIns.perDay') }}
          </h2>
        </template>
        <DashboardActivityAreaChart
          v-if="data"
          :days="data.perDay.map(d => d.day)"
          :series="perDaySeries"
          :stacked="false"
        />
      </UCard>

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <UCard>
          <template #header>
            <div class="flex items-baseline justify-between gap-2">
              <h2 class="font-medium">
                {{ t('users.insights.byWeekday') }}
              </h2>
              <span
                v-if="busiestWeekday"
                class="text-xs text-muted"
              ><i18n-t keypath="users.insights.busiest"><template #value><strong class="text-highlighted">{{ busiestWeekday }}</strong></template></i18n-t></span>
            </div>
          </template>
          <DashboardColumnChart
            v-if="data"
            :labels="WEEKDAYS"
            :values="data.byWeekday"
            :name="t('users.usersPanel.signIns')"
          />
        </UCard>
        <UCard>
          <template #header>
            <div class="flex items-baseline justify-between gap-2">
              <h2 class="font-medium">
                {{ t('users.insights.byHour') }}
              </h2>
              <span
                v-if="busiestHour"
                class="text-xs text-muted"
              ><i18n-t keypath="users.insights.busiest"><template #value><strong class="text-highlighted">{{ busiestHour }}</strong></template></i18n-t></span>
            </div>
          </template>
          <DashboardColumnChart
            v-if="data"
            :labels="HOURS"
            :values="data.byHour"
            :name="t('users.usersPanel.signIns')"
          />
        </UCard>
      </div>

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <UCard>
          <template #header>
            <h2 class="font-medium">
              {{ t('users.insights.signIns.whyFailed') }}
            </h2>
          </template>
          <DashboardDonutChart
            v-if="reasonItems.length"
            :items="reasonItems"
          />
          <UEmpty
            v-else-if="data"
            variant="naked"
            size="xs"
            icon="i-lucide-calendar-range"
            :title="t('users.insights.signIns.noFailures')"
          />
        </UCard>
        <UCard>
          <template #header>
            <h2 class="font-medium">
              {{ t('users.insights.signIns.devices') }}
            </h2>
          </template>
          <DashboardHorizontalBarChart
            v-if="deviceItems.length"
            :items="deviceItems"
          />
          <UEmpty
            v-else-if="data"
            variant="naked"
            size="xs"
            icon="i-lucide-calendar-range"
            :title="t('users.insights.signIns.noSessions')"
          />
        </UCard>
      </div>

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <UCard>
          <template #header>
            <h2 class="font-medium">
              {{ t('users.insights.signIns.mostSignIns') }}
            </h2>
          </template>
          <div
            v-if="data?.topUsers.length"
            class="flex flex-col divide-y divide-default"
          >
            <NuxtLink
              v-for="u in data.topUsers"
              :key="u.user"
              :to="`/users/${u.user}`"
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
            :title="t('users.insights.signIns.noSignIns')"
          />
        </UCard>
        <UCard>
          <template #header>
            <h2 class="font-medium">
              {{ t('users.insights.signIns.mostFailures') }}
            </h2>
          </template>
          <div
            v-if="data?.topFailures.length"
            class="flex flex-col divide-y divide-default"
          >
            <component
              :is="f.user ? NuxtLink : 'div'"
              v-for="f in data.topFailures"
              :key="f.user ?? f.email ?? ''"
              :to="f.user ? `/users/${f.user}` : undefined"
              class="flex items-center gap-3 py-2 text-sm"
              :class="f.user ? 'hover:text-primary' : undefined"
            >
              <UAvatar
                :src="f.user ? directory.avatar(f.user) ?? undefined : undefined"
                :alt="f.user ? directory.label(f.user) : (f.email ?? '?')"
                size="xs"
              />
              <span class="min-w-0 flex-1 truncate">
                {{ f.user ? directory.label(f.user) : f.email }}
                <span
                  v-if="!f.user"
                  class="text-xs text-muted"
                >· {{ t('users.insights.signIns.noAccount') }}</span>
              </span>
              <span class="tabular-nums text-error">{{ numberFormat.format(f.count) }}</span>
            </component>
          </div>
          <UEmpty
            v-else-if="data"
            variant="naked"
            size="xs"
            icon="i-lucide-calendar-range"
            :title="t('users.insights.signIns.noFailures')"
          />
        </UCard>
      </div>

      <UCard :ui="{ body: 'p-0 sm:p-0' }">
        <template #header>
          <div class="flex items-center justify-between gap-2">
            <h2 class="font-medium">
              {{ t('users.insights.signIns.recentFailures') }}
            </h2>
            <UButton
              :label="t('users.insights.allInLogs')"
              icon="i-lucide-scroll-text"
              color="neutral"
              variant="ghost"
              size="sm"
              :to="failuresLink"
            />
          </div>
        </template>
        <UTable
          sticky
          :data="data?.recentFailures ?? []"
          :columns="recentColumns"
          :loading="pending"
        >
          <template #empty>
            <UEmpty
              variant="naked"
              size="sm"
              icon="i-lucide-log-in"
              :title="t('users.insights.signIns.noFailures')"
            />
          </template>
          <template #at-cell="{ row }">
            <span
              class="whitespace-nowrap text-muted"
              :title="dates.dateTime(row.original.at)"
            >{{ dates.dateTime(row.original.at, { dateStyle: 'medium', timeStyle: 'short' }) }}</span>
          </template>
          <template #account-cell="{ row }">
            <NuxtLink
              v-if="row.original.user"
              :to="`/users/${row.original.user}`"
              class="hover:underline"
            >{{ directory.label(row.original.user) }}</NuxtLink>
            <span v-else>{{ row.original.email ?? '—' }}</span>
          </template>
          <template #reason-cell="{ row }">
            <UBadge
              :label="reasonLabel(row.original.reason)"
              color="warning"
              variant="subtle"
              size="sm"
            />
          </template>
          <template #ip-cell="{ row }">
            <span class="font-mono text-xs text-muted">{{ row.original.ip ?? '—' }}</span>
          </template>
        </UTable>
      </UCard>
    </div>
  </PageShell>
</template>
