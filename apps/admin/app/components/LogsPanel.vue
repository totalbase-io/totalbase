<script setup lang="ts">
/**
 * The Logs rail group's own panel (layouts/default.vue's aside,
 * `activeGroupKey === 'logs'`): the audit log's advanced filters, the
 * same role UsersPanel.vue plays for the Users table. Everything it sets
 * lives in the route query (useLogsFilters), so pages/logs.vue just reads
 * it and a filtered view is a shareable URL.
 *
 * Counts come from GET /audit/logs/summary under the same filters, faceted:
 * each section ignores its own filter, so the alternatives stay visible.
 * A delegated user (Security.md §9) reads the log through
 * the Data API instead: the same filters, no counts and no security views -
 * those group entries by event name inside `metadata`, which the filter
 * grammar doesn't reach.
 */
import { CalendarDate, today, getLocalTimeZone } from '@internationalized/date'

const api = useAdminApi()
const { t } = useI18n()
const ui = useUiLocale()
const filters = useLogsFilters()
const session = useSession()
const isAdmin = computed(() => session.access.value === 'ADMIN')

interface LogsSummary {
  byStatus: Record<string, number>
  byPrincipalType: Record<string, number>
  byAction: Record<string, number>
}

// Keyed so pages/logs.vue's Refresh can refresh it too (refreshNuxtData).
const { data: summary } = useAsyncData(
  'audit-logs-summary',
  () => isAdmin.value ? api.get<LogsSummary>('/audit/logs/summary', filters.apiParams()).then(r => r.data) : Promise.resolve(null),
  { watch: [filters.key] }
)

const numberFormat = computed(() => new Intl.NumberFormat(ui.intlLocale.value))
function count(facet: keyof LogsSummary, ...keys: string[]): string {
  if (!summary.value) return ''
  return numberFormat.value.format(keys.reduce((sum, key) => sum + (summary.value![facet][key] ?? 0), 0))
}

const ITEM_CLASS = 'flex w-full min-w-0 items-center gap-2 rounded px-3 py-1.5 text-left text-sm hover:bg-elevated hover:text-highlighted'
function itemClass(active: boolean) {
  return [ITEM_CLASS, active ? 'bg-elevated text-highlighted' : 'text-default']
}

// --- Custom range: UCalendar in range mode. Its model is a pair of
// CalendarDates (@internationalized/date), not JS Dates - converted at
// this one seam, same as DataViewCalendar.vue's own jump picker.
const customOpen = ref(false)
const maxDate = today(getLocalTimeZone())

function toCalendarDate(d: Date) {
  return new CalendarDate(d.getFullYear(), d.getMonth() + 1, d.getDate())
}

// shallowRef: ref() would deep-unwrap the CalendarDate class type and
// no longer match UCalendar's DateRange.
const customValue = shallowRef<{ start: CalendarDate | undefined, end: CalendarDate | undefined }>({ start: undefined, end: undefined })

watch(customOpen, (open) => {
  if (!open) return
  customValue.value = filters.from.value && filters.to.value
    ? { start: toCalendarDate(filters.from.value), end: toCalendarDate(filters.to.value) }
    : { start: undefined, end: undefined }
})

