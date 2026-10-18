<script setup lang="ts">
/**
 * The audit log's one grid - the Logs page, a user's Activity tab,
 * Insights' latest entries and My account > Activity all show it; only
 * the query changes. It loads and pages the entries itself (useAuditLogs:
 * an administrator through the Admin API, anyone else through the Data
 * API under their grants), shows them in the cells of useAuditLogDisplay
 * and opens a row in AuditLogEntrySlideover.
 *
 * Its own PageShell, so a host passes its #header / #toolbar and gets the
 * pager in the footer; `embedded` lays it out inline (inside a card).
 * `own`: the viewer's own entries - no Who column (it is always them),
 * where they came from instead. `limit`: a fixed number of entries, no
 * pager. An entry's pivots open Logs filtered (`pivotLink`; by default
 * over all time) - only for a viewer who may open Logs.
 */
import { formatDistanceToNow } from 'date-fns'
import type { RouteLocationRaw } from 'vue-router'
import type { AuditLog } from '~/types/audit'
import type { AuditLogPivot } from '~/components/AuditLogEntrySlideover.vue'
import type { AuditLogQuery } from '~/composables/useAuditLogs'
import { describeUserAgent } from '~/utils/user-agent'
import { useApiErrorMessage } from '~/utils/api-error-message'

const props = withDefaults(defineProps<{
  query: AuditLogQuery
  own?: boolean
  limit?: number
  embedded?: boolean
  emptyTitle?: string
  /** Where an entry's pivot goes; default: Logs over all time, filtered by it. */
  pivotLink?: (patch: AuditLogPivot) => RouteLocationRaw
  /** The page size, when the host keeps it (a per-viewer preference); otherwise 25. */
  pageSize?: number
}>(), {
  own: false,
  limit: undefined,
  embedded: false,
  emptyTitle: undefined,
  pivotLink: (patch: AuditLogPivot) => ({ path: '/logs', query: { range: 'all', ...patch } }),
  pageSize: 25
})
const emit = defineEmits<{ 'update:pageSize': [size: number] }>()

const { t } = useI18n()
const ui = useUiLocale()
const dates = useDateTimeFormat()
const session = useSession()
const errorMessage = useApiErrorMessage()

const page = ref(1)
const size = ref(props.limit ?? props.pageSize)
watch(size, value => emit('update:pageSize', value))
watch(() => props.pageSize, (value) => {
  if (!props.limit) size.value = value
})

const display = useAuditLogDisplay()
const logs = useAuditLogs(() => props.query, page, size)
watch(logs.rows, list => display.ensureUsers(list, [props.query.principal]))

// A different query or page size makes the current offset meaningless - back to page 1.
const queryKey = computed(() => JSON.stringify(props.query))
watch([queryKey, size], () => {
  if (page.value === 1) void logs.load()
  else page.value = 1
})
watch(page, () => void logs.load())
onMounted(() => void logs.load())

const columns = computed(() => [
  { accessorKey: 'createdAt', header: t('audit.columns.time') },
  ...(props.own ? [] : [{ accessorKey: 'principalId', header: t('audit.columns.who') }]),
  { accessorKey: 'action', header: t('audit.columns.action') },
  { id: 'target', header: t('audit.columns.target') },
  ...(props.own ? [{ id: 'from', header: t('audit.columns.from') }] : []),
  { accessorKey: 'status', header: t('audit.columns.status') }
])

const selected = ref<AuditLog | null>(null)
const canOpenLogs = computed(() => session.can('logs', 'READ'))

async function pivot(patch: AuditLogPivot) {
  selected.value = null
  await navigateTo(props.pivotLink(patch))
}

defineExpose({ refresh: logs.load, pending: logs.pending })
</script>

