<script setup lang="ts">
import WorkflowRunSummaryCard from '~/components/workflows/WorkflowRunSummaryCard.vue'
import WorkflowRunStepHeader from '~/components/workflows/WorkflowRunStepHeader.vue'
import WorkflowRunStepDetail from '~/components/workflows/WorkflowRunStepDetail.vue'

/**
 * The editor's "Test run" and "Run" (specs/Specification_Workflows.md §11):
 * the trigger input as JSON, a Run button, and the run it
 * produced - status, final result or error, each step expandable to its
 * input/result/error - in the same modal.
 *
 * - `TEST` runs the saved draft (POST /workflows/:id/test-run): a real run,
 *   as the calling admin, marked TEST, never publishing or enabling.
 * - `PRODUCTION` runs the live version (POST /workflows/:id/run), enabled +
 *   published - the server answers 409 WORKFLOW_DISABLED otherwise, shown as
 *   is. A MANUAL workflow runs as the admin with the typed input; a CRON one
 *   (`scheduled`) as its schedule would, so the input editor is hidden.
 *
 * Both answer `{ run, steps }` (Specification_Workflows.md §11.3) with live, unredacted values,
 * whatever the history level. The run and its steps render through the same
 * components as the Logs slideover's run detail.
 */
const props = defineProps<{
  workflowId: string
  mode: 'TEST' | 'PRODUCTION'
  /** The live version's number, for the PRODUCTION description. */
  liveVersion?: number | null
  /** A PRODUCTION run of a CRON workflow: it runs as its schedule would - as its execution user, with the schedule data - so it takes no input. */
  scheduled?: boolean
  /** Names each step by its operation's label and key (the definition this mode runs). */
  operations?: { id: string, key: string, label: string }[]
  /** Runs before the request - the editor saves the draft first; a throw stops the run. */
  prepare?: () => Promise<void>
  /** The Start's configuration - a MANUAL one's input form and confirmation (Specification_Workflows.md §6.2). */
  startConfiguration?: Record<string, unknown>
}>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ 'open-logs': [runId: string] }>()
/**
 * Open in Runs: the modal closes first, and the run opens once it has - navigating while it still closes left its
 * layer on top, so the run's slideover never got its Close or Esc (Beta_Findings 1.16).
 */
const logsRun = ref<string | null>(null)
function openInLogs(runId: string) {
  logsRun.value = runId
  open.value = false
}
function afterLeave() {
  const runId = logsRun.value
  logsRun.value = null
  if (runId) emit('open-logs', runId)
}

const api = useAdminApi()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const isCompact = useCompactUi()

// The input survives closing and reopening the modal - testing the same
// payload again after an edit to the canvas is the common loop.
const inputJson = ref('{}')
const inputError = computed(() => jsonError(inputJson.value))
const editorRef = ref<{ format: () => void } | null>(null)

// A MANUAL Start's input form: its fields instead of the JSON editor, and its confirmation before Run.
interface InputField { name: string, label?: string, type: 'text' | 'number' | 'boolean' | 'date', required?: boolean }
const inputFields = computed<InputField[]>(() => Array.isArray(props.startConfiguration?.input_fields) ? props.startConfiguration.input_fields as InputField[] : [])
const confirmMessage = computed(() => typeof props.startConfiguration?.confirm_message === 'string' ? props.startConfiguration.confirm_message : '')
const formValues = ref<Record<string, unknown>>({})
const formValid = computed(() => inputFields.value.every(f => !f.required || (formValues.value[f.name] !== undefined && formValues.value[f.name] !== null && formValues.value[f.name] !== '')))
const numberValue = (name: string) => (typeof formValues.value[name] === 'number' ? formValues.value[name] as number : undefined)
const textValue = (name: string) => (typeof formValues.value[name] === 'string' ? formValues.value[name] as string : '')
const confirmOpen = ref(false)
function requestRun() {
  if (confirmMessage.value && props.mode === 'PRODUCTION') confirmOpen.value = true
  else void run()
}

const running = ref(false)
const outcome = ref<WorkflowRunOutcome | null>(null)
const requestError = ref<string | null>(null)
const expanded = ref<Set<string>>(new Set())

watch(open, (value) => {
  if (!value) return
  outcome.value = null
  requestError.value = null
  expanded.value = new Set()
})

const title = computed(() => props.mode === 'TEST' ? t('workflows.workflowRunModal.testRunTitle') : t('workflows.workflowRunModal.runTitle'))
const description = computed(() => props.mode === 'TEST'
  ? t('workflows.workflowRunModal.testDescription')
  : props.scheduled
    ? t('workflows.workflowRunModal.scheduledDescription', { version: props.liveVersion ? ` v${props.liveVersion}` : '', path: '{{start.data.scheduled_at}}' })
    : t('workflows.workflowRunModal.productionDescription', { version: props.liveVersion ? ` v${props.liveVersion}` : '' }))

async function run() {
  confirmOpen.value = false
  if (inputFields.value.length === 0 && inputError.value && !props.scheduled) return
  if (inputFields.value.length > 0 && !formValid.value) return
  running.value = true
  outcome.value = null
  requestError.value = null
  try {
    if (props.prepare) {
      try {
        await props.prepare()
      } catch (error) {
        const reason = error instanceof Error && error.message ? errorMessage(error, error.message) : ''
        requestError.value = reason ? t('workflows.workflowRunModal.draftNotSavedReason', { reason }) : t('workflows.workflowRunModal.draftNotSaved')
        return
      }
    }
    const path = props.mode === 'TEST' ? 'test-run' : 'run'
    const { data } = await api.post<WorkflowRunOutcome>(`/workflows/${props.workflowId}/${path}`, { data: props.scheduled ? null : inputFields.value.length > 0 ? formValues.value : JSON.parse(inputJson.value) })
    outcome.value = data
    // A failed step opens on its own - that's what the author came to read.
    expanded.value = new Set(data.steps.filter(s => s.status === 'FAILED').map(s => s.id))
  } catch (error) {
    requestError.value = errorMessage(error, error instanceof Error ? error.message : t('workflows.workflowRunModal.couldNotStart'))
  } finally {
    running.value = false
  }
}

