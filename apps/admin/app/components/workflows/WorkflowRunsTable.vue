<script setup lang="ts">
/**
 * A workflow's runs (Specification_Workflows.md §16.3) - the Runs section of its settings page: a server-paged
 * grid with its filters (status, trigger, mode, version, period) in the toolbar and the pager at the foot, as the
 * sessions grid. A row opens the run in a slideover beside the table (WorkflowRunSlideover.vue): its summary, result
 * or error, steps, and each step's detail. The open run lives in `?run=`, so a link lands on it (the editor's Test
 * run / Run modal, "Open in Runs"). While a run is in progress the list re-reads itself every few seconds.
 */
import type { WorkflowVersionRecord } from '~/composables/useWorkflowVersions'
import { errorPreview, runDuration, runStatusColor, type WorkflowRunSummary } from '~/utils/workflow-runs'
import WorkflowRunSlideover from '~/components/workflows/WorkflowRunSlideover.vue'
import { formatDistanceToNow } from 'date-fns'

const props = defineProps<{
  workflowId: string
  versions: WorkflowVersionRecord[]
  /** Names each step by its operation's label and key - the draft's operations (ids are stable across versions). */
  operations?: { id: string, key: string, label: string }[]
}>()

const api = useAdminApi()
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const dates = useDateTimeFormat()
const ui = useUiLocale()
const directory = useUserDirectory()

// --- Filters ---
const STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'PENDING'] as const
const TRIGGERS = ['MANUAL', 'CRON', 'WEBHOOK', 'DATA_EVENT'] as const
const MODES = ['PRODUCTION', 'TEST'] as const
const PERIODS = [
  { value: '24h', minutes: 60 * 24 },
  { value: '7d', minutes: 60 * 24 * 7 },
  { value: '30d', minutes: 60 * 24 * 30 },
  { value: 'all', minutes: null }
] as const
const ALL = 'ALL'
const status = ref<string>(ALL)
const trigger = ref<string>(ALL)
const mode = ref<string>(ALL)
const version = ref<string>(ALL)
const period = ref<(typeof PERIODS)[number]['value']>('all')
const withAll = (items: { label: string, value: string }[]) => [{ label: t('workflows.runs.filters.all'), value: ALL }, ...items]
const statusItems = computed(() => withAll(STATUSES.map(s => ({ label: t(`workflows.runs.status.${s}`), value: s }))))
const triggerItems = computed(() => withAll(TRIGGERS.map(s => ({ label: t(`workflows.runs.trigger.${s}`), value: s }))))
const modeItems = computed(() => withAll(MODES.map(s => ({ label: t(`workflows.runs.mode.${s}`), value: s }))))
const versionItems = computed(() => withAll(props.versions.map(v => ({ label: `v${v.version}`, value: v.id }))))
const periodItems = computed(() => PERIODS.map(p => ({ label: t(`workflows.runs.period.${p.value}`), value: p.value })))
const versionNumber = (id: string | null) => id ? props.versions.find(v => v.id === id)?.version : undefined

// --- The page ---
const prefs = usePagePreferences('workflow-runs', { pageSize: 20 })
const page = ref(1)
watch([status, trigger, mode, version, period, () => prefs.pageSize], () => {
  page.value = 1
})
const query = computed(() => {
  const minutes = PERIODS.find(p => p.value === period.value)?.minutes ?? null
  return {
    page: String(page.value),
    pageSize: String(prefs.pageSize),
    ...(status.value !== ALL && { status: status.value }),
    ...(trigger.value !== ALL && { trigger: trigger.value }),
    ...(mode.value !== ALL && { mode: mode.value }),
    ...(version.value !== ALL && { version: version.value }),
    ...(minutes !== null && { from: new Date(Date.now() - minutes * 60_000).toISOString() })
  }
})
const { data: result, pending, error, refresh } = await useAsyncData(
  `workflow-runs-${props.workflowId}`,
  async () => {
    const { data, meta } = await api.get<WorkflowRunSummary[]>(`/workflows/${props.workflowId}/runs`, query.value)
    await directory.ensure(data.map(run => initiatorUser(run)))
    return { runs: data, total: Number(meta?.total ?? 0) }
  },
  { watch: [query], default: () => ({ runs: [] as WorkflowRunSummary[], total: 0 }) }
)
const runs = computed(() => result.value.runs)
const total = computed(() => result.value.total)
const refreshing = ref(false)
async function refreshRuns() {
  refreshing.value = true
  try {
    await refresh()
  } finally {
    refreshing.value = false
  }
}
// A run in progress: the list follows it.
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    if (runs.value.some(run => run.status === 'RUNNING' || run.status === 'PENDING')) void refresh()
  }, 5000)
})
onUnmounted(() => clearInterval(timer))

