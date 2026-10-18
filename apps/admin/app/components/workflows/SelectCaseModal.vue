<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.select-case` node's `configuration` (Specification_Workflows.md §5.10):
 * an `input` plus an ORDERED list of named
 * cases, each its own filter (same grammar as Condition's, via
 * WhereField.vue) - the first case whose filter matches wins. An optional
 * `default` branch catches everything else; without one, no match is an
 * error (engine's own selectCase handler in handlers.ts).
 *
 * `input` is a literal JSON value with `{{operation.data.field}}` support,
 * same as ConditionModal.vue's own (see its doc comment for the full
 * reasoning) - reverted from the same literal/trigger-only picker this
 * modal used to share with it.
 */
export interface SelectCaseCase {
  /** The connection `output` value this case wires to - plain identifier, unique among cases, never "default" or "error". */
  output: string
  filter: Record<string, unknown>
}
export interface SelectCaseConfiguration {
  input?: unknown
  cases?: SelectCaseCase[]
  hasDefault?: boolean
}

const props = defineProps<{ modelValue: SelectCaseConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: SelectCaseConfiguration }] }>()

const keyValue = ref('')
const inputJson = ref('null')
const hasDefault = ref(false)
interface CaseRow { output: string, filterJson: string }
const cases = ref<CaseRow[]>([])
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  inputJson.value = JSON.stringify(props.modelValue.input ?? null, null, 2)
  hasDefault.value = props.modelValue.hasDefault ?? false
  cases.value = (props.modelValue.cases ?? []).map(c => ({ output: c.output, filterJson: JSON.stringify(c.filter, null, 2) }))
  if (cases.value.length === 0) cases.value.push({ output: 'case_1', filterJson: '{}' })
})

const inputError = computed(() => jsonError(inputJson.value))

const { t } = useI18n()
const OUTPUT_PATTERN = /^[a-z][a-z0-9_]*$/
function caseError(row: CaseRow, index: number): string | null {
  if (!OUTPUT_PATTERN.test(row.output)) return t('workflows.selectCaseModal.caseNamePattern')
  if (row.output === 'default' || row.output === 'error' || row.output === 'next') return t('workflows.selectCaseModal.reservedName')
  if (cases.value.some((c, i) => i !== index && c.output === row.output)) return t('workflows.selectCaseModal.duplicateName')
  try {
    const parsed = JSON.parse(row.filterJson)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) return t('workflows.selectCaseModal.filterEmpty')
  } catch { return t('workflows.json.invalid') }
  return null
}
const casesValid = computed(() => cases.value.length > 0 && cases.value.every((row, i) => !caseError(row, i)))

function addCase() {
  let n = cases.value.length + 1
  while (cases.value.some(c => c.output === `case_${n}`)) n++
  cases.value.push({ output: `case_${n}`, filterJson: '{}' })
}
function removeCase(index: number) {
  cases.value.splice(index, 1)
}
function moveCase(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= cases.value.length) return
  const [row] = cases.value.splice(index, 1)
  cases.value.splice(target, 0, row!)
}

function save() {
  if (inputError.value) return
  const configuration: SelectCaseConfiguration = {
    input: JSON.parse(inputJson.value),
    cases: cases.value.map(row => ({ output: row.output, filter: JSON.parse(row.filterJson) })),
    hasDefault: hasDefault.value
  }
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
    :title="$t('workflows.selectCaseModal.selectCase')"
    :description="$t('workflows.selectCaseModal.branchOnTheFirstMatching')"
    :ui="{ content: isCompact ? undefined : 'max-w-3xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.selectCaseModal.input')"
          :description="$t('workflows.selectCaseModal.anyJsonValueEachCase', { c0: '{{stepKey.data.field}}', c1: '{{start.data...}}' })"
          :error="inputError ?? undefined"
        >
          <UTextarea
            v-model="inputJson"
            :rows="3"
            class="w-full font-mono"
          />
        </UFormField>

        <div class="space-y-3">
          <div class="flex items-center justify-between">
            <p class="text-sm font-medium">
              {{ $t('workflows.selectCaseModal.cases') }}
            </p>
            <UButton
              icon="i-lucide-plus"
              size="xs"
              color="neutral"
              variant="ghost"
              :label="$t('workflows.selectCaseModal.addCase')"
              @click="addCase"
            />
          </div>
          <p class="text-xs text-dimmed">
            {{ $t('workflows.selectCaseModal.evaluatedInOrderTheFirst') }}
          </p>

          <div
            v-for="(row, index) in cases"
            :key="index"
            class="space-y-2 rounded-lg border border-default p-3"
          >
            <div class="flex items-center gap-2">
              <span class="w-6 shrink-0 text-center text-xs text-dimmed">{{ index + 1 }}</span>
              <UInput
                v-model="row.output"
                :aria-label="$t('workflows.selectCaseModal.caseName')"
                class="w-48 font-mono"
              />
              <div class="ml-auto flex items-center gap-1">
                <UButton
                  :aria-label="t('common.moveUp')"
                  icon="i-lucide-arrow-up"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :disabled="index === 0"
                  @click="moveCase(index, -1)"
                />
                <UButton
                  :aria-label="t('common.moveDown')"
                  icon="i-lucide-arrow-down"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :disabled="index === cases.length - 1"
                  @click="moveCase(index, 1)"
                />
                <UButton
                  :aria-label="t('common.remove')"
                  icon="i-lucide-x"
                  size="xs"
                  color="error"
                  variant="ghost"
                  :disabled="cases.length <= 1"
                  @click="removeCase(index)"
                />
              </div>
            </div>
            <WhereField
              v-model="row.filterJson"
              :label="$t('workflows.selectCaseModal.filter')"
              :error="caseError(row, index) ?? undefined"
            />
          </div>
        </div>

        <UFormField
          :label="$t('workflows.selectCaseModal.defaultBranch')"
          :description="$t('workflows.selectCaseModal.catchesAnyInputThatMatched')"
        >
          <USwitch v-model="hasDefault" />
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
          :disabled="!keyValid || !casesValid || !!inputError"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