function toggle(stepId: string) {
  const next = new Set(expanded.value)
  if (next.has(stepId)) next.delete(stepId)
  else next.add(stepId)
  expanded.value = next
}
function stepName(step: WorkflowRunStep): WorkflowRunStepName | undefined {
  const operation = props.operations?.find(o => o.id === step.operation)
  return operation && { label: operation.label, key: operation.key }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :fullscreen="isCompact"
    :title="title"
    :description="description"
    :ui="{ content: isCompact ? undefined : 'max-w-3xl' }"
    @after:leave="afterLeave"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <template v-if="!scheduled && inputFields.length > 0">
          <UFormField
            v-for="field in inputFields"
            :key="field.name"
            :label="field.label || field.name"
            :required="field.required"
          >
            <USwitch
              v-if="field.type === 'boolean'"
              :model-value="formValues[field.name] === true"
              :aria-label="field.label || field.name"
              @update:model-value="(v: boolean) => formValues[field.name] = v"
            />
            <UInputNumber
              v-else-if="field.type === 'number'"
              :model-value="numberValue(field.name)"
              class="w-full"
              @update:model-value="(v: number | null) => formValues[field.name] = v"
            />
            <UInput
              v-else
              :model-value="textValue(field.name)"
              :type="field.type === 'date' ? 'date' : 'text'"
              class="w-full"
              @update:model-value="(v: string | number) => formValues[field.name] = String(v)"
            />
          </UFormField>
        </template>
        <UFormField
          v-else-if="!scheduled"
          :label="$t('workflows.workflowRunModal.triggerInput')"
          :error="inputError ?? undefined"
          :description="$t('workflows.workflowRunModal.anyJsonValueTheRun', { c0: '{{start.data}}' })"
        >
          <div class="flex items-center justify-end gap-1 pb-2">
            <UButton
              :label="$t('workflows.workflowRunModal.format')"
              icon="i-lucide-wand-sparkles"
              size="xs"
              color="neutral"
              variant="ghost"
              @click="editorRef?.format()"
            />
          </div>
          <JsonEditor
            ref="editorRef"
            v-model="inputJson"
            min-height="8rem"
          />
        </UFormField>

        <UEmpty
          v-if="running"
          loading
          variant="naked"
          size="sm"
          :title="$t('workflows.workflowRunModal.running')"
        />
        <UAlert
          v-else-if="requestError"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="$t('workflows.workflowRunModal.theRunDidNotStart')"
          :description="requestError"
        />
        <section
          v-else-if="outcome"
          class="flex flex-col gap-3"
          :aria-label="$t('workflows.workflowRunModal.runResult')"
        >
          <WorkflowRunSummaryCard :run="outcome.run" />
          <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">
            {{ $t('workflows.workflowRunModal.steps') }}
          </h3>
          <div
            v-for="step in outcome.steps"
            :key="step.id"
            class="rounded-lg border border-default"
          >
            <button
              type="button"
              class="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-elevated"
              :aria-expanded="expanded.has(step.id)"
              @click="toggle(step.id)"
            >
              <WorkflowRunStepHeader
                :step="step"
                :name="stepName(step)"
              />
              <UIcon
                name="i-lucide-chevron-down"
                class="size-4 shrink-0 text-muted transition-transform"
                :class="expanded.has(step.id) ? 'rotate-180' : undefined"
              />
            </button>
            <div
              v-if="expanded.has(step.id)"
              class="border-t border-default p-3"
            >
              <WorkflowRunStepDetail :step="step" />
            </div>
          </div>
          <p
            v-if="outcome.steps.length === 0"
            class="text-sm text-muted"
          >
            {{ $t('workflows.workflowRunModal.theRunRecordedNoSteps') }}
          </p>
        </section>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <UButton
          v-if="outcome"
          :label="$t('workflows.workflowRunModal.openInLogs')"
          icon="i-lucide-scroll-text"
          color="neutral"
          variant="ghost"
          @click="openInLogs(outcome.run.id)"
        />
        <span v-else />
        <UPopover v-model:open="confirmOpen">
          <UButton
            :label="mode === 'TEST' ? t('workflows.workflowRunModal.runTest') : t('workflows.workflowRunModal.runTitle')"
            icon="i-lucide-play"
            :loading="running"
            :disabled="!scheduled && (inputFields.length > 0 ? !formValid : Boolean(inputError))"
            @click="requestRun"
          />
          <template #content>
            <div class="flex max-w-72 flex-col gap-2 p-3">
              <p class="text-sm">
                {{ confirmMessage }}
              </p>
              <div class="flex justify-end gap-2">
                <UButton
                  :label="$t('common.cancel')"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  @click="confirmOpen = false"
                />
                <UButton
                  :label="$t('workflows.workflowRunModal.runIt')"
                  size="xs"
                  @click="run"
                />
              </div>
            </div>
          </template>
        </UPopover>
      </div>
    </template>
  </UModal>
</template>
