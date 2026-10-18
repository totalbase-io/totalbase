<script setup lang="ts">
/**
 * The "Step ID" field every configurable operation's modal shows first -
 * the short reference id other steps will use to point at this one's
 * output once the execution engine (and its expression syntax) exists.
 * Shared here rather than duplicated per modal since the field, its
 * sanitization (InputPgIdentifier), and its uniqueness rule are identical
 * everywhere - only the sibling keys to validate against differ per node.
 *
 * Start is deliberately never one of this field's callers - its key is
 * fixed to "start" server-side, not user-edited (see workflow-tree-
 * context.ts's own doc comment on DraftNode.key).
 */
const modelValue = defineModel<string>({ required: true })
const props = defineProps<{
  /** Every OTHER step's key in this workflow - flags a collision the moment this one matches. */
  existingKeys: string[]
}>()

const { t } = useI18n()

const error = computed(() => {
  if (!modelValue.value) return t('workflows.workflowStepKeyField.required')
  if (modelValue.value === 'start') return t('workflows.workflowStepKeyField.reservedStart')
  if (modelValue.value === 'item') return t('workflows.workflowStepKeyField.reservedItem', { expression: '{{...}}' })
  if (modelValue.value === 'error') return t('workflows.workflowStepKeyField.reservedError', { expression: '{{...}}' })
  if (props.existingKeys.includes(modelValue.value)) return t('workflows.workflowStepKeyField.alreadyUsed')
  return null
})

defineExpose({ valid: computed(() => error.value === null) })
</script>

<template>
  <UFormField
    :label="$t('workflows.workflowStepKeyField.stepId')"
    required
    :error="error ?? undefined"
    :description="$t('workflows.workflowStepKeyField.shortIdOtherStepsUse')"
  >
    <InputPgIdentifier
      v-model="modelValue"
      maxlength="20"
      class="w-full"
    />
  </UFormField>
</template>
