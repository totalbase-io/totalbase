<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.execute-function` node's `configuration`: a
 * selected exposed FUNCTION resource plus its call `arguments` - literal
 * JSON that must resolve to an object at run time, with `{{operation.data
 * .field}}` support (apps/server/src/workflow-execution/templates.ts)
 * anywhere inside it.
 */

export interface ExecuteFunctionConfiguration {
  function?: string
  arguments?: unknown
}

const props = defineProps<{ modelValue: ExecuteFunctionConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: ExecuteFunctionConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

const { resources } = useResourcesList()
const functionOptions = computed(() =>
  (resources.value ?? [])
    .filter(r => r.status === 'ACTIVE' && r.type === 'FUNCTION' && r.exposedMethods.includes('POST'))
    .map(r => ({ label: `${r.schema}.${r.name}`, value: r.id }))
    .sort((a, b) => a.label.localeCompare(b.label)))

const functionId = ref<string | undefined>(undefined)
const argsJson = ref('{}')

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  functionId.value = props.modelValue.function
  argsJson.value = JSON.stringify(props.modelValue.arguments ?? {}, null, 2)
})

const argsError = computed(() => jsonError(argsJson.value))

function save() {
  if (argsError.value) return
  emit('save', { key: keyValue.value, configuration: { function: functionId.value, arguments: JSON.parse(argsJson.value) } })
  open.value = false
}
// A phone or tablet gets this editor fullscreen (AGENTS.md section 25, modals).
const isCompact = useCompactUi()
</script>

<template>
  <UModal
    v-model:open="open"
    :fullscreen="isCompact"
    :title="$t('workflows.executeFunctionModal.executeFunction')"
    :description="$t('workflows.executeFunctionModal.invokeAPostgresqlFunctionExposed')"
    :ui="{ content: isCompact ? undefined : 'max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.executeFunctionModal.function')"
          required
          :description="$t('workflows.executeFunctionModal.onlyActiveFunctionResourcesInvokable')"
        >
          <USelectMenu
            v-model="functionId"
            :items="functionOptions"
            value-key="value"
            searchable
            class="w-full"
          />
        </UFormField>

        <UFormField
          :label="$t('workflows.executeFunctionModal.arguments')"
          :description="$t('workflows.executeFunctionModal.aJsonObjectArgumentNames', { c0: '{{stepKey.data.field}}', c1: '{{start.data...}}' })"
          :error="argsError ?? undefined"
        >
          <JsonEditor
            v-model="argsJson"
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
          :disabled="!functionId || !keyValid || !!argsError"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
