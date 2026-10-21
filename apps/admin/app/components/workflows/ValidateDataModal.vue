<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.validate-data` node's `configuration`
 * (Workflows.md §5.9.1): an `input` and the `rules` it must
 * satisfy, each a filter in the one filter grammar (WhereField.vue, AGENTS.md
 * section 7 - the same as ConditionModal.vue's `filter`) plus the message
 * reported when it fails. All rules pass: `next` with the input. Any fails:
 * the step fails with WORKFLOW_VALIDATION_FAILED listing every failed rule's
 * message - its `error` output when connected.
 *
 * `input` is a literal JSON value with `{{stepKey.data.field}}` templates,
 * like Condition's. Both fields are optional at draft time.
 */
export interface ValidateDataRule {
  filter: Record<string, unknown>
  message?: string
}

export interface ValidateDataConfiguration {
  input?: unknown
  rules?: ValidateDataRule[]
}

interface RuleDraft {
  id: number
  filterJson: string
  message: string
}

const props = defineProps<{ modelValue: ValidateDataConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: ValidateDataConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

const inputJson = ref('null')
const rules = ref<RuleDraft[]>([])
let nextRuleId = 0

function newRule(rule?: ValidateDataRule): RuleDraft {
  return { id: nextRuleId++, filterJson: JSON.stringify(rule?.filter ?? {}, null, 2), message: rule?.message ?? '' }
}

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  inputJson.value = JSON.stringify(props.modelValue.input ?? null, null, 2)
  const saved = Array.isArray(props.modelValue.rules) ? props.modelValue.rules : []
  rules.value = saved.length ? saved.map(rule => newRule(rule)) : [newRule()]
})

const inputError = computed(() => jsonError(inputJson.value))
const ruleErrors = computed(() => rules.value.map(rule => jsonError(rule.filterJson)))
const hasErrors = computed(() => !!inputError.value || ruleErrors.value.some(error => !!error))

function removeRule(id: number) {
  rules.value = rules.value.filter(rule => rule.id !== id)
}

function save() {
  if (hasErrors.value) return
  const configuration: ValidateDataConfiguration = { input: JSON.parse(inputJson.value) }
  const parsedRules = rules.value
    .map(rule => ({ filter: JSON.parse(rule.filterJson) as Record<string, unknown>, message: rule.message.trim() || undefined }))
    .filter(rule => rule.filter && typeof rule.filter === 'object' && Object.keys(rule.filter).length > 0)
  if (parsedRules.length) configuration.rules = parsedRules
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
    :title="$t('workflows.validateDataModal.validateData')"
    :description="$t('workflows.validateDataModal.checkAValueAgainstRules')"
    :ui="{ content: isCompact ? undefined : 'max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.validateDataModal.input')"
          :description="$t('workflows.validateDataModal.anyJsonValueTheRules', { c0: '{{stepKey.data.field}}', c1: '{{start.data...}}' })"
          :error="inputError ?? undefined"
        >
          <UTextarea
            v-model="inputJson"
            :rows="3"
            class="w-full font-mono"
          />
        </UFormField>

        <div class="space-y-3">
          <p class="text-sm font-medium">
            {{ $t('workflows.validateDataModal.rules') }}
          </p>
          <p class="text-sm text-muted">
            {{ $t('workflows.validateDataModal.eachRuleIsAFilter') }}
          </p>
          <div
            v-for="(rule, index) in rules"
            :key="rule.id"
            class="space-y-2 border-t border-default pt-3"
          >
            <div class="flex items-center justify-between">
              <span class="text-sm text-muted">{{ $t('workflows.validateDataModal.ruleN', { n: index + 1 }) }}</span>
              <UButton
                icon="i-lucide-trash-2"
                size="xs"
                color="neutral"
                variant="ghost"
                :aria-label="$t('workflows.validateDataModal.removeRuleN', { n: index + 1 })"
                @click="removeRule(rule.id)"
              />
            </div>
            <WhereField
              v-model="rule.filterJson"
              :label="$t('workflows.validateDataModal.filter')"
              :description="$t('workflows.validateDataModal.mustMatchTheInputA', { c0: '{{stepKey.data.field}}' })"
              :error="ruleErrors[index] ?? undefined"
            />
            <UFormField
              :label="$t('workflows.validateDataModal.message')"
              :description="$t('workflows.validateDataModal.reportedWhenThisRuleFails')"
            >
              <UInput
                v-model="rule.message"
                class="w-full"
              />
            </UFormField>
          </div>
          <UButton
            :label="$t('workflows.validateDataModal.addRule')"
            icon="i-lucide-plus"
            size="xs"
            color="neutral"
            variant="outline"
            @click="rules.push(newRule())"
          />
        </div>
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
          :disabled="!keyValid || hasErrors"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
