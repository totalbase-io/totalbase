<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.process-batches` node's `configuration`:
 * `source` - a literal JSON value with `{{operation.data.field}}` support
 * (apps/server/src/workflow-execution/templates.ts) that must resolve to
 * a JSON array at run time - split into fixed-size `batchSize` chunks.
 * Same shape as `totalbase.for-each`'s own `items` (ForEachModal.vue) -
 * the body runs once per batch instead of once per element (engine.ts's
 * shared `runLoopOperation()`), wired via the node's own "Batch" output
 * the same way For each wires "Item". The current batch, once inside this
 * step's own body, is referenced with the reserved `{{item...}}` keyword.
 */
export interface ProcessBatchesConfiguration {
  batchSize?: number
  source?: unknown
}

const props = defineProps<{ modelValue: ProcessBatchesConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: ProcessBatchesConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

const batchSize = ref(50)
const sourceJson = ref('[]')

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  batchSize.value = props.modelValue.batchSize ?? 50
  sourceJson.value = JSON.stringify(props.modelValue.source ?? [], null, 2)
})

const sourceError = computed(() => jsonError(sourceJson.value))

function save() {
  if (sourceError.value) return
  emit('save', { key: keyValue.value, configuration: { batchSize: batchSize.value, source: JSON.parse(sourceJson.value) } })
  open.value = false
}
// A phone or tablet gets this editor fullscreen (AGENTS.md section 25, modals).
const isCompact = useCompactUi()
// Template expressions as message params (a mustache can't hold `{{`).
const ITEM_HINT = { c0: '{{item...}}', c1: '{{item.0.name}}' }
</script>

<template>
  <UModal
    v-model:open="open"
    :fullscreen="isCompact"
    :title="$t('workflows.processBatchesModal.processInBatches')"
    :description="$t('workflows.processBatchesModal.splitACollectionIntoFixed')"
    :ui="{ content: isCompact ? undefined : 'max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.processBatchesModal.batchSize')"
          required
        >
          <UInputNumber
            v-model="batchSize"
            :min="1"
            class="w-40"
          />
        </UFormField>

        <UFormField
          :label="$t('workflows.processBatchesModal.source')"
          :description="$t('workflows.processBatchesModal.mustResolveToAJson', { c0: '{{stepKey.data.field}}', c1: '{{start.data...}}' })"
          :error="sourceError ?? undefined"
        >
          <UTextarea
            v-model="sourceJson"
            :rows="4"
            class="w-full font-mono"
          />
        </UFormField>

        <p class="text-xs text-dimmed">
          {{ $t('workflows.processBatchesModal.wireThisStepSBatch', ITEM_HINT) }}
        </p>
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
          :disabled="!keyValid || !!sourceError"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
