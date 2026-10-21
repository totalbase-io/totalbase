<script setup lang="ts">
/**
 * Settings > PostgreSQL > Maintenance (Administration.md §6): every
 * table's size and vacuum/analyze state, from PostgreSQL's own statistics.
 * A row opens its details and indexes in a sidebar - a lookup next to the
 * list, not an editor (AGENTS.md section 25) - with its actions: VACUUM,
 * ANALYZE and REINDEX CONCURRENTLY, queued to the maintenance worker. Runs
 * are polled only while one is still pending or running.
 *
 * Batches - "Run maintenance" or a selection - open MaintenanceBatchModal:
 * the list first, then progress that can't be dismissed, only stopped. A
 * batch running when this page loads reopens it (useMaintenanceBatch).
 */
import type { DropdownMenuItem, TableColumn } from '@nuxt/ui'
import { formatDistanceToNow } from 'date-fns'
import type { MaintenanceBatchPlan, MaintenanceIndex, MaintenanceOperation, MaintenanceOverview, MaintenanceRun, MaintenanceTable } from '~/types/maintenance'

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()
const ui = useUiLocale()

const { data: overview, pending, error, refresh } = await useAsyncData(
  'maintenance-tables',
  () => api.get<MaintenanceOverview>('/maintenance/tables').then(r => r.data)
)

const refreshing = ref(false)
async function refreshTables() {
  refreshing.value = true
  try {
    await refresh()
  } finally {
    refreshing.value = false
  }
}

// Dead rows worth a look: at least 1,000 and a tenth of the table - the
// same scale autovacuum's own defaults work at (50 rows + 20%), a little
// earlier so the list flags a table before autovacuum is overdue.
function deadShare(table: MaintenanceTable): number | null {
  if (table.deadRows === null || table.liveRows === null) return null
  const total = table.deadRows + table.liveRows
  return total === 0 ? 0 : table.deadRows / total
}
// Never analyzed only matters for a table that holds rows - an empty one
// has nothing for the planner to estimate.
function neverAnalyzed(table: MaintenanceTable): boolean {
  return table.estimatedRows === null && table.kind !== 'PARTITIONED_TABLE' && (table.liveRows ?? 0) > 0
}
function needsAttention(table: MaintenanceTable): boolean {
  const share = deadShare(table)
  return (share !== null && table.deadRows! >= 1000 && share >= 0.1) || neverAnalyzed(table)
}

const search = ref('')
const onlyAttention = ref(false)
const tables = computed(() => {
  const term = search.value.trim().toLowerCase()
  return (overview.value?.tables ?? []).filter(table =>
    (!term || `${table.schema}.${table.name}`.toLowerCase().includes(term))
    && (!onlyAttention.value || needsAttention(table))
  )
})
const attentionCount = computed(() => (overview.value?.tables ?? []).filter(needsAttention).length)
const largest = computed(() => Math.max(1, ...(overview.value?.tables ?? []).map(table => table.totalBytes)))

const latest = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b)
function ago(value: string | null): string {
  return value ? formatDistanceToNow(new Date(value), { addSuffix: true, locale: ui.dateFns.value }) : t('settings.maintenance.never')
}
const KIND_LABEL = computed<Record<MaintenanceTable['kind'], string | null>>(() => ({
  TABLE: null,
  PARTITIONED_TABLE: t('settings.maintenance.partitioned'),
  MATERIALIZED_VIEW: t('settings.maintenance.materializedView')
}))
const numberFormat = computed(() => new Intl.NumberFormat(ui.intlLocale.value))

// Sortable by clicking a header - client-side, the whole list is already
// loaded. Largest first by default, the server's own order. "never"
// sorts as the oldest time, a missing count as below zero.
const sorting = ref([{ id: 'size', desc: true }])
// The part of TanStack's Column a header needs - UTable passes the full one.
interface SortableColumn {
  getIsSorted: () => false | 'asc' | 'desc'
  toggleSorting: (desc?: boolean) => void
}
function sortable(label: string, align: 'left' | 'right' = 'left') {
  return ({ column }: { column: SortableColumn }) => {
    const sorted = column.getIsSorted()
    return sortableHeader(label, sorted, () => column.toggleSorting(sorted === 'asc'), align)
  }
}
const time = (value: string | null) => (value ? new Date(value).getTime() : 0)

