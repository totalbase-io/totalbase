<script setup lang="ts">
import type { SqlConsoleError, SqlExecuteResult } from '~/types/sql-console'

const props = defineProps<{
  result: SqlExecuteResult | null
  /** A plain message, or the SQL Console's PostgreSQL diagnostics. */
  error: string | SqlConsoleError | null
  executing: boolean
  search?: string
  wrap?: boolean
}>()

const { t } = useI18n()
const ui = useUiLocale()

function cellText(value: unknown): string {
  if (value === null) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

const filteredRows = computed(() => {
  const rows = props.result?.rows ?? []
  const term = props.search?.trim().toLowerCase()
  if (!term) return rows
  return rows.filter(row => Object.values(row).some(v => cellText(v).toLowerCase().includes(term)))
})

const noticesOpen = ref(false)

const errorDetails = computed<SqlConsoleError | null>(() => (typeof props.error === 'string' ? { message: props.error } : props.error))
/** PostgreSQL's DETAIL, HINT, SQLSTATE and the position, each when it gave them. */
const errorLines = computed(() => {
  const error = errorDetails.value
  if (!error) return []
  return [
    error.detail ? { label: t('database.sqlResultsPanel.detail'), value: error.detail } : null,
    error.hint ? { label: t('database.sqlResultsPanel.hint'), value: error.hint } : null,
    error.location ? { label: t('database.sqlResultsPanel.position'), value: t('database.sqlResultsPanel.lineColumn', { line: error.location.line, column: error.location.column }) } : null,
    error.sqlstate ? { label: 'SQLSTATE', value: error.sqlstate } : null
  ].filter(line => line !== null)
})
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <div
      v-if="executing"
      class="flex-1 flex items-center justify-center text-sm text-muted"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="animate-spin size-4 mr-2"
      />
      {{ t('database.sqlResultsPanel.running') }}
    </div>

    <!-- No `result` on a failed execution - the error takes over the same
    slot the empty-state placeholder would otherwise occupy, since there's
    no grid (and so no footer) to attach it below. -->
    <UAlert
      v-else-if="errorDetails"
      color="error"
      variant="subtle"
      :title="t('database.sqlResultsPanel.executionFailed')"
      class="m-px"
    >
      <template #description>
        <p class="whitespace-pre-wrap">
          {{ errorDetails.message }}
        </p>
        <dl
          v-if="errorLines.length"
          class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1"
        >
          <template
            v-for="line in errorLines"
            :key="line.label"
          >
            <dt class="font-medium">
              {{ line.label }}
            </dt>
            <dd class="whitespace-pre-wrap font-mono">
              {{ line.value }}
            </dd>
          </template>
        </dl>
      </template>
    </UAlert>

    <div
      v-else-if="!result"
      class="flex-1 flex items-center justify-center text-sm text-muted text-center px-4"
    >
      {{ t('database.sqlResultsPanel.runPrompt') }}
    </div>

    <template v-else>
      <UEmpty
        v-if="result.rows.length === 0"
        variant="naked"
        size="sm"
        icon="i-lucide-table-2"
        :title="t('database.sqlResultsPanel.noRowsReturned')"
        :description="t('database.sqlResultsPanel.rowsAffected', { count: result.rowCount })"
        class="flex-1"
      />

      <div
        v-else-if="filteredRows.length === 0"
        class="flex-1 flex items-center justify-center text-sm text-muted"
      >
        {{ t('database.sqlResultsPanel.noRowsMatch', { search }) }}
      </div>

      <div
        v-else
        class="flex-1 min-h-0 overflow-auto border border-default rounded-lg"
      >
        <UTable
          sticky
          :data="filteredRows"
          :columns="result.columns.map(c => ({ accessorKey: c.name, header: `${c.name} (${c.dataType})` }))"
        >
          <template
            v-for="col in result.columns"
            :key="col.name"
            #[`${col.name}-cell`]="{ row }"
          >
            <span :class="['font-mono text-xs', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-nowrap']">{{ cellText(row.original[col.name]) }}</span>
          </template>
        </UTable>
      </div>

      <!-- Fixed-height footer regardless of notice count - a UPopover for
      the list rather than stacking UAlerts inline, which grew the footer
      with every RAISE NOTICE a statement produced. -->
      <div class="flex items-center gap-2 text-xs text-muted pt-2 mt-2 border-t border-default shrink-0">
        <UBadge
          :color="result.status === 'EXECUTED' ? 'success' : 'error'"
          variant="subtle"
          size="sm"
        >
          {{ result.status }}
        </UBadge>
        <span>
          {{ t('database.sqlResultsPanel.rowsDuration', { count: result.rowCount, ms: result.durationMs }) }}<template v-if="result.truncated">
            {{ t('database.sqlResultsPanel.truncated', { shown: result.rows.length.toLocaleString(ui.intlLocale.value) }) }}
          </template>
        </span>

        <UPopover
          v-if="result.notices.length > 0"
          v-model:open="noticesOpen"
        >
          <UButton
            :label="t('database.sqlResultsPanel.notices', result.notices.length)"
            icon="i-lucide-info"
            color="neutral"
            variant="outline"
            size="xs"
            class="ms-auto"
          />
          <template #content>
            <div class="flex flex-col gap-2 p-3 max-w-sm max-h-64 overflow-y-auto">
              <UAlert
                v-for="(notice, i) in result.notices"
                :key="i"
                :color="notice.severity === 'WARNING' ? 'warning' : 'neutral'"
                variant="subtle"
                :title="notice.severity"
                :description="notice.message"
              />
            </div>
          </template>
        </UPopover>
      </div>
    </template>
  </div>
</template>
