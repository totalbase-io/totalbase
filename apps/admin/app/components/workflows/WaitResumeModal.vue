<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.wait-resume` node's `configuration`: how long
 * to suspend before continuing. Only the timed-wait half exists - a
 * signal-based resume (an external call waking the run early) is
 * permanently out of scope, not deferred: this engine's runs are
 * synchronous and never persisted mid-flight, so there's nothing an
 * external call could resume (see the handler's own doc comment,
 * wait-resume-handlers.ts). Keep waits short (seconds to a few minutes) -
 * the whole run still has to fit inside `workflows.max_run_duration_ms`.
 */
export interface WaitResumeConfiguration {
  waitSeconds?: number
}

const props = defineProps<{ modelValue: WaitResumeConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: WaitResumeConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

const waitSeconds = ref(60)

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  waitSeconds.value = props.modelValue.waitSeconds ?? 60
})

function save() {
  emit('save', { key: keyValue.value, configuration: { waitSeconds: waitSeconds.value } })
  open.value = false
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="$t('workflows.waitResumeModal.waitResume')"
    :description="$t('workflows.waitResumeModal.suspendTheRunForA')"
    :ui="{ content: 'max-w-md' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.waitResumeModal.waitTime')"
          required
          :description="$t('workflows.waitResumeModal.secondsToSuspendBeforeThe')"
        >
          <UInputNumber
            v-model="waitSeconds"
            :min="1"
            class="w-40"
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
