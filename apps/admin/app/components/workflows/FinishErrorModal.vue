<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.finish-error` node's `configuration`: a message
 * and optional code to stop the run with. Terminal node - the tree
 * renderer (WorkflowTree.vue's TERMINAL_TYPES) gives it no outputs at
 * all, not even a "next" slot.
 */
export interface FinishErrorConfiguration {
  message?: string
  code?: string
}

const props = defineProps<{ modelValue: FinishErrorConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: FinishErrorConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

const message = ref('')
const code = ref('')

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  message.value = props.modelValue.message ?? ''
  code.value = props.modelValue.code ?? ''
})

function save() {
  emit('save', { key: keyValue.value, configuration: { message: message.value, code: code.value || undefined } })
  open.value = false
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="$t('workflows.finishErrorModal.finishWithError')"
    :description="$t('workflows.finishErrorModal.stopTheRunWithA')"
    :ui="{ content: 'max-w-md' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.finishErrorModal.message')"
          required
          :description="$t('workflows.finishErrorModal.referenceAnotherStepSResult', { c0: '{{stepKey.data.field}}', c1: '{{start.data...}}' })"
        >
          <UTextarea
            v-model="message"
            :rows="3"
            class="w-full"
          />
        </UFormField>

        <UFormField
          :label="$t('workflows.finishErrorModal.code')"
          :description="$t('workflows.finishErrorModal.optionalAShortMachineReadable')"
        >
          <UInput
            v-model="code"
            class="w-full font-mono"
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
          color="error"
          :disabled="!message || !keyValid"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
