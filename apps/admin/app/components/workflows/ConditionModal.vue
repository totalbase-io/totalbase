<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.condition` node's `configuration` (Workflows.md §5.9):
 * an `input` evaluated against a
 * `filter` using the existing filter-object grammar (AGENTS.md section 7 "one
 * grammar, three uses" - reused here as its fourth use, via WhereField.vue,
 * rather than inventing a workflow-specific filter editor).
 *
 * `input` is a literal JSON value the author types directly - `{{operation
 * .data.field}}` expressions (apps/server/src/workflow-execution/
 * templates.ts) can appear anywhere inside it, resolved at run time
 * against any other step (Start included, as `{{start.data...}}`).
 * Reverted from the earlier literal/trigger-only hand-rolled picker (see
 * this file's own git history) once `{{...}}` became the
 * one cross-catalog convention for referencing another step's data - same
 * reasoning as CreateRecordsModal.vue's own doc comment. `filter` gets the
 * same treatment for free (WhereField's own JSON, resolved as part of this
 * whole configuration) - a comparison value can reference another step's
 * data too, not just `input` itself.
 *
 * Both fields are optional at draft time (Workflows.md §3.5 - "Condition
 * requires both input and a syntactically valid filter" is a completeness
 * rule, not a save-blocking one); this modal never blocks Save on an
 * incomplete condition.
 *
 * Uses UModal (not UDrawer) - operation configuration is edited through a
 * modal in this editor, keeping node config visually distinct from the
 * heavier drawers used elsewhere (SQL Console, table editing).
 */
export interface ConditionConfiguration {
  input?: unknown
  filter?: Record<string, unknown>
}

const props = defineProps<{ modelValue: ConditionConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: ConditionConfiguration }] }>()

const keyValue = ref('')
const inputJson = ref('null')
const filterJson = ref('{}')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  inputJson.value = JSON.stringify(props.modelValue.input ?? null, null, 2)
  filterJson.value = JSON.stringify(props.modelValue.filter ?? {}, null, 2)
})

const inputError = computed(() => jsonError(inputJson.value))
const filterError = computed(() => jsonError(filterJson.value))

function save() {
  if (inputError.value || filterError.value) return
  const configuration: ConditionConfiguration = { input: JSON.parse(inputJson.value) }
  const parsedFilter = JSON.parse(filterJson.value)
  if (parsedFilter && typeof parsedFilter === 'object' && Object.keys(parsedFilter).length > 0) configuration.filter = parsedFilter
  emit('save', { key: keyValue.value, configuration })
  open.value = false
}
// A phone or tablet gets this editor fullscreen (AGENTS.md section 25, modals).
const isCompact = useCompactUi()
</script>

<template>
  <UModal
    v-model:open="open"
    :fullscreen="isCompact"
    :title="$t('workflows.conditionModal.condition')"
    :description="$t('workflows.conditionModal.configureTheBranchThisNode')"
    :ui="{ content: isCompact ? undefined : 'max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.conditionModal.input')"
          :description="$t('workflows.conditionModal.anyJsonValueTheFilter', { c0: '{{stepKey.data.field}}', c1: '{{start.data...}}' })"
          :error="inputError ?? undefined"
        >
          <UTextarea
            v-model="inputJson"
            :rows="3"
            class="w-full font-mono"
          />
        </UFormField>

        <WhereField
          v-model="filterJson"
          :label="$t('workflows.conditionModal.filter')"
          :description="$t('workflows.conditionModal.evaluatedAgainstTheInputAbove', { c0: '{{stepKey.data.field}}' })"
          :error="filterError ?? undefined"
        />
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
          :disabled="!keyValid || !!inputError || !!filterError"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