const columns = computed<TableColumn<MaintenanceTable>[]>(() => [
  { id: 'select', meta: { class: { th: 'w-10', td: 'w-10' } } },
  { id: 'table', accessorFn: row => `${row.schema}.${row.name}`, header: sortable(t('settings.maintenance.columns.table')) },
  { id: 'size', accessorFn: row => row.totalBytes, header: sortable(t('settings.maintenance.columns.size')), meta: { class: { th: 'w-56' } } },
  { id: 'rows', accessorFn: row => row.estimatedRows ?? -1, header: sortable(t('settings.maintenance.columns.rows'), 'right'), meta: { class: { th: 'text-right', td: 'text-right' } } },
  { id: 'dead', accessorFn: row => row.deadRows ?? -1, header: sortable(t('settings.maintenance.columns.dead'), 'right'), meta: { class: { th: 'text-right', td: 'text-right' } } },
  { id: 'vacuum', accessorFn: row => time(latest(row.lastVacuum, row.lastAutovacuum)), header: sortable(t('settings.maintenance.lastVacuum')) },
  { id: 'analyze', accessorFn: row => time(latest(row.lastAnalyze, row.lastAutoanalyze)), header: sortable(t('settings.maintenance.lastAnalyze')) }
])

// --- Runs: single-table actions, polled only while one is active (a
// batch's items are followed through useMaintenanceBatch instead) ---
const runs = ref<MaintenanceRun[]>([])
const isActive = (run: MaintenanceRun) => run.status === 'PENDING' || run.status === 'RUNNING'
const activeRuns = computed(() => runs.value.filter(run => isActive(run) && !run.batchId))

const { batch, watch: watchBatch, stop: unwatchBatch } = useMaintenanceBatch()
onMounted(watchBatch)
onBeforeUnmount(unwatchBatch)
const batchActive = computed(() => !!batch.value?.active)

/** What's happening to a table right now - a single action or a batch item - for its badge. */
const activityByTable = computed(() => {
  const activity = new Map<number, { operation: MaintenanceOperation, text: string }>()
  for (const run of activeRuns.value) activity.set(run.tableOid, { operation: run.operation, text: runStatusText(run) })
  if (batch.value?.active) {
    for (const item of batch.value.items) {
      if (item.status === 'PENDING') activity.set(item.tableOid, { operation: batch.value.operation, text: t('settings.maintenance.status.queued') })
      if (item.status === 'RUNNING') {
        const progress = batch.value.current?.progress
        activity.set(item.tableOid, { operation: batch.value.operation, text: progress ? `${progress.phase}${progress.percent !== null ? ` · ${progress.percent}%` : ''}` : t('settings.maintenance.status.running') })
      }
    }
  }
  return activity
})
let pollTimer: ReturnType<typeof setTimeout> | undefined

async function loadRuns() {
  const hadActive = activeRuns.value.length > 0
  runs.value = (await api.get<MaintenanceRun[]>('/maintenance/runs')).data
  // One finished: its table's statistics changed - PostgreSQL publishes
  // them within about a second of the command ending, so read them then.
  if (hadActive && activeRuns.value.length === 0) {
    setTimeout(() => {
      refresh()
      if (selected.value) loadIndexes(selected.value.oid)
    }, 1500)
  }
  clearTimeout(pollTimer)
  if (activeRuns.value.length > 0) pollTimer = setTimeout(loadRuns, 2000)
}
onMounted(loadRuns)
onBeforeUnmount(() => clearTimeout(pollTimer))

// A batch ended: same statistics refresh as a single run's.
function onBatchFinished() {
  setTimeout(() => {
    refresh()
    loadRuns()
    if (selected.value) loadIndexes(selected.value.oid)
  }, 1500)
}