// --- Columns ---
const columns = computed(() => [
  { id: 'status', header: t('common.status'), meta: { class: { td: 'whitespace-nowrap' } } },
  { id: 'trigger', header: t('workflows.runs.columns.trigger') },
  { id: 'mode', header: t('workflows.runs.columns.mode') },
  { id: 'version', header: t('workflows.runs.columns.version') },
  { id: 'started', header: t('workflows.runs.columns.started'), meta: { class: { td: 'whitespace-nowrap' } } },
  { id: 'duration', header: t('workflows.runs.columns.duration') },
  { id: 'initiator', header: t('workflows.runs.columns.initiator') },
  { id: 'error', header: t('workflows.runs.columns.error'), meta: { class: { td: 'max-w-md' } } }
])
function initiatorUser(run: WorkflowRunSummary): string | undefined {
  const initiator = run.initiator as { type?: string, id?: string } | null
  return initiator?.type === 'USER' ? initiator.id : undefined
}
function initiatorLabel(run: WorkflowRunSummary): string {
  const initiator = run.initiator as { type?: string, id?: string, public?: boolean } | null
  switch (initiator?.type) {
    case 'USER': return directory.label(initiator.id!)
    case 'API_KEY': return t('workflows.runs.initiator.apiKey')
    case 'CRON': return t('workflows.runs.initiator.cron')
    case 'WEBHOOK': return initiator.public ? t('workflows.runs.initiator.publicWebhook') : t('workflows.runs.initiator.webhook')
    case 'DATA_EVENT': return t('workflows.runs.initiator.dataEvent')
    case 'EXECUTE_WORKFLOW': return t('workflows.runs.initiator.workflow')
    default: return t('workflows.runs.initiator.system')
  }
}
const relative = (value: string | null) => value ? formatDistanceToNow(new Date(value), { addSuffix: true, locale: ui.dateFns.value }) : '—'

// --- The open run: ?run= ---
const openRun = computed<string | undefined>({
  get: () => (typeof route.query.run === 'string' ? route.query.run : undefined),
  // Closed, the key leaves the address - not `run: undefined` beside the rest.
  set: (id) => {
    const { run: _closed, ...rest } = route.query
    void router.replace({ query: id ? { ...rest, run: id } : rest })
  }
})
</script>

<template>
  <PageShell embedded>
    <template #toolbar>
      <div class="flex flex-wrap items-center gap-2">
        <USelect
          v-model="status"
          :items="statusItems"
          value-key="value"
          :aria-label="t('common.status')"
          size="sm"
          class="w-36"
        />
        <USelect
          v-model="trigger"
          :items="triggerItems"
          value-key="value"
          :aria-label="t('workflows.runs.columns.trigger')"
          size="sm"
          class="w-40"
        />
        <USelect
          v-model="mode"
          :items="modeItems"
          value-key="value"
          :aria-label="t('workflows.runs.columns.mode')"
          size="sm"
          class="w-32"
        />
        <USelect
          v-model="version"
          :items="versionItems"
          value-key="value"
          :aria-label="t('workflows.runs.columns.version')"
          size="sm"
          class="w-28"
        />
        <USelect
          v-model="period"
          :items="periodItems"
          value-key="value"
          :aria-label="t('workflows.runs.filters.period')"
          size="sm"
          class="w-36"
        />
        <div class="flex-1" />
        <UTooltip :text="t('common.refresh')">
          <UButton
            icon="i-lucide-refresh-cw"
            color="neutral"
            variant="outline"
            size="sm"
            square
            :loading="refreshing"
            :aria-label="t('common.refresh')"
            @click="refreshRuns"
          />
        </UTooltip>
      </div>
    </template>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error.message"
    />
    <div
      v-else
      class="overflow-x-auto"
    >
      <UTable
        sticky
        :data="runs"
        :columns="columns"
        :loading="pending"
        :ui="{ tr: 'cursor-pointer' }"
        @select="(_e: Event, row: { original: WorkflowRunSummary }) => { openRun = row.original.id }"
      >
        <template #status-cell="{ row: { original: run } }">
          <UBadge
            :label="t(`workflows.runs.status.${run.status}`)"
            :color="runStatusColor(run.status)"
            variant="subtle"
            size="sm"
            :trailing-icon="run.hasHandledErrors ? 'i-lucide-triangle-alert' : undefined"
          />
        </template>
        <template #trigger-cell="{ row: { original: run } }">
          {{ t(`workflows.runs.trigger.${run.trigger}`) }}
        </template>
        <template #mode-cell="{ row: { original: run } }">
          {{ t(`workflows.runs.mode.${run.mode}`) }}
        </template>
        <template #version-cell="{ row: { original: run } }">
          {{ versionNumber(run.version) ? `v${versionNumber(run.version)}` : t('workflows.runs.draft') }}
        </template>
        <template #started-cell="{ row: { original: run } }">
          <span :title="run.startedAt ? dates.dateTime(run.startedAt) : undefined">{{ relative(run.startedAt) }}</span>
        </template>
        <template #duration-cell="{ row: { original: run } }">
          {{ runDuration(run) }}
        </template>
        <template #initiator-cell="{ row: { original: run } }">
          {{ initiatorLabel(run) }}
        </template>
        <template #error-cell="{ row: { original: run } }">
          <span
            v-if="errorPreview(run.error)"
            class="block truncate text-error"
          >{{ errorPreview(run.error) }}</span>
          <span
            v-else
            class="text-dimmed"
          >—</span>
        </template>
        <template #empty>
          <UEmpty
            variant="naked"
            icon="i-lucide-history"
            :title="t('workflows.runs.noRuns')"
          />
        </template>
      </UTable>
    </div>

    <template #footer>
      <TablePager
        v-model:page="page"
        v-model:page-size="prefs.pageSize"
        :total="total"
        :noun="t('workflows.runs.noun')"
        :plural="t('workflows.runs.nounPlural')"
        :page-size-options="[20, 50, 100]"
      />
    </template>

    <WorkflowRunSlideover
      v-model:run="openRun"
      :operations="operations"
      @changed="refresh()"
    />
  </PageShell>
</template>