async function applyCustomRange() {
  const { start, end } = customValue.value
  if (!start) return
  const tz = getLocalTimeZone()
  customOpen.value = false
  await navigateTo(filters.customRangeLink(start.toDate(tz), (end ?? start).toDate(tz)))
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <section>
      <div class="flex items-center pb-2">
        <span class="text-xs font-medium uppercase tracking-wide text-muted">{{ t('content.logs.panel.timeRange') }}</span>
      </div>
      <NuxtLink
        v-for="preset in LOGS_RANGE_PRESETS"
        :key="preset.value"
        :to="filters.rangeLink(preset.value)"
        :class="itemClass(filters.range.value === preset.value)"
      >
        <UIcon
          :name="preset.value === 'all' ? 'i-lucide-infinity' : 'i-lucide-clock'"
          class="size-4 shrink-0 text-muted"
        />
        <span class="truncate">{{ t(preset.labelKey) }}</span>
      </NuxtLink>
      <UPopover
        v-model:open="customOpen"
        :content="{ side: 'right', align: 'start' }"
      >
        <button
          type="button"
          :class="itemClass(filters.range.value === 'custom')"
        >
          <UIcon
            name="i-lucide-calendar-range"
            class="size-4 shrink-0 text-muted"
          />
          <span class="truncate">{{ filters.range.value === 'custom' ? filters.rangeLabel.value : t('content.logs.panel.customRange') }}</span>
        </button>
        <template #content>
          <div class="flex flex-col gap-3 p-3">
            <UCalendar
              v-model="customValue"
              range
              :number-of-months="2"
              :max-value="maxDate"
            />
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs text-muted">{{ t('content.logs.panel.customRangeHint') }}</span>
              <div class="flex gap-2">
                <UButton
                  :label="t('common.cancel')"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  @click="customOpen = false"
                />
                <UButton
                  :label="t('common.apply')"
                  size="sm"
                  :disabled="!customValue.start"
                  @click="applyCustomRange"
                />
              </div>
            </div>
          </div>
        </template>
      </UPopover>
    </section>

    <section>
      <div class="pb-2 text-xs font-medium uppercase tracking-wide text-muted">
        {{ t('common.status') }}
      </div>
      <NuxtLink
        v-for="status in LOGS_STATUSES"
        :key="status.value"
        :to="filters.toggle('status', status.value)"
        :class="itemClass(filters.status.value === status.value)"
      >
        <span
          class="size-2 mx-1 shrink-0 rounded-full"
          :class="status.dot"
        />
        <span class="truncate">{{ t(status.labelKey) }}</span>
        <span class="ms-auto text-xs text-muted tabular-nums">{{ count('byStatus', status.value) }}</span>
      </NuxtLink>
    </section>

    <section>
      <div class="pb-2 text-xs font-medium uppercase tracking-wide text-muted">
        {{ t('content.logs.panel.category') }}
      </div>
      <template
        v-for="category in LOGS_CATEGORIES"
        :key="category.key"
      >
        <NuxtLink
          :to="filters.categoryLink(category)"
          :class="itemClass(filters.categoryState(category) === 'all')"
        >
          <UIcon
            :name="category.icon"
            class="size-4 shrink-0 text-muted"
          />
          <span class="truncate">{{ t(category.labelKey) }}</span>
          <span class="ms-auto text-xs text-muted tabular-nums">{{ count('byAction', ...category.actions.map(a => a.value)) }}</span>
        </NuxtLink>
        <!-- A category's own actions, once it (or one of them) is picked -
        "just the deletes" without listing all eleven actions up front. -->
        <template v-if="category.actions.length > 1 && filters.categoryState(category) !== 'none'">
          <NuxtLink
            v-for="action in category.actions"
            :key="action.value"
            :to="filters.action.value === action.value ? filters.categoryLink(category) : filters.linkWith({ action: action.value, event: category.key === 'access' ? filters.event.value : undefined })"
            :class="[itemClass(filters.action.value === action.value), 'ps-7']"
          >
            <UIcon
              :name="action.icon"
              class="size-4 shrink-0 text-muted"
            />
            <span class="truncate">{{ t(action.labelKey) }}</span>
            <span class="ms-auto text-xs text-muted tabular-nums">{{ count('byAction', action.value) }}</span>
          </NuxtLink>
        </template>
      </template>
    </section>

    <section>
      <div class="pb-2 text-xs font-medium uppercase tracking-wide text-muted">
        {{ t('content.logs.panel.principal') }}
      </div>
      <NuxtLink
        v-for="principal in LOGS_PRINCIPAL_TYPES"
        :key="principal.value"
        :to="filters.toggle('principal_type', principal.value)"
        :class="itemClass(filters.principalType.value === principal.value)"
      >
        <UIcon
          :name="principal.icon"
          class="size-4 shrink-0 text-muted"
        />
        <span class="truncate">{{ t(principal.labelKey) }}</span>
        <span class="ms-auto text-xs text-muted tabular-nums">{{ count('byPrincipalType', principal.value) }}</span>
      </NuxtLink>
    </section>

    <section v-if="isAdmin">
      <div class="pb-2 text-xs font-medium uppercase tracking-wide text-muted">
        {{ t('content.logs.panel.securityViews') }}
      </div>
      <NuxtLink
        v-for="view in LOGS_SECURITY_VIEWS"
        :key="view.key"
        :to="filters.securityViewLink(view)"
        :class="itemClass(filters.securityView.value?.key === view.key)"
      >
        <UIcon
          :name="view.icon"
          class="size-4 shrink-0 text-muted"
        />
        <span class="truncate">{{ t(view.labelKey) }}</span>
      </NuxtLink>
    </section>
  </div>
</template>