// --- Batches: what "Run maintenance" and a selection would run ---
const plan = ref<MaintenanceBatchPlan | null>(null)
const rowSelection = ref<Record<string, boolean>>({})
const selectedTables = computed(() => (overview.value?.tables ?? []).filter(table => rowSelection.value[String(table.oid)]))
const allTables = computed(() => overview.value?.tables ?? [])
const labelOf = (table: MaintenanceTable) => `${table.schema}.${table.name}`
const notMaintainable = (list: MaintenanceTable[]) =>
  list.filter(table => !table.canMaintain).map(table => ({ label: labelOf(table), reason: t('settings.maintenance.ownedByReason', { owner: table.owner }) }))

const withDeadRows = computed(() => allTables.value.filter(table => (table.deadRows ?? 0) > 0))
const toAnalyze = computed(() => allTables.value.filter(neverAnalyzed))
const withInvalidIndexes = computed(() => allTables.value.filter(table => table.invalidIndexes.length > 0))

function openPlan(operation: MaintenanceOperation, title: string, candidates: MaintenanceTable[], note?: string) {
  plan.value = {
    operation,
    title,
    targets: candidates.filter(table => table.canMaintain).map(table => ({ table: table.oid, label: labelOf(table) })),
    skipped: notMaintainable(candidates),
    ...(note ? { note } : {})
  }
}
function planVacuumDeadRows() {
  const clean = allTables.value.length - withDeadRows.value.length
  openPlan('VACUUM', t('settings.maintenance.plans.vacuumDead'), withDeadRows.value, t('settings.maintenance.plans.vacuumDeadNote', clean))
}
function planAnalyzeNever() {
  openPlan('ANALYZE', t('settings.maintenance.plans.analyzeNever'), toAnalyze.value, t('settings.maintenance.plans.analyzeNeverNote'))
}
async function planRebuildInvalid() {
  // Index names for the list - the overview carries only their OIDs.
  const targets: MaintenanceBatchPlan['targets'] = []
  for (const table of withInvalidIndexes.value.filter(table => table.canMaintain)) {
    const names = new Map((await api.get<MaintenanceIndex[]>(`/maintenance/tables/${table.oid}/indexes`)).data.map(index => [index.oid, index.name]))
    for (const oid of table.invalidIndexes) targets.push({ table: table.oid, index: oid, label: `${table.schema}.${names.get(oid) ?? oid}` })
  }
  plan.value = { operation: 'REINDEX', title: t('settings.maintenance.plans.rebuildInvalid'), targets, skipped: notMaintainable(withInvalidIndexes.value) }
}
function planSelection(operation: MaintenanceOperation) {
  const list = selectedTables.value
  const indexBytes = list.filter(table => table.canMaintain).reduce((sum, table) => sum + table.indexBytes, 0)
  const note = operation === 'REINDEX'
    ? t('settings.maintenance.plans.reindexNote', { size: formatBytes(indexBytes) })
    : undefined
  openPlan(operation, t('settings.maintenance.plans.selection', { operation: OPERATION_LABEL[operation] }, list.length), list, note)
}

const runMenu = computed<DropdownMenuItem[][]>(() => [[
  { label: `${t('settings.maintenance.plans.vacuumDead')} (${withDeadRows.value.length})`, icon: 'i-lucide-sparkles', disabled: withDeadRows.value.length === 0, onSelect: planVacuumDeadRows },
  { label: `${t('settings.maintenance.plans.analyzeNever')} (${toAnalyze.value.length})`, icon: 'i-lucide-chart-bar', disabled: toAnalyze.value.length === 0, onSelect: planAnalyzeNever },
  { label: `${t('settings.maintenance.plans.rebuildInvalid')} (${withInvalidIndexes.value.reduce((n, table) => n + table.invalidIndexes.length, 0)})`, icon: 'i-lucide-list-restart', disabled: withInvalidIndexes.value.length === 0, onSelect: planRebuildInvalid }
]])

