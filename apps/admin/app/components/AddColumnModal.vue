<script setup lang="ts">
/**
 * Control-first Add Column (Specification_DataViews.md §16.2) - two steps:
 * pick a control of the column input catalog (@totalbase/tb-catalog'
 * COLUMN_INPUTS - "Number field", "Email", "Relation"), then configure it.
 * The entry derives dataType/check/foreignKey (buildColumnCreationBody) and
 * is the column's control (its presentation's `input`) - this component
 * never lets the user type a raw Postgres type.
 *
 * Own file, not inlined into ResourceColumns.vue - same call NewTableModal.
 * vue/NewSchemaModal.vue already made for a modal this size.
 */
import { COLUMN_INPUTS, NUMBER_TYPES, buildColumnCreationBody, columnValueKind, creatableColumnInputs, type ColumnInputDefinition, type ColumnInputKey, type ColumnPresentation, type CreationConfig, type FkAction, type NumberType } from '@totalbase/tb-catalog'
import type { ColumnBody, RelationDetail } from '~/types/schema'
import type { WizardStep } from '~/components/WizardModal.vue'
import { useColumnInputText } from '~/utils/column-input-text'

const FK_ACTIONS: FkAction[] = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']

const props = defineProps<{ schema: string, table: string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ added: [] }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()
const inputText = useColumnInputText()
function typeLabel(key: ColumnInputKey) {
  return inputText.label(key)
}

/** The controls that create their column, by group, in the UI's language - @totalbase/tb-catalog' English as the fallback. */
const GROUPS: ColumnInputDefinition['group'][] = ['text', 'number', 'choice', 'date', 'other', 'relation']
const ENTRIES = computed(() => creatableColumnInputs().map(key => ({ ...COLUMN_INPUTS[key], key, label: inputText.label(key), description: inputText.description(key), technical: inputText.technical(key) })))
const typeSearch = ref('')
function matchesTypeSearch(entry: (typeof ENTRIES.value)[number]) {
  const term = typeSearch.value.trim().toLowerCase()
  if (!term) return true
  return [entry.key, entry.label, entry.description, entry.technical].some(value => value.toLowerCase().includes(term))
}
const filteredGroups = computed(() => GROUPS
  .map(group => ({ group, entries: ENTRIES.value.filter(e => e.group === group && matchesTypeSearch(e)) }))
  .filter(g => g.entries.length > 0))
const hasTypeSearchResults = computed(() => filteredGroups.value.length > 0)
// Enter in the search box takes the first match (Specification_DataViews.md
// §16.2) and moves on to its configuration - type, Enter, configure.
const wizard = useTemplateRef<{ next: () => void }>('wizard')
function pickFirstMatch() {
  const first = filteredGroups.value[0]?.entries[0]
  if (!first) return
  pick(first.key)
  nextTick(() => wizard.value?.next())
}

// --- Step state ---
const selectedKey = ref<ColumnInputKey | null>(null)
const selectedEntry = computed(() => selectedKey.value ? COLUMN_INPUTS[selectedKey.value] : null)
const strategy = computed(() => selectedEntry.value?.create ?? null)
// Types with a scalar strategy but no type-specific field below (Unique
// lives with the other switches now, right under Not null) - the
// Configuration section has nothing left to show for these, so it's
// hidden rather than rendering an empty header.
const SCALAR_CONFIG_WIDGETS: ReadonlySet<ColumnInputKey> = new Set([
  'text', 'number-field', 'number-stepper', 'slider', 'rating', 'pin'
])
const hasScalarConfig = computed(() => !!selectedKey.value && SCALAR_CONFIG_WIDGETS.has(selectedKey.value))

function pick(key: ColumnInputKey) {
  selectedKey.value = key
}

// --- Step 2: always-shown identity fields ---
const name = ref('')
const notNull = ref(false)
const defaultExpr = ref('')

