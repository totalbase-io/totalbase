<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.finish-result` node's `configuration`: a static
 * JSON result to stop the run with. Terminal node - see FinishErrorModal's
 * own doc comment.
 */
export interface FinishResultConfiguration {
  result?: unknown
}

const props = defineProps<{ modelValue: FinishResultConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: FinishResultConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

const resultJson = ref('{}')

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  resultJson.value = JSON.stringify(props.modelValue.result ?? {}, null, 2)
})

const resultError = computed(() => jsonError(resultJson.value))
const editorRef = ref<{ format: () => void } | null>(null)

function save() {
  const result = resultError.value ? {} : JSON.parse(resultJson.value)
  emit('save', { key: keyValue.value, configuration: { result } })
  open.value = false
}
// A phone or tablet gets this editor fullscreen (AGENTS.md section 25, modals).
const isCompact = useCompactUi()
</script>

<template>
  <UModal
    v-model:open="open"
    :fullscreen="isCompact"
    :title="$t('workflows.finishResultModal.finishWithResult')"
    :description="$t('workflows.finishResultModal.stopTheRunWithAn')"
    :ui="{ content: isCompact ? undefined : 'max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.finishResultModal.result')"
          :error="resultError ?? undefined"
          :description="$t('workflows.finishResultModal.anyJsonValueReferenceAnother', { c0: '{{stepKey.data.field}}', c1: '{{start.data...}}' })"
        >
          <div class="flex items-center justify-end gap-1 pb-2">
            <UButton
              :label="$t('workflows.finishResultModal.format')"
              icon="i-lucide-wand-sparkles"
              size="xs"
              color="neutral"
              variant="ghost"
              @click="editorRef?.format()"
            />
          </div>
          <JsonEditor
            ref="editorRef"
            v-model="resultJson"
            min-height="10rem"
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
          :disabled="!keyValid"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
