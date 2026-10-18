<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.create-records` node's `configuration`: a
 * selected exposed TABLE plus the record(s) payload to insert. `records`
 * is a literal JSON array the author types directly - `{{operation.data.
 * field}}` expressions (apps/server/src/workflow-execution/templates.ts)
 * can appear anywhere inside it, at any nesting depth, resolved at run
 * time against any other step in the workflow (Start included, addressed
 * as `{{start.data...}}`). Replaces the earlier structured-Binding picker
 * (WorkflowBindingField.vue) for this field specifically: that model
 * forced the WHOLE field to come from exactly
 * one source, which couldn't express `{"name": "{{start.data.name}}",
 * "source": "workflow"}` (literal and dynamic mixed in the same object).
 *
 * Uses UModal, same as ReadRecordsModal.vue/ConditionModal.vue.
 */

export interface CreateRecordsConfiguration {
  resource?: string
  records?: unknown
  emitEvents?: boolean
}

const props = defineProps<{ modelValue: CreateRecordsConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: CreateRecordsConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))
const emitEvents = ref(false)

const { resources } = useResourcesList()
const resourceOptions = computed(() =>
  (resources.value ?? [])
    .filter(r => r.status === 'ACTIVE' && r.type === 'TABLE' && r.exposedMethods.includes('POST'))
    .map(r => ({ label: `${r.schema}.${r.name}`, value: r.id }))
    .sort((a, b) => a.label.localeCompare(b.label)))

const resourceId = ref<string | undefined>(undefined)
const recordsJson = ref('[]')

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  resourceId.value = props.modelValue.resource
  recordsJson.value = JSON.stringify(props.modelValue.records ?? [], null, 2)
  emitEvents.value = props.modelValue.emitEvents ?? false
})

const recordsError = computed(() => jsonError(recordsJson.value))

function save() {
  if (recordsError.value) return
  emit('save', { key: keyValue.value, configuration: { resource: resourceId.value, records: JSON.parse(recordsJson.value), emitEvents: emitEvents.value } })
  open.value = false
}
// A phone or tablet gets this editor fullscreen (AGENTS.md section 25, modals).
const isCompact = useCompactUi()
</script>

<template>
  <UModal
    v-model:open="open"
    :fullscreen="isCompact"
    :title="$t('workflows.createRecordsModal.createRecords')"
    :description="$t('workflows.createRecordsModal.insertOneOrMoreRecords')"
    :ui="{ content: isCompact ? undefined : 'max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.createRecordsModal.resource')"
          required
          :description="$t('workflows.createRecordsModal.onlyActiveTableResourcesWritable')"
        >
          <USelectMenu
            v-model="resourceId"
            :items="resourceOptions"
            value-key="value"
            searchable
            class="w-full"
          />
        </UFormField>

        <UFormField
          :label="$t('workflows.createRecordsModal.records')"
          :description="$t('workflows.createRecordsModal.aJsonArrayOneObject', { c0: '{{stepKey.data.field}}', c1: '{{start.data...}}', c2: '{{stepKey.data[0].field}}' })"
          :error="recordsError ?? undefined"
        >
          <JsonEditor
            v-model="recordsJson"
            min-height="10rem"
          />
        </UFormField>

        <UFormField
          :label="$t('workflows.createRecordsModal.emitDatabaseEvents')"
          :description="$t('workflows.createRecordsModal.letThisStepSInserts')"
        >
          <USwitch v-model="emitEvents" />
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
          :disabled="!resourceId || !keyValid || !!recordsError"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