// --- Step 2: presentation (Specification_DataViews.md §15)
// - never touches DDL: how the column reads in every view that shows
// it, stored in its resources_columns row. ---
const presentation = ref<ColumnPresentation>({})
/** A number control's PostgreSQL type - its own default (a whole number for − and +, a decimal for a number field). */
const numberType = ref<NumberType | undefined>(undefined)
const effectiveNumberType = computed(() => numberType.value ?? selectedEntry.value?.numberType)
watch(selectedKey, () => {
  numberType.value = undefined
})
const NUMBER_TYPE_ITEMS = computed(() => NUMBER_TYPES.map(type => ({ label: t(`database.addColumn.numberTypes.${type}`), value: type })))

// --- Step 2: scalar config ---
const unique = ref(false)
const minLength = ref<number | undefined>(undefined)
const maxLength = ref<number | undefined>(undefined)
const pattern = ref('')
const min = ref<number | undefined>(undefined)
const max = ref<number | undefined>(undefined)
const decimals = ref<number | undefined>(undefined)
const ratingLength = ref<number | undefined>(undefined)
const pinLength = ref<number | undefined>(undefined)

// --- Step 2: UID config - the column of this table its slug comes from
// (Specification_DataViews.md §16.3). ---
const uidSource = ref('')
const ownColumns = ref<string[]>([])
watch(() => strategy.value?.kind === 'uid', async (isUid) => {
  if (!isUid || ownColumns.value.length > 0) return
  const own = (allTables.value ?? []).find(t => t.schema === props.schema && t.name === props.table)
  if (!own) return
  const { data } = await api.get<RelationDetail>(`/catalog/table/${own.oid}`)
  ownColumns.value = data.columns.map(c => c.name)
})

// --- Step 2: selection config (Choice / Choice-multiple) ---
const options = ref<{ value: string, label: string }[]>([{ value: '', label: '' }])
function addOption() {
  options.value.push({ value: '', label: '' })
}
function removeOption(index: number) {
  options.value.splice(index, 1)
}
const validOptions = computed(() => options.value.filter(o => o.value.trim().length > 0))

// --- Step 2: relation config (guided target picker - the FK target
// validation of the former ColumnConstraintFields.vue, just the target-
// validation half, not the whole component (its Unique/Check toggles don't
// apply here, Selection/Email/PIN already replace what free-typed Check
// used to cover in this modal). ---
const { tables: allTables } = useCatalogTablesList()
const targetSchema = ref('public')
const targetTable = ref('')
const targetColumn = ref('')
const targetOnDelete = ref<FkAction | undefined>(undefined)
const targetOnUpdate = ref<FkAction | undefined>(undefined)
const targetDetail = ref<RelationDetail | null>(null)
const targetColumns = ref<string[]>([])
const loadingTarget = ref(false)

const schemaOptions = computed(() => [...new Set((allTables.value ?? []).map(t => t.schema))])
const targetTableOptions = computed(() => (allTables.value ?? []).filter(t => t.schema === targetSchema.value).map(t => t.name))

async function onTargetTableChange() {
  targetColumn.value = ''
  targetColumns.value = []
  targetDetail.value = null
  const target = (allTables.value ?? []).find(t => t.schema === targetSchema.value && t.name === targetTable.value)
  if (!target) return
  loadingTarget.value = true
  try {
    const { data } = await api.get<RelationDetail>(`/catalog/table/${target.oid}`)
    targetDetail.value = data
    targetColumns.value = data.columns.map(c => c.name)
  } finally {
    loadingTarget.value = false
  }
}

// PostgreSQL requires the referenced column to carry a PK or UNIQUE.
const fkTargetIsValid = computed(() => {
  if (!targetColumn.value || !targetDetail.value) return false
  return targetDetail.value.primaryKey.includes(targetColumn.value)
    || targetDetail.value.uniqueConstraints.some(cols => cols.length === 1 && cols[0] === targetColumn.value)
})
const targetColumnDataType = computed(() => targetDetail.value?.columns.find(c => c.name === targetColumn.value)?.dataType)

