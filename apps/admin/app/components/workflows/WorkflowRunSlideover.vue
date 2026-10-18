<script setup lang="ts">
/**
 * One run beside the runs table (Specification_Workflows.md §16.3): a USlideover - looking something up, the table
 * stays visible (AGENTS.md §25) - with the run's summary, its result or error, its steps, and one step's detail
 * (input, result, error) with Back. Cancel while it runs (§8.5, cooperative), and Audit entries - the audit log
 * filtered to the run (§7.4). `run` is the open run's id; none closes it.
 */
import WorkflowRunSummaryCard from '~/components/workflows/WorkflowRunSummaryCard.vue'
import WorkflowRunStepHeader from '~/components/workflows/WorkflowRunStepHeader.vue'
import WorkflowRunStepDetail from '~/components/workflows/WorkflowRunStepDetail.vue'
import type { WorkflowRunOutcome, WorkflowRunStep, WorkflowRunStepName, WorkflowRunSummary } from '~/utils/workflow-runs'

const props = defineProps<{
  operations?: { id: string, key: string, label: string }[]
}>()
const runId = defineModel<string | undefined>('run')
const emit = defineEmits<{ changed: [] }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()

const open = computed({
  get: () => runId.value !== undefined,
  set: (value: boolean) => {
    if (!value) runId.value = undefined
  }
})
const run = ref<WorkflowRunSummary | null>(null)
const steps = ref<WorkflowRunStep[]>([])
const step = ref<WorkflowRunStep | null>(null)
const loading = ref(false)

async function load(id: string) {
  loading.value = true
  try {
    const { data } = await api.get<WorkflowRunOutcome>(`/workflows/runs/${id}`)
    run.value = data.run
    steps.value = data.steps
  } catch (error) {
    notifyError(error, t('workflows.runs.loadError'))
    runId.value = undefined
  } finally {
    loading.value = false
  }
}
watch(runId, (id) => {
  step.value = null
  if (id) void load(id)
  else {
    run.value = null
    steps.value = []
  }
}, { immediate: true })
// In progress: followed until it ends.
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    if (runId.value && (run.value?.status === 'RUNNING' || run.value?.status === 'PENDING')) void load(runId.value)
  }, 3000)
})
onUnmounted(() => clearInterval(timer))

const canceling = ref(false)
async function cancelRun() {
  if (!run.value) return
  const id = run.value.id
  canceling.value = true
  try {
    await api.post(`/workflows/runs/${id}/cancel`)
    toast.add({ title: t('workflows.runs.cancelRequested'), description: t('workflows.runs.cancelRequestedDescription'), color: 'success' })
    await new Promise(resolve => setTimeout(resolve, 1000))
    if (runId.value === id) await load(id)
    emit('changed')
  } catch (error) {
    notifyError(error, t('workflows.runs.cancelFailed'))
  } finally {
    canceling.value = false
  }
}
function stepName(item: WorkflowRunStep): WorkflowRunStepName | undefined {
  const operation = props.operations?.find(o => o.id === item.operation)
  return operation && { label: operation.label, key: operation.key }
}
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="step ? t('workflows.runs.stepDetail') : t('workflows.runs.runDetail')"
    :ui="{ content: 'max-w-lg' }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UEmpty
          v-if="loading && !run"
          loading
          variant="naked"
          size="sm"
        />
        <template v-else-if="run && !step">
          <div
            class="flex items-center justify-end gap-2"
          >
            <UButton
              :label="t('workflows.runs.auditEntries')"
              icon="i-lucide-scroll-text"
              size="xs"
              color="neutral"
              variant="outline"
              :to="{ path: '/logs', query: { workflow_run: run.id, range: 'all' } }"
            />
            <UButton
              v-if="run.status === 'RUNNING'"
              :label="t('workflows.runs.cancelRun')"
              icon="i-lucide-circle-stop"
              size="xs"
              color="error"
              variant="outline"
              :loading="canceling"
              @click="cancelRun"
            />
          </div>
          <WorkflowRunSummaryCard :run="run" />
          <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">
            {{ t('workflows.runs.steps') }}
          </h3>
          <p
            v-if="run.historyLevel === 'SUMMARY'"
            class="text-xs text-muted"
          >
            {{ t('workflows.runs.summaryHistory') }}
          </p>
          <component
            :is="run.historyLevel === 'SUMMARY' ? 'div' : 'button'"
            v-for="item in steps"
            :key="item.id"
            :type="run.historyLevel === 'SUMMARY' ? undefined : 'button'"
            class="flex w-full items-center justify-between gap-3 rounded-lg border border-default px-3 py-2 text-left"
            :class="run.historyLevel === 'SUMMARY' ? 'opacity-60' : 'hover:bg-elevated'"
            @click="run.historyLevel === 'SUMMARY' ? undefined : (step = item)"
          >
            <WorkflowRunStepHeader
              :step="item"
              :name="stepName(item)"
            />
            <UIcon
              v-if="run.historyLevel !== 'SUMMARY'"
              name="i-lucide-chevron-right"
              class="size-4 shrink-0 text-muted"
            />
          </component>
          <p
            v-if="steps.length === 0"
            class="text-sm text-muted"
          >
            {{ t('workflows.runs.noSteps') }}
          </p>
        </template>
        <template v-else-if="step">
          <UButton
            :label="t('workflows.runs.backToRun')"
            icon="i-lucide-arrow-left"
            size="xs"
            color="neutral"
            variant="ghost"
            class="self-start"
            @click="step = null"
          />
          <div class="flex flex-col gap-3 rounded-lg border border-default p-3">
            <WorkflowRunStepHeader
              :step="step"
              :name="stepName(step)"
            />
            <WorkflowRunStepDetail :step="step" />
          </div>
        </template>
      </div>
    </template>
  </USlideover>
</template>
