<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.for-each` node's `configuration` (Workflows.md §5.11):
 * one `items` value that must resolve to
 * an array at run time. The body itself isn't configured here - it's
 * drawn on the canvas by wiring the node's own "Item" output (see
 * WorkflowTree.vue/[id].vue's addStep(), which tags every step added under
 * that slot with `parent = this node's id`, per Workflows.md §3.4's explicit
 * body ownership).
 *
 * `items` is a literal JSON value with `{{operation.data.field}}` support
 * (apps/server/src/workflow-execution/templates.ts) - reverted from the
 * structured literal/trigger-data/prior-operation `Binding` picker this
 * modal used to have (the very last field in the whole catalog still on
 * that picker), same conversion every other field already went through.
 * The current loop item, once inside this step's own body, is referenced
 * with the reserved `{{item...}}` keyword, not configured here.
 */
export interface ForEachConfiguration {
  items?: unknown
}

const props = defineProps<{
  modelValue: ForEachConfiguration
  nodeKey: string
  existingKeys: string[]
}>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: ForEachConfiguration }] }>()

const keyValue = ref('')
const itemsJson = ref('[]')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  itemsJson.value = JSON.stringify(props.modelValue.items ?? [], null, 2)
})

const itemsError = computed(() => jsonError(itemsJson.value))

function save() {
  if (itemsError.value) return
  emit('save', { key: keyValue.value, configuration: { items: JSON.parse(itemsJson.value) } })
  open.value = false
}
// A phone or tablet gets this editor fullscreen (AGENTS.md section 25, modals).
const isCompact = useCompactUi()
// Template expressions as message params (a mustache can't hold `{{`).
const ITEM_HINT = { c0: '{{item...}}', c1: '{{item.name}}' }
</script>

<template>
  <UModal
    v-model:open="open"
    :fullscreen="isCompact"
    :title="$t('workflows.forEachModal.forEachItem')"
    :description="$t('workflows.forEachModal.runTheBodyOncePer')"
    :ui="{ content: isCompact ? undefined : 'max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.forEachModal.items')"
          required
          :description="$t('workflows.forEachModal.mustResolveToAJson', { c0: '{{stepKey.data.field}}', c1: '{{start.data...}}' })"
          :error="itemsError ?? undefined"
        >
          <UTextarea
            v-model="itemsJson"
            :rows="4"
            class="w-full font-mono"
          />
        </UFormField>

        <p class="text-xs text-dimmed">
          {{ $t('workflows.forEachModal.wireThisStepSItem', ITEM_HINT) }}
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
          :disabled="!keyValid || !!itemsError"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