// --- Validity gate ---
const steps = computed<WizardStep[]>(() => [
  { key: 'type', title: t('database.addColumn.controlStep'), description: t('database.addColumn.typeStepDescription'), valid: !!selectedKey.value },
  { key: 'config', title: t('database.addColumn.configuration'), description: t('database.addColumn.configStepDescription'), valid: valid.value }
])
const valid = computed(() => {
  if (!name.value.trim() || !selectedKey.value) return false
  if (strategy.value?.kind === 'selection') return validOptions.value.length > 0
  if (strategy.value?.kind === 'uid') return !!uidSource.value && uidSource.value !== name.value.trim()
  if (strategy.value?.kind === 'relation' && strategy.value.target === 'guided') {
    return fkTargetIsValid.value
  }
  return true
})

function resetForm() {
  typeSearch.value = ''
  selectedKey.value = null
  name.value = ''
  notNull.value = false
  defaultExpr.value = ''
  presentation.value = {}
  unique.value = false
  minLength.value = undefined
  maxLength.value = undefined
  pattern.value = ''
  min.value = undefined
  max.value = undefined
  decimals.value = undefined
  ratingLength.value = undefined
  pinLength.value = undefined
  options.value = [{ value: '', label: '' }]
  uidSource.value = ''
  ownColumns.value = []
  targetSchema.value = 'public'
  targetTable.value = ''
  targetColumn.value = ''
  targetOnDelete.value = undefined
  targetOnUpdate.value = undefined
  targetDetail.value = null
  targetColumns.value = []
}
watch(open, (isOpen) => {
  if (isOpen) resetForm()
})

function buildCreationConfig(): CreationConfig {
  return {
    unique: unique.value || undefined,
    minLength: minLength.value,
    maxLength: maxLength.value,
    pattern: pattern.value.trim() || undefined,
    min: min.value,
    max: max.value,
    numberType: numberType.value,
    decimals: decimals.value,
    options: strategy.value?.kind === 'selection' ? validOptions.value : undefined,
    ratingLength: ratingLength.value,
    pinLength: pinLength.value,
    uidSource: strategy.value?.kind === 'uid' ? uidSource.value || undefined : undefined,
    relation: strategy.value?.kind === 'relation' && strategy.value.target === 'guided' && targetColumnDataType.value
      ? {
          targetSchema: targetSchema.value,
          targetTable: targetTable.value,
          targetColumn: targetColumn.value,
          targetColumnDataType: targetColumnDataType.value,
          onDelete: targetOnDelete.value,
          onUpdate: targetOnUpdate.value
        }
      : undefined
  }
}

/**
 * The kind of value the column will hold - which presentation options
 * apply (a format for a number or a date...). A relation's is decided by
 * its foreign key, whatever the key's type.
 */
const presentationKind = computed(() => {
  if (!selectedKey.value) return 'text' as const
  if (strategy.value?.kind === 'relation') return 'relation' as const
  if (strategy.value?.kind === 'uid') return 'text' as const
  return columnValueKind(buildColumnCreationBody(selectedKey.value, 'column', buildCreationConfig()).dataType, null)
})

/**
 * The column's presentation, pushed alongside it into resources_columns
 * (Specification_DataViews.md §16.2). A choice's labels come
 * from its options editor; its values themselves go to the CHECK only.
 */
function buildPresentation(): ColumnPresentation {
  if (strategy.value?.kind !== 'selection') return presentation.value
  const options = Object.fromEntries(validOptions.value.filter(o => o.label.trim()).map(o => [o.value.trim(), { label: o.label.trim() }]))
  return { ...presentation.value, options }
}