const OPERATION_LABEL: Record<MaintenanceOperation, string> = { VACUUM: 'Vacuum', ANALYZE: 'Analyze', REINDEX: 'Reindex' }
const queuing = ref<string | null>(null)
async function queue(table: MaintenanceTable, operation: MaintenanceOperation, index?: MaintenanceIndex) {
  const key = `${operation}:${index?.oid ?? table.oid}`
  queuing.value = key
  try {
    await api.post(`/maintenance/tables/${table.oid}/${operation.toLowerCase()}`, index ? { data: { index: index.oid } } : undefined)
    toast.add({ title: t('settings.maintenance.queued', { operation: OPERATION_LABEL[operation] }), description: `${table.schema}.${index?.name ?? table.name}`, color: 'success' })
    await loadRuns()
  } catch (err) {
    notifyError(err, t('settings.maintenance.queueError', { operation: OPERATION_LABEL[operation].toLowerCase() }))
  } finally {
    queuing.value = null
  }
}
function runStatusText(run: MaintenanceRun): string {
  if (run.status === 'PENDING') return t('settings.maintenance.status.queued')
  if (run.status === 'RUNNING') {
    const phase = run.progress?.phase
    return phase ? `${phase}${run.progress?.percent !== null && run.progress?.percent !== undefined ? ` · ${run.progress.percent}%` : ''}` : t('settings.maintenance.status.running')
  }
  return run.status === 'COMPLETED' ? t('settings.maintenance.status.done') : run.status === 'CANCELLED' ? t('settings.maintenance.status.cancelled') : t('settings.maintenance.status.failed')
}
const selectedRuns = computed(() => runs.value.filter(run => run.tableOid === selected.value?.oid))

// --- Details sidebar ---
const selected = ref<MaintenanceTable | null>(null)
const isDetailsOpen = computed({
  get: () => selected.value !== null,
  set: (open: boolean) => { if (!open) selected.value = null }
})
// Keep the open sidebar on the latest numbers after a refresh.
watch(overview, (next) => {
  if (selected.value) selected.value = next?.tables.find(table => table.oid === selected.value!.oid) ?? null
})
const indexes = ref<MaintenanceIndex[]>([])
const loadingIndexes = ref(false)
async function loadIndexes(oid: number) {
  loadingIndexes.value = true
  try {
    indexes.value = (await api.get<MaintenanceIndex[]>(`/maintenance/tables/${oid}/indexes`)).data
  } finally {
    loadingIndexes.value = false
  }
}
watch(() => selected.value?.oid, (oid) => {
  indexes.value = []
  if (oid) loadIndexes(oid)
})
</script>