<template>
  <PageShell :embedded="embedded">
    <template
      v-if="$slots.header"
      #header
    >
      <slot name="header" />
    </template>
    <template
      v-if="$slots.toolbar"
      #toolbar
    >
      <slot name="toolbar" />
    </template>

    <UAlert
      v-if="logs.error.value"
      color="error"
      variant="subtle"
      :title="errorMessage(logs.error.value)"
    />

    <UTable
      sticky
      :data="logs.rows.value"
      :columns="columns"
      :loading="logs.pending.value"
      :on-select="(_e: Event, row: { original: AuditLog }) => { selected = row.original }"
      class="cursor-pointer"
    >
      <template #empty>
        <slot name="empty">
          <UEmpty
            variant="naked"
            size="sm"
            icon="i-lucide-history"
            :title="emptyTitle ?? t('audit.empty')"
          />
        </slot>
      </template>
      <template #createdAt-cell="{ row }">
        <UTooltip :text="formatDistanceToNow(new Date(row.original.createdAt), { addSuffix: true, locale: ui.dateFns.value })">
          <span class="text-muted whitespace-nowrap tabular-nums">{{ formatAuditTime(row.original.createdAt, dates.timezone.value) }}</span>
        </UTooltip>
      </template>
      <template #principalId-cell="{ row }">
        <div class="flex flex-col min-w-0 max-w-64">
          <span class="truncate">{{ display.principalLabel(row.original) }}</span>
          <span class="truncate text-xs text-muted">{{ display.origin(row.original) }}</span>
        </div>
      </template>
      <!-- What happened in words; the action or event's own name below. -->
      <template #action-cell="{ row }">
        <div class="flex items-center gap-2 whitespace-nowrap">
          <UIcon
            :name="display.actionIcon.get(row.original.action) ?? 'i-lucide-circle'"
            class="size-4 shrink-0 text-muted"
          />
          <div class="flex flex-col min-w-0">
            <span>{{ display.actionLabel(row.original) }}</span>
            <span class="font-mono text-xs text-muted">{{ auditEventName(row.original) ?? row.original.action }}</span>
          </div>
        </div>
      </template>
      <template #target-cell="{ row }">
        <span
          v-if="display.target(row.original)"
          class="block truncate max-w-md"
          :class="display.target(row.original)!.mono ? 'font-mono text-xs' : 'text-sm'"
          :title="display.target(row.original)!.text"
        >{{ display.target(row.original)!.text }}</span>
        <span
          v-else
          class="text-dimmed"
        >—</span>
      </template>
      <template #from-cell="{ row }">
        <div class="flex min-w-0 items-center gap-2">
          <UIcon
            :name="describeUserAgent(row.original.userAgent, t).icon"
            class="size-4 shrink-0 text-muted"
          />
          <div class="flex min-w-0 flex-col">
            <span
              class="truncate"
              :title="row.original.userAgent ?? undefined"
            >{{ describeUserAgent(row.original.userAgent, t).label }}</span>
            <span class="font-mono text-xs text-muted">{{ row.original.ip ?? '—' }}</span>
          </div>
        </div>
      </template>
      <!-- A colored badge only for what went wrong - an EXECUTED badge on
      nearly every row would bury the Denied/Failed ones; a quiet dot +
      label instead. -->
      <template #status-cell="{ row }">
        <UBadge
          v-if="row.original.status !== 'EXECUTED'"
          :color="auditStatusColor(row.original.status)"
          variant="subtle"
          size="sm"
        >
          {{ t(`audit.statuses.${row.original.status}`) }}
        </UBadge>
        <span
          v-else
          class="inline-flex items-center gap-1.5 text-xs text-muted whitespace-nowrap"
        >
          <span class="size-1.5 rounded-full bg-success" />
          {{ t('audit.statuses.EXECUTED') }}
        </span>
      </template>
    </UTable>

    <template
      v-if="!limit"
      #footer
    >
      <TablePager
        v-model:page="page"
        v-model:page-size="size"
        :total="logs.total.value"
        :total-capped="logs.totalCapped.value"
        :noun="t('audit.pager.noun')"
        :plural="t('audit.pager.plural')"
        :page-size-options="[25, 50, 100, 200]"
      />
    </template>

    <AuditLogEntrySlideover
      v-model="selected"
      :display="display"
      :pivots="canOpenLogs"
      @pivot="pivot"
    />
  </PageShell>
</template>