const saving = ref(false)
async function save() {
  if (!selectedKey.value || !valid.value) return
  saving.value = true
  try {
    // What the user chose - the entry and its config; the server derives the
    // column's type, CHECK, foreign key and UID from them (AGENTS.md §6: the
    // admin never builds the DDL).
    const isUid = strategy.value?.kind === 'uid'
    const body: ColumnBody = {
      name: name.value.trim(),
      nullable: isUid ? true : !notNull.value,
      default: isUid ? undefined : defaultExpr.value.trim() || undefined,
      unique: strategy.value?.kind === 'scalar' ? (unique.value || undefined) : undefined,
      input: selectedKey.value,
      creation: buildCreationConfig(),
      config: buildPresentation()
    }
    await api.post(`/schema/${props.schema}/tables/${props.table}/columns`, { data: body })
    toast.add({ title: t('database.addColumn.added'), color: 'success' })
    open.value = false
    emit('added')
  } catch (err) {
    notifyError(err, t('database.addColumn.addError'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <WizardModal
    ref="wizard"
    v-model:open="open"
    :title="t('database.addColumn.title')"
    :steps="steps"
    :submit-label="t('common.add')"
    :submitting="saving"
    width="max-w-4xl"
    height="h-[52vh]"
    @submit="save"
  >
    <!-- Step 1: pick a column type -->
    <template #type>
      <div class="flex flex-col gap-5">
        <UFormField
          :label="t('common.search')"
          :description="t('database.addColumn.searchDescription')"
        >
          <UInput
            v-model="typeSearch"
            icon="i-lucide-search"
            type="search"
            class="w-full"
            autofocus
            @keydown.enter.prevent="pickFirstMatch"
          />
        </UFormField>

        <div
          v-for="{ group, entries } in filteredGroups"
          :key="group"
        >
          <p class="text-xs font-semibold uppercase tracking-wide text-muted mb-3">
            {{ t(`database.columnInputGroups.${group}`) }}
          </p>
          <div class="grid grid-cols-2 gap-3">
            <button
              v-for="opt in entries"
              :key="opt.key"
              type="button"
              class="relative rounded-lg border p-4 text-left transition-colors"
              :class="selectedKey === opt.key ? 'border-primary bg-primary/5' : 'border-default hover:bg-elevated'"
              @click="pick(opt.key)"
            >
              <UIcon
                :name="opt.icon"
                class="size-6 mb-2"
                :class="selectedKey === opt.key ? 'text-primary' : 'text-muted'"
              />
              <p class="text-sm font-semibold text-highlighted">
                {{ opt.label }}
              </p>
              <p class="text-xs text-muted">
                {{ opt.description }}
              </p>
              <p class="mt-1 font-mono text-[11px] text-dimmed">
                {{ opt.technical }}
              </p>
            </button>
          </div>
        </div>

        <UEmpty
          v-if="!hasTypeSearchResults"
          variant="naked"
          icon="i-lucide-search-x"
          :title="t('database.addColumn.noMatchTitle')"
          :description="t('database.addColumn.noMatchDescription', { term: typeSearch.trim() })"
          :actions="[{ label: t('database.addColumn.clearSearch'), color: 'neutral', variant: 'outline', onClick: () => { typeSearch = '' } }]"
        />
      </div>
    </template>

    <!-- Step 2: configure (only once a widget is picked) -->
    <template #config>
      <div
        v-if="selectedEntry"
        class="flex flex-col gap-4"
      >
        <div class="flex items-center gap-2 text-sm text-muted">
          <UIcon
            :name="selectedEntry!.icon"
            class="size-4"
          />
          <span>{{ typeLabel(selectedKey!) }}</span>
        </div>

        <!-- Database - everything that shapes the real Postgres column:
        identity, constraints, and whatever DDL the widget's own strategy
        derives (CHECKs, FK target). -->
        <div class="flex flex-col gap-4">
          <p class="text-xs font-semibold uppercase tracking-wide text-muted">
            {{ t('database.addColumn.database') }}
          </p>

          <UFormField
            :label="t('common.name')"
            :description="t('database.addColumn.nameDescription', { example: 'published_at' })"
            required
          >
            <InputPgIdentifier
              v-model="name"
              class="w-full"
              autofocus
            />
          </UFormField>

          <!-- A UID column is always nullable, UNIQUE and without a
          default: its trigger fills it, and a row whose source is empty
          stays empty (Specification_DataViews.md §16.3). -->
          <UFormField
            v-if="strategy?.kind === 'uid'"
            :label="t('database.addColumn.generatedFrom')"
            :description="t('database.addColumn.generatedFromDescription')"
            required
          >
            <USelect
              v-model="uidSource"
              :items="ownColumns.filter(c => c !== name.trim())"
              class="w-full"
              :aria-label="t('database.addColumn.generatedFrom')"
            />
          </UFormField>

          <div
            v-if="strategy?.kind !== 'uid'"
            class="flex items-center justify-between"
          >
            <span class="text-sm">{{ t('database.addColumn.notNull') }}</span>
            <USwitch
              v-model="notNull"
              :aria-label="t('database.addColumn.notNull')"
            />
          </div>

          <!-- Not offered for Password: a UNIQUE constraint on an argon2
          hash is meaningless - its random salt means two different
          users' hashes never collide anyway. -->
          <div
            v-if="strategy?.kind === 'scalar' && selectedKey !== 'password'"
            class="flex items-center justify-between"
          >
            <span class="text-sm">{{ t('database.addColumn.unique') }}</span>
            <USwitch
              v-model="unique"
              :aria-label="t('database.addColumn.unique')"
            />
          </div>

          <UFormField
            v-if="strategy?.kind !== 'uid'"
            :label="t('database.addColumn.default')"
            :description="t('database.addColumn.defaultDescription', { examples: 'now(), 0, gen_random_uuid()' })"
          >
            <UInput
              v-model="defaultExpr"
              class="w-full"
            />
          </UFormField>

          <div
            v-if="hasScalarConfig"
            class="flex flex-col gap-4 border-t border-default pt-4"
          >
            <div
              v-if="selectedKey === 'text'"
              class="grid grid-cols-2 gap-3"
            >
              <UFormField :label="t('database.addColumn.minLength')">
                <UInputNumber
                  v-model="minLength"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                :label="t('database.addColumn.maxLength')"
                :description="t('database.addColumn.maxLengthDescription', { type: 'varchar(n)' })"
              >
                <UInputNumber
                  v-model="maxLength"
                  class="w-full"
                />
              </UFormField>
            </div>

            <UFormField
              v-if="selectedEntry?.numberType"
              :label="t('database.addColumn.numberType')"
              :description="t('database.addColumn.numberTypeHelp')"
            >
              <USelect
                :model-value="effectiveNumberType"
                :items="NUMBER_TYPE_ITEMS"
                class="w-full"
                @update:model-value="(v: NumberType) => numberType = v"
              />
            </UFormField>
            <div
              v-if="['number-field', 'number-stepper', 'slider'].includes(selectedKey ?? '')"
              class="grid grid-cols-2 gap-3"
            >
              <UFormField :label="t('database.addColumn.min')">
                <UInputNumber
                  v-model="min"
                  class="w-full"
                />
              </UFormField>
              <UFormField :label="t('database.addColumn.max')">
                <UInputNumber
                  v-model="max"
                  class="w-full"
                />
              </UFormField>
            </div>
            <UFormField
              v-if="selectedEntry?.numberType && effectiveNumberType === 'decimal'"
              :label="t('database.addColumn.decimalPlaces')"
              :description="t('database.addColumn.defaultsTo', { value: 2 })"
            >
              <UInputNumber
                v-model="decimals"
                class="w-full"
              />
            </UFormField>

            <UFormField
              v-if="selectedKey === 'rating'"
              :label="t('database.addColumn.maxRating')"
              :description="t('database.addColumn.defaultsTo', { value: 5 })"
            >
              <UInputNumber
                v-model="ratingLength"
                class="w-full"
              />
            </UFormField>

            <UFormField
              v-if="selectedKey === 'pin'"
              :label="t('database.addColumn.length')"
              required
            >
              <UInputNumber
                v-model="pinLength"
                class="w-full"
              />
            </UFormField>
          </div>

          <div
            v-if="strategy?.kind === 'selection'"
            class="flex flex-col gap-3 border-t border-default pt-4"
          >
            <p class="text-xs font-medium text-muted">
              {{ t('database.addColumn.options') }}
            </p>
            <p class="text-xs text-muted">
              {{ t('database.addColumn.optionsHelp') }}
            </p>
            <div
              v-for="(opt, i) in options"
              :key="i"
              class="flex items-center gap-2"
            >
              <UInput
                v-model="opt.value"
                :aria-label="t('common.value')"
                class="w-full"
              />
              <UInput
                v-model="opt.label"
                :aria-label="t('common.label')"
                class="w-full"
              />
              <UButton
                :aria-label="t('common.remove')"
                icon="i-lucide-trash-2"
                size="xs"
                color="error"
                variant="ghost"
                :disabled="options.length === 1"
                @click="removeOption(i)"
              />
            </div>
            <UButton
              :label="t('database.addColumn.addOption')"
              icon="i-lucide-plus"
              size="xs"
              color="neutral"
              variant="outline"
              class="self-start"
              @click="addOption"
            />
          </div>

          <div
            v-if="strategy?.kind === 'relation' && strategy.target === 'guided'"
            class="flex flex-col gap-3 border-t border-default pt-4"
          >
            <p class="text-xs font-medium text-muted">
              {{ t('database.addColumn.relationTarget') }}
            </p>
            <div class="grid grid-cols-2 gap-2">
              <UFormField :label="t('database.addColumn.targetSchema')">
                <USelect
                  v-model="targetSchema"
                  :items="schemaOptions"
                  class="w-full"
                  @update:model-value="onTargetTableChange"
                />
              </UFormField>
              <UFormField :label="t('database.addColumn.targetTable')">
                <USelect
                  v-model="targetTable"
                  :items="targetTableOptions"
                  class="w-full"
                  @update:model-value="onTargetTableChange"
                />
              </UFormField>
            </div>
            <UFormField :label="t('database.addColumn.targetColumn')">
              <USelect
                v-model="targetColumn"
                :items="targetColumns"
                :loading="loadingTarget"
                class="w-full"
              />
            </UFormField>
            <UAlert
              v-if="targetColumn && !fkTargetIsValid"
              color="warning"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :title="t('database.addColumn.invalidTargetTitle')"
              :description="t('database.addColumn.invalidTargetDescription')"
            />
            <div class="grid grid-cols-2 gap-2">
              <UFormField :label="t('database.addColumn.onDelete')">
                <USelect
                  v-model="targetOnDelete"
                  :items="FK_ACTIONS"
                  class="w-full"
                />
              </UFormField>
              <UFormField :label="t('database.addColumn.onUpdate')">
                <USelect
                  v-model="targetOnUpdate"
                  :items="FK_ACTIONS"
                  class="w-full"
                />
              </UFormField>
            </div>
          </div>
        </div>

        <!-- Presentation - never touches DDL: how it reads in every view that shows it. -->
        <div class="flex flex-col gap-4">
          <p class="text-xs font-semibold uppercase tracking-wide text-muted">
            {{ t('database.addColumn.presentation') }}
          </p>
          <ColumnPresentationFields
            v-model="presentation"
            :column-name="name.trim()"
            :kind="presentationKind"
          />
        </div>
      </div>
    </template>
  </WizardModal>
</template>
