<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.generate-file` node's `configuration`: which
 * format to serialize `data` as (CSV or JSON) for export. `data` is a
 * literal JSON value with `{{operation.data.field}}` support (apps/server/
 * src/workflow-execution/templates.ts), same conversion every other
 * catalog field went through - a bare `{{stepKey.data}}` hands over the
 * whole referenced value (e.g. a Read records step's array result).
 */
export interface GenerateFileConfiguration {
  format?: 'csv' | 'json'
  data?: unknown
}

const props = defineProps<{ modelValue: GenerateFileConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: GenerateFileConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

const format = ref<'csv' | 'json'>('json')
const dataJson = ref('null')

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  format.value = props.modelValue.format ?? 'json'
  dataJson.value = JSON.stringify(props.modelValue.data ?? null, null, 2)
})

const dataError = computed(() => jsonError(dataJson.value))

function save() {
  if (dataError.value) return
  emit('save', { key: keyValue.value, configuration: { format: format.value, data: JSON.parse(dataJson.value) } })
  open.value = false
}
// A phone or tablet gets this editor fullscreen (AGENTS.md section 25, modals).
const isCompact = useCompactUi()
</script>

<template>
  <UModal
    v-model:open="open"
    :fullscreen="isCompact"
    :title="$t('workflows.generateFileModal.generateCsvJson')"
    :description="$t('workflows.generateFileModal.serializeDataForExport')"
    :ui="{ content: isCompact ? undefined : 'max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField :label="$t('workflows.generateFileModal.format')">
          <USelect
            v-model="format"
            :items="['csv', 'json']"
            class="w-40"
          />
        </UFormField>

        <UFormField
          :label="$t('workflows.generateFileModal.data')"
          :description="$t('workflows.generateFileModal.aJsonArrayObjectTo', { c0: '{{stepKey.data.field}}', c1: '{{start.data...}}' })"
          :error="dataError ?? undefined"
        >
          <UTextarea
            v-model="dataJson"
            :rows="6"
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
          :disabled="!keyValid || !!dataError"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