<template>
  <PageShell>
    <template #header>
      <PageHeader
        :title="t('settings.maintenance.title')"
        :description="t('settings.maintenance.description')"
        icon="i-lucide-wrench"
      >
        <template v-if="selectedTables.length">
          <span class="text-sm text-muted whitespace-nowrap">{{ t('settings.maintenance.selected', { n: selectedTables.length }) }}</span>
          <UButton
            v-for="operation in (['VACUUM', 'ANALYZE', 'REINDEX'] as const)"
            :key="operation"
            :label="OPERATION_LABEL[operation]"
            color="neutral"
            variant="outline"
            :disabled="batchActive"
            @click="planSelection(operation)"
          />
          <UButton
            :label="t('common.clear')"
            color="neutral"
            variant="ghost"
            @click="rowSelection = {}"
          />
        </template>
        <UDropdownMenu
          v-else
          :items="runMenu"
          :content="{ align: 'start' }"
          :disabled="batchActive"
        >
          <UButton
            :label="t('settings.maintenance.runMaintenance')"
            icon="i-lucide-wrench"
            trailing-icon="i-lucide-chevron-down"
            :disabled="batchActive"
          />
        </UDropdownMenu>
        <UButton
          :label="t('settings.maintenance.needsAttention', { n: attentionCount })"
          :color="onlyAttention ? 'warning' : 'neutral'"
          :variant="onlyAttention ? 'soft' : 'outline'"
          icon="i-lucide-triangle-alert"
          @click="onlyAttention = !onlyAttention"
        />
        <div class="flex-1" />
        <UInput
          v-model="search"
          :aria-label="t('settings.maintenance.searchTables')"
          icon="i-lucide-search"
          :placeholder="t('settings.maintenance.searchTables')"
          class="w-64"
        />
        <UTooltip :text="t('common.refresh')">
          <UButton
            icon="i-lucide-refresh-cw"
            :aria-label="t('common.refresh')"
            color="neutral"
            variant="outline"
            square
            :loading="refreshing"
            @click="refreshTables"
          />
        </UTooltip>
      </PageHeader>
    </template>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error.message"
      class="mb-4"
    />

    <UTable
      v-model:sorting="sorting"
      v-model:row-selection="rowSelection"
      :get-row-id="(row: MaintenanceTable) => String(row.oid)"
      sticky
      :data="tables"
      :columns="columns"
      :loading="pending && !overview"
      :on-select="(_e: Event, row: { original: MaintenanceTable }) => { selected = row.original }"
      class="cursor-pointer"
    >
      <template #empty>
        <UEmpty
          variant="naked"
          size="sm"
          icon="i-lucide-wrench"
          :title="onlyAttention ? t('settings.maintenance.noneNeedsAttention') : t('settings.maintenance.noTablesMatch')"
        />
      </template>
      <template #select-header="{ table }">
        <UCheckbox
          :model-value="table.getIsSomePageRowsSelected() ? 'indeterminate' : table.getIsAllPageRowsSelected()"
          :aria-label="t('settings.maintenance.selectAll')"
          @update:model-value="(v: boolean | 'indeterminate') => table.toggleAllPageRowsSelected(v === true)"
          @click.stop
        />
      </template>
      <template #select-cell="{ row }">
        <UCheckbox
          :model-value="row.getIsSelected()"
          :aria-label="t('settings.secrets.select', { key: `${row.original.schema}.${row.original.name}` })"
          @update:model-value="(v: boolean | 'indeterminate') => row.toggleSelected(v === true)"
          @click.stop
        />
      </template>
      <template #table-cell="{ row }">
        <div class="flex min-w-0 items-center gap-2">
          <UIcon
            v-if="!row.original.canMaintain"
            name="i-lucide-lock"
            class="size-3.5 shrink-0 text-dimmed"
            :title="t('settings.maintenance.ownedByLocked', { owner: row.original.owner })"
          />
          <span class="truncate">
            <span class="text-muted">{{ row.original.schema }}.</span><span class="font-medium text-highlighted">{{ row.original.name }}</span>
          </span>
          <UBadge
            v-if="KIND_LABEL[row.original.kind]"
            :label="KIND_LABEL[row.original.kind]!"
            color="neutral"
            variant="subtle"
            size="sm"
          />
          <UBadge
            v-if="activityByTable.get(row.original.oid)"
            :label="`${OPERATION_LABEL[activityByTable.get(row.original.oid)!.operation]}: ${activityByTable.get(row.original.oid)!.text}`"
            icon="i-lucide-loader-circle"
            color="primary"
            variant="subtle"
            size="sm"
            :ui="{ leadingIcon: 'animate-spin' }"
          />
        </div>
      </template>
      <template #size-cell="{ row }">
        <div class="flex items-center gap-2">
          <div class="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-elevated">
            <div
              class="h-full rounded-full bg-primary/60"
              :style="{ width: `${Math.max(2, (row.original.totalBytes / largest) * 100)}%` }"
            />
          </div>
          <span class="tabular-nums whitespace-nowrap">{{ formatBytes(row.original.totalBytes) }}</span>
        </div>
      </template>
      <template #rows-cell="{ row }">
        <span class="tabular-nums">{{ row.original.estimatedRows === null ? '—' : numberFormat.format(row.original.estimatedRows) }}</span>
      </template>
      <template #dead-cell="{ row }">
        <span
          class="tabular-nums"
          :class="needsAttention(row.original) && row.original.deadRows ? 'font-medium text-warning' : 'text-muted'"
        >
          {{ row.original.deadRows === null ? '—' : numberFormat.format(row.original.deadRows) }}
          <template v-if="deadShare(row.original)">
            ({{ Math.round(deadShare(row.original)! * 100) }}%)
          </template>
        </span>
      </template>
      <template #vacuum-cell="{ row }">
        <span class="whitespace-nowrap text-muted">{{ ago(latest(row.original.lastVacuum, row.original.lastAutovacuum)) }}</span>
      </template>
      <template #analyze-cell="{ row }">
        <span
          class="whitespace-nowrap"
          :class="neverAnalyzed(row.original) ? 'text-warning' : 'text-muted'"
        >{{ ago(latest(row.original.lastAnalyze, row.original.lastAutoanalyze)) }}</span>
      </template>
    </UTable>

    <template #footer>
      <span
        v-if="overview"
        class="text-sm text-muted"
      >
        {{ t('settings.maintenance.count', tables.length) }}<template v-if="tables.length !== overview.tables.length">{{ t('settings.secrets.countOf', { total: overview.tables.length }) }}</template>
        · {{ overview.database }} {{ formatBytes(overview.sizeBytes) }} · PostgreSQL {{ overview.version }}
      </span>
    </template>

    <USlideover
      v-model:open="isDetailsOpen"
      :title="selected ? `${selected.schema}.${selected.name}` : ''"
      :description="selected ? t('settings.maintenance.ownedBy', { owner: selected.owner }) : undefined"
    >
      <template #body>
        <div
          v-if="selected"
          class="flex flex-col gap-6 text-sm"
        >
          <UAlert
            v-if="!selected.canMaintain"
            color="neutral"
            variant="subtle"
            icon="i-lucide-lock"
            :title="t('settings.maintenance.cantMaintainTitle')"
            :description="t('settings.maintenance.cantMaintainDescription', { owner: selected.owner })"
          />

          <!-- The record's own actions, not a form to commit - they stay in
          the body (AGENTS.md section 25). None blocks reads or writes. -->
          <section class="flex flex-col gap-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">
              {{ t('settings.maintenance.title') }}
            </h3>
            <div class="flex flex-wrap gap-2">
              <UButton
                v-for="operation in (['VACUUM', 'ANALYZE', 'REINDEX'] as const)"
                :key="operation"
                :label="OPERATION_LABEL[operation]"
                :icon="operation === 'VACUUM' ? 'i-lucide-sparkles' : operation === 'ANALYZE' ? 'i-lucide-chart-bar' : 'i-lucide-list-restart'"
                color="neutral"
                variant="outline"
                size="sm"
                :disabled="!selected.canMaintain || batchActive || activityByTable.has(selected.oid)"
                :loading="queuing === `${operation}:${selected.oid}`"
                @click="queue(selected, operation)"
              />
            </div>
            <p class="text-xs text-muted">
              {{ t('settings.maintenance.operationsHelp') }}
            </p>
            <div
              v-if="selectedRuns.length"
              class="flex flex-col divide-y divide-default rounded-lg border border-default"
            >
              <div
                v-for="run in selectedRuns.slice(0, 5)"
                :key="run.id"
                class="flex items-center gap-2 px-3 py-2 text-xs"
              >
                <UIcon
                  :name="isActive(run) ? 'i-lucide-loader-circle' : run.status === 'COMPLETED' ? 'i-lucide-circle-check' : run.status === 'CANCELLED' ? 'i-lucide-circle-slash' : 'i-lucide-circle-x'"
                  class="size-4 shrink-0"
                  :class="isActive(run) ? 'animate-spin text-primary' : run.status === 'COMPLETED' ? 'text-success' : run.status === 'CANCELLED' ? 'text-dimmed' : 'text-error'"
                />
                <span class="font-medium">{{ OPERATION_LABEL[run.operation] }}</span>
                <span
                  v-if="run.indexOid"
                  class="truncate font-mono text-muted"
                >{{ run.label }}</span>
                <span
                  class="ml-auto shrink-0"
                  :class="run.status === 'FAILED' ? 'text-error' : 'text-muted'"
                  :title="run.error ?? undefined"
                >{{ runStatusText(run) }} · {{ ago(run.completedAt ?? run.createdAt) }}</span>
              </div>
            </div>
          </section>

          <section class="flex flex-col gap-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">
              {{ t('settings.maintenance.columns.size') }}
            </h3>
            <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
              <span class="text-muted">{{ t('settings.maintenance.total') }}</span>
              <span class="tabular-nums font-medium">{{ formatBytes(selected.totalBytes) }}</span>
              <span class="text-muted">{{ t('settings.maintenance.columns.table') }}</span>
              <span class="tabular-nums">{{ formatBytes(selected.tableBytes) }}</span>
              <span class="text-muted">{{ t('settings.maintenance.indexes') }}</span>
              <span class="tabular-nums">{{ formatBytes(selected.indexBytes) }}</span>
              <span class="text-muted">TOAST</span>
              <span class="tabular-nums">{{ formatBytes(selected.toastBytes) }}</span>
            </div>
          </section>

          <section class="flex flex-col gap-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">
              {{ t('settings.maintenance.rowsAndMaintenance') }}
            </h3>
            <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
              <span class="text-muted">{{ t('settings.maintenance.estimatedRows') }}</span>
              <span class="tabular-nums">{{ selected.estimatedRows === null ? t('settings.maintenance.notAnalyzedYet') : numberFormat.format(selected.estimatedRows) }}</span>
              <span class="text-muted">{{ t('settings.maintenance.liveDead') }}</span>
              <span class="tabular-nums">{{ selected.liveRows === null ? '—' : numberFormat.format(selected.liveRows) }} / {{ selected.deadRows === null ? '—' : numberFormat.format(selected.deadRows) }}</span>
              <span class="text-muted">{{ t('settings.maintenance.lastVacuum') }}</span>
              <span>{{ ago(selected.lastVacuum) }}</span>
              <span class="text-muted">{{ t('settings.maintenance.lastAutovacuum') }}</span>
              <span>{{ ago(selected.lastAutovacuum) }}</span>
              <span class="text-muted">{{ t('settings.maintenance.lastAnalyze') }}</span>
              <span>{{ ago(selected.lastAnalyze) }}</span>
              <span class="text-muted">{{ t('settings.maintenance.lastAutoanalyze') }}</span>
              <span>{{ ago(selected.lastAutoanalyze) }}</span>
            </div>
          </section>

          <section class="flex flex-col gap-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">
              {{ t('settings.maintenance.indexes') }}
            </h3>
            <UEmpty
              v-if="loadingIndexes"
              loading
              variant="naked"
              size="sm"
            />
            <p
              v-else-if="indexes.length === 0"
              class="text-muted"
            >
              {{ t('settings.maintenance.noIndexes') }}
            </p>
            <div
              v-else
              class="flex flex-col divide-y divide-default rounded-lg border border-default"
            >
              <div
                v-for="index in indexes"
                :key="index.oid"
                class="flex flex-col gap-1 px-3 py-2"
              >
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-mono text-xs font-medium text-highlighted">{{ index.name }}</span>
                  <UBadge
                    v-if="index.primary"
                    :label="t('settings.maintenance.primary')"
                    color="neutral"
                    variant="subtle"
                    size="sm"
                  />
                  <UBadge
                    v-else-if="index.unique"
                    :label="t('settings.maintenance.unique')"
                    color="neutral"
                    variant="subtle"
                    size="sm"
                  />
                  <UBadge
                    v-if="!index.valid"
                    :label="t('settings.maintenance.invalid')"
                    color="error"
                    variant="subtle"
                    size="sm"
                  />
                  <span class="ml-auto tabular-nums text-muted">{{ formatBytes(index.bytes) }}</span>
                  <UTooltip :text="index.valid ? t('settings.maintenance.rebuildIndex') : t('settings.maintenance.rebuildInvalidIndex')">
                    <UButton
                      icon="i-lucide-list-restart"
                      color="neutral"
                      variant="ghost"
                      size="xs"
                      :aria-label="t('settings.maintenance.reindexNamed', { name: index.name })"
                      :disabled="!selected.canMaintain || batchActive || activityByTable.has(selected.oid)"
                      :loading="queuing === `REINDEX:${index.oid}`"
                      @click="queue(selected, 'REINDEX', index)"
                    />
                  </UTooltip>
                </div>
                <p class="text-xs text-muted">
                  {{ t('settings.maintenance.scans', { n: numberFormat.format(index.scans) }, index.scans) }}<template v-if="index.scans === 0 && !index.primary && !index.unique">
                    · {{ t('settings.maintenance.neverUsed') }}
                  </template>
                </p>
                <code
                  class="truncate text-xs text-dimmed"
                  :title="index.definition"
                >{{ index.definition }}</code>
              </div>
            </div>
          </section>
        </div>
      </template>
    </USlideover>

    <MaintenanceBatchModal
      v-model:plan="plan"
      @finished="onBatchFinished"
    />
  </PageShell>
</template>
