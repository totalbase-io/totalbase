<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.execute-workflow` node's `configuration`:
 * another workflow to invoke, plus `input` - literal JSON passed as that
 * workflow's own trigger data, with `{{operation.data.field}}` support
 * (apps/server/src/workflow-execution/templates.ts) anywhere inside it.
 *
 * Only MANUAL- or CRON-triggered workflows can be targeted (agreed with
 * the user) - a DATA_EVENT target expects a real captured mutation record
 * (Specification_Workflows.md §6.3), which doesn't exist here, and a WEBHOOK target's own
 * `{query, body}`/access-mode/rate-limit contract is an HTTP-layer concern
 * this internal call has no use for (a workflow that wants both external
 * and internal reachability just uses MANUAL for that). The picker below
 * filters accordingly, alongside excluding this workflow itself - see
 * execute-workflow.ts's own doc comment for why (the server enforces the
 * same rules independently; this is just avoiding an obviously-invalid
 * choice at author time).
 */
interface WorkflowListItem {
  id: string
  name: string
  triggerType?: string | null
}

export interface ExecuteWorkflowConfiguration {
  workflow?: string
  input?: unknown
}

const props = defineProps<{ modelValue: ExecuteWorkflowConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: ExecuteWorkflowConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

const route = useRoute()
const api = useAdminApi()
const { data: workflows } = useAsyncData('execute-workflow-list', () =>
  api.get<WorkflowListItem[]>('/workflows').then(r => r.data), { default: () => [] })
// A workflow calling itself would recurse without a base case the engine
// has no way to enforce yet - excluded from the picker entirely rather
// than allowed and left to fail loudly later. Only MANUAL/CRON targets -
// see this file's own doc comment.
const workflowOptions = computed(() =>
  (workflows.value ?? [])
    .filter(w => w.id !== route.params.id && (w.triggerType === 'MANUAL' || w.triggerType === 'CRON'))
    .map(w => ({ label: w.name, value: w.id }))
    .sort((a, b) => a.label.localeCompare(b.label)))

const workflowId = ref<string | undefined>(undefined)
const inputJson = ref('null')

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  workflowId.value = props.modelValue.workflow
  inputJson.value = JSON.stringify(props.modelValue.input ?? null, null, 2)
})

const inputError = computed(() => jsonError(inputJson.value))

function save() {
  if (inputError.value) return
  emit('save', { key: keyValue.value, configuration: { workflow: workflowId.value, input: JSON.parse(inputJson.value) } })
  open.value = false
}
// A phone or tablet gets this editor fullscreen (AGENTS.md section 25, modals).
const isCompact = useCompactUi()
</script>

<template>
  <UModal
    v-model:open="open"
    :fullscreen="isCompact"
    :title="$t('workflows.executeWorkflowModal.executeAnotherWorkflow')"
    :description="$t('workflows.executeWorkflowModal.reuseAProcess')"
    :ui="{ content: isCompact ? undefined : 'max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.executeWorkflowModal.workflow')"
          required
        >
          <USelectMenu
            v-model="workflowId"
            :items="workflowOptions"
            value-key="value"
            searchable
            class="w-full"
          />
        </UFormField>

        <UFormField
          :label="$t('workflows.executeWorkflowModal.input')"
          :description="$t('workflows.executeWorkflowModal.passedAsTheInvokedWorkflow', { c0: '{{stepKey.data.field}}', c1: '{{start.data...}}' })"
          :error="inputError ?? undefined"
        >
          <JsonEditor
            v-model="inputJson"
            min-height="8rem"
          />
        </UFormField>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="$t('common.cancel')"
          @click="open = false"
        />
        <UButton
          :label="$t('common.save')"
          :disabled="!workflowId || !keyValid || !!inputError"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
