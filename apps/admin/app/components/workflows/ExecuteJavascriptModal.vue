<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.execute-javascript` node's `configuration`: a
 * plain JavaScript source string, edited via the shared CodeEditor.vue
 * (same Monaco instance DataView controllers use). Runs in a genuinely
 * isolated V8 isolate (`isolated-vm`, see code-handlers.ts's own doc
 * comment) with exactly two globals - `trigger` and `results` - and no
 * `fs`/network/`process`/`require` access at all. The step's own return
 * value must be plain JSON data (no functions, class instances, `Map`/
 * `Set`, or circular references) - enforced by a JSON round-trip inside
 * the isolate itself, not just a convention.
 */
export interface ExecuteJavascriptConfiguration {
  code?: string
}

const props = defineProps<{ modelValue: ExecuteJavascriptConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: ExecuteJavascriptConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

const code = ref('')

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  code.value = props.modelValue.code ?? ''
})

function save() {
  emit('save', { key: keyValue.value, configuration: { code: code.value } })
  open.value = false
}
// A phone or tablet gets this editor fullscreen (AGENTS.md section 25, modals).
const isCompact = useCompactUi()
</script>

<template>
  <UModal
    v-model:open="open"
    :fullscreen="isCompact"
    :title="$t('workflows.executeJavascriptModal.executeJavascript')"
    :description="$t('workflows.executeJavascriptModal.customLogicTransformationRunAs')"
    :ui="{ content: isCompact ? undefined : 'max-w-3xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.executeJavascriptModal.code')"
          :description="$t('workflows.executeJavascriptModal.runsInAnIsolatedSandbox')"
        >
          <CodeEditor
            v-model="code"
            language="javascript"
            min-height="16rem"
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
